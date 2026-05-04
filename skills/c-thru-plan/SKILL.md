---
name: c-thru-plan
description: |
  Agentic plan/wave orchestrator. Breaks any task into a wave-based execution plan,
  drives waves to completion, and tracks state in ${TMPDIR:-/tmp}/c-thru/<repo>/<slug>/.
  Invoked as /c-thru-plan <user intent>.
color: blue
---

# /c-thru-plan — Wave Orchestrator

<!-- Phase 0: Pre-check (state-exists, contract-version detection) -->
<!-- Phase 1: Discovery -->
<!-- Phase 2: Plan construction (signal=intent, unified planner) -->
<!-- Phase 3: Plan review loop (max 20 rounds) -->
<!-- Phase 4: Wave loop (three-branch: clean / dep_update / outcome_risk) -->
<!--   deterministic pre-processor classifies each transition — zero LLM on clean -->
<!--   planner handles both dep_update and outcome_risk branches -->
<!-- Phase 5: Final review -->

## Phase 0 — Pre-check

Compute `SLUG` from the user intent (lowercase, hyphenated, ≤40 chars).

```sh
REPO_BASENAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
PLAN_ROOT="${TMPDIR:-/tmp}/c-thru/$REPO_BASENAME"
PLAN_DIR="$PLAN_ROOT/$SLUG"
```

If `$PLAN_DIR/current.md` exists:

  **Contract version check:**

  If `.c-thru-contract-version` does NOT exist in `$PLAN_DIR`:
    - Print: "Pre-refactor plan state detected (no contract version marker). This plan was created with the old orchestrator contract (Mode 1/2/3). Options: **drain** (finish remaining waves via legacy path), **discard** (archive + start fresh), or **abort**."
    - Prompt user and wait.
    - discard: move `$PLAN_DIR` to `$PLAN_DIR.archived.<timestamp>`, proceed as fresh.
    - abort: exit.
    - drain: proceed to Phase 4, treating first wave as a recovery wave (accept VERDICT=done from legacy orchestrator).

  If `.c-thru-contract-version` contains `2` (v2 plan — wave.json format):
    - Print: "Legacy v2 plan detected (wave.json format). Contract version 3 uses wave.md. Options: **drain** (finish remaining waves using legacy wave.json code path — harness reads wave.json with readWaveJson() fallback), **discard** (archive + start fresh on v3), or **abort**."
    - Prompt user and wait.
    - drain: proceed to Phase 4; harness automatically reads wave.json as fallback when wave.md is absent (emits deprecation warning to pre-processor.log).
    - discard: move `$PLAN_DIR` to `$PLAN_DIR.archived.<timestamp>`, proceed as fresh.
    - abort: exit.

  If `.c-thru-contract-version` contains `3` (current — wave.md format, resume case):
    - Prompt user: **resume** (continue from current plan), **restart** (archive + fresh), or **abort**.
    - resume: skip to Phase 4, picking up next incomplete wave.
      - Check for any wave dir that has `findings.jsonl` but no matching `Wave: <NNN>` git commit via `git log --grep="Wave: <NNN>"` — if found, offer to re-run that wave.
    - restart: move `$PLAN_DIR` to `$PLAN_DIR.archived.<timestamp>`, then proceed as fresh.
    - abort: exit.

If fresh: `mkdir -p $PLAN_DIR/waves $PLAN_DIR/discovery $PLAN_DIR/plan/snapshots $PLAN_DIR/review`.

## State model

- `current.md` — single source of truth. Two immutable-rule sections: `## Outcome` (written once, never changed) and `## Items` (updated by planner per-wave). `[x]` items are immutable.
- `waves/<NNN>/` — ephemeral per-wave artifacts (wave.md, digests, outputs, findings, verify.json, wave-summary.md). Write-once per wave. `decision.json` and `replan-brief.md` are exception-path only (outcome_risk escalation).
- `plan/snapshots/p-<NNN>.md` + `plan/snapshots/wave-<NNN>.md` — historical snapshot post-commit (current.md + wave.md).
- `journal.md` — append-only event log.
- `learnings.md` — cross-wave improvements; refreshed by planner (step 2 of planner algorithm).
- `meta.json` — counters (`revision_rounds`, `status`).
- `pre-processor.log` — structured log of each wave transition classification.
- `.c-thru-contract-version` — marker file; value `3` = wave.md contract (current); value `2` = legacy wave.json contract; absent = pre-refactor.

