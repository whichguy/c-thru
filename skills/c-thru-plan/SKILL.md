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

Run `/review-plan` up to **20 rounds** (c-thru override — the default cap is 3).
Pass `max_rounds=20` to the skill invocation.

```
Skill("review-plan", { target: ".c-thru/plans/<slug>/current.md", max_rounds: 20 })
```

Proceed to Phase 4 only when review-plan returns APPROVED.

## Phase 4 — Wave loop

Repeat until no ready items OR final-reviewer approves:

### Phase 4a — plan-orchestrator → wave.json

Determine next wave number `NNN` (next unused `waves/NNN/` directory, zero-padded to 3 digits).
`mkdir -p .c-thru/plans/<slug>/waves/<NNN>/digests .c-thru/plans/<slug>/waves/<NNN>/outputs .c-thru/plans/<slug>/waves/<NNN>/findings`

```
Agent(subagent_type: "plan-orchestrator",
  prompt: "<contents of current.md>")
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
```

Pre-check: every digest declared in wave.json must be non-empty before proceeding.

### Phase 4c — Execute

For each batch in `wave.json.batches`:
- Fire all items as parallel Agent() calls in a **single message**:
  ```
  Agent(subagent_type: "<agent-name>",
    prompt: "<digest contents>")
  ```
- Write each response to `waves/<NNN>/outputs/<agent>-<item>.md`
- Extract findings to `waves/<NNN>/findings/<agent>-<item>.jsonl`

After each batch, scan all findings for classification:
- **crisis** anywhere → pause wave; invoke planner (Mode 2); plan-orchestrator full re-read; new wave.
- **plan-material** anywhere → pause remaining batches; invoke planner (Mode 2); plan-orchestrator re-runs; resume.
- **contextual/trivial** → log to journal; continue to next batch.

After all batches: `cat waves/<NNN>/findings/*.jsonl > waves/<NNN>/findings.jsonl`

**reviewer-fix loop** (for code items only, max 5 iterations):
```
Agent(subagent_type: "reviewer-fix",
  prompt: "<code-review-digest>")
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
  prompt: "<artifact.md>\n\n<relevant sections of current.md>\n\n<verify.json>")
```

Writes `waves/<NNN>/decision.json`:
```json
{ "action": "continue|extend|revise", "rationale": "..." }
```

Validate `action` ∈ {continue, extend, revise}.

### Phase 4g — Commit

Update `current.md`:
- Mark completed items `status: complete`
- Add confirmed learnings to assumption state
- Add completed-work summaries for use in future digests
- On **extend**: mark affected items `status: extend` (plan-orchestrator will re-queue them)
- On **revise**: invoke planner (Mode 2) to rewrite pending items; plan-orchestrator full re-read

Snapshot: `cp current.md plan/snapshots/p-<NNN>.md`

Append to `journal.md`:
- **continue**: 1-line entry: `Wave <NNN> complete — <items completed>`
- **extend/revise**: rich entry: what changed, which assumptions shifted, improvement suggestions from agent outputs

Extract agent `## Improvement suggestions` sections → append to journal.md for journal-digester.

## Phase 5 — Final review

When plan-orchestrator finds no ready items:

```
Agent(subagent_type: "final-reviewer",
  prompt: "<original_intent>\n\n<current.md>\n\n<last 5 journal entries>")
```

If `recommendation: complete` → done. Print summary to user.

If `recommendation: needs_items` → invoke planner (Mode 3):
```
Agent(subagent_type: "planner",
  prompt: "<original_intent>\n\n<current.md>\n\n<gap_analysis>\n\n<last 5 journal entries>")
```
Plan-orchestrator re-runs; gaps → immediately ready items (deps already complete).
Cap: **20 revision rounds total** across all final-review iterations. Escalate to user if cap reached.

## Revision cap

Total plan revision rounds (Phases 3 + 5 combined) capped at **20**. Counter tracked in `.c-thru/plans/<slug>/meta.json`:
```json
{ "slug": "<slug>", "revision_rounds": 0, "created": "<iso-timestamp>", "status": "active" }
```
Increment on each review-plan or final-reviewer→planner cycle. At 20: pause and ask user to continue or abort.
