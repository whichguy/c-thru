---
name: c-thru-plan
description: |
  Agentic plan/wave orchestrator. Breaks any task into a wave-based execution plan,
  drives waves to completion, and tracks state in .c-thru/plans/<slug>/.
  Invoked as /c-thru-plan <user intent>.
color: blue
---

# /c-thru-plan — Wave Orchestrator

<!-- Phase 0: Pre-check (state-exists) -->
<!-- Phase 1: Discovery -->
<!-- Phase 2: Plan construction -->
<!-- Phase 3: Plan review loop (max 20 rounds) -->
<!-- Phase 4: Wave loop -->
<!--   Phase 4a: plan-orchestrator → wave.json -->
<!--   Phase 4b: Prepare (digests) -->
<!--   Phase 4c: Execute (parallel agent dispatch) -->
<!--   Phase 4d: Consolidate -->
<!--   Phase 4e: Verify -->
<!--   Phase 4f: Reflect + Determine (auditor) -->
<!--   Phase 4f.5: wave-synthesizer (extend/revise only) -->
<!--   Phase 4g: Commit (update current.md, journal) -->
<!-- Phase 5: Final review -->

## Phase 0 — Pre-check

Compute `SLUG` from the user intent (lowercase, hyphenated, ≤40 chars).
Set `PLAN_DIR = .c-thru/plans/<SLUG>`.

If `$PLAN_DIR/current.md` exists:
- Prompt user: **resume** (continue from current plan), **restart** (archive + fresh), or **abort**.
- resume: skip to Phase 4, picking up next incomplete wave.
- restart: move `$PLAN_DIR` to `$PLAN_DIR.archived.<timestamp>`, then proceed as fresh.
- abort: exit.

If fresh: `mkdir -p $PLAN_DIR/waves $PLAN_DIR/discovery $PLAN_DIR/plan/snapshots`.

## State model

- `current.md` — mutable plan state. Written only by planner (Modes 1/2/3). Read by every other phase via its INDEX.md.
- `INDEX.md` — companion to current.md; `<section>: <start>-<end>` per line.
- `waves/<NNN>/` — ephemeral per-wave artifacts (wave.json, digests, outputs, findings, verify.json, decision.json, artifact.md, replan-brief.md, INDEX.md). Write-once per wave.
- `plan/snapshots/p-<NNN>.md` — historical snapshot post-commit.
- `journal.md` — append-only event log.
- `learnings.md` + `learnings.INDEX.md` — wiki-style cross-wave improvements. Refreshed by `learnings-consolidator` at start of each wave.
- `meta.json` — counters (`revision_rounds`, `status`).

**Invariants:**
- Agents take paths, never inlined content. Returns are ≤20-line STATUS blocks.
- One wave exists at a time. Replan is post-wave.
- `status: complete` items are immutable — no mode ever touches them.
- Driver context holds pointers + STATUS blocks, never full file bodies.

## Phase 1 — Discovery

**Stage 1 — Reconnaissance (read-only, no agent spawn):**
Read: `CLAUDE.md`, relevant wiki entries, existing source structure, any prior `.c-thru/plans/` overlapping the intent.
Build an internal context summary. Do not write any files in this stage.

**Stage 2 — Gap check:**
Self-interrogate: "What do I still not know that would materially change the plan?"
If gaps exist, dispatch lightweight discovery agents (read-only):
```
Agent(subagent_type: "explorer", run_in_background: true,
  prompt: "<specific gap question>",
  // Each explorer writes its summary to a unique path:
  // .c-thru/plans/<slug>/discovery/<gap-slug>.md
)
```
Await all explorers (max 60s per agent). Resume with or without results.

**Stage 3 — Synthesize:**
Merge reconnaissance + discovery summaries into a context block for the planner.
Greenfield projects typically skip Stage 2; existing-codebase work almost always needs it.

## Phase 2 — Plan construction

```
Agent(subagent_type: "planner",
  prompt: "<user_intent>\n\n<context_block_from_discovery>")
```

Planner writes `.c-thru/plans/<slug>/current.md`.

## Phase 3 — Plan review loop

Invoke the `review-plan` **agent** (not the skill) in a loop capped at 20 rounds.
The agent returns a machine-readable verdict (`APPROVED` or `NEEDS_REVISION`).

```
round = 0
while round < 20:
    result = Agent(subagent_type: "review-plan",
                   prompt: "current.md: .c-thru/plans/<slug>/current.md
                            INDEX:      .c-thru/plans/<slug>/INDEX.md
                            round:      <round>")

    # Parse verdict: look for literal "APPROVED" or "NEEDS_REVISION" in result
    if result contains "APPROVED":
        break  # proceed to Phase 4

    # NEEDS_REVISION — pass findings path to planner; driver does NOT read findings file
    Agent(subagent_type: "planner",
          prompt: "Mode 2 — revision.
                   current.md:  .c-thru/plans/<slug>/current.md
                   INDEX:       .c-thru/plans/<slug>/INDEX.md
                   findings:    <path from result.WROTE>
                   Do not touch items with status: complete.")

    # Persist revision count
    update .c-thru/plans/<slug>/meta.json: meta.revision_rounds += 1

    round += 1

if round == 20 and no APPROVED received:
    # Escalate — do NOT proceed to Phase 4
    Tell user: "Plan review hit the 20-round cap without APPROVED. Manual intervention required."
    Stop.
```