**Invariants:**
- Agents take paths, never inlined content. Returns are ≤20-line STATUS blocks.
- One wave executes at a time. Parallel waves annotated (`PARALLEL_WAVES: true`) but deferred to v2.
- `[x]` items are immutable — no agent may modify them.
- Driver context holds pointers + STATUS blocks, never full file bodies.
- Cloud judge is invoked only on `signal=intent` (initial plan) or `outcome_risk` transition.

## Phase 1 — Discovery

**Stage 1 — Reconnaissance (read-only, no agent spawn):**
Read: `CLAUDE.md`, relevant wiki entries, existing source structure, any prior plans in `${TMPDIR:-/tmp}/c-thru/` overlapping the intent.

Write reconnaissance summary to `$PLAN_DIR/discovery/recon.md` (always overwrite fresh — `rm -f` first if it exists):
```markdown
# Reconnaissance — <slug>
## Source structure
<key directories, patterns, and conventions observed>
## Prior plan overlap
<any existing plans relevant to this intent; "none" if absent>
## Known constraints
<CLAUDE.md directives, wiki entities, or invariants that affect the plan>
```
This file is the orchestrator's scratchpad — never cached between runs.

**Stage 2a — Gap advisor:**
Invoke the explore agent to identify what is still unknown:
```
Agent(subagent_type: "explore",
  prompt: "intent:     <original user intent>
           recon_path: $PLAN_DIR/discovery/recon.md
           gaps_out:   $PLAN_DIR/discovery/gaps.md")
```
Wait for `STATUS: COMPLETE`. If `GAPS: 0` (greenfield or fully covered by recon) → skip Stage 2b.

**Stage 2b — Explorer fan-out:**
For each gap listed in `gaps.md`, dispatch one explore agent (read-only, in parallel):
```
Agent(subagent_type: "explore", run_in_background: true,
  prompt: "gap_question: <specific gap question from gaps.md>
           output_path:  $PLAN_DIR/discovery/<gap-slug>.md")
```
Await all explorers (max 60s per agent). Resume with or without results — partial discovery is acceptable; record missing gaps as `assumed` in the plan.

**Stage 3 — Synthesize:**
Merge reconnaissance + discovery summaries into a context block for the planner.
Greenfield projects typically skip Stage 2b; existing-codebase work almost always needs it.

## Phase 2 — Plan construction

```sh
# Write discovery synthesis to disk — never inline large context into prompt
# (agents/planner.md: "Read inputs from paths, never expect file contents inline")
cat $PLAN_DIR/discovery/*.md > $PLAN_DIR/discovery/combined.md 2>/dev/null || true
```

```
Agent(subagent_type: "planner",
  prompt: "signal:     intent
           intent:     <user_intent>
           discovery:  $PLAN_DIR/discovery/combined.md
           current.md: $PLAN_DIR/current.md")
```

Validate planner return — fail-loud on any of:
- (a) `STATUS` not in `{COMPLETE, CYCLE, ERROR}`
- (b) `VERDICT` not in `{ready, done}`
- (c) `VERDICT=ready` but `READY_ITEMS` empty or absent
- (d) `READY_ITEMS` contains item IDs not present in current.md as pending
- (e) `STATUS=CYCLE` but `ITEMS` list absent or empty
- (f) `STATUS=ERROR` but `SUMMARY` absent
- (g) `VERDICT=done` but `READY_ITEMS` non-empty (contradictory)
- (h) `VERDICT=done` but `COMMIT_MESSAGE` present

On validation failure: print the specific rule (a)–(h) and the raw planner return; stop and escalate to user.

On `STATUS=CYCLE`: print "Dependency cycle in initial plan: ITEMS=<items>". Stop. Surface to user for manual resolution.

Write contract version marker:
```sh
echo "3" > $PLAN_DIR/.c-thru-contract-version
```

## Phase 3 — Plan review loop

<!-- This invokes code-reviewer (APPROVED/NEEDS_REVISION verdict expected in response).
     code-reviewer treats plan review as a structural review with approve/reject output. -->
