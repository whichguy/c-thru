# Grok Review Converge: c-thru plan-visibility subsystem (code, tests, docs, logic flows, corner cases)

**Test command:** `node test/plan-state-lib.test.js && node test/plan-dashboard.test.js && bash test/c-thru-plan-visibility-hook.test.sh && bash tools/sync-plugin-bundle.sh --check`
**Started:** 2026-07-12          **Status:** active
**Round counter:** 1          <!-- derived; must match Log -->
**Consecutive clean rounds:** 0

## Scope note
Narrowed target = the plan-visibility subsystem landed at baseline commit `fa51501`:
`tools/plan-state-lib.js`, `tools/plan-dashboard.html`, `tools/c-thru-plan-visibility-hook.sh`,
`tools/c-thru-plan-harness.js` (exported parsers), `skills/plan-page/SKILL.md`, the 3 tests
(`test/plan-{state-lib,dashboard}.test.js`, `test/c-thru-plan-visibility-hook.test.sh`),
plus the proxy endpoints `/c-thru/plan` + `/c-thru/plan/dashboard` (already committed at HEAD).

**Excluded pre-existing dirty paths (Round 5 concurrent workstream — NEVER stage/commit/revert these):**
`AGENTS.md`, `CLAUDE.md`, `docs/env-vars.md`, `docs/journaling.md`,
`docs/planning/TODO-round5-continuation.md`, `tools/claude-proxy`, `tools/model-map-resolve.js`,
`tools/model-map-validate.js`, and their `plugins/c-thru/` mirrors, `test/cli-e2e-flags.test.js`,
`test/model-map-validate.test.js`, `test/proxy-quality.test.js`. CHANGED_PATHS each round is
computed as (dirty paths) MINUS this set MINUS `GROK_CONVERGE.md`. The dirty-tree guard is
satisfied by treating this set as the known baseline, not fresh dirt.

**Plan-review augmentation (per user goal):** Phase 4 uses THREE critics, not one — (a) the
resumed Phase-1 Grok reviewer, (b) an independent fresh Grok agent, (c) Codex (read-only). All
three critiques are incorporated natively before implementing.

## Stop-condition tracking
- consecutive-no-progress: 0
- consecutive-same-error: 0 (signature: none)