Proceed to Phase 4 only when the agent returns APPROVED.

## Phase 4 — Wave loop

Repeat until no ready items OR final-reviewer approves:

### Phase 4a — plan-orchestrator → wave.json

Determine next wave number `NNN` (next unused `waves/NNN/` directory, zero-padded to 3 digits).
`mkdir -p .c-thru/plans/<slug>/waves/<NNN>/digests .c-thru/plans/<slug>/waves/<NNN>/outputs .c-thru/plans/<slug>/waves/<NNN>/findings`

plan-orchestrator reads current.md fresh from disk each wave — no cached wave state carries over.

```
Agent(subagent_type: "plan-orchestrator",
  prompt: "current.md:        .c-thru/plans/<slug>/current.md
           INDEX:             .c-thru/plans/<slug>/INDEX.md
           learnings:         .c-thru/plans/<slug>/learnings.md
           learnings.INDEX:   .c-thru/plans/<slug>/learnings.INDEX.md
           prior_findings:    [waves/*/findings.jsonl]
           journal:           .c-thru/plans/<slug>/journal.md
           wave_output:       waves/<NNN>/wave.json")
```

Writes `waves/<NNN>/wave.json`. Validate schema (wave_id, batches array present).
If CYCLE error: escalate to user immediately — do not proceed.

### Phase 4b — Prepare (no LLM)

For each item in `wave.json`, assemble a digest at `waves/<NNN>/digests/<agent>-<item>.md`
using the digest schema:

```markdown
---
agent: <role>
item_id: <id>
wave: <NNN>
target_resources: [<resource-ids>]
---
## Mission context
<2 sentences: overall task goal and where this item fits>

## Prior wave context
<Completed work summaries relevant to this item's deps>
<Confirmed assumptions affecting this work>
<Invalidated assumptions this agent must know about>

## Your task
<Item description from current.md>
<Success criteria — concrete and verifiable>

## Constraints
<Patterns to follow; what not to touch; known landmines>

## Accumulated learnings
<Pull topic sections from learnings.md relevant to this agent role and target_resources.
 Use learnings.INDEX.md to identify line ranges; Read(learnings.md, offset, limit) only those sections.
 If learnings.md is empty or absent, omit this section.>
```

Pre-check: every digest declared in wave.json must be non-empty before proceeding.

### Phase 4c — Execute

For each batch in `wave.json.batches`:
- Fire all items as parallel Agent() calls in a **single message**:
  ```
  Agent(subagent_type: "<agent-name>",
    prompt: "<digest path: waves/<NNN>/digests/<agent>-<item>.md>")
  ```
- Write each response to `waves/<NNN>/outputs/<agent>-<item>.md`
- Extract findings to `waves/<NNN>/findings/<agent>-<item>.jsonl`

After each batch, scan `FINDING_CATS` counts returned by each worker agent (do NOT read findings files mid-batch):
- **crisis** anywhere → cut the wave short immediately. Skip remaining batches. Jump to Phase 4d with `decision=partial`. No mid-wave replan.
- **plan-material** anywhere → log to journal; continue the wave. Post-wave auditor + wave-synthesizer drive any replan.
- **contextual/trivial** → log to journal; continue to next batch.

After all batches: `cat waves/<NNN>/findings/*.jsonl > waves/<NNN>/findings.jsonl`

**reviewer-fix loop** (for code items only, max 5 iterations):
```
Agent(subagent_type: "reviewer-fix",
  prompt: "<code-review-digest path>")
```
Iterate until findings show no plan-material/crisis items, or cap hit.

### Phase 4d — Consolidate

Pre-check: every declared output file exists and is non-empty.
If any missing: mark `decision=partial`, write `waves/<NNN>/artifact.md` with what's available, skip to Phase 4g.

Concatenate all outputs into `waves/<NNN>/artifact.md`.
Concatenate all findings into `waves/<NNN>/findings.jsonl`.

### Phase 4e — Verify (no LLM)

Bash checks only:
- Declared `target_resources` files exist on disk
- If success criteria mention tests: run them, capture pass/fail
- Basic syntax check on modified source files (bash -n, node --check as appropriate)

Write `waves/<NNN>/verify.json`:
```json
{ "files_present": true/false, "tests_pass": true/false/null, "syntax_valid": true/false }
```

