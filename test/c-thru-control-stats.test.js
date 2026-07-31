#!/usr/bin/env node
'use strict';
// Gap 4: tools/c-thru-control.js NL / argv clear dispatch → POST /c-thru/stats/clear
// Fixture HTTP server runs in a child process so spawnSync does not block its event loop.
// Run: node test/c-thru-control-stats.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, assertEq, summary } = require('./helpers');

const REPO = path.resolve(__dirname, '..');
const CONTROL = path.join(REPO, 'tools', 'c-thru-control.js');

console.log('c-thru-control stats clear dispatch\n');

function runControl(port, argv) {
  return spawnSync(process.execPath, [CONTROL, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
    timeout: 10000,
  });
}

async function startFixtureServer(dir) {
  const portFile = path.join(dir, 'port.txt');
  const logFile = path.join(dir, 'log.json');
  const script = path.join(dir, 'fixture.js');
  fs.writeFileSync(script, `
'use strict';
const http = require('http');
const fs = require('fs');
const log = [];
function flush() { fs.writeFileSync(process.env.LOG_FILE, JSON.stringify(log)); }
const server = http.createServer((req, res) => {
  res.setHeader('Connection', 'close');
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    log.push({ method: req.method, url: req.url });
    flush();
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && (req.url || '').includes('/c-thru/stats/clear')) {
      res.end(JSON.stringify({ ok: true, cleared_at: '2026-07-31T12:00:00.000Z' }));
      return;
    }
    if (req.method === 'GET' && (req.url || '').includes('/c-thru/status')) {
      res.end(JSON.stringify({
        ok: true, mode: 'best-cloud', hardware_tier: '64gb', config_source: 'test',
        ollama_health: 'ok', active_capabilities: { workhorse: 'm' },
        usage: { total_input: 0, total_output: 0, by_model: {}, by_agent: {}, cleared_at: '2026-07-31T12:00:00.000Z' },
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PORT_FILE, String(server.address().port));
  flush();
});
`);
  fs.writeFileSync(logFile, '[]');
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PORT_FILE: portFile, LOG_FILE: logFile },
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
  if (!port) {
    try { child.kill('SIGKILL'); } catch { /* */ }
    throw new Error('fixture server did not publish port');
  }
  return {
    port,
    readLog() {
      try { return JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch { return []; }
    },
    clearLog() {
      fs.writeFileSync(logFile, '[]');
      // Child appends to in-memory log; restart file is only for parent reads
      // between cases — also signal by truncating; child will still accumulate.
      // For per-case isolation, kill/restart is heavier; filter by length delta instead.
    },
    logFile,
    stop() {
      try { child.kill('SIGTERM'); } catch { /* */ }
    },
  };
}

async function main() {
  // Missing base URL
  {
    const r2 = spawnSync(process.execPath, [CONTROL, 'clear-stats'], {
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries({ ...process.env }).filter(([k]) => k !== 'ANTHROPIC_BASE_URL')
      ),
      timeout: 5000,
    });
    assert(r2.status !== 0, 'missing ANTHROPIC_BASE_URL exits non-zero');
    assert(/ANTHROPIC_BASE_URL/i.test(r2.stderr || r2.stdout || ''),
      'missing base URL prints diagnostic');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-ctl-'));
  const fixture = await startFixtureServer(dir);

  const phrases = [
    ['clear stats'],
    ['reset usage'],
    ['clear-stats'],
    ['stats-clear'],
    ['clear_stats'],
    ['zero stats'],
  ];

  try {
    let logStart = 0;
    for (const argv of phrases) {
      const before = fixture.readLog().length;
      const r = runControl(fixture.port, argv);
      assertEq(r.status, 0, `${argv.join(' ')}: exit 0 (stderr=${(r.stderr || '').slice(0, 120)})`);
      assert(/cleared/i.test(r.stdout), `${argv.join(' ')}: prints cleared`);
      const log = fixture.readLog().slice(before);
      const posts = log.filter(e => e.method === 'POST' && (e.url || '').includes('/c-thru/stats/clear'));
      assertEq(posts.length, 1, `${argv.join(' ')}: exactly one POST /c-thru/stats/clear`);
      logStart = fixture.readLog().length;
    }
    void logStart;

    // Status path must NOT clear
    {
      const before = fixture.readLog().length;
      const r = runControl(fixture.port, ['status']);
      assertEq(r.status, 0, 'status: exit 0');
      const log = fixture.readLog().slice(before);
      const posts = log.filter(e => e.method === 'POST' && (e.url || '').includes('stats/clear'));
      assertEq(posts.length, 0, 'status: no stats/clear POST');
    }
  } finally {
    fixture.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.exit(summary() ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
