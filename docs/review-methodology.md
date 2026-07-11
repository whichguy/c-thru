# Running a quality-review round

This is a living process doc — edit it in place as practice improves. It does not get
superseded by a dated snapshot the way `docs/*-audit.md` files do; those are *output* of a
round, this is *how to run one*.

**Not this doc:** `skills/review-plan` (reviews one plan document) and `skills/review-fix`
(fix→recheck loop on one diff) are per-artifact loops invoked mid-task. This doc is for a
deliberate, whole-codebase-or-whole-subsystem review campaign — usually multiple agent fan-outs
across a session, ending in one or more commits.

## When to run a round

- After a schema or agent-roster migration (the single most reliable trigger this project has
  seen — every mode-system collapse, schema reshape, or agent-roster change has left stale
  descriptions somewhere; see the "doc/code drift is the default" rule below).
- Before a release or a hand-off.
- Periodically, even absent a trigger — the chronic-failure lesson below shows that problems can
  sit unnoticed for an entire session (or longer) without anyone asking why.
- When a user explicitly asks for "a full review" or "expand test coverage."

## The phases

### Phase 1 — Survey (parallel fan-out)

Split the surface into areas (a subsystem, a file cluster, a doc set — not "one finding each")
and read the **live code**, not prior docs or your own memory of the codebase. A prior doc
describing the architecture is a *hypothesis* to verify, not a source of truth. When a claim
depends on an external fact (a pricing tier, an API's current behavior, a vendor's model
lineup), verify it live (WebSearch/WebFetch) rather than trusting training data — this project
has caught a stale quota citation this way.

### Phase 2 — Adversarial verification (mandatory, no exceptions)

Every raw finding from Phase 1 gets independently re-derived by someone who didn't produce it —
they re-read the actual file:line, reproduce the claimed failure mechanism themselves, and only
then confirm. A finding that can't be independently reproduced doesn't ship. This project has run
this gate dozens of times with a near-100% confirmation rate — the point isn't distrust of the
survey agents, it's that "I read the code and it looks wrong" and "I reproduced the exact failure"
are different confidence levels, and only the second is safe to act on.

### Phase 3 — Grouping & fix dispatch

Group confirmed findings **by file/area**, never one agent per finding. Two reasons: parallel
fixers that don't share a file can never race each other, and a fixer handling several related
findings in one file writes a more coherent diff than three uncoordinated ones would.

**When a file has a concurrent session's uncommitted work-in-progress mixed into it** (this
project routinely has multiple sessions sharing one working tree — see `CLAUDE.md`'s "Concurrent
sessions" section), you cannot `git add` the whole file and you cannot blindly overwrite it. Use
hunk-level patch surgery instead:

1. `git diff <file> | grep -n '^@@'` — list every hunk's boundary.
2. Read each hunk's content and classify it as yours or theirs. In practice hunks from two
   unrelated concurrent edits almost never interleave at the hunk level (verified true across
   every instance of this technique used so far) — if you find one that does, stop and handle
   that hunk by hand rather than trusting the mechanical steps below.
3. Extract the **other session's** hunks (plus the diff header) into a standalone patch file.
4. `git apply -R --check <patch>` to confirm it reverses cleanly against the current working
   tree.