## Log
### Round 1 — 2026-07-12
**Review (Grok):** 11 material, 5 minor (5 dimensions covered: code correctness, test coverage,
docs, logic-flow, corner cases). Full findings: `plugins/c-thru` untouched, target =
tools/plan-state-lib.js, plan-dashboard.html, c-thru-plan-visibility-hook.sh, SKILL.md.
**Material findings:**
- empty-`newTodos` truthiness [`plan-state-lib.js:157`] — logic-flow (later DISPROVEN — no-op, see plan review)
- snapshot-create busy-loop on non-EEXIST failure [`c-thru-plan-visibility-hook.sh:76-81`] — fail-open/corner
- over-eager native↔wave join by repo-basename [`plan-state-lib.js:284-293`] — logic-flow (later FILED AS OPEN ITEM — ambiguous, no correct fix within scope)
- reference-unaware snapshot prune [`c-thru-plan-visibility-hook.sh:136-138`] — corner
- index-based dashboard plan selection [`plan-dashboard.html:88-91,134`] — logic-flow
- no prune tests, no join-mismatch fixture, no XSS unit, no jq-absent node-path test, no /plan-page test — test coverage (5 items)
- `plan_page:false` opt-out undocumented; `GET /c-thru/plan` API undocumented — docs (2 items)
**Git-history check:** first commit of this feature (`fa51501`, staged as review baseline this round by
explicit pathspec, leaving a concurrent Round-5 workstream's dirty `claude-proxy`/`model-map-*` files
untouched). No prior grok-review-converge history to build on or avoid repeating.
**Plan:** F2a bounded-retry+exit-before-write on snapshot-create exhaustion; F2b reference-aware prune
(union of newest-50, refs in both events.ndjson + events.1.ndjson, grace-window floor); F3a join-stable
namespaced dashboard-selection identity (native:<id> / wave:<slug>, match either); F4b-d doc fixes
(state-API doc, fictional port-default fix, note-key wording); F5 regression tests for F2a/F2b/F3a +
note-key attach test. F1a (todos truthiness) and F1b (join) DROPPED from implementation.
**Plan review (Grok + Grok + Codex, 3 critics):** Resumed Grok reviewer: F1a is a no-op (`[]` is truthy
in JS, existing test already proves fallback wins); F1b's naive "exactly 1+1" guard breaks the green
`repo-alpha` 2-native+2-wave fixture (test asserts a join) — no correct fix possible without a wave-schema
session/cwd field that doesn't exist; F2b must union `events.ndjson` ∪ `events.1.ndjson` refs, not just
the live file; F3a needs an exact composite identity, not ad-hoc. Fresh independent Grok: confirmed F1a
no-op and F1b regression risk independently; flagged F4a's doc target (`docs/env-vars.md`) was itself in
the Round-5-excluded set — relocated to SKILL.md; flagged several F5 tests (XSS, jq-masked) wouldn't
actually fail pre-fix — reclassified as optional coverage, not regression claims. Codex (independent,
retried once after first attempt wedged — pid died mid-`verifying`, no dead-PID reaper, known collision
class): confirmed F1a/F1b drop; caught a genuine residual race in F2b (snapshot-create + event-append are
lock-free, so re-scan-before-`rm` alone doesn't close the window on a delayed concurrent writer) — fixed
with a 30s grace-period floor; caught a genuine collision risk in F3a's bare snapshot-id-OR-slug identity
(a wave slug can equal a snapshot id) — fixed with namespaced `native:`/`wave:` keys matched independently.
All three critiques incorporated natively into plan v3 before implementation (see
`/Users/dadleet/.claude/jobs/7d277970/tmp/round1-plan.md`).
**Implementation:** codex-worker, bounded brief scoped to 8 files (3 edited + 2 new docs + 3 test
files, + 3 plugin mirrors via sync-plugin-bundle.sh). Applied F2a (50-attempt bounded snapshot-create
retry, exit-before-any-write on exhaustion), F2b (reference-aware prune across events.ndjson ∪
events.1.ndjson with a 30s mtime grace floor closing the lock-free-append race Codex flagged), F3a
(namespaced `native:<id>`/`wave:<slug>` join-stable dashboard selection, selectedIndex-based render,
escaped option values), F4a/b/c/d (state-API doc, fictional-port-default fix, note-key wording,
plan_page:false doc), F5 regression tests, and filed the join-identity open item as a TODO doc (no
guessed code fix). Round-5-forbidden files verified untouched (content-identical diff, only the
plugin-bundle sync harmlessly re-stamped 3 already-dirty mirrors with unchanged content).
**Test result:** PASS — re-ran natively (not just trusting the worker's sandboxed report):
`node test/plan-state-lib.test.js` 20/20, `node test/plan-dashboard.test.js` 16/16,
`bash test/c-thru-plan-visibility-hook.test.sh` all pass (incl. 4 new F2a assertions, 4 new F2b
assertions), `bash tools/sync-plugin-bundle.sh --check` clean.
**Outcome:** fixed
**Error signature:** none
**Learnings:** The single highest-value moment this round was cross-model plan review catching two
would-be regressions before implementation: F1a (empty-`newTodos` truthiness) looked like a real bug
in isolation but is a no-op in JS (`[]` is truthy — both the "buggy" and "fixed" forms behave
identically for arrays), which the fresh independent Grok reviewer caught by re-deriving from first
principles rather than trusting the original review; F1b's naive "exactly 1 native + 1 wave" join
guard would have broken the project's own green baseline test (`repo-alpha` with 2 natives + 2 waves
asserts a join), a fact only surfaced by explicitly reading git-history/existing-test context in Phase
3 before finalizing the plan. Codex's fresh-file-scoped retry (after its first attempt wedged — dead
PID under a "verifying" status with no reaper, a known collision class) added real value beyond the
two Grok passes: it caught a genuine residual concurrency race in the F2b prune design (lock-free
snapshot-create + event-append means a re-scan-before-delete alone doesn't close the window on a
just-created, not-yet-referenced snapshot from a concurrent writer — fixed with a 30s grace floor) and
a genuine key-collision risk in the F3a identity design (a wave slug can equal a snapshot id — fixed
with `native:`/`wave:` namespacing). Three independent critics each surfaced at least one finding the
others missed, validating the "no single model's self-review is enough for a nontrivial mechanism
change" rule. Process learning: dispatching Codex with a narrow, file-scoped, question-limited prompt
on retry (vs. the original broad "critique this plan" framing) resolved in ~2 minutes what had wedged
after ~15 minutes on the first, broader-scoped attempt — tight scoping isn't just about correctness,
it materially reduces the odds of hitting the review-agent's own reasoning-time ceiling.
**Consecutive clean rounds after this entry:** 0
**Committed:** yes
**Notes:** Open item filed this round (not a guessed fix): `docs/planning/TODO-plan-visibility-join-identity.md`
— native↔wave join mispairs concurrent same-repo-basename sessions; correct fix needs wave manifests to
carry cwd/session_id (schema change, out of scope). Deferred minors: title-in-fences, Number.isFinite
numeric-string rejection, readTail UTF-8 boundary split, single-generation event rotation (now
lower-risk since F2b protects both event files' refs), outer-catch silent all-plans loss (intended
fail-open). Codex attempt #1 wedged (task-mriphs0s-fb5mjf, pid 16668 died silently while status stayed
"running" ~15min) — retried fresh per policy, retry succeeded in ~2min with a tighter, file-scoped prompt.
