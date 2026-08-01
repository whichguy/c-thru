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
// "Registered" means an uncommented command line contains the canonical
// "$REPO_DIR/test/<filename>" path. A structured
// "# EXCLUDED: <filename> — <reason>" line is the only alternative. A filename
// in an unrelated comment is deliberately insufficient.
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
  'offload-artifact-fixtures.js', // deterministic generated-artifact helper
]);

// Non-recursive on purpose: subdirs (e.g. stubs/) are fixtures/tooling, not suites.
const files = fs.readdirSync(TEST_DIR, { withFileTypes: true })
  .filter(e => e.isFile() && /\.(js|sh)$/.test(e.name))
  .map(e => e.name)
  .sort();

function isRegistered(file, source = RUN_ALL) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const invocation = new RegExp(
    String.raw`^\s*(?:node|bash)\s+["']?\$REPO_DIR/test/${escaped}["']?(?:\s|$)`,
  );
  return source.split(/\r?\n/).some(line =>
    !line.trimStart().startsWith('#') && invocation.test(line));
}

function isStructuredExclusion(file, source = RUN_ALL) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exclusion = new RegExp(
    String.raw`^# EXCLUDED:\s*${escaped}\s+(?:—|--|-|:)\s+\S`,
  );
  return source.split(/\r?\n/).some(line => exclusion.test(line));
}

console.log(`run-all-coverage: ${files.length} runnable files in test/ (${INFRA_ALLOWLIST.size} infra-allowlisted)\n`);

for (const file of files) {
  if (INFRA_ALLOWLIST.has(file)) continue;
  assert(isRegistered(file) || isStructuredExclusion(file),
    `${file}: registered by canonical test path or named in a structured EXCLUDED line with a reason`);
}

const invented = 'invented-never-run.test.js';
assert(
  !isRegistered(invented, `# TODO mention ${invented} someday\n`),
  'self-test: an unrelated comment cannot satisfy registration',
);
assert(
  !isStructuredExclusion(invented, `# TODO mention ${invented} someday\n`),
  'self-test: an unrelated comment cannot satisfy exclusion',
);
assert(
  isRegistered(
    invented,
    `run_suite "invented" \\\n  node "$REPO_DIR/test/${invented}"\n`,
  ),
  'self-test: a canonical command path satisfies registration',
);
assert(
  isStructuredExclusion(
    invented,
    `# EXCLUDED: ${invented} — generated manually by an external conformance tool\n`,
  ),
  'self-test: a structured exclusion with a reason satisfies exclusion',
);

// Allowlist hygiene: an allowlisted file that no longer exists is a stale entry.
for (const file of INFRA_ALLOWLIST) {
  assert(files.includes(file) || file === 'run-all.sh',
    `allowlist entry ${file} still exists in test/`);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
