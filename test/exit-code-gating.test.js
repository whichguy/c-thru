#!/usr/bin/env node
'use strict';
// Exit-gate meta-lint: every Node suite (test/*.test.js) must wire its PROCESS
// EXIT CODE to its FAILURE COUNT, so run-all.sh (which keys purely on the suite's
// exit code) can never paint a suite green while one of its assertions failed.
//
// Why this exists — the P0 bug it would have caught:
//   proxy-runtime-fallback.test.js ended its main() with a BARE `summary();`
//   (return value discarded) followed only by `main().catch(...=>process.exit(1))`.
//   summary() doesn't throw on a failed assertion — it just returns the failed
//   count and logs "N FAILED". With the count discarded, main() resolved
//   normally, the catch never fired, and node exited 0. run-all.sh saw exit 0
//   and marked the whole fallback dimension PASS even though assertions failed.
//
// The fix idiom (used by ~90 sibling suites):
//   const failed = summary(); process.exit(failed > 0 ? 1 : 0);
//
// This lint is precise enough to bite that bug: a suite that calls summary()
// but neither (a) feeds a failure count into process.exit, nor (b) guards a
// non-zero exit on a failure count, nor (c) fails fast (a helper that itself
// process.exit(1)s on the failure branch), is flagged ungated.
//
// It must PASS on the current tree. Genuinely-different harnesses (no
// summary()/assert pattern, or an intentionally fail-fast driver) are in
// ALLOWLIST below, each with a one-line reason.
//
// Run: node test/exit-code-gating.test.js

const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const TEST_DIR = __dirname;

// ── Allowlist: Node-suite-shaped filenames that are intentionally NOT gated on
//    a summary()/failed-count harness. Each needs a one-line reason. Keep this
//    list SHORT — the default expectation is the canonical idiom. ─────────────
const ALLOWLIST = new Map([
  // Bash suite that happens to carry a .js extension (run via `bash` in
  // run-all.sh, NOT `node`). Its only `process.exit(...)` is inside an embedded
  // `node -e` string, not its own gate, so the Node-source heuristics don't
  // apply — exclude it from the Node lint entirely.
  ['agent-router-hook.test.js',
    'bash suite (shebang #!/usr/bin/env bash); run with `bash`, not a Node summary() harness'],
  // Fail-fast live driver: its fail() helper calls process.exit(1) on the FIRST
  // failed check (no summary()/failed-count aggregation). A failed assertion can
  // never exit 0 here — it exits 1 immediately — so it satisfies the intent by a
  // different mechanism than the count-gated idiom.
  ['agent-prompt-hierarchy.test.js',
    'fail-fast driver: fail() → process.exit(1) on first failure; no summary() count to gate'],
]);

// Strip comments WITHOUT a string/regex-aware lexer. A char-by-char state machine
// that strips strings has to disambiguate `/` (division vs. regex literal), and a
// naive one swallows the rest of the file the moment a string/regex contains a
// `'`, `"`, `` ` ``, or `/*` (e.g. the literal globs `agents/*.md` and `/v1/*`
// that appear in test strings, or a regex like `/[:'"`]/`). Instead we use the
// standard NON-GREEDY block-comment regex plus a `//`-to-EOL strip that ignores
// `//` preceded by `:` (so it never eats `http://`):
//   - `/\*[\s\S]*?\*\//` matches a real `/** ... */` doc block but NO-OPS on an
//     unclosed `/*` inside a string glob (no later `*/` ⇒ the match simply fails
//     and the text is left intact — the exact case that broke the state machine).
// The residual risk (two string literals `'/*'` ... `'*/'` wrongly bridged) does
// not occur in this tree, and even if it did the effect is a false FLAG (forces
// a human to allowlist), never a false PASS — gate detection below only ever
// grants a pass on a count/guarded/fail-fast exit, never on a bare literal exit,
// so a `process.exit(7)`/`process.exit(0)` surviving inside a string is harmless.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // /* ... */  (non-greedy, no-ops on unclosed)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');     // // ...  but not the // in http://
}

// A failure-count identifier: the conventional names a suite uses to accumulate
// failed assertions. summary() is the helpers.js aggregator that RETURNS the
// failed count.
const COUNT_TOKEN = String.raw`(?:failed|failures|_failed|exitCode|skippedUnexpected|summary\s*\(\s*\))`;

// (1) Count-fed exit: process.exit( <expr that references a count token> ).
//     Covers `process.exit(failed ? 1 : 0)`, `process.exit(failed > 0 ? 1 : 0)`,
//     `process.exit(summary())`, `process.exit(failed === 0 ? 0 : 1)`,
//     `process.exit(failed || skippedUnexpected ? 1 : 0)`.
const RE_COUNT_EXIT = new RegExp(
  String.raw`process\.exit\(\s*[^)]*${COUNT_TOKEN}[^)]*\)`,
);

// (1b) Resolved-from-runner exit: `main().then(failed => process.exit(failed > 0 ? 1 : 0))`
//      or `.then(() => process.exit(summary() ? 1 : 0))`. Already covered by
//      RE_COUNT_EXIT since the token is inside the exit args; kept explicit for clarity.

