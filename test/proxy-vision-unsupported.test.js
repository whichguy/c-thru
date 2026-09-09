#!/usr/bin/env node
'use strict';
// C39 runtime signal: x-c-thru-vision-unsupported header + recent-ring flag.
//
// When a Messages body carries image/document content and the FINAL served
// model is text-only, the proxy stamps `x-c-thru-vision-unsupported: <model>`
// and sets requestMeta.visionUnsupported (→ recent ring `vision_unsupported` →
// c-thru-stop-hook.sh prose). Stamping is at the writeHead sites, keyed on the
// POST-fALLBACK effectiveModel, so the signal keys on the model that actually
// served: no false positive (capable fallback after a text-only primary) and
// no false negative (text-only fallback after a capable primary).
//
// Run: node test/proxy-vision-unsupported.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

console.log('proxy vision-unsupported runtime signal tests\n');

// Minimal 1x1 PNG (base64) — only the block TYPE matters to the detector, not
// the pixel data, but a real base64 PNG keeps the body well-formed.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// A text-only model (NOT in VISION_CAPABLE_DEFAULTS) and a vision-capable one.
const TEXT_ONLY = 'text-only-ghost';
const VISION_OK = 'qwen3-vl:8b';

function imageBody(model) {
  return {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
        { type: 'text', text: 'describe this' },
      ],
    }],
    max_tokens: 5,
  };
}

function textBody(model) {
  return {
    model,
    messages: [{ role: 'user', content: 'just text, no image' }],
    max_tokens: 5,
  };
}

// ── Configs ──────────────────────────────────────────────────────────────────

