#!/usr/bin/env node
'use strict';

// Regression test for per-session warning dedupe in model-map-validate.
// With C_THRU_SESSION_ID set, the same warning string emitted twice in a
// row should print exactly once. With it unset, both emissions should print.

const fs = require('fs');
const path = require('path');
const { validateConfig } = require('../tools/model-map-validate.js');

// Config with multiple warning-eligible patterns:
//   - placeholder model (`:TODO`) → llm_profiles warning
//   - non-localhost endpoint with no auth → endpoint warning
const badConfig = {
  endpoints: {
    cloudish: { format: 'anthropic', url: 'https://example.com' },
  },
  llm_profiles: {
    coder: { 'best-cloud': 'placeholder:TODO' },
  },
};

function captureWarn(fn) {
  const original = console.warn;
  const captured = [];
  console.warn = (msg) => captured.push(String(msg));
  try { fn(); } finally { console.warn = original; }
  return captured;
}

function cleanupStamp(sid) {
  if (!sid) return;
  const tmp = process.env.TMPDIR || '/tmp';
  try { fs.unlinkSync(path.join(tmp, `c-thru-warned.${sid}`)); } catch {}
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); failures++; }
}

// Case 1: with session id, second call dedupes.
{
  const sid = `test-${process.pid}-${Date.now()}`;
  process.env.C_THRU_SESSION_ID = sid;
  try {
    const first = captureWarn(() => validateConfig(badConfig, []));
    const second = captureWarn(() => validateConfig(badConfig, []));
    assert(first.length > 0, `first call should emit warnings (got ${first.length})`);
    assert(second.length === 0, `second call should emit zero warnings, got ${second.length}: ${JSON.stringify(second)}`);
  } finally {
    cleanupStamp(sid);
    delete process.env.C_THRU_SESSION_ID;
  }
}

// Case 2: without session id, both calls emit (no dedupe).
{
  delete process.env.C_THRU_SESSION_ID;
  const first = captureWarn(() => validateConfig(badConfig, []));
  const second = captureWarn(() => validateConfig(badConfig, []));
  assert(first.length > 0, `standalone first call should emit warnings`);
  assert(second.length === first.length,
    `standalone second call should match first (got ${first.length} then ${second.length})`);
}

if (failures > 0) {
  console.error(`model-map-validate-dedupe: ${failures} failure(s)`);
  process.exit(1);
}
console.log('model-map-validate-dedupe: OK');
