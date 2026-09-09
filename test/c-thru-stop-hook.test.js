#!/usr/bin/env node
'use strict';
// c-thru-stop-hook.sh: emits a systemMessage when this session's most recent
// request was served by a fallback.
//
// Round-5 B3: rewritten. The old test/c-thru-stop-hook.test.sh fed synthetic
// log lines containing [fallback.candidate_success]/[fallback.chain_start] —
// event names the fallback engine no longer emits (its own header admitted
// this: green tests over dead code, the exact anti-pattern
// docs/review-methodology.md warns about). This drives a REAL spawned proxy
// through a REAL primary-fails/secondary-serves fallback (same recipe as
// test/proxy-recent-requests.test.js Test 5) and the hook's actual
// GET /c-thru/recent call — no synthetic fixtures.
//
// Run: node test/c-thru-stop-hook.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend, spawnCapture,
} = require('./helpers');

const REPO_DIR = path.join(__dirname, '..');
const HOOK_SOURCE = path.join(REPO_DIR, 'tools', 'c-thru-stop-hook.sh');
const LIB_SOURCE  = path.join(REPO_DIR, 'tools', 'c-thru-lib.sh');

console.log('c-thru-stop-hook (fallback systemMessage: real proxy, real fallback)\n');

function which(tool) {
  const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
const BASH = which('bash') || 'bash';
const haveJq = which('jq') !== '';

// A test run from inside a LIVE c-thru session has ANTHROPIC_BASE_URL,
// CLAUDE_PROXY_PORT, C_THRU_SESSION_ID etc. already set to that real
// session's real proxy — scrub every one before setting our own, or the
// hook silently talks to the wrong proxy instead of this test's stub (the
// exact ambient-leak class of bug docs/test-authoring.md warns about).
const CTHRU_ENV_KEYS = [
  'CLAUDE_PROXY_PORT', 'PROXY_PORT', 'ANTHROPIC_BASE_URL',
  'CLAUDE_PROXY_USE_OLLAMA_PORT', 'C_THRU_SESSION_ID', 'C_THRU_PLUGIN_PORT',
  'C_THRU_SESSION_SCOPED_MODE',
];

// port + sessionId (not a pre-built URL): cthru_hook_base_url() constructs
// the /s/<id> suffix itself from C_THRU_SESSION_ID (matching how a real
// c-thru launch always sets CLAUDE_PROXY_PORT/PROXY_PORT and
// C_THRU_SESSION_ID together) — it does NOT re-parse a path out of
// ANTHROPIC_BASE_URL. Pass port=null/sessionId=null to simulate "c-thru not
// active" (nothing set, fail-open).
async function runHook(scratchHook, fakeClaudeHome, port, sessionId) {
  const env = Object.assign({}, process.env, { HOME: fakeClaudeHome });
  for (const k of CTHRU_ENV_KEYS) delete env[k];
  if (port) env.CLAUDE_PROXY_PORT = String(port);
  if (sessionId) env.C_THRU_SESSION_ID = sessionId;
  const r = await spawnCapture(BASH, [scratchHook], { env, timeout: 10000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '', parsed };
}

async function main() {
  if (!haveJq) {
    console.log('jq not on PATH — hook fail-opens by design; skipping (nothing to assert).');
    process.exit(0);
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-stop-hook-'));
  const scratchTools = path.join(base, 'scratch', 'tools');
  fs.mkdirSync(scratchTools, { recursive: true });
  const scratchHook = path.join(scratchTools, 'c-thru-stop-hook.sh');
  fs.copyFileSync(HOOK_SOURCE, scratchHook);
  fs.copyFileSync(LIB_SOURCE, path.join(scratchTools, 'c-thru-lib.sh'));
  fs.chmodSync(scratchHook, 0o755);

  let primary, secondary, textOnly;
  try {
    primary = await stubBackend({ failWith: 500 });
    secondary = await stubBackend();
    // A text-only model served by a healthy backend (200) — used to drive the
    // C39 vision-drop event WITHOUT a fallback (so the vision event is the
    // highest-priority event this scan and surfaces in the stop-hook prose).
    textOnly = await stubBackend();
    const cfg = {
      backends: {
        primary_be:   { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}`, fallback_to: 'secondary-target' },
        secondary_be: { kind: 'anthropic', url: `http://127.0.0.1:${secondary.port}` },
        text_be:      { kind: 'anthropic', url: `http://127.0.0.1:${textOnly.port}` },
      },
      model_routes: {
        'primary-model':    'primary_be',
        'secondary-target': 'secondary_be',
        // NOT in VISION_CAPABLE_DEFAULTS — a direct text-only model route.
        'text-only-solo':   'text_be',
      },
    };
    const configPath = writeConfig(base, cfg);

    await withProxy({ configPath }, async ({ port }) => {
      // ── 1. Session A triggers a real fallback ──────────────────────────
      console.log('1. Session A: real fallback fires -> hook reports it');
      const rA = await httpJson(port, 'POST', '/s/session-a/v1/messages', {
        model: 'primary-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
      }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
      assertEq(rA.status, 200, 'session A request served via fallback (200)');

      const homeA = fs.mkdtempSync(path.join(base, 'home-a-'));
      fs.mkdirSync(path.join(homeA, '.claude'), { recursive: true });
      const out1 = await runHook(scratchHook, homeA, port, 'session-a');
      assertEq(out1.status, 0, 'hook always exits 0');
      assert(out1.parsed && typeof out1.parsed.systemMessage === 'string', `hook emits a systemMessage JSON object (got: ${out1.stdout})`);
      assert(out1.parsed.systemMessage.includes('primary-model') && out1.parsed.systemMessage.includes('secondary-target'),
        `systemMessage names both the original and serving model (got: ${out1.parsed.systemMessage})`);

      // ── 2. Same session, second hook invocation: already reported → silent ──
      console.log('\n2. Same session, second invocation: dedup tracker suppresses re-report');
      const out2 = await runHook(scratchHook, homeA, port, 'session-a');
      assertEq(out2.status, 0, 'second invocation also exits 0');
      assertEq(out2.stdout, '', `second invocation is silent — already reported this fallback (got: ${JSON.stringify(out2.stdout)})`);

      // ── 3. Session B never had a fallback → silent, session-isolated ────
      console.log('\n3. Session B (healthy request only): silent, isolated from session A');
      const rB = await httpJson(port, 'POST', '/s/session-b/v1/messages', {
        model: 'secondary-target', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
      }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
      assertEq(rB.status, 200, 'session B healthy request succeeds (200)');
      const homeB = fs.mkdtempSync(path.join(base, 'home-b-'));
      fs.mkdirSync(path.join(homeB, '.claude'), { recursive: true });
      const out3 = await runHook(scratchHook, homeB, port, 'session-b');
      assertEq(out3.status, 0, 'session B hook exits 0');
      assertEq(out3.stdout, '', `session B reports nothing — no fallback in ITS history (got: ${JSON.stringify(out3.stdout)})`);

      // ── 4. Unkeyed (no session prefix): proxy not discoverable via lib fallback ──
      // Without CLAUDE_PROXY_PORT/PROXY_PORT and an ANTHROPIC_BASE_URL that
      // isn't loopback-shaped, cthru_hook_base_url returns empty → fail-open.
      console.log('\n4. No discoverable proxy (c-thru not active): silent no-op');
      const homeC = fs.mkdtempSync(path.join(base, 'home-c-'));
      fs.mkdirSync(path.join(homeC, '.claude'), { recursive: true });
      const out4 = await runHook(scratchHook, homeC, null, null);
      assertEq(out4.status, 0, 'no-proxy case exits 0');
      assertEq(out4.stdout, '', 'no-proxy case is silent');

      // ── 5. (C39) Session D sends an image to a text-only model that answers
      //    200 (the image is silently dropped). No fallback/hard_fail this scan,
      //    so the vision event surfaces: the hook directs to the `vision` agent.
      console.log('\n5. Session D: image to a text-only 200 model -> hook directs to the vision agent');
      const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const rD = await httpJson(port, 'POST', '/s/session-d/v1/messages', {
        model: 'text-only-solo', max_tokens: 10,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
            { type: 'text', text: 'describe this' },
          ],
        }],
      }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
      assertEq(rD.status, 200, 'session D text-only model answers 200 (around the dropped image)');
      assertEq(rD.headers['x-c-thru-vision-unsupported'], 'text-only-solo',
        'runtime header flags the text-only model that dropped the image');
      const homeD = fs.mkdtempSync(path.join(base, 'home-d-'));
      fs.mkdirSync(path.join(homeD, '.claude'), { recursive: true });
      const out5 = await runHook(scratchHook, homeD, port, 'session-d');
      assertEq(out5.status, 0, 'session D hook exits 0');
      assert(out5.parsed && typeof out5.parsed.systemMessage === 'string',
        `hook emits a vision systemMessage (got: ${out5.stdout})`);
      assert(out5.parsed.systemMessage.includes('text-only-solo') &&
        /Use the `vision` agent for images/.test(out5.parsed.systemMessage),
        `vision systemMessage names the text-only model and directs to the vision agent (got: ${out5.parsed.systemMessage})`);
      // Must NOT misframe as a fallback or hard_fail (no routing event this scan).
      assert(!/fallback just fired/.test(out5.parsed.systemMessage) && !/brand\/model pin/.test(out5.parsed.systemMessage),
        `vision event does not borrow the fallback/hard_fail framing (got: ${out5.parsed.systemMessage})`);
    });
  } finally {
    try { await primary.close(); } catch {}
    try { await secondary.close(); } catch {}
    try { await textOnly.close(); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  }

  const failed = summary();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
