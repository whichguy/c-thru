#!/usr/bin/env node
'use strict';
/**
 * Live Anthropic API Coverage Test Suite (opt-in)
 *
 * Counterpart to `test/anthropic-api-coverage.test.js`, which uses a stub
 * backend. This suite hits the real `https://api.anthropic.com` upstream
 * through the proxy so that ⚠️ Tier-2 cells in
 * `docs/anthropic-api-coverage.md` can be flipped to 🔁 (live-verified).
 *
 * Self-skip protocol:
 *   - Skipped (exit 0) unless BOTH `C_THRU_LIVE_ANTHROPIC=1` and
 *     `ANTHROPIC_API_KEY` are set in the environment.
 *
 * What it verifies:
 *   1. GET  /v1/models                              — 200 with non-empty data[]
 *                                                     (NOTE: this endpoint is
 *                                                     synthesized inside the
 *                                                     proxy, NOT passthrough —
 *                                                     so no x-c-thru-passthrough
 *                                                     header expected; included
 *                                                     to prove the proxy is
 *                                                     reachable and the
 *                                                     `anthropic` endpoint is
 *                                                     wired before exercising
 *                                                     true catch-all paths).
 *   2. GET  /v1/organizations/me                    — true catch-all → Anthropic.
 *                                                     200 with `id` if admin
 *                                                     scope granted; 401/403
 *                                                     fallback documents that
 *                                                     auth header was forwarded
 *                                                     and method propagated.
 *                                                     Either way the response
 *                                                     carries x-c-thru-passthrough: 1.
 *   3. DELETE /v1/messages/batches/<bogus-id>       — true catch-all. 404 with
 *                                                     error.type ===
 *                                                     "not_found_error"
 *                                                     (proves DELETE method
 *                                                     propagation through the
 *                                                     catch-all forwarder).
 *                                                     Verified via
 *                                                     x-c-thru-passthrough: 1.
 *   4. anthropic-beta header round-trip on (3)      — request did not 400 on
 *                                                     a benign beta token.
 *
 * Auth: ANTHROPIC_API_KEY is forwarded as the standard `x-api-key` header.
 *
 * Stdlib-only.
 */

const path = require('path');
const {
  assert, assertEq, summary, httpJson, withProxy,
} = require('./helpers');

const LIVE = process.env.C_THRU_LIVE_ANTHROPIC === '1';
const KEY  = process.env.ANTHROPIC_API_KEY;

if (!LIVE || !KEY) {
  console.log('SKIP: live anthropic tests require C_THRU_LIVE_ANTHROPIC=1 and ANTHROPIC_API_KEY');
  process.exit(0);
}

console.log('anthropic-api-coverage-live: real api.anthropic.com via proxy\n');

// Use the shipped config: endpoints.anthropic already points at
// https://api.anthropic.com. No override needed.
const SHIPPED_CONFIG = path.resolve(__dirname, '..', 'config', 'model-map.json');

const ANTHROPIC_VERSION = '2023-06-01';
const BETA_TOKEN        = 'prompt-caching-2024-07-31';

const AUTH_HEADERS = {
  'x-api-key':         KEY,
  'anthropic-version': ANTHROPIC_VERSION,
};

(async () => {
  await withProxy({
    configPath: SHIPPED_CONFIG,
    env: { ANTHROPIC_API_KEY: KEY },
  }, async ({ port }) => {
    // ─── 1. GET /v1/models (proxy-synthesized — sanity / liveness check) ─
    const modelsRes = await httpJson(
      port, 'GET', '/v1/models', null, AUTH_HEADERS, 10000,
    );
    assertEq(modelsRes.status, 200, 'GET /v1/models returns 200 (synthesized)');
    assert(modelsRes.json && Array.isArray(modelsRes.json.data) && modelsRes.json.data.length > 0,
      'GET /v1/models response has non-empty data[]');

    // ─── 2. GET /v1/organizations/me (true catch-all → Anthropic) ────────
    const orgRes = await httpJson(
      port, 'GET', '/v1/organizations/me', null, AUTH_HEADERS, 15000,
    );
    assertEq(orgRes.headers['x-c-thru-passthrough'], '1',
      'GET /v1/organizations/me has x-c-thru-passthrough: 1 (catch-all forwarded)');
    if (orgRes.status === 200) {
      assert(orgRes.json && typeof orgRes.json.id === 'string',
        'GET /v1/organizations/me has id field');
    } else if (orgRes.status === 401 || orgRes.status === 403) {
      // Documented fallback: non-admin keys cannot read /organizations/me.
      // The catch-all still forwarded — passthrough header asserted above
      // proves auth-forwarding + GET method propagation.
      console.log(`  NOTE  /v1/organizations/me returned ${orgRes.status} (key lacks admin scope); passthrough header proves forwarding`);
    } else {
      assert(false, `unexpected /v1/organizations/me status ${orgRes.status} (body: ${orgRes.bodyText.slice(0,200)})`);
    }

    // ─── 3. DELETE /v1/messages/batches/<bogus> + anthropic-beta round-trip
    const delRes = await httpJson(
      port, 'DELETE', '/v1/messages/batches/msgbatch_does_not_exist_xyz123',
      null,
      Object.assign({}, AUTH_HEADERS, { 'anthropic-beta': BETA_TOKEN }),
      15000,
    );
    assertEq(delRes.headers['x-c-thru-passthrough'], '1',
      'DELETE response has x-c-thru-passthrough: 1 (method propagated through catch-all)');
    // Beta header round-trip: Anthropic accepts unknown beta tokens silently
    // on non-corresponding endpoints. A 400 here would mean the proxy
    // mangled the header en route.
    assert(delRes.status !== 400,
      'DELETE with anthropic-beta did not 400 (header round-tripped cleanly)');
    assertEq(delRes.status, 404,
      'DELETE /v1/messages/batches/<bogus> returns upstream 404');
    assert(delRes.json && delRes.json.error && delRes.json.error.type === 'not_found_error',
      'DELETE 404 body has error.type === "not_found_error" (upstream Anthropic shape)');
  });

  process.exit(summary());
})().catch(err => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