// Single backend serving `model` over a stub. Used for cases 1–3.
function singleBackendConfig(stubPort) {
  return {
    backends: {
      be: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: {
      [TEXT_ONLY]: 'be',
      [VISION_OK]: 'be',
    },
    llm_profiles: {
      // A non-vision capability (workhorse) routed to either model. The signal
      // fires for ANY capability, not just vision/pdf — this is the "default
      // model dropped my screenshot → use the vision agent" case.
      workhorse: { 'best-cloud': { '128gb': TEXT_ONLY } },
      vision:    { 'best-cloud': { '128gb': VISION_OK } },
    },
  };
}

// Two backends: the primary's backend fails (502), the fallback's backend
// serves (200). model_routes are keyed by ROLE (primaryModel→failing backend,
// fallbackModel→ok backend) so swapping which model is primary vs fallback
// (cases 4 vs 5) routes each model to the backend with the matching liveness.
function fallbackConfig(failPort, okPort, primaryModel, fallbackModel) {
  return {
    backends: {
      be_fail: { kind: 'anthropic', url: `http://127.0.0.1:${failPort}` },
      be_ok:   { kind: 'anthropic', url: `http://127.0.0.1:${okPort}` },
    },
    model_routes: {
      [primaryModel]:  'be_fail',
      [fallbackModel]: 'be_ok',
    },
    llm_profiles: {
      workhorse: {
        'best-cloud': { '128gb': primaryModel },
        on_failure: 'cascade',
      },
    },
    fallback_chains: {
      '128gb': {
        workhorse: [
          { model: primaryModel,   quality_score: 100 },
          { model: fallbackModel,  quality_score: 80 },
        ],
      },
    },
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-vision-'));

  try {
    // ── 1. image input → text-only model → header + ring flag ───────────────
    console.log('1. image input to a text-only model stamps the header + ring flag');
    {
      const stub = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir, singleBackendConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port }) => {
          // Route through the workhorse (text-only) capability.
          const r = await httpJson(port, 'POST', '/v1/messages', imageBody('workhorse'));
          assertEq(r.status, 200, 'request succeeded (text-only model still answers around the image)');
          assertEq(r.headers['x-c-thru-vision-unsupported'], TEXT_ONLY,
            'x-c-thru-vision-unsupported names the text-only served model');

          const recent = await httpJson(port, 'GET', '/c-thru/recent?n=5', null, {}, { retries: 1 });
          assertEq(recent.status, 200, 'recent ring reachable');
          const entry = recent.json.requests[0];
          assertEq(entry.vision_unsupported, true, 'ring entry flags vision_unsupported:true');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 2. text-only body (no image) → text-only model → NO header/flag ──────
    console.log('\n2. text-only body to a text-only model is silent (no image input)');
    {
      const stub = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir, singleBackendConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', textBody('workhorse'));
          assertEq(r.status, 200, 'request succeeded');
          assertEq(r.headers['x-c-thru-vision-unsupported'], undefined,
            'no x-c-thru-vision-unsupported when body has no image');

          const recent = await httpJson(port, 'GET', '/c-thru/recent?n=5', null, {}, { retries: 1 });
          const entry = recent.json.requests[0];
          assertEq(entry.vision_unsupported, false, 'ring entry flags vision_unsupported:false');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 3. image input → vision-capable model → NO header/flag ───────────────
    console.log('\n3. image input to a vision-capable model is silent');
    {
      const stub = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir, singleBackendConfig(stub.port));
        await withProxy({ configPath, profile: '128gb', mode: 'best-cloud' }, async ({ port }) => {
          // Route through the vision capability (qwen3-vl:8b).
          const r = await httpJson(port, 'POST', '/v1/messages', imageBody('vision'));
          assertEq(r.status, 200, 'request succeeded');
          assertEq(r.headers['x-c-thru-vision-unsupported'], undefined,
            'no x-c-thru-vision-unsupported for a vision-capable model');

          const recent = await httpJson(port, 'GET', '/c-thru/recent?n=5', null, {}, { retries: 1 });
          const entry = recent.json.requests[0];
          assertEq(entry.vision_unsupported, false, 'ring entry flags vision_unsupported:false (capable model)');
        });
      } finally { await stub.close().catch(() => {}); }
    }

    // ── 4. text-only primary (502) → capable fallback (200) + image → NO header
    //    (no FALSE POSITIVE: the final served model is vision-capable)
    console.log('\n4. text-only primary fails → capable fallback serves image → no false positive');
    {
      const primary  = await stubBackend({ failWith: 502 });
      const fallback = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir,
          fallbackConfig(primary.port, fallback.port, TEXT_ONLY, VISION_OK));
        await withProxy({
          configPath, profile: '128gb', mode: 'best-cloud',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
        }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', imageBody('workhorse'), {}, 12000);
          assertEq(r.status, 200, 'fallback cascade returns 200');
          assert(fallback.requests.length >= 1, `fallback backend served (got ${fallback.requests.length})`);
          assertEq(r.headers['x-c-thru-vision-unsupported'], undefined,
            'no header — final served model (vision-capable) did not drop the image');

          const recent = await httpJson(port, 'GET', '/c-thru/recent?n=5', null, {}, { retries: 1 });
          const entry = recent.json.requests[0];
          assertEq(entry.vision_unsupported, false, 'ring flags vision_unsupported:false (capable final model)');
        });
      } finally {
        await primary.close().catch(() => {});
        await fallback.close().catch(() => {});
      }
    }

    // ── 5. capable primary (502) → text-only fallback (200) + image → header SET
    //    (no FALSE NEGATIVE: the signal keys on the FINAL text-only model, even
    //    though the primary was vision-capable)
    console.log('\n5. capable primary fails → text-only fallback serves image → no false negative');
    {
      const primary  = await stubBackend({ failWith: 502 });
      const fallback = await stubBackend();
      try {
        const configPath = writeConfig(tmpDir,
          fallbackConfig(primary.port, fallback.port, VISION_OK, TEXT_ONLY));
        await withProxy({
          configPath, profile: '128gb', mode: 'best-cloud',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' },
        }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', imageBody('workhorse'), {}, 12000);
          assertEq(r.status, 200, 'fallback cascade returns 200');
          assert(fallback.requests.length >= 1, `fallback backend served (got ${fallback.requests.length})`);
          assertEq(r.headers['x-c-thru-vision-unsupported'], TEXT_ONLY,
            'header names the text-only FINAL model that dropped the image');

          const recent = await httpJson(port, 'GET', '/c-thru/recent?n=5', null, {}, { retries: 1 });
          const entry = recent.json.requests[0];
          assertEq(entry.vision_unsupported, true, 'ring flags vision_unsupported:true (text-only final model)');
        });
      } finally {
        await primary.close().catch(() => {});
        await fallback.close().catch(() => {});
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});