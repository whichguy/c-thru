#!/usr/bin/env node
'use strict';
// Gap 8: tools/c-thru stats → _print_usage_tables label and cleared_at window.
// Run: node test/c-thru-stats-cli.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, assertEq, summary } = require('./helpers');

const REPO = path.resolve(__dirname, '..');
const CTHRU = path.join(REPO, 'tools', 'c-thru');

console.log('c-thru stats CLI usage tables\n');

function which(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0;
}

async function main() {
  if (!which('jq')) {
    console.log('jq not on PATH — skip (CLI tables require jq)');
    process.exit(0);
  }

  // Child fixture server: spawnSync(c-thru) blocks the event loop, so an
  // in-process HTTP server cannot answer curl from c-thru stats.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-stats-cli-'));
  const portFile = path.join(dir, 'port.txt');
  const modeFile = path.join(dir, 'mode.txt'); // "full" | "zero"
  fs.writeFileSync(modeFile, 'full');
  const script = path.join(dir, 'fixture.js');
  fs.writeFileSync(script, `
'use strict';
const http = require('http');
const fs = require('fs');
const usageFull = {
  total_input: 1200, total_output: 340, total_duration_ms: 5000,
  first_recorded: '2026-01-01T00:00:00.000Z',
  last_recorded: '2026-07-31T10:00:00.000Z',
  cleared_at: '2026-07-30T08:00:00.000Z',
  by_model: {
    'model-a': { input: 1000, output: 300, calls: 4, total_duration_ms: 4000, first_call: null, last_call: '2026-07-31T09:00:00.000Z' },
    'model-b': { input: 200, output: 40, calls: 2, total_duration_ms: 1000, first_call: null, last_call: '2026-07-31T10:00:00.000Z' },
  },
  by_agent: {
    coder: { input: 1000, output: 300, calls: 4, total_duration_ms: 4000, first_call: null, last_call: '2026-07-31T09:00:00.000Z', served_by: { 'model-a': 4 } },
  },
  by_backend: {},
};
const usageZero = {
  total_input: 0, total_output: 0, total_duration_ms: 0,
  first_recorded: null, last_recorded: null, cleared_at: '2026-07-30T08:00:00.000Z',
  by_model: {}, by_agent: {}, by_backend: {},
};
let clearHits = 0;
const s = http.createServer((req, res) => {
  res.setHeader('Connection', 'close');
  res.setHeader('Content-Type', 'application/json');
  const mode = fs.readFileSync(process.env.MODE_FILE, 'utf8').trim();
  const usage = mode === 'zero' ? usageZero : usageFull;
  if ((req.url || '').includes('/c-thru/status')) {
    res.end(JSON.stringify({ ok: true, mode: 'best-cloud-oss', hardware_tier: '128gb', usage }));
    return;
  }
  // F4 CLI path: first N clears return 503 lock busy, then 200.
  if (req.method === 'POST' && (req.url || '').includes('/c-thru/stats/clear')) {
    clearHits += 1;
    if (mode === 'lockbusy' && clearHits < 3) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: 'usage lock busy' }));
      return;
    }
    if (mode === 'lockbusy-fail') {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: 'usage lock busy' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, cleared_at: '2026-07-31T12:00:00.000Z' }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
s.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PORT_FILE, String(s.address().port));
});
`);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PORT_FILE: portFile, MODE_FILE: modeFile },
    stdio: 'ignore',
  });
  let port = 0;
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(portFile)) {
      port = parseInt(fs.readFileSync(portFile, 'utf8'), 10) || 0;
      if (port > 0) break;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  assert(port > 0, 'fixture published port');

  try {
    const r = spawnSync('bash', [CTHRU, 'stats'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROXY_PORT: String(port),
        PROXY_PORT: String(port),
        C_THRU_SKIP_PROXY_AUTOSTART: '1',
      },
      timeout: 15000,
    });
    assertEq(r.status, 0, `c-thru stats exit 0 (stderr=${(r.stderr || '').slice(0, 200)})`);
    const out = r.stdout || '';
    assert(/Usage totals \(since clear\)/.test(out),
      `prints Usage totals (since clear) (got ${JSON.stringify(out.slice(0, 200))})`);
    assert(!/Session totals/.test(out), 'does not print Session totals');
    assert(/2026-07-30/.test(out), 'window start includes cleared_at date');
    assert(!/2026-01-01/.test(out), 'window start does not use older first_recorded');
    assert(/\b6\s+calls\b/.test(out) || /6 calls/.test(out),
      `sums by_model calls to 6 (got ${JSON.stringify(out.slice(0, 300))})`);

    fs.writeFileSync(modeFile, 'zero');
    const r0 = spawnSync('bash', [CTHRU, 'stats'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROXY_PORT: String(port),
        PROXY_PORT: String(port),
        C_THRU_SKIP_PROXY_AUTOSTART: '1',
      },
      timeout: 15000,
    });
    assertEq(r0.status, 0, 'c-thru stats zero exit 0');
    assert(!/Usage totals \(since clear\)/.test(r0.stdout || ''),
      'zero calls: no Usage totals line');

    // F4: clear retries past 503 lock-busy then succeeds
    fs.writeFileSync(modeFile, 'lockbusy');
    const rClear = spawnSync('bash', [CTHRU, 'stats', 'clear'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROXY_PORT: String(port),
        PROXY_PORT: String(port),
        C_THRU_SKIP_PROXY_AUTOSTART: '1',
      },
      timeout: 20000,
    });
    assertEq(rClear.status, 0, `stats clear after 503 retries exit 0 (stderr=${(rClear.stderr || '').slice(0, 200)})`);
    assert(/cleared_at|ok/.test(rClear.stdout || '') || /2026-07-31T12:00:00/.test(rClear.stdout || ''),
      `clear prints success JSON (got ${JSON.stringify((rClear.stdout || '').slice(0, 200))})`);

    // Persistent 503 → non-zero + lock busy message (not "proxy did not respond")
    fs.writeFileSync(modeFile, 'lockbusy-fail');
    const rFail = spawnSync('bash', [CTHRU, 'stats', 'clear'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROXY_PORT: String(port),
        PROXY_PORT: String(port),
        C_THRU_SKIP_PROXY_AUTOSTART: '1',
      },
      timeout: 20000,
    });
    assert(rFail.status !== 0, 'persistent lock busy exits non-zero');
    assert(/lock busy/i.test(rFail.stderr || '') || /lock busy/i.test(rFail.stdout || ''),
      `stderr mentions lock busy (got ${JSON.stringify((rFail.stderr || rFail.stdout || '').slice(0, 300))})`);
    assert(!/proxy did not respond/i.test(rFail.stderr || ''),
      'does not mislabel 503 as proxy down');
  } finally {
    try { child.kill('SIGTERM'); } catch { /* */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.exit(summary() ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