Invoke the `code-reviewer` agent in a loop capped at 20 rounds.

```
# Read persisted counter from disk on entry — guards against Phase-5 re-entry
# resetting a local variable. Initializes to 0 for pre-existing plan dirs
# that lack the key (upgrade path).
meta = read $PLAN_DIR/meta.json
meta.revision_rounds = meta.revision_rounds ?? 0
write $PLAN_DIR/meta.json

while meta.revision_rounds < 20:
    result = Agent(subagent_type: "code-reviewer",
                   prompt: "current.md:  $PLAN_DIR/current.md
                            INDEX:       $PLAN_DIR/INDEX.md
                            round:       <meta.revision_rounds>
                            review_out:  $PLAN_DIR/review/round-<meta.revision_rounds>.md")

    if result contains "APPROVED":
        break  # proceed to Phase 3 aftermath

    # NEEDS_REVISION — pass findings path to planner
    # affected_items: [] = full scope (plan review can affect any pending item)
    Agent(subagent_type: "planner",
          prompt: "signal:       wave_summary
                   wave_summary: $PLAN_DIR/review/round-<meta.revision_rounds>.md
                   affected_items: []
                   current.md:   $PLAN_DIR/current.md
                   learnings.md: $PLAN_DIR/learnings.md")

    # Persist counter to disk before next iteration so Phase-5 re-entry sees the
    # correct cumulative count rather than a reset local variable.
    meta.revision_rounds += 1
    write $PLAN_DIR/meta.json

if meta.revision_rounds >= 20 and no APPROVED received:
    Tell user: "Plan review hit the 20-round cap without APPROVED. Manual intervention required."
    Stop.
```

## Phase 3 aftermath — Re-materialize READY_ITEMS

After APPROVED, compute initial READY_ITEMS for wave 001 without an LLM call:

```
Read $PLAN_DIR/current.md:
  READY_ITEMS = [item IDs where status=pending AND all depends_on entries are [x] or depends_on is empty]
  commit_message = "<imperative summary of first-wave items, ≤72 chars>"
  # Derive commit_message locally from READY_ITEMS descriptions; no planner call needed
```

If no READY_ITEMS found after review (plan complete after review): proceed to Phase 5.

Proceed to Phase 4 with initial READY_ITEMS[] and commit_message.

## Phase 4 — Wave loop

```
loop:
  # Driver creates clean wave directory
  NNN = next unused wave number (zero-padded to 3 digits)
  mkdir -p $PLAN_DIR/waves/<NNN>/digests $PLAN_DIR/waves/<NNN>/outputs $PLAN_DIR/waves/<NNN>/findings

  # Orchestrator executes the wave
  result = Agent(subagent_type: "coder",
    prompt: "current.md:    $PLAN_DIR/current.md
             READY_ITEMS:   [<item-id>, <item-id>, ...]
             commit_message: <commit_message>
             wave_dir:      $PLAN_DIR/waves/<NNN>")

  if result.STATUS == PARTIAL:
    Print: "Partial wave <NNN> — crisis finding cut it short. Check $PLAN_DIR/waves/<NNN>/failures/ and findings.jsonl"
    Abort loop. Surface wave_dir to user.

  if result.STATUS == ERROR:
    Print: "Error in wave <NNN> — check $PLAN_DIR/waves/<NNN>/"
    Abort loop. Surface wave_dir to user.

  # STATUS == COMPLETE: run deterministic pre-processor
  transition = pre_process(result.FINDINGS_PATH, $PLAN_DIR/current.md)

  if transition.type == "clean":
    READY_ITEMS = transition.ready_items
    commit_message = transition.commit_message      # generated by local 7B
    if READY_ITEMS is empty: break → Phase 5        # all items done

  elif transition.type == "dep_update":
    planner_result = Agent(subagent_type: "planner",
      prompt: "signal:        wave_summary
               wave_summary:  <result.FINDINGS_PATH>
               affected_items: <transition.affected_items joined as list>
               current.md:    $PLAN_DIR/current.md
               learnings.md:  $PLAN_DIR/learnings.md")
    # Validate planner-local return (same rules a–h as Phase 2)
    if planner_result.STATUS == ERROR: surface to user; abort
    if planner_result.STATUS == CYCLE:
      Print: "Dependency cycle after dep_update — ITEMS=<ITEMS>"
      Abort loop. Surface to user.
    READY_ITEMS = planner_result.READY_ITEMS
    commit_message = planner_result.COMMIT_MESSAGE
    if planner_result.VERDICT == "done": break → Phase 5

  elif transition.type == "outcome_risk":
    planner_result = Agent(subagent_type: "planner",
      prompt: "signal:         wave_summary
               wave_summary:   <result.FINDINGS_PATH>
               affected_items: <transition.affected_items joined as comma-separated list>
               current.md:     $PLAN_DIR/current.md
               learnings.md:   $PLAN_DIR/learnings.md")
    # Validate planner return (same rules a–h as Phase 2)
    if planner_result.STATUS == ERROR: surface to user; abort
    if planner_result.STATUS == CYCLE:
      Print: "Dependency cycle after outcome_risk planner — ITEMS=<ITEMS>"
      Abort loop. Surface wave_dir to user.
    READY_ITEMS = planner_result.READY_ITEMS
    commit_message = planner_result.COMMIT_MESSAGE
    if planner_result.VERDICT == "done": break → Phase 5

  update $PLAN_DIR/meta.json: meta.wave_count += 1

  # Parallel waves: annotated but not executed in v1
  if planner_result.PARALLEL_WAVES == true:
    log to $PLAN_DIR/pre-processor.log: "parallel waves detected — deferred to v2"
```

