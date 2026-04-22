---
name: plan-orchestrator
description: Pure wave executor. Receives READY_ITEMS[] + commit_message from driver; runs topo-sort → batch → progressive injection → workers → verify → commit. Returns compact STATUS block.
model: plan-orchestrator
tier_budget: 1000
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

Also check for `$wave_dir/wave.md` — if it exists and any batch is incomplete (see **Within-wave resume** below), resume from the first incomplete batch rather than re-dispatching from scratch. Legacy fallback: if `wave.md` is absent but `wave.json` is present (v2 in-flight plan), read via `readWaveJson()` (emits deprecation warning to `pre-processor.log`). After reading wave.json, immediately write it out as `wave.md` via `writeWaveMd()` before any `update-marker` calls — this promotes the in-flight plan to v3 format in one step.

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

After each batch in step 5, delegate the abort decision to the harness:

```sh
node tools/c-thru-plan-harness.js batch-abort \
  --failed <N> --total <N> --wave-dir "$wave_dir"
```

Exit 1 → abort remaining batches, jump to step 6 with `decision=partial` and `STATUS=PARTIAL`.
Exit 0 → continue. Decision + ratio written to `$wave_dir/batch-abort.log`.

---

## Within-wave resume

Pre-check examines `$wave_dir/wave.md` when it exists:

- **Batch-complete predicate:** a batch is complete iff every item in the `batches:` frontmatter list has a corresponding `$wave_dir/findings/<agent>-<item>.jsonl` file with a valid STATUS entry. (Batch structure is read from frontmatter; per-item `batch:` annotation is denormalized for human scanning only.)
- **Partial batch:** some items have findings, others do not — re-run from the first item missing a findings file. Item markers (`[~]`, `[x]`, `[!]`) provide a secondary consistency check but `findings/` presence is canonical.
- **All batches complete:** treat wave as fully dispatched; skip to step 6.
- **Known limitation:** resume assumes no upstream plan edits (`current.md`) occurred between orchestrator restarts. If such edits occurred, discard `wave.md` and re-dispatch the wave fresh.

---

## Step 1 — Refresh learnings (moved — see planner algorithm step 2)

---

## Step 2 — Select ready items (moved — see deterministic pre-processor in SKILL.md)

---

## Step 2.5 — Complexity evaluation

Before wave planning, evaluate plan complexity from four recon signals read from `$plan_dir/discovery/` and the item list in `current.md`:

| Signal | Source |
|---|---|
| `files_affected` | Count of distinct `target_resources` across all items in `READY_ITEMS` |
| `shared_interfaces` | Count of schemas/types consumed by ≥2 files outside the plan's file set (from recon) |
| `persisted_state` | `PERSISTED_STATE_STORES` recon field: `present` if non-empty/non-`none`, else `absent` |
| `external_consumers` | Count of callers not in the plan's file set that reference plan-touched files (from recon) |

**Rubric (evaluate in order — first match wins):**
- `trivial`: `files_affected ≤ 2` AND `shared_interfaces = 0` AND `persisted_state = absent` AND `external_consumers = 0`
- `complex`: `files_affected ≥ 5` OR `persisted_state = present` OR `external_consumers > 0`
- `moderate`: all other cases

**Downstream behavior:**
- `trivial` → single wave, skip deployability guard, skip CI-safety wave
- `moderate` → deployability guard runs per wave
- `complex` → deployability guard + migration evaluation + final CI-safety wave appended

**Logging:** Write derivation inputs and result to `$wave_dir/plan.json` (create or merge):
```json
{
  "complexity": "trivial|moderate|complex",
  "complexity_inputs": {
    "files_affected": N,
    "shared_interfaces": N,
    "persisted_state": "present|absent",
    "external_consumers": N
  }
}
```
Also emit one calibration tuple to `$wave_dir/cascade/complexity.jsonl`:
```
{"intent_summary":"<≤10 words>","file_count":N,"classification":"trivial|moderate|complex","downstream_wave_count":N}
```

Emit `COMPLEXITY: trivial|moderate|complex` in the return STATUS block (Step 13).

