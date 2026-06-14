#!/usr/bin/env node
'use strict';
// Gate-completeness validator: every artifact the git pre-commit hook RUNS must
// also be a registered suite in test/run-all.sh (the pre-push net).
//
// Why: the pre-commit gate and the full suite silently diverged once already —
// the gate ran the contract checker against the live repo only, while the suite
// (test/c-thru-contract-check.test.sh) exercised the REPO_DIR rewrite that
// actually exposed a file-absent-guard gap. A deterministic regression slipped
// the gate and was caught only by a manual run-all x3. This test makes the
// binding fail-closed: the gate can never run a check the suite doesn't also
// run, so "green commit" can never again mean less than "green suite".
//
// Direction is intentional — gate ⊆ suite (the safe direction). Combined with
// run-all-coverage (every test file ∈ suite), the gate can never be stricter
// than the suite and the suite can never omit a test file.
//
// "Referenced" = the artifact's repo-relative path appears in run-all.sh as a
// delimited token (same convention as run-all-coverage.test.js).
//
// Run: node test/gate-coverage.test.js

const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const REPO_DIR   = path.join(__dirname, '..');
const HOOKS_DIR  = path.join(REPO_DIR, '.githooks');
const PRECOMMIT  = path.join(HOOKS_DIR, 'pre-commit');
const PREPUSH    = path.join(HOOKS_DIR, 'pre-push');
const RUN_ALL_SH = path.join(__dirname, 'run-all.sh');

// Same delimited-token match as run-all-coverage.test.js: a token must be
// bounded by start/end or a non-[word.-/] char so tools/c-thru doesn't get
// credited by tools/c-thru-contract-check.sh appearing in the file.
function isReferenced(token, haystack) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.-])${escaped}([^\\w.-]|$)`, 'm').test(haystack);
}

// Repo-relative tools/* and test/* paths the hook actually invokes (config/*.json
// data args are excluded — they are inputs, not suites). $REPO_ROOT/tools/c-thru
// and $REPO_ROOT/tools/claude-proxy are extensionless, hence the [\w.-]* tail.
function invokedArtifacts(hookSrc) {
  const re = /\$REPO_ROOT\/((?:tools|test)\/[\w][\w.-]*)/g;
  return [...new Set([...hookSrc.matchAll(re)].map(m => m[1]))].sort();
}

console.log('gate-coverage: pre-commit/pre-push artifacts must be registered suites in run-all.sh\n');

// ── Existence: absent hooks dir is a clean skip; a present dir with no
//    pre-commit is a regression (the hook was renamed or deleted) ────────────
if (!fs.existsSync(HOOKS_DIR)) {
  console.log('  SKIP  .githooks/ not present — no gate to validate (exit 0)');
  process.exit(0);
}
assert(fs.existsSync(PRECOMMIT),
  '.githooks/ exists → .githooks/pre-commit must exist (a removed/renamed hook is itself a regression)');
if (!fs.existsSync(PRECOMMIT)) {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const preCommitSrc = fs.readFileSync(PRECOMMIT, 'utf8');
const runAll       = fs.readFileSync(RUN_ALL_SH, 'utf8');

// ── pre-commit ⊆ run-all: every artifact the gate runs is a registered suite ──
const artifacts = invokedArtifacts(preCommitSrc);
assert(artifacts.length > 0,
  'pre-commit invokes at least one tools/ or test/ artifact (extraction sanity)');
for (const art of artifacts) {
  assert(isReferenced(art, runAll),
    `pre-commit artifact "${art}" is a delimited token in run-all.sh (register it via run_suite so the suite is never looser than the gate)`);
}

// ── pre-push, if present, must drive the full suite ──────────────────────────
if (fs.existsSync(PREPUSH)) {
  const prePushSrc = fs.readFileSync(PREPUSH, 'utf8');
  assert(isReferenced('run-all.sh', prePushSrc),
    'pre-push invokes test/run-all.sh (the broad hermetic net)');
}

// ── Named critical subset: the checks P0 added must stay gated at commit ──────
for (const must of ['tools/c-thru-contract-check.sh', 'test/contract-check-guards-bite.test.sh']) {
  assert(isReferenced(must, preCommitSrc),
    `pre-commit still runs "${must}" (a future edit must not silently drop the contract gate)`);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
