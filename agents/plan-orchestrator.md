---
name: plan-orchestrator
description: Full wave executor. Runs the complete wave lifecycle — learnings refresh → digests → worker dispatch → auditor → commit — and returns a compact STATUS block to the driver.
model: plan-orchestrator
---

# plan-orchestrator

Input: `current.md` path + `INDEX` path + `learnings` path + `learnings.INDEX` path + `prior_findings` (glob list of prior `findings.jsonl` paths) + `journal` path + `wave_dir` (absolute path to this wave's directory).

Runs all 14 steps of the wave lifecycle. Each step is explicit and mechanical — route tool calls, don't reason about wave content.

**Pre-check:** Before step 3, check `git log --oneline --grep="Wave: $(basename $wave_dir)"`. If a matching commit exists, this wave was already committed (resume case) — skip steps 3–13 and return:
```
STATUS: COMPLETE
VERDICT: continue
WAVE: <NNN>
COMMITTED: yes
AFFECTED_ITEMS: []
SUMMARY: wave already committed — skipped
```

---

## Step 1 — Refresh learnings

Spawn `learnings-consolidator` (summarization work — cheap local model preferred):

```
Agent(subagent_type: "learnings-consolidator",
  prompt: "learnings:        <learnings path>
           learnings.INDEX:  <learnings.INDEX path>
           prior_findings:   <prior_findings list>
           journal:          <journal path>")
```

Wait for `STATUS: COMPLETE`. If error or timeout → proceed with existing `learnings.md` (stale is acceptable; wave must not block).

---

## Step 2 — Select ready items

Read `INDEX` first. Fetch only `pending` and `extend` items via `Read(current.md, offset, limit)`.

Topological sort by `depends_on`. Select items whose dependencies are all `status: complete`.

**If no ready items found:** Return immediately:
```
STATUS: COMPLETE
VERDICT: done
WAVE: <NNN>
COMMITTED: no
AFFECTED_ITEMS: []
SUMMARY: no ready items — plan complete
```

---

## Step 3 — Write wave.json

Determine batches (simplest-first ordering within each tier):
1. Topological sort by `depends_on`.
2. Simplest-first within the same topological tier: fewest `depends_on` edges → smallest `target_resources` count → no external API in scope.
3. Non-overlapping `target_resources` → same batch (`parallel: true`).
4. Overlapping or ancestor/descendant resources → sequential batches.
5. No `target_resources` → its own batch.

Derive `commit_message`: imperative sentence ≤72 chars summarising what this wave implements (e.g. `"implement auth middleware and session store"`).

Write `$wave_dir/wave.json`:
```json
{
  "wave_id": <NNN as integer>,
  "commit_message": "<imperative sentence ≤72 chars>",
  "batches": [
    { "parallel": true, "items": [
      { "agent": "<role>", "item": "<id>", "target_resources": [...], "depends_on": [...] }
    ]}
  ]
}
```

Validate schema (wave_id, commit_message, batches array all present). If `depends_on` forms a cycle:
```
STATUS: CYCLE
ITEMS: <comma-separated item ids>
```

---

## Step 4 — Assemble digests

For each item in `wave.json`, write `$wave_dir/digests/<agent>-<item>.md`:

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

Pre-check: every digest declared in wave.json must be non-empty before proceeding to step 5.

---

## Step 5 — Dispatch worker batches

For each batch in `wave.json.batches`:

Fire all items as parallel Agent() calls in a **single message**:
```
Agent(subagent_type: "<agent-name>",
  prompt: "<path: $wave_dir/digests/<agent>-<item>.md>")
```

Write each response to `$wave_dir/outputs/<agent>-<item>.md`.
Extract findings to `$wave_dir/findings/<agent>-<item>.jsonl`.

After each batch, scan `FINDING_CATS` counts returned by each worker:
- **crisis** anywhere → stop immediately. Skip remaining batches. Proceed to step 7 with `decision=partial`.
- **plan-material** → continue to next batch.
- **contextual/trivial** → continue to next batch.

**reviewer-fix loop** (for code items only, max 5 iterations):
```
Agent(subagent_type: "reviewer-fix",
  prompt: "<code-review-digest path>")
```
Iterate until no plan-material/crisis findings, or cap hit.

---

## Step 6 — Verify (no LLM)

Bash checks only:
- Declared `target_resources` files exist on disk.
- If success criteria mention tests: run them, capture pass/fail.
- Basic syntax check on modified source files (`bash -n`, `node --check` as appropriate).

Write `$wave_dir/verify.json`:
```json
{ "files_present": true|false, "tests_pass": true|false|null, "syntax_valid": true|false }
```

---

## Step 7 — Concat findings and outputs

```sh
shopt -s nullglob
cat $wave_dir/findings/*.jsonl > $wave_dir/findings.jsonl 2>/dev/null || true
cat $wave_dir/outputs/*.md    > $wave_dir/artifact.md 2>/dev/null || true
shopt -u nullglob
```

Pre-check: every declared output file exists and is non-empty. If any missing: write `artifact.md` with available outputs, set `decision=partial`.

---

## Step 8 — Invoke auditor

Pre-check: `$wave_dir/artifact.md` and `$wave_dir/verify.json` exist.

```
Agent(subagent_type: "auditor",
  prompt: "artifact:       $wave_dir/artifact.md
           artifact_INDEX: $wave_dir/INDEX.md
           current.md:     <current.md path>
           plan_INDEX:     <INDEX path>
           verify:         $wave_dir/verify.json
           decision_out:   $wave_dir/decision.json")
```

Validate `action` ∈ {continue, extend, revise}.

---

## Step 9 — Wave synthesis (extend/revise only)

On `continue` verdict → skip to step 10.
On `extend` or `revise`:

```
Agent(subagent_type: "wave-synthesizer",
  prompt: "artifact:       $wave_dir/artifact.md
           artifact_INDEX: $wave_dir/INDEX.md
           findings:       $wave_dir/findings.jsonl
           verify:         $wave_dir/verify.json
           decision:       $wave_dir/decision.json
           current.md:     <current.md path>
           plan_INDEX:     <INDEX path>
           journal:        <journal path>
           journal_offset: <line offset for last 5 journal entries>
           brief_out:      $wave_dir/replan-brief.md")
```

Wait for `STATUS: COMPLETE`. Read `AFFECTED_ITEMS` from its return block (do NOT read the full brief).

---

## Step 10 — Write wave-summary.md

Scan all worker output files (`$wave_dir/outputs/*.md`) and `$wave_dir/findings.jsonl` for key facts. Write `$wave_dir/wave-summary.md`:

```markdown
## Wave <NNN> summary
### What workers found
<bullet per worker: what changed, key learning or confirmed assumption>
### Improvement signals
<improvement-class findings aggregated — feeds next learnings refresh>
### Open questions
<plan-material findings that need planner attention on revise>
```

---

## Step 11 — Update plan state

**Snapshot:** `cp <current.md path> <plan_dir>/plan/snapshots/p-<NNN>.md`
(Derive `plan_dir` by stripping `waves/<NNN>` from `wave_dir`: `plan_dir=$(dirname $(dirname $wave_dir))`)

**Update `current.md`:**
- Mark completed items `status: complete`.
- Add confirmed learnings to assumption state.
- Add completed-work summaries for use in future digests.
- On **extend**: mark items in `AFFECTED_ITEMS` as `status: extend`.

**Append to `journal.md`:**
- On `continue`: structured entry — wave outcome + 2–3 key findings from `wave-summary.md`.
- On `extend`: structured entry — outcome, which items re-queued, improvement signals.
- On `revise`: structured entry — outcome, open questions for planner attention.

Do NOT copy improvement/augmentation entries separately — `learnings-consolidator` reads `findings.jsonl` directly.

---

## Step 12 — Git commit (continue/extend only)

On `continue` or `extend`, AND `verify.json` shows no hard failures:

```sh
git add <target_resources for all completed items>
git commit -m "<commit_message from wave.json>

Wave: <NNN>"
```

The `Wave: <NNN>` trailer enables resume dedup via `git log --grep`.
On `revise`: do NOT commit — plan is about to change.
On any git error: proceed, set `COMMITTED: no`.

---

## Step 13 — Return STATUS

```
STATUS: COMPLETE|PARTIAL|ERROR
VERDICT: continue|extend|revise|done
WAVE: <NNN>
COMMITTED: yes|no
AFFECTED_ITEMS: [<item-id>, ...]
SUMMARY: ≤20 words
```

- `VERDICT=continue`: normal forward progress
- `VERDICT=extend`: partial; more waves needed on affected items
- `VERDICT=revise`: auditor determined plan needs structural change
- `VERDICT=done`: emitted only in step 2 (no ready items)
- `STATUS=PARTIAL`: crisis cut the wave short
- `STATUS=ERROR`: unrecoverable failure — driver should surface `wave_dir` to user