---

## Step 3 — Write wave.md

Receive `READY_ITEMS[]` and `commit_message` from driver input. Delegate topo-sort
and batch assembly to the harness (deterministic, zero LLM):

```sh
node tools/c-thru-plan-harness.js batch \
  --current-md "$plan_dir/current.md" \
  --items "<READY_ITEMS joined as comma-separated list>" \
  --wave-id <NNN> \
  --commit-msg "<commit_message>" \
  --output "$wave_dir/wave.md"
```

On exit code 2 (cycle detected): return `STATUS: ERROR, SUMMARY: dependency cycle in READY_ITEMS — driver validation gap`.

**Deployability guard** (skip when `COMPLEXITY: trivial`): Before finalizing each wave, assert that merging only the items in that wave leaves the codebase deployable. Formally: no item in wave N may introduce an import or call-site to a module that first appears in wave N+1 or later.

Detection: for each item's `target_resources`, scan for import/require statements targeting files that are `produced:` by a *later* wave's items (read all subsequent waves from `current.md`). A forward reference exists when a later-wave `produced:` path matches an import target.

**On violation — default action = collapse:** merge the forward-referencing pair into the same wave. Split-with-stub only when: the referenced module exports >1 symbol AND only one is needed in the earlier wave AND a stub can satisfy that interface.

**Logging on guard activation:**
- Emit human-readable reason to orchestrator stdout: `[deployability-guard] wave N: <item-id> imports <path> from wave M — collapsing into wave N`
- Append to `$wave_dir/cascade/deployability.jsonl`:
  ```
  {"wave_id":N,"violation_type":"forward-ref","item_id":"<id>","imported_path":"<path>","resolution":"collapse|split-stub"}
  ```

**Sole-writer invariant:** only the orchestrator writes `wave.md`. Workers never call `update-marker` directly. All marker updates go through: `node tools/c-thru-plan-harness.js update-marker --wave-md "$wave_dir/wave.md" --item <id> --status <x|~|!|+> [...]`.

**Field contract:** `needs:` in `wave.md` carries forward dep edges (renamed from `depends_on:` in `current.md`). No reverse `dependents:` field is stored; use `findDependents()` in the harness when needed. `batch:` per-item and frontmatter `batches:` are computed by the harness — never hand-edited.

**State migration evaluation** (gated on `COMPLEXITY ≠ trivial` AND `PERSISTED_STATE_STORES ≠ absent/none`): For each wave, determine whether any item touches a persisted-state store (DB schema, queue config, key-value store) identified in recon. Formally: check whether any item's `target_resources` includes a file that matches a path in `PERSISTED_STATE_STORES`.

If a schema-touching item is found:
- Set `MIGRATION_REQUIRED: yes` for that wave
- Insert a dedicated migration wave immediately before the schema change wave; migration wave items carry `migration_target: <store-path>` and a `migration_plan: <≤20-word summary>` field
- Migration wave items are dispatched to the `deep-coder` tier (same as normal implementer items; no routing change needed)

If no schema-touching item: set `MIGRATION_REQUIRED: no` for that wave (no migration wave inserted).

Emit `MIGRATION_REQUIRED: yes|no` in the wave's wave.md frontmatter. Absent field defaults to `no` (graceful degradation).

**Backward-compatible defaults:** Wave-1 items lacking escalation fields → `escalation_policy: "local"`, `escalation_depth: 0`, `escalation_log: []` on read. Step 4b never emits `never-cloud` — that is user/policy-set only.

Validate schema after write (harness does this automatically): wave_id, commit_message, ≥1 item block present.

---

## Step 4 — Assemble digests

For each item in `wave.md` (read frontmatter `batches:` for ordering; `needs:`, `target_resources:`, `agent:` from item blocks), write `$wave_dir/digests/<agent>-<item>.md`:

