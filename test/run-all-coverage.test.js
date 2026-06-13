#!/usr/bin/env node
'use strict';
// Registry-completeness validator: every runnable file in test/ must be
// REFERENCED in test/run-all.sh — registered via run_suite (env-gated if it
// needs creds/proxy) or named in an EXCLUDED comment with a reason.
//
// Why: a test that exists but never runs is a guard whose failure mode is
// silence — the same master pattern as the disarmed pre-commit hook. 14
// runnable files (including a pure regression test that simply never got
// registered) sat orphaned in test/ until the 2026-06 registry audit. This
// makes the registry fail-closed: you cannot add a test file without either
// wiring it in or writing down, next to the registry itself, why not.
//
// "Referenced" = the bare filename appears in run-all.sh as a delimited token.
// Exclusions therefore live IN run-all.sh as the existing comment convention —
// one source of truth, impossible to exclude without writing a reason next to
// the filename.
//
// Run: node test/run-all-coverage.test.js

const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const TEST_DIR = __dirname;
const RUN_ALL = fs.readFileSync(path.join(TEST_DIR, 'run-all.sh'), 'utf8');

// Infra files that are not suites — allowlisted here, with the reason.
const INFRA_ALLOWLIST = new Set([
  'run-all.sh',           // the registry itself
  'helpers.js',           // shared Node test helpers, required by suites
  'helpers.sh',           // shared shell test helpers, sourced by suites
  'agent-prompt-unit.js', // manual CLI driver (invoked by a human or by run-hierarchy-e2e.sh)
]);

// Non-recursive on purpose: subdirs (stubs/, supervisor-benchmark/) are
// fixtures/tooling, not suites.
const files = fs.readdirSync(TEST_DIR, { withFileTypes: true })
  .filter(e => e.isFile() && /\.(js|sh)$/.test(e.name))
  .map(e => e.name)
  .sort();

// Delimited-token match so model-map-validate.test.js isn't credited by
// model-map-validate-dedupe.test.js appearing in the registry.
function isReferenced(file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.-])${escaped}([^\\w.-]|$)`, 'm').test(RUN_ALL);
}

console.log(`run-all-coverage: ${files.length} runnable files in test/ (${INFRA_ALLOWLIST.size} infra-allowlisted)\n`);

for (const file of files) {
  if (INFRA_ALLOWLIST.has(file)) continue;
  assert(isReferenced(file),
    `${file}: referenced in run-all.sh — register with run_suite (env-gated if it needs creds/proxy) or add an EXCLUDED comment naming the file with a reason`);
}

// Allowlist hygiene: an allowlisted file that no longer exists is a stale entry.
for (const file of INFRA_ALLOWLIST) {
  assert(files.includes(file) || file === 'run-all.sh',
    `allowlist entry ${file} still exists in test/`);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
