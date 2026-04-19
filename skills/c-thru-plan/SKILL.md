---
name: c-thru-plan
description: |
  Agentic plan/wave orchestrator. Breaks any task into a wave-based execution plan,
  drives waves to completion, and tracks state in ${TMPDIR:-/tmp}/c-thru/<repo>/<slug>/.
  Invoked as /c-thru-plan <user intent>.
color: blue
---

# /c-thru-plan — Wave Orchestrator

<!-- Phase 0: Pre-check (state-exists) -->
<!-- Phase 1: Discovery -->
<!-- Phase 2: Plan construction -->
<!-- Phase 3: Plan review loop (max 20 rounds) -->
<!-- Phase 4: Wave loop -->
<!--   plan-orchestrator runs the complete wave (learnings → digests → dispatch → auditor → commit) -->
<!-- Phase 5: Final review -->

## Phase 0 — Pre-check

Compute `SLUG` from the user intent (lowercase, hyphenated, ≤40 chars).

```sh
REPO_BASENAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
PLAN_ROOT="${TMPDIR:-/tmp}/c-thru/$REPO_BASENAME"
PLAN_DIR="$PLAN_ROOT/$SLUG"
```

If `$PLAN_DIR/current.md` exists:
- Prompt user: **resume** (continue from current plan), **restart** (archive + fresh), or **abort**.
- resume: skip to Phase 4, picking up next incomplete wave.
  - Check for any wave dir that has `findings.jsonl` but no matching `Wave: <NNN>` git commit via `git log --grep="Wave: <NNN>"` — if found, offer to re-run that wave.
- restart: move `$PLAN_DIR` to `$PLAN_DIR.archived.<timestamp>`, then proceed as fresh.
- abort: exit.

If fresh: `mkdir -p $PLAN_DIR/waves $PLAN_DIR/discovery $PLAN_DIR/plan/snapshots $PLAN_DIR/review`.

## State model

- `current.md` — mutable plan state. Written only by planner (Modes 1/2/3). Read by every other phase via its INDEX.md.
- `INDEX.md` — companion to current.md; `<section>: <start>-<end>` per line.
- `waves/<NNN>/` — ephemeral per-wave artifacts (wave.json, digests, outputs, findings, verify.json, decision.json, artifact.md, replan-brief.md, wave-summary.md, INDEX.md). Write-once per wave.
- `plan/snapshots/p-<NNN>.md` — historical snapshot post-commit.
- `journal.md` — append-only event log.
- `learnings.md` + `learnings.INDEX.md` — wiki-style cross-wave improvements. Refreshed by plan-orchestrator (step 1) at start of each wave.
- `meta.json` — counters (`revision_rounds`, `status`).

**Invariants:**
- Agents take paths, never inlined content. Returns are ≤20-line STATUS blocks.
- One wave exists at a time. Replan is post-wave.
- `status: complete` items are immutable — no mode ever touches them.
- Driver context holds pointers + STATUS blocks, never full file bodies.

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
  prompt: "mode:      1
           intent:    <user_intent>
           discovery: <context_block_from_discovery>")