**TEST_FRAMEWORKS forwarding:** Before assembling digests, read the recon output at `$plan_dir/discovery/` for a `TEST_FRAMEWORKS:` line from `discovery-advisor` or any explorer answer. If found and non-empty (not `none`), forward it into each worker digest's `## Mission context` section as: `Test infrastructure: <TEST_FRAMEWORKS value>`. Absent or `none` → omit the line. Implementer, test-writer, and wave-reviewer agents use this to align their work with the project's actual test contract.

```markdown
---
agent: <role>
item_id: <id>
wave: <NNN>
target_resources: [<repo-relative file paths>]
---
## Mission context
<2 sentences: overall task goal and where this item fits>
<If TEST_FRAMEWORKS was detected: "Test infrastructure: {value}">

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

After all digests are assembled, inject the shared worker contract (idempotent):

```sh
node tools/c-thru-plan-harness.js inject-contract \
  --contract "$(git rev-parse --show-toplevel)/shared/_worker-contract.md" \
  --digests-dir "$wave_dir/digests"
```

Pre-check: every digest declared in `wave.md` must be non-empty before proceeding to step 4b.

---

## Step 4b — Tactical pre-dispatch classification

After all digests are assembled (Step 4), before dispatch (Step 5):

For each item in `wave.md` (read item blocks) where `escalation_policy` is absent or `"local"` — skip items already carrying `"never-cloud"` (user/policy-set; orchestrator never overwrites these):

Read the item's assembled digest. Classify as `pre-escalate` if ANY of:
- No existing pattern cited by file/line/function for the core operation
- Success criteria cannot be verified (no test, no structural check)
- Two or more valid interpretations exist — choosing wrong one fails verify
- Judgment language in criteria: "appropriately", "determine how to", "choose a/the"
- New external interface with no existing equivalent to copy
- Approach unspecified: "figure out", "implement a solution"

If pre-escalate signal fires, update the item in `wave.md` via the harness:
```sh
node tools/c-thru-plan-harness.js update-marker \
  --wave-md "$wave_dir/wave.md" --item <id> --status '~' \
  --escal-policy pre-escalate --escal-policy-source step4b
```
Otherwise leave `"local"` unchanged.

**Cloud unavailability:** When a `pre-escalate` item is about to dispatch and the cloud agent is unreachable (no API key, degraded backend) → mark item `blocked`. Do NOT escalate to `judge` tier as a coder substitute. Surface `blocked` items in wave summary for user review. `WAVE_CLOUD_ESCALATION_BUDGET` counter is not charged for error-blocked items.

---

## Step 5 — Dispatch worker batches

Read frontmatter `batches:` from `wave.md` — each element is a list of item IDs that run in parallel. Dispatch each batch as a single `Agent()` message (true parallelism — one tool turn, N sub-agents). For each batch in `batches:`:

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

**uplift-decider special case (checked first):** `uplift-decider` returns `STATUS: COMPLETE` with a `VERDICT` field and no `## Work completed` / `## Findings` / `## Output INDEX` sections. Detect uplift-decider responses by checking for a `VERDICT` field in the STATUS block before any section parsing:
- `VERDICT: accept` → local partial output is correct as written. Copy `PARTIAL_OUTPUT` (from escalation context) to `$wave_dir/outputs/<original-agent>-<item>.md`. Mark item `COMPLETE`. Do not dispatch further. No calibration tuple emitted for uplift-decider itself.
- `VERDICT: uplift` → dispatch `implementer-cloud` with uplift escalation context (see step 9 below).
- `VERDICT: restart` → dispatch `implementer-cloud` with clean original digest (see step 9 below).
- If `VERDICT` is missing or unrecognized: mark item `failed`; write raw to `$wave_dir/failures/uplift-decider-<item>.raw`.