// (2) Guarded non-zero exit: `if (failed > 0) process.exit(1)` /
//     `if (failures > 0) { ... process.exit(1) }`. The exit literal is 1, but
//     it is reachable ONLY when the count is non-zero, which is equivalent.
const RE_GUARDED_EXIT = new RegExp(
  String.raw`if\s*\(\s*${COUNT_TOKEN}\s*(?:>\s*0|!==?\s*0|!=\s*0)?\s*\)[\s\S]{0,80}?process\.exit\(\s*1\s*\)`,
);

// (3) Fail-fast helper: an assert/fail helper whose FAILURE branch itself calls
//     process.exit(1). Recognized by a process.exit(1) that is NOT the
//     main().catch tail-handler. We detect the catch-tail separately so a suite
//     that ONLY has the catch-tail exit (the P0 shape) is NOT credited here.
const RE_CATCH_TAIL = /\.catch\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{[\s\S]{0,120}?process\.exit\(\s*1\s*\)/;

// Does the suite even use the summary()/assert harness? If it never calls
// summary() and never declares an assert-style counter, it may be a throw-only
// suite (a thrown error rejects main() and the catch-tail exits 1 — which IS
// correct gating). We only DEMAND count-gating from suites that actually
// aggregate failures via summary().
function usesSummaryHarness(code) {
  return /\bsummary\s*\(\s*\)/.test(code);
}

console.log('exit-code-gating: every Node suite must tie its exit code to its failure count\n');

const files = fs.readdirSync(TEST_DIR, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.test.js'))
  .map(e => e.name)
  .sort();

let scanned = 0;
const flagged = [];

for (const file of files) {
  if (ALLOWLIST.has(file)) continue;
  scanned++;
  const raw  = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
  const code = stripComments(raw);

  const countExit   = RE_COUNT_EXIT.test(code);
  const guardedExit = RE_GUARDED_EXIT.test(code);

  // Fail-fast credit: a process.exit(1) exists that is NOT (only) the catch-tail.
  // Strip the catch-tail handler, then see if any process.exit(1) remains AND the
  // suite does not rely on summary() aggregation (a summary() suite with a stray
  // process.exit(1) elsewhere should still be count-gated).
  const withoutCatchTail = code.replace(RE_CATCH_TAIL, '');
  const hasNonTailExit1  = /process\.exit\(\s*1\s*\)/.test(withoutCatchTail);
  const failFast = hasNonTailExit1 && !usesSummaryHarness(code);

  const gated = countExit || guardedExit || failFast;

  // The decisive precision check: a suite that calls summary() but is NOT
  // count-gated and NOT guarded is the P0 shape — a bare summary() whose result
  // is discarded. Flag it explicitly.
  const baresummaryBug = usesSummaryHarness(code) && !countExit && !guardedExit;

  assert(gated && !baresummaryBug,
    `${file}: exit code is wired to the failure count ` +
    `(count-fed process.exit / guarded if(failed>0) exit / fail-fast). ` +
    (baresummaryBug
      ? `It calls summary() but discards the count — a failed assertion would still exit 0 (the proxy-runtime-fallback P0). ` +
        `Fix: \`const failed = summary(); process.exit(failed > 0 ? 1 : 0);\``
      : `No count-dependent exit found. Add the canonical gate or, if this is a genuinely different harness, allowlist it with a reason.`));

  if (!(gated && !baresummaryBug)) flagged.push(file);
}

// ── Allowlist hygiene: every allowlisted file must still exist ───────────────
for (const file of ALLOWLIST.keys()) {
  assert(fs.existsSync(path.join(TEST_DIR, file)),
    `allowlist entry ${file} still exists in test/`);
}

// ── Self-test: prove the lint actually bites the P0 shape ───────────────────
// A synthetic "bad" suite (bare summary(), only a catch-tail exit) MUST be
// flagged; a synthetic "good" one (count-fed exit) MUST pass. This keeps the
// heuristic honest — if a refactor loosens it into a no-op, this trips.
{
  const BAD = `const { summary } = require('./helpers');
async function main() { summary(); }
main().catch(e => { console.error(e); process.exit(1); });`;
  const GOOD = `const { summary } = require('./helpers');
async function main() { const failed = summary(); process.exit(failed > 0 ? 1 : 0); }
main().catch(e => { console.error(e); process.exit(1); });`;
  const isGated = (src) => {
    const code = stripComments(src);
    const countExit   = RE_COUNT_EXIT.test(code);
    const guardedExit = RE_GUARDED_EXIT.test(code);
    const withoutTail = code.replace(RE_CATCH_TAIL, '');
    const failFast = /process\.exit\(\s*1\s*\)/.test(withoutTail) && !usesSummaryHarness(code);
    const bareBug = usesSummaryHarness(code) && !countExit && !guardedExit;
    return (countExit || guardedExit || failFast) && !bareBug;
  };
  assert(!isGated(BAD),  'self-test: the P0 shape (bare summary() + catch-tail only) is flagged ungated');
  assert(isGated(GOOD),  'self-test: the canonical `const failed = summary(); process.exit(...)` passes');
}

console.log(`\nscanned ${scanned} Node suite(s); ${ALLOWLIST.size} allowlisted; ${flagged.length} flagged`);
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