## Deterministic pre-processor

Named driver function `pre_process(findings_path, current_md_path)`. Zero LLM cost.

**Algorithm:**

a0. Parse each finding from `findings_path` (JSONL). Validate required fields:
    `{item_id, status, produced, dep_discoveries, outcome_risk, confidence}`.
    - If finding is structurally valid: proceed to steps (a)–(d).
    - If finding is missing required fields but contains `item_id` and `status` (migration shim):
      Normalize to `{outcome_risk: false, dep_discoveries: [], confidence: "low"}`.
      Log as `shim-normalized` in `$PLAN_DIR/pre-processor.log`.
      Treat as dep_update input (low-confidence).
    - If finding is unrecoverable (missing item_id or status):
      Log as `unrecoverable-rejection` in `$PLAN_DIR/pre-processor.log`.
      Force `transition_type=outcome_risk`.

a. Buffer dep_discovery updates for affected pending items (target_resources, notes).

b. Buffer `[x]` markings for completed items (wave: NNN, produced: [paths]).

   Write current.md atomically (tmp→rename) with both (a) and (b) applied together — never partial-write.
   After writing current.md, regenerate INDEX.md: scan section headings in current.md, record `<section>: <start>-<end>` one per line. INDEX.md must be fresh before any agent call that receives it as input.

c. Compute newly-ready items: items where all `depends_on` entries are now `[x]`.

d. Classify TRANSITION_TYPE:
   - `clean`:        no outcome_risk findings, no shim-normalized findings,
                     all dep_discoveries have confidence=high
   - `dep_update`:   any dep_discovery has confidence=low (including shim-normalized),
                     OR dep_discovery type requires semantic judgment (new item, dep removal)
   - `outcome_risk`: any finding has outcome_risk=true, OR any finding was unrecoverable

e. If TRANSITION_TYPE == clean: generate commit_message locally using commit-message-generator tier
   (local 7B, templated from READY_ITEMS descriptions).

f. Compress findings: strip prose_notes, write compressed copy to `$PLAN_DIR/waves/<NNN>/wave_summary_compressed.md`.

g. Check PARALLEL_WAVES annotation in current.md items (v1: log only, always serial).

h. Emit structured log line to `$PLAN_DIR/pre-processor.log`:
   `{wave, transition_type, reason, dep_discoveries_count, low_confidence_count, outcome_risk_items, ready_items, rejected_findings}`

**Return:**
```
{
  type:                  "clean" | "dep_update" | "outcome_risk",
  ready_items:           [item-id, ...],
  commit_message:        string | null,   # null on dep_update/outcome_risk (planner derives)
  affected_items:        [item-id, ...],  # items whose deps were updated; [] on clean
  findings_compressed:   path,
  rejected_findings:     [path, ...]
}
```

## Phase 5 — Final review

