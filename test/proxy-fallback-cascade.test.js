#!/usr/bin/env node
'use strict';
// Runtime fallback chain tests: when the primary backend fails (502/503),
// does the proxy actually walk fallback_chains and serve the request from
// a working candidate? Asserts response, x-c-thru-fallback-from header,
// and that hard_fail capabilities skip the cascade entirely.
//
// Run: node test/proxy-fallback-cascade.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  assert, assertEq, summary,
  writeConfig, withProxy, httpJson, stubBackend,
} = require('./helpers');

console.log('proxy fallback cascade tests\n');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-cascade-'));

  try {
    // ── Test 1: primary 502, secondary 200 → secondary serves ───────────────
    console.log('1. primary 502 → secondary 200: cascade fires');
    {
      const primary   = await stubBackend({ failWith: 502 });
      const secondary = await stubBackend();
      try {
        const config = {
          backends: {
            be_primary:   { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}` },
            be_secondary: { kind: 'anthropic', url: `http://127.0.0.1:${secondary.port}` },
          },
          model_routes: {
            'primary:big':   'be_primary',
            'secondary:mid': 'be_secondary',
          },
          llm_profiles: {
            '128gb': {
              workhorse: {
                connected_model:  'primary:big',
                disconnect_model: 'primary:big',
                on_failure: 'cascade',
              },
            },
          },
          fallback_chains: {
            '128gb': {
              workhorse: [
                { model: 'primary:big',   quality_score: 100 },
                { model: 'secondary:mid', quality_score: 80 },
              ],
            },
          },
        };
        const configPath = writeConfig(tmpDir, config);
        await withProxy({ configPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' } }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          }, {}, 8000);
          assertEq(r.status, 200, 'cascade returns 200');
          assert(secondary.requests.length >= 1, `secondary backend received traffic (got ${secondary.requests.length})`);
          // x-c-thru-fallback-from header should reference the failed primary
          const ff = r.headers['x-c-thru-fallback-from'];
          assert(typeof ff === 'string' && ff.length > 0,
            `x-c-thru-fallback-from set (got ${JSON.stringify(ff)})`);
        });
      } finally {
        await primary.close().catch(() => {});
        await secondary.close().catch(() => {});
      }
    }

    // ── Test 2: two-hop cascade — primary 502, secondary 502, tertiary 200 ──
    console.log('\n2. two-hop cascade: primary+secondary 502, tertiary 200');
    {
      const primary   = await stubBackend({ failWith: 502 });
      const secondary = await stubBackend({ failWith: 502 });
      const tertiary  = await stubBackend();
      try {
        const config = {
          backends: {
            be_p: { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}` },
            be_s: { kind: 'anthropic', url: `http://127.0.0.1:${secondary.port}` },
            be_t: { kind: 'anthropic', url: `http://127.0.0.1:${tertiary.port}` },
          },
          model_routes: {
            'p:big': 'be_p',
            's:mid': 'be_s',
            't:low': 'be_t',
          },
          llm_profiles: {
            '128gb': {
              workhorse: {
                connected_model:  'p:big',
                disconnect_model: 'p:big',
                on_failure: 'cascade',
              },
            },
          },
          fallback_chains: {
            '128gb': {
              workhorse: [
                { model: 'p:big', quality_score: 100 },
                { model: 's:mid', quality_score: 90 },
                { model: 't:low', quality_score: 70 },
              ],
            },
          },
        };
        const configPath = writeConfig(tmpDir, config);
        await withProxy({ configPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' } }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          }, {}, 12000);
          assertEq(r.status, 200, 'two-hop cascade returns 200');
          assert(tertiary.requests.length >= 1,
            `tertiary backend served (got tertiary=${tertiary.requests.length}, primary=${primary.requests.length}, secondary=${secondary.requests.length})`);
        });
      } finally {
        await primary.close().catch(() => {});
        await secondary.close().catch(() => {});
        await tertiary.close().catch(() => {});
      }
    }

    // ── Test 3: whole chain fails → returns 5xx error to client ─────────────
    console.log('\n3. whole chain fails: clean error returned, no silent success');
    {
      const a = await stubBackend({ failWith: 502 });
      const b = await stubBackend({ failWith: 502 });
      try {
        const config = {
          backends: {
            be_a: { kind: 'anthropic', url: `http://127.0.0.1:${a.port}` },
            be_b: { kind: 'anthropic', url: `http://127.0.0.1:${b.port}` },
          },
          model_routes: {
            'a:big': 'be_a',
            'b:mid': 'be_b',
          },
          llm_profiles: {
            '128gb': {
              workhorse: {
                connected_model:  'a:big',
                disconnect_model: 'a:big',
                on_failure: 'cascade',
              },
            },
          },
          fallback_chains: {
            '128gb': {
              workhorse: [
                { model: 'a:big', quality_score: 100 },
                { model: 'b:mid', quality_score: 90 },
              ],
            },
          },
        };
        const configPath = writeConfig(tmpDir, config);
        await withProxy({ configPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' } }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          }, {}, 12000);
          // All upstreams 502 → proxy returns non-2xx (502 or 504, but NOT 200)
          assert(r.status >= 400 && r.status < 600,
            `non-2xx error returned (got ${r.status})`);
          assert(r.status !== 200, `not 200 (got ${r.status})`);
        });
      } finally {
        await a.close().catch(() => {});
        await b.close().catch(() => {});
      }
    }

    // ── Test 4: hard_fail → primary 502 returns clean error, no fallback ────
    console.log('\n4. hard_fail: cascade is gated, error returned even with fallback chain present');
    {
      const primary  = await stubBackend({ failWith: 502 });
      const fallback = await stubBackend(); // would serve if cascade were allowed
      try {
        const config = {
          backends: {
            be_primary:  { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}` },
            be_fallback: { kind: 'anthropic', url: `http://127.0.0.1:${fallback.port}` },
          },
          model_routes: {
            'strict-primary':  'be_primary',
            'strict-fallback': 'be_fallback',
          },
          llm_profiles: {
            '128gb': {
              'judge-strict': {
                connected_model:  'strict-primary',
                disconnect_model: 'strict-primary',
                on_failure: 'hard_fail',
              },
            },
          },
          fallback_chains: {
            '128gb': {
              'judge-strict': [
                { model: 'strict-primary',  quality_score: 100 },
                { model: 'strict-fallback', quality_score: 90 },
              ],
            },
          },
        };
        const configPath = writeConfig(tmpDir, config);
        await withProxy({ configPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' } }, async ({ port }) => {
          const r = await httpJson(port, 'POST', '/v1/messages', {
            model: 'judge-strict',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          }, {}, 8000);
          // hard_fail must error rather than serving from fallback backend
          assert(r.status >= 400 && r.status < 600,
            `hard_fail returns error (got ${r.status})`);
          assertEq(fallback.requests.length, 0,
            `fallback backend NOT called for hard_fail (got ${fallback.requests.length})`);
        });
      } finally {
        await primary.close().catch(() => {});
        await fallback.close().catch(() => {});
      }
    }

    // ── Test 5: cascade vs hard_fail at same scaffold — divergent results ───
    console.log('\n5. cascade vs hard_fail with identical fixture: divergent results');
    {
      const primary  = await stubBackend({ failWith: 502 });
      const fallback = await stubBackend();
      try {
        // Same config but workhorse=cascade and judge-strict=hard_fail
        const config = {
          backends: {
            be_p: { kind: 'anthropic', url: `http://127.0.0.1:${primary.port}` },
            be_f: { kind: 'anthropic', url: `http://127.0.0.1:${fallback.port}` },
          },
          model_routes: {
            'pm': 'be_p',
            'fm': 'be_f',
          },
          llm_profiles: {
            '128gb': {
              workhorse:    { connected_model: 'pm', disconnect_model: 'pm', on_failure: 'cascade' },
              'judge-strict': { connected_model: 'pm', disconnect_model: 'pm', on_failure: 'hard_fail' },
            },
          },
          fallback_chains: {
            '128gb': {
              workhorse:    [{ model: 'pm', quality_score: 100 }, { model: 'fm', quality_score: 90 }],
              'judge-strict': [{ model: 'pm', quality_score: 100 }, { model: 'fm', quality_score: 90 }],
            },
          },
        };
        const configPath = writeConfig(tmpDir, config);
        await withProxy({ configPath, profile: '128gb', mode: 'connected',
          env: { CLAUDE_PROXY_SKIP_VALIDATOR: '1' } }, async ({ port }) => {
          const cascadeRes = await httpJson(port, 'POST', '/v1/messages', {
            model: 'workhorse',
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
          }, {}, 8000);
          const hardFailRes = await httpJson(port, 'POST', '/v1/messages', {
            model: 'judge-strict',
            messages: [{ role: 'user', content: 'hi' }], max_tokens: 5,
          }, {}, 8000);
          assertEq(cascadeRes.status, 200, 'cascade workhorse → 200');
          assert(hardFailRes.status >= 400, `hard_fail judge-strict → error (got ${hardFailRes.status})`);
          // workhorse cascaded (fallback served), judge-strict didn't
          // fallback received exactly one request (from workhorse), not two
          assert(fallback.requests.length === 1,
            `fallback received exactly 1 request (cascade only) (got ${fallback.requests.length})`);
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

main().catch(err => { console.error(err); process.exit(1); });