```

Planner writes `$PLAN_DIR/current.md`.

## Phase 3 — Plan review loop

<!-- This invokes the c-thru-native agents/review-plan.md (headless, APPROVED/NEEDS_REVISION verdict).
     The skills/review-plan/ skill is a separate interactive human plan-mode tool — not used here. -->
Invoke the `review-plan` **agent** (not the skill) in a loop capped at 20 rounds.
The agent returns a machine-readable verdict (`APPROVED` or `NEEDS_REVISION`).

```
round = 0
while round < 20:
    result = Agent(subagent_type: "review-plan",
                   prompt: "current.md:  $PLAN_DIR/current.md
                            INDEX:       $PLAN_DIR/INDEX.md
                            round:       <round>
                            review_out:  $PLAN_DIR/review/round-<round>.md")

    # Parse verdict: look for literal "APPROVED" or "NEEDS_REVISION" in result
    if result contains "APPROVED":
        break  # proceed to Phase 4

    # NEEDS_REVISION — pass findings path to planner; driver does NOT read findings file
    Agent(subagent_type: "planner",
          prompt: "mode:       2
                   current.md: $PLAN_DIR/current.md
                   INDEX:      $PLAN_DIR/INDEX.md
                   findings:   $PLAN_DIR/review/round-<round>.md")

    # Persist revision count
    update $PLAN_DIR/meta.json: meta.revision_rounds += 1

    round += 1

if round == 20 and no APPROVED received:
    # Escalate — do NOT proceed to Phase 4
    Tell user: "Plan review hit the 20-round cap without APPROVED. Manual intervention required."
    Stop.
```

Proceed to Phase 4 only when the agent returns APPROVED.

## Phase 4 — Wave loop

Determine next wave number `NNN` (next unused `$PLAN_DIR/waves/NNN/` directory, zero-padded to 3 digits).
`mkdir -p $PLAN_DIR/waves/<NNN>/digests $PLAN_DIR/waves/<NNN>/outputs $PLAN_DIR/waves/<NNN>/findings`

```
result = Agent(subagent_type: "plan-orchestrator",
  prompt: "current.md:      $PLAN_DIR/current.md
           INDEX:           $PLAN_DIR/INDEX.md
           learnings:       $PLAN_DIR/learnings.md
           learnings.INDEX: $PLAN_DIR/learnings.INDEX.md
           prior_findings:  [$PLAN_DIR/waves/*/findings.jsonl]
           journal:         $PLAN_DIR/journal.md
           wave_dir:        $PLAN_DIR/waves/<NNN>")
```

Parse result:
- `STATUS=CYCLE` → dependency cycle detected. Print: "Dependency cycle in wave <NNN>: ITEMS=<items list>". Abort loop. Surface wave_dir to user for manual resolution.
- `STATUS=PARTIAL` → crisis finding cut wave short. Print: "Crisis in wave <NNN> — check $PLAN_DIR/waves/<NNN>/failures/ and findings.jsonl". Abort loop. Surface wave_dir to user.
- `STATUS=ERROR` → print `wave_dir` ($PLAN_DIR/waves/<NNN>), abort loop, surface to user
- `VERDICT=continue` or `VERDICT=extend` → increment NNN, loop (next wave)
- `VERDICT=revise` → invoke planner (Mode 2) with replan-brief path, then re-enter Phase 3 review loop:
  ```
  Agent(subagent_type: "planner",
    prompt: "mode:         2
             replan-brief: $PLAN_DIR/waves/<NNN>/replan-brief.md
             brief_INDEX:  $PLAN_DIR/waves/<NNN>/replan-brief.INDEX.md
             current.md:   $PLAN_DIR/current.md
             INDEX:        $PLAN_DIR/INDEX.md
             artifact:     $PLAN_DIR/waves/<NNN>/artifact.md
             findings:     $PLAN_DIR/waves/<NNN>/findings.jsonl
             verify:       $PLAN_DIR/waves/<NNN>/verify.json
             decision:     $PLAN_DIR/waves/<NNN>/decision.json
             journal:      $PLAN_DIR/journal.md
             Verdict:      revise")
  update $PLAN_DIR/meta.json: meta.revision_rounds += 1
  ```
  After planner returns `STATUS: COMPLETE` → re-enter Phase 3 review loop, then Phase 4 (next wave).
- `VERDICT=done` → proceed to Phase 5

## Phase 5 — Final review

When plan-orchestrator returns `VERDICT=done`:

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

If `RECOMMENDATION: needs_items` → invoke planner (Mode 3) with path:
```
Agent(subagent_type: "planner",
  prompt: "mode:           3
           intent:         <original user intent>
           current.md:     $PLAN_DIR/current.md
           INDEX:          $PLAN_DIR/INDEX.md
           final_review:   $PLAN_DIR/final-review.md
           journal:        $PLAN_DIR/journal.md
           journal_offset: <line offset for last 5 entries>")
```
Plan-orchestrator re-runs; gaps → immediately ready items (deps already complete).
Cap: **20 revision rounds total** across all final-review iterations. Escalate to user if cap reached.

## Revision cap

Total plan revision rounds (Phases 3 + 5 combined) capped at **20**. Counter tracked in `$PLAN_DIR/meta.json`:
```json
{ "slug": "<slug>", "revision_rounds": 0, "created": "<iso-timestamp>", "status": "active" }
```
Increment on each review-plan or final-reviewer→planner cycle. At 20: pause and ask user to continue or abort.