If `STATUS: RECUSE`:
1. Extract: `ATTEMPTED` (yes|no), `RECUSAL_REASON`, `RECOMMEND`, `PARTIAL_OUTPUT` (omitted when `ATTEMPTED=no`).
2. Increment item's `escalation_depth` in `wave.md` via `update-marker --escal-depth <N>`.
3. Append to item's `escalation_log` (read current log, append entry, write via `update-marker`): `{"agent": "<name>", "tier": "<capability-alias>", "attempted": <bool>, "recusal_reason": "<text>", "partial_output": "<path or null>"}`.
4. Write raw RECUSE response to `$wave_dir/failures/<agent>-<item>.raw` for diagnostic trace.
5. **Judge-tier RECOMMEND (checked before depth cap):** if `RECOMMEND` resolves to `judge` tier (i.e., `RECOMMEND == "judge"` or the agent named in `RECOMMEND` maps to the `judge` capability alias in `agent_to_capability`) → mark item `blocked` AND surface to user with full `escalation_log`. Do not dispatch. This check fires regardless of `escalation_depth`.
6. **Depth cap:** if `escalation_depth >= 3` (default `max_escalations`) → mark item `blocked`; log to `$wave_dir/batch-abort.log`.
7. **Cloud unavailability:** if `RECOMMEND` names a cloud agent and cloud is unreachable → mark item `blocked` (not `failed`).
8. **Malformed RECUSE** (missing `RECUSAL_REASON`): mark item `failed`, write raw to failures/.
9. Otherwise: build a well-formed `## Escalation context` section and append it to the digest before dispatch. Every cloud agent dispatch **must** have this section — ambiguous context is worse than no context.
   - `uplift` verdict from uplift-decider (or ATTEMPTED=yes): append `## Escalation context\nmode: uplift\nPrior partial output: <PARTIAL_OUTPUT path>\nRecusal reason: <RECUSAL_REASON>`. Include all prior escalation_log entries as context.
   - `restart` verdict from uplift-decider (or ATTEMPTED=no with no prior output): append `## Escalation context\nmode: restart\n(no partial output — fresh start)` — explicitly marks restart so the cloud agent branches deterministically.
   - Direct dispatch (no uplift-decider step, e.g. wave-reviewer → implementer-cloud): append `## Escalation context\nmode: direct\nRecusal reason: <RECUSAL_REASON>` and include PARTIAL_OUTPUT path if present.

   **Digest pre-check before uplift-decider dispatch:** `grep -q '^## Escalation context' <digest>` — if absent, do not dispatch; mark item `blocked` with reason `malformed-digest:missing-escalation-context`.

   Fire `Agent(subagent_type: RECOMMEND, prompt: <digest-path>, timeout: ${WORKER_TIMEOUT_SEC:-600})`. Apply this same Step 5r check to the new response — recursive re-dispatch until STATUS is not RECUSE, depth cap hit, or cloud unavailable.

**State transitions on STATUS:** On `STATUS: COMPLETE` + verify pass → `update-marker --status x`. On recuse depth cap → `update-marker --status !`. On `STATUS: PARTIAL` → `update-marker --status +`. On dispatch → `update-marker --status ~`.

**RECUSE idempotency on resume:** On orchestrator crash between RECUSE receipt and next dispatch, re-read `escalation_log` in `wave.md`. Use `findings/<next-agent>-<item>.jsonl` absence as canonical "not yet dispatched" signal — do not re-dispatch already-attempted tiers.

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

**wave-reviewer loop** (for code items only, max 5 iterations):
```
Agent(subagent_type: "wave-reviewer",
  prompt: "<code-review-digest path>")
```
Iterate until no plan-material/crisis findings, or cap hit.

---

## Step 5.5 — CI-safety final wave (complex plans only)

**Pre-check:** `COMPLEXITY: complex` AND `TEST_FRAMEWORKS` present (from recon or forwarded in plan.json). Skip entirely for `trivial` and `moderate`.

For `COMPLEXITY: complex`, append a final "CI-safety" wave to the plan before dispatching the last implementation wave. This wave runs the project's declared test/lint/build commands.

**Parse TEST_FRAMEWORKS tokens:**
```
parsedFrameworks = TEST_FRAMEWORKS.split(',').map(t => t.trim()).filter(t => t !== 'none')
```
Each token format: `{framework}@{test-dir}[+ci:{system}]`
- `framework` (before `@`) → maps to a test command (e.g. `jest` → `npx jest`, `pytest` → `pytest`, `node` → `node --check`)
- `ci` tag (after `+ci:`) → CI entry point file (e.g. `.github/workflows/ci.yml`)