### Phase 4f — Reflect + Determine (auditor)

Pre-check: `artifact.md` and `verify.json` exist.

```
Agent(subagent_type: "auditor",
  prompt: "artifact:       waves/<NNN>/artifact.md
           artifact_INDEX: waves/<NNN>/INDEX.md
           current.md:     .c-thru/plans/<slug>/current.md
           plan_INDEX:     .c-thru/plans/<slug>/INDEX.md
           verify:         waves/<NNN>/verify.json
           decision_out:   waves/<NNN>/decision.json")
```

Writes `waves/<NNN>/decision.json`:
```json
{ "action": "continue|extend|revise", "rationale": "..." }
```

Validate `action` ∈ {continue, extend, revise}.

### Phase 4f.5 — Wave synthesis (extend/revise only)

On `continue` verdict → skip directly to Phase 4g.
On `extend` or `revise`:

```
Agent(subagent_type: "wave-synthesizer",
  prompt: "artifact:       waves/<NNN>/artifact.md
           artifact_INDEX: waves/<NNN>/INDEX.md
           findings:       waves/<NNN>/findings.jsonl
           verify:         waves/<NNN>/verify.json
           decision:       waves/<NNN>/decision.json
           current.md:     .c-thru/plans/<slug>/current.md
           plan_INDEX:     .c-thru/plans/<slug>/INDEX.md
           journal:        .c-thru/plans/<slug>/journal.md
           brief_out:      waves/<NNN>/replan-brief.md")
```

Wait for `STATUS: COMPLETE`. Driver reads `AFFECTED_ITEMS` list from return (small) but NOT the full brief.

### Phase 4g — Commit

Update `current.md`:
- Mark completed items `status: complete`
- Add confirmed learnings to assumption state
- Add completed-work summaries for use in future digests
- On **extend**: mark affected items `status: extend` (plan-orchestrator will re-queue them)
- On **revise**: invoke planner (Mode 2) to rewrite pending items:

```
Agent(subagent_type: "planner",
  prompt: "Mode 2 — post-wave revision.
           Primary briefing (read first):
             replan-brief:  waves/<NNN>/replan-brief.md
             brief_INDEX:   waves/<NNN>/replan-brief.INDEX.md
           Raw sources (consult when brief is ambiguous):
             current.md:    .c-thru/plans/<slug>/current.md
             INDEX:         .c-thru/plans/<slug>/INDEX.md
             artifact:      waves/<NNN>/artifact.md
             findings:      waves/<NNN>/findings.jsonl
             verify:        waves/<NNN>/verify.json
             decision:      waves/<NNN>/decision.json
             journal:       .c-thru/plans/<slug>/journal.md
           Verdict:         <extend|revise>")
```

Update `.c-thru/plans/<slug>/meta.json`: `meta.revision_rounds += 1`

After planner returns `STATUS: COMPLETE` → re-enter **Phase 3** review loop to validate the amended plan → only then proceed to Phase 4a (next wave).

Snapshot: `cp current.md plan/snapshots/p-<NNN>.md`

Append to `journal.md`:
- **continue**: 1-line entry: `Wave <NNN> complete — <items completed>`
- **extend/revise**: rich entry: what changed, which assumptions shifted, improvement suggestions from agent outputs

Extract agent `## Improvement suggestions` sections → append to journal.md for journal-digester.

## Phase 5 — Final review

When plan-orchestrator finds no ready items:

```
Agent(subagent_type: "final-reviewer",
  prompt: "intent:         <original user intent>
           current.md:     .c-thru/plans/<slug>/current.md
           INDEX:          .c-thru/plans/<slug>/INDEX.md
           journal:        .c-thru/plans/<slug>/journal.md
           journal_offset: <line offset for last 5 entries>
           review_out:     .c-thru/plans/<slug>/final-review.md")
```

If `recommendation: complete` → done. Print summary to user.

If `recommendation: needs_items` → invoke planner (Mode 3) with path:
```
Agent(subagent_type: "planner",
  prompt: "Mode 3 — gap fill.
           intent:       <original user intent>
           current.md:   .c-thru/plans/<slug>/current.md
           INDEX:        .c-thru/plans/<slug>/INDEX.md
           final-review: .c-thru/plans/<slug>/final-review.md
           journal:      .c-thru/plans/<slug>/journal.md")
```
Plan-orchestrator re-runs; gaps → immediately ready items (deps already complete).
Cap: **20 revision rounds total** across all final-review iterations. Escalate to user if cap reached.

## Revision cap

Total plan revision rounds (Phases 3 + 5 combined) capped at **20**. Counter tracked in `.c-thru/plans/<slug>/meta.json`:
```json
{ "slug": "<slug>", "revision_rounds": 0, "created": "<iso-timestamp>", "status": "active" }
```
Increment on each review-plan or final-reviewer→planner cycle. At 20: pause and ask user to continue or abort.
