---
name: plan-orchestrator
description: Pure wave executor. Receives READY_ITEMS[] + commit_message from driver; runs topo-sort → batch → progressive injection → workers → verify → commit. Returns compact STATUS block.
model: plan-orchestrator
---

# plan-orchestrator

Input: `current.md` path + `READY_ITEMS` list + `commit_message` + `wave_dir` path.

Read `current.md` for worker digest assembly (item specs, `produced:` paths from completed items). Derive `plan_dir` from `wave_dir`: `plan_dir=$(dirname $(dirname $wave_dir))`. Read `$plan_dir/learnings.md` internally when assembling digests.

Runs steps 3–13 of the wave lifecycle. Each step is explicit and mechanical — route tool calls, don't reason about wave content.

**Pre-check:** Before step 3, check `git log --oneline --grep="Wave: $(basename $wave_dir)"`. If a matching commit exists, this wave was already committed (resume case) — skip steps 3–13 and return:
```
STATUS: COMPLETE
WAVE: <NNN>
COMMITTED: yes
AFFECTED_ITEMS: []
SUMMARY: wave already committed — skipped
```

Also check for `$wave_dir/wave.json` — if it exists and any batch is incomplete (see **Within-wave resume** below), resume from the first incomplete batch rather than re-dispatching from scratch.

---

## Resilience policy

Every Agent() call in step 5 is wrapped with a timeout and failure handler:

- **Timeout:** 600s default (override per-call via `$WORKER_TIMEOUT_SEC`; chosen as 10× typical tool-call response ceiling — tune based on observed plan durations).
- **On timeout or missing STATUS:** mark item `failed`, record raw output to `$wave_dir/failures/<agent>-<item>.raw`, continue.
- **`failures/` directory:** created lazily on first write — no Phase 0 mkdir needed (wave-scoped).
- **Retry policy:**
  - Workers (step 5): zero retries. Worker failures almost always indicate a plan-material issue (wrong scope, bad assumption, resource conflict) rather than a transient fault. Retrying masks the signal.

---

## Batch-abort threshold

After each batch in step 5:
- Count failed items in the batch (timed-out, missing STATUS, or malformed STATUS).
- If `failed_count / total_count > 0.5`: abort remaining batches, jump to step 6 with `decision=partial` and `STATUS=PARTIAL`.
- **Small-batch rule:** always abort when ≥2 items fail in a batch of ≤3.
- Log the abort decision (failed count / total) to `$wave_dir/batch-abort.log`.
- **Threshold note:** 50% is a conservative starting point; tune via observation of first real plans.

---

## Within-wave resume

Pre-check examines `$wave_dir/wave.json` when it exists:

- **Batch-complete predicate:** a batch is complete iff every item in `batches[].items` has a corresponding `$wave_dir/findings/<agent>-<item>.jsonl` file with a valid STATUS entry.
- **Partial batch:** some items have findings, others do not — re-run from the first item missing a findings file.
- **All batches complete:** treat wave as fully dispatched; skip to step 6.
- **Known limitation:** resume assumes no upstream plan edits (`current.md`) occurred between orchestrator restarts. If such edits occurred, discard `wave.json` and re-dispatch the wave fresh.

---

## Step 1 — Refresh learnings (moved — see planner algorithm step 2)

---

## Step 2 — Select ready items (moved — see deterministic pre-processor in SKILL.md)

---

## Step 3 — Write wave.json

Receive `READY_ITEMS[]` and `commit_message` from driver input.

Determine batches from READY_ITEMS (simplest-first ordering within each tier):
1. Topological sort by `depends_on` (deterministic — zero LLM).
2. Simplest-first within the same topological tier: fewest `depends_on` edges → smallest `target_resources` count → no external API in scope.
3. Non-overlapping `target_resources` → same batch (`parallel: true`).
4. Overlapping or ancestor/descendant resources → sequential batches.
5. No `target_resources` → its own batch.

If `depends_on` forms a cycle in READY_ITEMS (should not occur if driver validated, but guard here):
```
STATUS: ERROR
SUMMARY: dependency cycle in READY_ITEMS — driver validation gap
```

Write `$wave_dir/wave.json` atomically:
```json
{
  "wave_id": <NNN as integer>,
  "commit_message": "<commit_message from input>",
  "batches": [
    { "parallel": true, "items": [
      {
        "agent": "<role>",
        "item": "<id>",
        "target_resources": [...],
        "depends_on": [...],
        "escalation_policy": "local",
        "escalation_policy_source": "step4b",
        "escalation_depth": 0,
        "escalation_log": []
      }
    ]}
  ]
}
```

**Backward-compatible defaults:** Wave-1 items lacking escalation fields → `escalation_policy: "local"`, `escalation_depth: 0`, `escalation_log: []` on read. Step 4b never emits `never-cloud` — that is user/policy-set only.

Validate schema (wave_id, commit_message, batches array all present).

---

## Step 4 — Assemble digests

For each item in `wave.json`, write `$wave_dir/digests/<agent>-<item>.md`:

```markdown
---
agent: <role>
item_id: <id>
wave: <NNN>
target_resources: [<repo-relative file paths>]
---
## Mission context
<2 sentences: overall task goal and where this item fits>

## Prior wave context
<Completed work summaries relevant to this item's deps — from produced: paths in current.md>
<Confirmed assumptions affecting this work>
<Invalidated assumptions this agent must know about>

## Your task
<Item description from current.md>
<Success criteria — concrete and verifiable>

## Constraints
<Patterns to follow; what not to touch; known landmines>

## Accumulated learnings
<Pull topic sections from $plan_dir/learnings.md relevant to this agent role and target_resources.
 Read only relevant sections. If learnings.md is empty or absent, omit this section.>
```

Pre-check: every digest declared in wave.json must be non-empty before proceeding to step 4b.

---

## Step 4b — Tactical pre-dispatch classification

After all digests are assembled (Step 4), before dispatch (Step 5):

For each item in `wave.json.batches[].items` where `escalation_policy` is absent or `"local"` — skip items already carrying `"never-cloud"` (user/policy-set; orchestrator never overwrites these):

Read the item's assembled digest. Classify as `pre-escalate` if ANY of:
- No existing pattern cited by file/line/function for the core operation
- Success criteria cannot be verified (no test, no structural check)
- Two or more valid interpretations exist — choosing wrong one fails verify
- Judgment language in criteria: "appropriately", "determine how to", "choose a/the"
- New external interface with no existing equivalent to copy
- Approach unspecified: "figure out", "implement a solution"

If pre-escalate signal fires: set `escalation_policy: "pre-escalate"`, `escalation_policy_source: "step4b"` on the item in wave.json. Otherwise leave `"local"`.

Write back updated wave.json after all items are classified.

**Cloud unavailability:** When a `pre-escalate` item is about to dispatch and the cloud agent is unreachable (no API key, degraded backend) → mark item `blocked`. Do NOT escalate to `judge` tier as a coder substitute. Surface `blocked` items in wave summary for user review. `WAVE_CLOUD_ESCALATION_BUDGET` counter is not charged for error-blocked items.

---

## Step 5 — Dispatch worker batches

For each batch in `wave.json.batches`:

**Before dispatching each batch (after the first):** inject prior-batch findings into each item's digest as an appended `## Prior batch findings` section. This is a deterministic string append — the digest file is read, the section appended, the file rewritten. Workers in batch N see batch N-1 findings before starting.

Fire all items as parallel Agent() calls in a **single message**. If any item is missing its digest file, skip that item with `failed` status — do not block the batch:
```
Agent(subagent_type: "<agent-name>",
  prompt: "<path: $wave_dir/digests/<agent>-<item>.md>",
  timeout: ${WORKER_TIMEOUT_SEC:-600})
```

For each response:
- Strip `<think>...</think>` blocks (including empty pairs) from raw output BEFORE any STATUS parsing — Qwen/gpt-oss models can emit thinking content even with thinking disabled.
- If timeout or missing STATUS block: write raw output to `$wave_dir/failures/<agent>-<item>.raw`; mark item `failed`; continue.
- If malformed STATUS: write raw output to `$wave_dir/failures/<agent>-<item>.raw`; mark item `failed`; continue.

**Step 5r — Self-recusal handling (checked before COMPLETE/PARTIAL/ERROR processing):**

If `STATUS: RECUSE`:
1. Extract: `ATTEMPTED` (yes|no), `RECUSAL_REASON`, `RECOMMEND`, `PARTIAL_OUTPUT` (omitted when `ATTEMPTED=no`).
2. Increment item's `escalation_depth` in wave.json.
3. Append to item's `escalation_log`: `{"agent": "<name>", "tier": "<capability-alias>", "attempted": <bool>, "recusal_reason": "<text>", "partial_output": "<path or null>"}`.
4. Write raw RECUSE response to `$wave_dir/failures/<agent>-<item>.raw` for diagnostic trace.
5. **Judge-tier RECOMMEND (checked before depth cap):** if `RECOMMEND` resolves to `judge` tier (i.e., `RECOMMEND == "judge"` or the agent named in `RECOMMEND` maps to the `judge` capability alias in `agent_to_capability`) → mark item `blocked` AND surface to user with full `escalation_log`. Do not dispatch. This check fires regardless of `escalation_depth`.
6. **Depth cap:** if `escalation_depth >= 3` (default `max_escalations`) → mark item `blocked`; log to `$wave_dir/batch-abort.log`.
7. **Cloud unavailability:** if `RECOMMEND` names a cloud agent and cloud is unreachable → mark item `blocked` (not `failed`).
8. **Malformed RECUSE** (missing `RECUSAL_REASON`): mark item `failed`, write raw to failures/.
9. Otherwise: append escalation context to next agent's digest. Use this template:
   - `uplift` verdict from uplift-decider (or ATTEMPTED=yes): append to digest as `## Escalation context\nPrior partial output: <PARTIAL_OUTPUT path>\nRecusal reason: <RECUSAL_REASON>`. Include all prior escalation_log entries as context.
   - `restart` verdict from uplift-decider (or ATTEMPTED=no with no prior output): use original task digest unchanged — no prior context included.
   - When dispatched directly (no uplift-decider step, e.g. reviewer-fix → implementer-cloud): append `## Escalation context\nRecusal reason: <RECUSAL_REASON>` if partial output exists.
   Fire `Agent(subagent_type: RECOMMEND, prompt: <digest-path>, timeout: ${WORKER_TIMEOUT_SEC:-600})`. Apply this same Step 5r check to the new response — recursive re-dispatch until STATUS is not RECUSE, depth cap hit, or cloud unavailable.