When the wave loop exits (all items done):

```
Agent(subagent_type: "code-reviewer",
  prompt: "intent:         <original user intent>
           current.md:     $PLAN_DIR/current.md
           INDEX:          $PLAN_DIR/INDEX.md
           journal:        $PLAN_DIR/journal.md
           journal_offset: <line offset for last 5 entries>
           review_out:     $PLAN_DIR/final-review.md")
```

If `RECOMMENDATION: complete`:
```sh
ARCHIVE_DIR="$HOME/.claude/c-thru-archive/$SLUG-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ARCHIVE_DIR"
cp "$PLAN_DIR/current.md" "$PLAN_DIR/journal.md" "$PLAN_DIR/learnings.md" "$PLAN_DIR/final-review.md" "$ARCHIVE_DIR/" 2>/dev/null || true
cp -r "$PLAN_DIR/plan/snapshots" "$ARCHIVE_DIR/" 2>/dev/null || true
echo "Plan archived to: $ARCHIVE_DIR"
```
Print summary to user.

If `RECOMMENDATION: needs_items`:
```
# Planner adds gap items
planner_result = Agent(subagent_type: "planner",
  prompt: "signal:        final_review
           final_review:  $PLAN_DIR/final-review.md
           current.md:    $PLAN_DIR/current.md
           learnings.md:  $PLAN_DIR/learnings.md")
# Read from disk before incrementing — Phase 5 may be re-entered after context compaction
# (meta variable from Phase 3 would be stale). ?? 0 guard for upgrade path.
meta = read $PLAN_DIR/meta.json
meta.revision_rounds = meta.revision_rounds ?? 0
meta.revision_rounds += 1
write $PLAN_DIR/meta.json

# Re-materialize READY_ITEMS from updated current.md (same logic as Phase 3 aftermath)
READY_ITEMS = [items where status=pending and all depends_on are [x]]
commit_message = <derived locally>
```
Re-enter Phase 4 loop. Cap: **20 revision rounds total** across all iterations.

## Revision cap

Total plan revision rounds (Phases 3 + 5 combined) capped at **20**. Counter tracked in `$PLAN_DIR/meta.json`:
```json
{ "slug": "<slug>", "revision_rounds": 0, "wave_count": 0, "created": "<iso-timestamp>", "status": "active" }
```
Increment on each review-plan or final-reviewer→planner cycle. At 20: pause and ask user to continue or abort.

## Complexity & deployability contract

**Complexity evaluation** runs in the coder (wave executor) Step 2.5, before wave emission. The coder derives a `COMPLEXITY: trivial|moderate|complex` signal from structural scope only (files affected, shared interfaces, external consumers):

| Complexity | Deployability guard |
|---|---|
| `trivial` | skipped |
| `moderate` | runs per wave |
| `complex` | runs per wave |

**Absent `COMPLEXITY`** (old orchestrator output) → treated as `moderate` (safe default).

**Per-wave self-questions** (asked before emitting each wave — any complexity):
- *Does this wave need migration?* → `MIGRATION_REQUIRED: yes` + dedicated migration wave inserted before this one
- *Could this wave break CI?* → `ci_risk: yes` annotated in wave frontmatter

**CI-safety final wave**: appended as the last wave of the plan whenever any wave carries `ci_risk: yes` — not gated on complexity. Runs the project's test/lint/build commands from `TEST_FRAMEWORKS`; falls back to `node --check`. Items dispatched to `tester` + `code-reviewer` tiers.

**State migration** (`MIGRATION_REQUIRED`): triggered by the per-wave self-question, not by complexity tier. Any plan can get a migration wave — even a trivial one if it touches stored data. Absent field → `no`.

**Test/CI reconnaissance** (`TEST_FRAMEWORKS`): the `explore` agent emits a `TEST_FRAMEWORKS:` line in its STATUS block: comma-separated `{framework}@{test-dir}[+ci:{system}]` tokens, or `none`. Forwarded into every worker digest's `## Mission context` section. Absent → `none` (no behavioral change).

**Deployability guard**: for each wave (moderate/complex only), the coder checks that no item imports a module produced by a later wave. On violation: collapse the pair into the same wave. Logged to `$wave_dir/cascade/deployability.jsonl`.
