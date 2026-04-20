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
<!--   planner-local handles dep_update (local 27B+); planner handles outcome_risk (cloud) -->
<!-- Phase 5: Final review -->

## Phase 0 — Pre-check

Compute `SLUG` from the user intent (lowercase, hyphenated, ≤40 chars).

```sh
REPO_BASENAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
PLAN_ROOT="${TMPDIR:-/tmp}/c-thru/$REPO_BASENAME"
PLAN_DIR="$PLAN_ROOT/$SLUG"
```

If `$PLAN_DIR/current.md` exists:

  **Contract version check:** If `.c-thru-contract-version` does NOT exist in `$PLAN_DIR`:
    - Print: "Pre-refactor plan state detected (no contract version marker). This plan was created with the old orchestrator contract (Mode 1/2/3). Options: **drain** (finish remaining waves via legacy path), **discard** (archive + start fresh), or **abort**."
    - Prompt user and wait.
    - discard: move `$PLAN_DIR` to `$PLAN_DIR.archived.<timestamp>`, proceed as fresh.
    - abort: exit.
    - drain: proceed to Phase 4, treating first wave as a recovery wave (accept VERDICT=done from legacy orchestrator).

  If `.c-thru-contract-version` exists (resume case):
    - Prompt user: **resume** (continue from current plan), **restart** (archive + fresh), or **abort**.
    - resume: skip to Phase 4, picking up next incomplete wave.
      - Check for any wave dir that has `findings.jsonl` but no matching `Wave: <NNN>` git commit via `git log --grep="Wave: <NNN>"` — if found, offer to re-run that wave.
    - restart: move `$PLAN_DIR` to `$PLAN_DIR.archived.<timestamp>`, then proceed as fresh.
    - abort: exit.

If fresh: `mkdir -p $PLAN_DIR/waves $PLAN_DIR/discovery $PLAN_DIR/plan/snapshots $PLAN_DIR/review`.

## State model

- `current.md` — single source of truth. Two immutable-rule sections: `## Outcome` (written once, never changed) and `## Items` (updated by planner per-wave). `[x]` items are immutable.
- `waves/<NNN>/` — ephemeral per-wave artifacts (wave.json, digests, outputs, findings, verify.json, wave-summary.md). Write-once per wave. `decision.json` and `replan-brief.md` are exception-path only (outcome_risk escalation).
- `plan/snapshots/p-<NNN>.md` — historical snapshot post-commit.
- `journal.md` — append-only event log.
- `learnings.md` — cross-wave improvements; refreshed by planner (step 2 of planner algorithm).
- `meta.json` — counters (`revision_rounds`, `status`).
- `pre-processor.log` — structured log of each wave transition classification.
- `.c-thru-contract-version` — marker file; value `2` indicates refactored contract.

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
Invoke the discovery-advisor to identify what is still unknown:
```
Agent(subagent_type: "discovery-advisor",
  prompt: "intent:     <original user intent>
           recon_path: $PLAN_DIR/discovery/recon.md
           gaps_out:   $PLAN_DIR/discovery/gaps.md")
```
Wait for `STATUS: COMPLETE`. If `GAPS: 0` (greenfield or fully covered by recon) → skip Stage 2b.

**Stage 2b — Explorer fan-out:**
For each gap listed in `gaps.md`, dispatch one explorer (read-only, in parallel):
```
Agent(subagent_type: "explorer", run_in_background: true,
  prompt: "gap_question: <specific gap question from gaps.md>
           output_path:  $PLAN_DIR/discovery/<gap-slug>.md")
```
Await all explorers (max 60s per agent). Resume with or without results — partial discovery is acceptable; record missing gaps as `assumed` in the plan.

**Stage 3 — Synthesize:**
Merge reconnaissance + discovery summaries into a context block for the planner.
Greenfield projects typically skip Stage 2b; existing-codebase work almost always needs it.

## Phase 2 — Plan construction

```
Agent(subagent_type: "planner",
  prompt: "signal:     intent
           intent:     <user_intent>
           discovery:  <context_block_from_discovery>
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
echo "2" > $PLAN_DIR/.c-thru-contract-version
```

## Phase 3 — Plan review loop

<!-- This invokes the c-thru-native agents/review-plan.md (headless, APPROVED/NEEDS_REVISION verdict).
     The skills/review-plan/ skill is a separate interactive human plan-mode tool — not used here. -->
Invoke the `review-plan` **agent** (not the skill) in a loop capped at 20 rounds.

```
round = 0
while round < 20:
    result = Agent(subagent_type: "review-plan",
                   prompt: "current.md:  $PLAN_DIR/current.md
                            INDEX:       $PLAN_DIR/INDEX.md
                            round:       <round>
                            review_out:  $PLAN_DIR/review/round-<round>.md")

    if result contains "APPROVED":
        break  # proceed to Phase 3 aftermath

    # NEEDS_REVISION — pass findings path to planner
    Agent(subagent_type: "planner",
          prompt: "signal:     wave_summary
                   wave_summary: $PLAN_DIR/review/round-<round>.md
                   current.md: $PLAN_DIR/current.md
                   learnings.md: $PLAN_DIR/learnings.md")

    update $PLAN_DIR/meta.json: meta.revision_rounds += 1
    round += 1

if round == 20 and no APPROVED received:
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
  result = Agent(subagent_type: "plan-orchestrator",
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
    planner_result = Agent(subagent_type: "planner-local",
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
      prompt: "signal:        wave_summary
               wave_summary:  <result.FINDINGS_PATH>
               current.md:    $PLAN_DIR/current.md
               learnings.md:  $PLAN_DIR/learnings.md")
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
Agent(subagent_type: "final-reviewer",
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
update $PLAN_DIR/meta.json: meta.revision_rounds += 1

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