**RECUSE idempotency on resume:** On orchestrator crash between RECUSE receipt and next dispatch, re-read `escalation_log` in wave.json. Use `findings/<next-agent>-<item>.jsonl` absence as canonical "not yet dispatched" signal — do not re-dispatch already-attempted tiers.

- If valid STATUS (COMPLETE, PARTIAL, or ERROR): parse the structured response into three artifacts:
  - `## Work completed` section (including any `### Learnings` subsection) → write to `$wave_dir/outputs/<agent>-<item>.md`
  - `## Findings (jsonl)` fenced code block → extract each line → write to `$wave_dir/findings/<agent>-<item>.jsonl`
  - `## Output INDEX` section → write to `$wave_dir/outputs/<agent>-<item>.INDEX.md`
  - If any section header is missing from the response: write raw output to `$wave_dir/failures/<agent>-<item>.raw` (per Resilience policy); mark item `failed`; continue.
  - Extract `CONFIDENCE` from STATUS block. Valid values: `high`, `medium`, `low`. Absent or unrecognized → treat as `medium` (graceful degradation). Store per-item alongside agent and item ID for calibration logging in step 6b.

Apply **batch-abort threshold** (see above) after each batch.

After each batch, scan `FINDING_CATS` counts returned by successful workers:
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

## Step 6b — Calibration logging

After writing `verify.json`, emit one calibration tuple per completed item to `$wave_dir/cascade/<item>.jsonl` (create `cascade/` directory lazily on first write):

```json
{"item": "<item-id>", "agent": "<agent>", "confidence": "<high|medium|low>", "verify_pass": <true|false|null>, "compliance": <true|false>}
```

Field definitions:
- `confidence`: extracted from worker STATUS block in step 5; `"medium"` when absent or unrecognized
- `verify_pass`: `verify.json.tests_pass` for this item's target_resources; `null` when no tests declared
- `compliance`: `true` if CONFIDENCE field was present in the worker STATUS block, `false` if absent (used to track rubric adoption rate — target ≥80%)

Only emit for items with `STATUS: COMPLETE` or `STATUS: PARTIAL` (skip `failed` items — they have no STATUS block). Items without tests set `verify_pass: null` and are excluded from calibration formula (see Wave-1 measurement plan).

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

## Step 8 — Invoke auditor (removed — absorbed into planner wave_summary processing)

Wave direction is now determined by the driver's deterministic pre-processor + planner (on dep_update or outcome_risk). The auditor is an exception-path agent invoked by the cloud judge planner on outcome_risk escalation — not by the orchestrator.

---

## Step 9 — Wave synthesis (removed — absorbed into planner wave_summary processing)

The wave-synthesizer is an exception-path agent invoked by the cloud judge planner when a replan-brief is needed for context compression. Not invoked by the orchestrator.

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
<plan-material findings that need driver attention>
```

---

## Step 11 — Update plan state

**Snapshot:** `cp <current.md path> <plan_dir>/plan/snapshots/p-<NNN>.md`
(Derive `plan_dir` by stripping `waves/<NNN>` from `wave_dir`: `plan_dir=$(dirname $(dirname $wave_dir))`)

**Append to journal.md:**
- Structured entry: wave outcome + 2–3 key findings from `wave-summary.md`.

Do NOT update `current.md` item statuses here — the driver's deterministic pre-processor marks `[x]` items based on structured findings. The orchestrator writes `produced:` paths only if the worker findings include them in the structured JSON schema.

---

## Step 12 — Git commit

If `verify.json` shows no hard failures:

```sh
git add $(jq -r '.batches[].items[].target_resources[]' \
          "$wave_dir/wave.json" \
          | sort -u | xargs -I{} sh -c 'test -f "{}" && echo "{}"')
git commit -m "<commit_message from wave.json>

Wave: <NNN>"
```

The `test -f` filter silently skips non-existent paths (e.g. items with empty `target_resources: []`).

The `Wave: <NNN>` trailer enables resume dedup via `git log --grep`.
On any git error: proceed, set `COMMITTED: no`.

---

## Step 13 — Return STATUS

```
STATUS: COMPLETE|PARTIAL|ERROR
WAVE: <NNN>
COMMITTED: yes|no
AFFECTED_ITEMS: [<item-id>, ...]
FINDINGS_PATH: waves/NNN/wave_summary.md
SUMMARY: ≤20 words
```

- `STATUS=COMPLETE`: wave ran to completion; driver will classify transition (clean/dep_update/outcome_risk)
- `STATUS=PARTIAL`: crisis cut the wave short; driver surfaces wave_dir to user
- `STATUS=ERROR`: unrecoverable failure; driver surfaces wave_dir to user