**CI-safety wave structure:**
- Items are dispatched to `test-writer` and `wave-reviewer` tiers (same as today)
- If `parsedFrameworks` is empty (TEST_FRAMEWORKS was `none` or absent): wave still runs; items target `node --check` on all `.js` files in the plan's `target_resources`. Emit `STATUS: COMPLETE` with "no CI commands detected — ran syntax check only".
- Wave commit message: `"ci: verify CI-safety gate — <plan-slug>"`

This is a template the orchestrator merges into the plan — no new agent role.

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

After writing `verify.json`, emit one calibration tuple per completed item (COMPLETE or PARTIAL only):

```sh
node tools/c-thru-plan-harness.js calibrate \
  --item "<item-id>" --agent "<agent>" \
  --confidence "<high|medium|low or absent→medium>" \
  --verify-pass "<true|false|null>" \
  [--has-confidence]   # flag: omit when CONFIDENCE was absent in STATUS block \
  --wave-dir "$wave_dir"
```

Pass `--has-confidence` only when the CONFIDENCE field was present in the worker STATUS block (tracks rubric adoption; target ≥80%). See docs/agent-architecture.md §12.1.

---

## Step 7 — Concat findings and outputs

```sh
node tools/c-thru-plan-harness.js concat --wave-dir "$wave_dir"
```

Writes `$wave_dir/findings.jsonl` (all `findings/*.jsonl` lines) and `$wave_dir/artifact.md` (all `outputs/*.md` content). Pre-check: if any declared output file is missing, set `decision=partial`.

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

**Snapshot:** snapshot both `current.md` and `wave.md` into the plan snapshots directory:
```sh
cp <current.md path> <plan_dir>/plan/snapshots/p-<NNN>.md
cp "$wave_dir/wave.md" "<plan_dir>/plan/snapshots/wave-<NNN>.md"
```
(Derive `plan_dir` by stripping `waves/<NNN>` from `wave_dir`: `plan_dir=$(dirname $(dirname $wave_dir))`)

**Append to journal.md:**
- Structured entry: wave outcome + 2–3 key findings from `wave-summary.md`.

Do NOT update `current.md` item statuses here — the driver's deterministic pre-processor marks `[x]` items based on structured findings. The orchestrator writes `produced:` paths only if the worker findings include them in the structured JSON schema.

---

## Step 12 — Git commit

If `verify.json` shows no hard failures:

```sh
# Emit sorted unique target paths; exits non-zero on malformed wave.md
targets=$(node tools/c-thru-plan-harness.js targets --wave-md "$wave_dir/wave.md") \
  || { echo "targets subcommand failed — aborting commit"; COMMITTED=no; }

if [ -n "$targets" ]; then
  git add $(echo "$targets" | xargs -I{} sh -c 'test -f "{}" && echo "{}"')
fi

git commit -m "<commit_message from wave.md frontmatter>

Wave: <NNN>"
```

The `test -f` filter silently skips non-existent paths (e.g. items with empty `target_resources: []`). The `targets` subcommand replaces the former `jq` invocation on `wave.json` — no `jq` dependency.

The `Wave: <NNN>` trailer enables resume dedup via `git log --grep`.
On any git error: proceed, set `COMMITTED: no`.

---

## Step 13 — Return STATUS

```
STATUS: COMPLETE|PARTIAL|ERROR
WAVE: <NNN>
COMMITTED: yes|no
COMPLEXITY: trivial|moderate|complex
AFFECTED_ITEMS: [<item-id>, ...]
FINDINGS_PATH: waves/NNN/wave_summary.md
SUMMARY: ≤20 words
```

- `STATUS=COMPLETE`: wave ran to completion; driver will classify transition (clean/dep_update/outcome_risk)
- `STATUS=PARTIAL`: crisis cut the wave short; driver surfaces wave_dir to user
- `STATUS=ERROR`: unrecoverable failure; driver surfaces wave_dir to user