5. `git add <file>` (stages everything, both sessions' changes), then
   `git apply -R --cached <patch>` (reverses just the other session's hunks out of the *index*
   only — the working tree is untouched).
6. Verify: `git diff --cached <file>` shows only your hunks; `git diff <file>` (unstaged) shows
   only theirs; `git show :<file> | node --check -` (or the language-appropriate syntax check) on
   the staged blob confirms it's valid on its own.

This leaves the other session's in-progress work exactly as they left it, uncommitted and
untouched, while your changes land cleanly.

### Phase 4 — Fix + regression test

Every fix ships with a test that **fails against the pre-fix code and passes against the
post-fix code** — don't just add an assertion that happens to pass once the fix is in; verify it
would have caught the bug. See `docs/test-authoring.md` for the mechanical house style.

### Phase 5 — Chronic-failure audit (mandatory, non-skippable)

Before the round is considered done, enumerate every suite that is currently red, or that anyone
has informally called "flaky" or "pre-existing." Each one must be root-caused this round — not
re-labeled "environmental" again — **or** re-justified with fresh, specific evidence (e.g. it's
gated behind a documented, checked-in limitation, like a sandbox-specific note in `AGENTS.md`).

This phase exists because of a direct incident: three suites failed on *every single run* across
an entire multi-round session and were repeatedly waved off as pre-existing/environmental without
anyone actually reproducing why. When finally investigated, both root causes were real, cheap
fixes — one was a sandbox environment variable (`FORCE_COLOR`) corrupting a port-capture through
an ANSI-colorized `console.log`, the other was a shared test helper not scrubbing an ambient
session's real config path out of a spawned child process. Neither would have been found without
treating "pre-existing" as a claim to verify, not a label to trust. See rule 1 below.

### Phase 6 — Open-items handling

A finding that's real but whose correct fix is genuinely ambiguous does not get a guessed patch.
File it as `docs/planning/TODO-<slug>.md` with the evidence trail (what's wrong, what you
checked, why the replacement isn't obvious) so the next person — or the next round — doesn't
have to re-derive the investigation. This project has done this at least twice: two hook scripts
watching for proxy-log event names confirmed (via git archaeology) to no longer exist in the
current code, where guessing a plausible-looking replacement event risked being wrong in a way
that would look fixed but silently stay broken.

### Phase 7 — Commit & wrap-up

Commit per area/cluster rather than one mega-commit when the changes are logically separable.
Update the affected reference doc in the **same commit** as the code fix that made it accurate —
a doc fix that lands in a later, disconnected commit is exactly how docs drift in the first
place. Run the full test suite (not just the suites you touched) plus
`tools/c-thru-contract-check.sh` and `tools/c-thru-hygiene-check.sh` before calling the round
done, and run it a second time if anything in the run looked like it could be a timing flake —
don't let a genuine regression hide behind "probably just contention."

## Rules

These are the anti-patterns this project has actually hit. Follow them by default; deviate only
with a specific reason, not convenience.

1. **Never accept "pre-existing / environmental / flaky" as a final label without reproducing
   the root cause.** The sole exception: a failure already covered by a checked-in, documented
   limitation (e.g. a sandbox constraint noted in `AGENTS.md`) — cite that doc, don't re-invent
   the excuse from scratch.
2. **A finding is "confirmed" only after independent reproduction** by someone other than
   whoever found it (Phase 2). Don't skip this gate because a finding "looks obviously right."
3. **Group fixes by file/area**, never one agent per finding, so parallel fixers can't collide.
4. **A file with mixed concurrent-session WIP gets hunk-level reverse-apply** (Phase 3) — never
   a blind overwrite, never a stash that could clobber someone else's in-progress work.
5. **No fix lands without a regression test that demonstrably fails pre-fix.**
6. **Don't guess a fix when the correct answer is genuinely ambiguous.** File an open TODO with
   the evidence instead (Phase 6) — a wrong guess that looks fixed is worse than an honest gap.
7. **Writing a new test is a discovery step, not just a verification step.** Run every new test
   you write, even when what it turns up is unrelated to the round's stated focus — this project
   found a real, unrelated, repeated bug (a trailing-newline bug in a JSON-escaping fallback
   path, present in 4 call sites across 3 files) purely because writing one coverage test for a
   different hook surfaced it.
8. **Cross-model adversarial review of the plan is standard practice for nontrivial mechanism
   changes**, not an occasional extra — asking a different model family to poke holes in a plan
   before implementing catches assumptions a single model's self-review won't.
9. **Doc/code drift after a migration is the default expected state, not an edge case.** When you
   find one doc describing a deprecated architecture, grep for the same stale vocabulary across
   *every* doc in the repo — this project has repeatedly found the same drift duplicated in
   3-4 unrelated files once it started looking.

## Cross-references

- `docs/test-authoring.md` — mechanical house style for writing the regression tests Phase 4
  requires.
- `docs/test-coverage-audit.md` — tracks WHAT'S untested (a gap list), complementary to this
  doc's process guidance.
- `docs/functionality-verification.md` — per-capability implementation/test verdicts; a natural
  Phase 1 starting point for scoping a survey area.
- `docs/orphan-disposition.md` — the file-level live-vs-dead reverse audit; useful when a Phase 1
  survey needs to first establish which files are even still in use.
- `AGENTS.md` — documented sandbox/environment limitations; check here before spending Phase 5
  effort re-investigating something already known and recorded.
