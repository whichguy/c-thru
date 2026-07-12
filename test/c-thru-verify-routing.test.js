#!/usr/bin/env node
'use strict';
// c-thru-verify-routing.sh — live routing validator, hermetic regression test.
//
// Spawns a REAL proxy (stub upstream, no network) and drives the tool as a
// subprocess against it, proving both signals it cross-checks:
//   1. x-c-thru-resolved-via header vs c-thru's own predicted resolution.
//   2. The persisted /c-thru/status usage-by-agent delta.
// The zero-token case proves the tool's actual value-add over the header
// alone: a response can look right (correct model in the header) while the
// proxy's own usage stats never actually recorded the call.
//
// Run: node test/c-thru-verify-routing.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { assert, assertEq, summary, withProxy, stubBackend } = require('./helpers');

console.log('c-thru-verify-routing.sh (live proxy, header + usage-stats cross-check)\n');

const TOOL = path.resolve(__dirname, '..', 'tools', 'c-thru-verify-routing.sh');

function mkConfig(stubPort) {
  return {
    llm_mode: 'best-cloud',
    agent_to_capability: { planner: 'planner' },
    llm_profiles: {
      planner: { 'best-cloud': { '64gb': 'stub-model-a' } },
    },
    model_routes: {
      'stub-model-a': 'stubBackend',
    },
    endpoints: {
      stubBackend: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}`, auth: 'none' },
    },
  };
}

// Must be ASYNC (not spawnSync): the stub backend's HTTP server and the
// proxy both run in-process on this test's event loop. spawnSync blocks
// that event loop synchronously while waiting on the subprocess, so the
// stub could never actually respond to the tool's request — a deadlock.
function runTool(args, baseUrl) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { ANTHROPIC_BASE_URL: baseUrl });
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    const child = spawn('bash', [TOOL, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c.toString());
    child.stderr.on('data', c => stderr += c.toString());
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('runTool: timed out')); }, 15000);
    child.on('close', status => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ status, stdout, stderr, json });
    });
  });
}

async function main() {
  const stub = await stubBackend();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-verify-routing-'));
  const configPath = path.join(tmpDir, 'model-map.json');
  fs.writeFileSync(configPath, JSON.stringify(mkConfig(stub.port)));

  try {
    await withProxy({ configPath, profile: '64gb', mode: 'best-cloud' }, async ({ port }) => {
      const baseUrl = `http://127.0.0.1:${port}`;

      // ── Case 1: happy path — normal (non-zero-token) response ──────────
      const r1 = await runTool(['--agent', 'planner', '--json'], baseUrl);
      assertEq(r1.status, 0, 'happy path: tool exits 0');
      assert(Array.isArray(r1.json) && r1.json.length === 1, 'happy path: one result entry');
      const c1 = r1.json && r1.json[0];
      assertEq(c1 && c1.predicted, 'stub-model-a', 'happy path: predicted == stub-model-a');
      assertEq(c1 && c1.served_by, 'stub-model-a', 'happy path: header served_by == predicted');
      assertEq(c1 && c1.header_match, true, 'happy path: header_match true');
      assertEq(c1 && c1.stats_confirmed, true, 'happy path: stats_confirmed true (usage delta incremented)');
      assertEq(c1 && c1.verdict, 'PASS', 'happy path: overall verdict PASS');

      // ── Case 2: zero-token response — header still names the right ─────
      // model, but recordUsage() skips zero-token responses as noise, so the
      // persisted usage delta never moves. Proves the tool doesn't just
      // trust the header.
      stub.setHandler((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_stub_zero', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: '' }],
            model: body.model, stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }));
        });
        return true;
      });

      const r2 = await runTool(['--agent', 'planner', '--json'], baseUrl);
      assertEq(r2.status, 1, 'zero-token: tool exits non-zero (does not trust header alone)');
      const c2 = r2.json && r2.json[0];
      assertEq(c2 && c2.header_match, true, 'zero-token: header still reports the right model');
      assertEq(c2 && c2.stats_confirmed, false, 'zero-token: usage delta did NOT move');
      assertEq(c2 && c2.verdict, 'FAIL', 'zero-token: overall verdict FAIL');

      stub.setHandler(null);

      // ── Case 3: unknown agent — no predicted resolution ────────────────
      const r3 = await runTool(['--agent', 'not-a-real-agent', '--json'], baseUrl);
      assertEq(r3.status, 1, 'unknown agent: tool exits non-zero');
      const c3 = r3.json && r3.json[0];
      assertEq(c3 && c3.verdict, 'FAIL', 'unknown agent: verdict FAIL');
      assert(stub.requests.every(r => !r.body || r.body.model !== 'not-a-real-agent'),
        'unknown agent: no request was ever sent for it');

      // ── Case 4: --dry-run — reports prediction, sends zero requests ────
      const requestsBefore = stub.requests.length;
      const r4 = await runTool(['--agent', 'planner', '--dry-run', '--json'], baseUrl);
      assertEq(r4.status, 0, 'dry-run: tool exits 0');
      const c4 = r4.json && r4.json[0];
      assertEq(c4 && c4.predicted, 'stub-model-a', 'dry-run: reports predicted model');
      assertEq(c4 && c4.verdict, 'DRY_RUN', 'dry-run: verdict DRY_RUN');
      assertEq(stub.requests.length, requestsBefore, 'dry-run: no live request was sent');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await stub.close();
  }
}

main()
  .then(() => process.exit(summary()))
  .catch(e => { console.error(e); process.exit(1); });
