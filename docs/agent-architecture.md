# Agentic Plan/Wave Architecture

The `/c-thru-plan` skill drives complex tasks through a wave-based execution loop using
specialized agents (see `agents/` directory). Each agent declares its own name as its
`model:` — the c-thru proxy resolves it to a hardware-appropriate concrete model at
request time.

> **Canonical source.** This roster is descriptive; the authoritative agent→capability
> mapping lives in [`config/model-map.json#agent_to_capability`](../config/model-map.json), and the
> full agent→model→endpoint table is the README ["Agent routing reference"](../README.md#agent-routing-reference)
> (verified live by `test/agent-mapping-complete.test.js`). The dispatch edges below are verified by
> `test/agent-dispatch-graph.test.js`. If this section disagrees with those, they win.

> **How the agent name actually reaches the proxy.** An agent's `model:` frontmatter is not sent to
> the backend, and hooks are forbidden from rewriting `body.model`. Instead the `PreToolUse` hook
> ([`tools/c-thru-agent-router-hook.sh`](../tools/c-thru-agent-router-hook.sh)) prepends a signed
> sentinel — `[[c-thru-agent:<name>:<hmac>]]` — to the *prompt text*; the proxy verifies the HMAC,
> strips it, and only then resolves agent → capability → model. This is illustrated end to end in the
> README's [Architecture section](../README.md#architecture-how-a-prompt-becomes-a-model-call), and
> steppable in [`docs/request-flow.html`](request-flow.html).

## Agent roster

The fleet is **27 agents**: 22 pipeline/utility roles plus **5 brand-name agents**
(`grok`, `deepseek`, `qwen`, `kimi`, `gemini`). Each declares `model: <its-own-name>` in
frontmatter. The proxy resolves
`name → agent_to_capability → llm_profiles[capability][mode][tier] → concrete model` at
request time (or a `model:` pin for brand agents). Pipeline agents map 1:1 (capability == name)
**except** the two ⚠ rows. Brand agents pin to concrete models. The **Dispatches →**
column is the inter-agent dispatch/escalation graph, parsed from each agent's `UNBLOCKED_TASKS`
block (self-loops are continuation, `↑` marks an escalation to a harder tier). Brand agents are
always leaves.

**Delivery (hard constraint).** Fleet definitions are **not** default-stored for the Claude CLI.
`tools/c-thru` builds JSON from repo `agents/*.md` and passes it as ephemeral
`--agents <json>` on each launch. `install.sh` actively removes legacy
`~/.claude/agents/c-thru` links. Plain `claude` / marketplace-plugin-only sessions do not load
this fleet.

| Agent | Capability | Role | Dispatches → |
|---|---|---|---|
| `planner` | `planner` | Implementation/architecture plans before any code | `coder`, `planner-hard` ↑ |
| `planner-hard` | `planner-hard` | High-stakes/ambiguous/cross-system planning (Opus) | `coder` |
| `explore` | `explore` | Read-only context-gathering before planning/coding | `coder`, `planner` |
| `coder` | `coder` | Writes/edits/refactors code to a plan | `coder` (continue), `tester`, `debugger-hypothesis` |
| `coder-fallback` | `coder-fallback` | Second attempt when `coder` stalls (different model) | `tester`, `debugger-hypothesis` |
| `tester` | `tester` | Runs/writes tests, verifies behavior | `tester` (continue), `code-reviewer`, `debugger-hypothesis` |
| `code-reviewer` | `code-reviewer` | Correctness/style/coverage review after `coder` | `coder` (fix), `reviewer-security` ↑ |
| `reviewer-security` | `reviewer-security` | Security review (authz, crypto, injection); hard-fail | `coder` (fix) |
| `reviewer-plan` ⚠ | `code-reviewer` | Plan-document review (APPROVED / NEEDS_REVISION) | `planner` (revise) |
| `plan-scheduler` ⚠ | `fast-generalist` | Standalone helper: dispatches a wave's READY_ITEMS via `/schedule-plan-tasks` when invoked directly (e.g. "schedule these tasks"). **Not** part of `/c-thru-plan`'s own Phase 4 loop — that loop dispatches straight to `coder` | (leaf) |
| `debugger-hypothesis` | `debugger-hypothesis` | Generates/ranks hypotheses for an unknown bug | `debugger-investigate`, `debugger-hard` ↑ |
| `debugger-investigate` | `debugger-investigate` | Deep investigation of a hypothesis (logs, traces) | `debugger-investigate` (continue), `tester`, `debugger-hard` ↑ |
| `debugger-hard` | `debugger-hard` | Bugs resisting normal debugging (Opus); hard-fail | `coder` (fix), `tester` |
| `docs` | `docs` | Updates CLAUDE.md/README/help after API changes | `docs` (continue) |
| `generalist` | `generalist` | Best all-rounder when no specialist fits | (leaf) |
| `fast-generalist` | `fast-generalist` | Fastest generalist for quick one-shot answers | (leaf) |
| `fast-scout` | `fast-scout` | Rapid read-only recon / context mapping | (leaf) |
| `long-context` | `long-context` | 384K-window retrieval over large spans | (leaf) |
| `writer` | `writer` | Long-form prose (docs, release notes, guides) | (leaf) |
| `edge` | `edge` | Tiny-model tasks (classify, summarize, transform) | (leaf) |
| `vision` | `vision` | Screenshots, diagrams, image OCR | (leaf) |
| `pdf` | `pdf` | PDF parsing (tables, multi-column, figures) | (leaf) |
| `grok` 📌 | `model:grok-4.5` | Brand: xAI Grok commercial cloud | (leaf) |
| `deepseek` 📌 | `model:deepseek-v4-pro:cloud` | Brand: DeepSeek cloud OSS | (leaf) |
| `qwen` 📌 | `model:qwen3.6:35b` | Brand: local Qwen | (leaf) |
| `kimi` 📌 | `model:kimi-k2.7-code:cloud` | Brand: Kimi cloud OSS | (leaf) |
| `gemini` 📌 | `model:gemini-pro` | Brand: Google Gemini | (leaf) |

**⚠ Non-1:1 rows.** `reviewer-plan` → `code-reviewer` and `plan-scheduler` → `fast-generalist`.
**📌 Brand pins** map via `model:<concrete>` (always that model, not hardware-tier profiles).
**Utility passthroughs** `WebSearch` / `WebFetch` /
`Monitor` are tool calls mapped to `fast-scout` in `agent_to_capability` for observability only —
they are not agent files and the router does not override their model.

## Grok surfaces (brand vs gov vs CLI)

Grok appears in **three** places. Parents and operators must not treat them as one path.

| Surface | How it is reached | Runtime | Auth | c-thru owns it? |
|---|---|---|---|---|
| **A — xAI Responses gateway** | Opinion leaf: `Agent(grok)`. Full Claude Code session: `cthru --model grok-build` (or agent view with `cthru agents --model grok-build`). | Claude Code sends Anthropic Messages → c-thru's shared Responses translator → `api.x.ai/v1/responses`; **Claude Code owns and executes the client tools** | `XAI_API_KEY` (metered API billing) | Yes |
| **B — Capability pin** | Mode `best-cloud-gov`, tier ≥ 32gb: `generalist` / `writer` cells → `grok-4.5` | Same proxy path as A | `XAI_API_KEY` | Yes (`llm_profiles`) |
| **C — Grok Build CLI** | `grok-cc` plugin / `/grok-cc:rescue` / global Claude policy (stuck, review, explicit implement) | Separate `grok -p` process (or ACP client) — **Grok owns its session and tools; it is not the c-thru proxy** | `grok login` preferred (pooled subscription usage); `XAI_API_KEY` explicit fallback only when no login session exists — an ambient key is stripped from the child env when login is present, closing an inversion risk. See `docs/subscription-auth.md` § Delegate CLIs. | No (marketplace plugin) |

**Install and auth conditions.** Surface A's named leaf needs the **CLI install** path (`c-thru` injects `--agents`); the full-session `--model grok-build` route only needs c-thru plus a usable `XAI_API_KEY`. Surface C needs the **grok-cc** plugin and a working Grok CLI; it works without c-thru fleet injection. Surfaces A and B use xAI's OpenAI-compatible Responses API, including stateless `function_call` / `function_call_output` round trips and Responses SSE translation. Live canary: `C_THRU_LIVE_XAI=1 node test/proxy-xai-live.test.js`. A cached `grok login` session cannot authenticate the API route, and an `XAI_API_KEY` cannot be silently replaced with CLI subscription auth.

**Support boundary.** Anthropic does not officially support substituting a
non-Claude model behind Claude Code. Surface A is therefore an opt-in c-thru
compatibility layer: its contract is the checked request/response translation
and live canary above, not an upstream Anthropic compatibility guarantee.

### Dispatch ladder (first match wins)

| Priority | Signal | Route |
|---|---|---|
| 1 | Explicit Grok implement / fix / multi-step write | **C** CLI for subscription-backed Grok-owned execution; **A** via `cthru --model grok-build` when the user explicitly wants Claude Code tools/API routing; otherwise `coder` / Codex per global policy |
| 2 | Explicit Grok review / diagnose, no edits | **C** CLI `--read` / `/grok-cc:review` |
| 3 | *Ask Grok* opinion / critique (no multi-file edit contract) | **A** brand leaf |
| 4 | Normal Sonnet/Opus/Fable implementation | Codex / native — **not** Grok |
| 5 | Stuck or Codex path blocked | **C** CLI (report prior failure first) |
| 6 | Silent `best-cloud-gov` generalist/writer | **B** capability pin |
| 7 | New app LLM features | xAI Responses API directly; do not shell through the Grok CLI as a faux stateless model API |

**Hard rules.** API-route failures do not prove the CLI works, and CLI success does not prove `XAI_API_KEY` billing is usable: they are different auth stacks. Never silent-fallback “as Grok” while answering with Claude. The named `grok` brand agent remains an opinion **leaf** (one spawn, no chains); use the explicit full-session route for Grok-backed patch work. Do not adapt `grok -p` or ACP into `/v1/messages`: Grok Build is already a tool-owning coding agent, while Claude's gateway contract expects model-emitted tool calls for Claude Code to execute.

Fleet `--append-system-prompt` tells the parent to spawn brand agents for *ask &lt;name&gt;* opinion asks; multi-file Grok implement/review should not default to the brand leaf. See also `docs/connectivity-modes.md` (gov Grok cells) and `docs/env-vars.md` (`XAI_API_KEY`, live canary).

## 4-layer resolution

```
Claude Code sends  subagent_type: coder
                          │
                          ▼  agent_to_capability (config/model-map.json)
                   coder                       (capability alias; 1:1 here)
                          │
                          ▼  llm_profiles[coder][<mode>][<detected-hw-tier>]
                   per-mode × per-tier model string
                          │
                          ▼  model_routes → endpoints
                   gemini-pro @ best-cloud/64gb  (or tier/mode-appropriate equivalent)
```

See `docs/hardware-profile-matrix.md` for the full hardware-profile table, and the README
["Agent routing reference"](../README.md#agent-routing-reference) for the resolved model per agent.

> **Reconciled 2026-06-11.** The sections below were rewritten against the live machinery:
> `skills/c-thru-plan/SKILL.md` (the executable phase spec), `tools/c-thru-plan-harness.js`
> (deterministic wave mechanics), and the contract tests `test/agent-status-schema.test.js`,
> `test/planner-return-schema.test.js`, and `test/agent-dispatch-graph.test.js`. If this
> document disagrees with those, they win.

## Wave lifecycle (Phases 0–5)

Driven by `skills/c-thru-plan/SKILL.md`; all agent names below are live `agents/*.md` files.

0. **Pre-check** — resume/restart/abort if prior plan state exists; `.c-thru-contract-version`
   detection for pre-refactor plans
1. **Discovery** — read-only reconnaissance by the driver (no agent spawn), then an `explore`
   gap-advisor call (`GAPS: N`), then a parallel `explore` fan-out, one agent per gap
   (max 60s each; partial discovery acceptable, missing gaps recorded as `assumed`)
2. **Plan construction** — `planner` (signal=intent; the only unconditional cloud-judge call)
   writes `current.md` with an immutable `## Outcome` section + all items
3. **Plan review loop** — `reviewer-plan` returns `APPROVED` or `NEEDS_REVISION`; revision
   rounds shared with Phase 5 under the 20-round cap
4. **Wave loop** — three-branch driver loop repeats until no ready items:
   - `coder` (wave executor) receives `current.md` + `READY_ITEMS` + a wave dir; mechanics
     (topological sort, resource-conflict batching, batch-abort thresholds, `wave.md`
     marker updates) live in `tools/c-thru-plan-harness.js`, not in an orchestrator agent
   - **Deterministic pre-processor** — a driver function in the skill (zero LLM) — parses
     `findings.jsonl`, applies `[x]` markings + dep discoveries to `current.md` atomically,
     and classifies the transition:
     - `clean` → commit message generated locally; no planner call; next wave proceeds
     - `dep_update` → `planner` (signal=wave_summary) updates affected items' deps
     - `outcome_risk` → `planner` (signal=wave_summary, cloud judge) re-evaluates outcome
       integrity; `decision.json` / `replan-brief.md` exist only on this exception path
   - Driver context holds pointers + ≤20-line STATUS blocks, never full file bodies;
     `READY_ITEMS[]` drives the next wave
5. **Final review** — `code-reviewer` gap analysis; `planner` (signal=final_review) adds gap
   items if found

## Local-first cost discipline

Cloud-tier calls happen only at two points: initial plan construction (signal=intent) and
`outcome_risk` re-planning — everything else is local-tier agents or zero-LLM driver code
([x] marking, ready-item selection, topo-sort/batching, verification, git commits). The
concrete model behind each agent at each tier is config-driven — see the README
["Agent routing reference"](../README.md#agent-routing-reference), regenerated from
`config/model-map.json` (never hardcode model names here; that table is the derived truth).

## Revision cap

20 revision rounds total (plan review + final-review cycles). Tracked in
`${TMPDIR:-/tmp}/c-thru/<repo>/<slug>/meta.json`. Counter reaches 20 → user escalation.

## Wave state layout

State root: `${TMPDIR:-/tmp}/c-thru/<repo-basename>/<slug>/`
Completed plans archived to: `~/.claude/c-thru-archive/<slug>-<ts>/`

```
${TMPDIR:-/tmp}/c-thru/<repo>/<slug>/
  current.md          — single source of truth; ## Outcome (immutable) + ## Items (living dep map)
  meta.json           — slug, revision_rounds, wave_count, created, status
  journal.md          — wave-by-wave log (append-only)
  learnings.md        — cross-wave wiki; refreshed by planner step 2
  plan/snapshots/     — p-NNN.md (current.md snapshot) + wave-NNN.md (wave.md snapshot) per wave
  discovery/          — explore-agent summaries from Phase 1
  pre-processor.log   — structured log of each wave transition classification
  .c-thru-contract-version  — value 3 = wave.md contract (v2 plans have value 2; v1 plans absent marker)
  waves/
    NNN/
      wave.md         — markdown manifest: YAML frontmatter (wave_id, commit_message,
                        contract_version:3, batches:[[id,...],...] # computed) +
                        checkbox items (needs:, batch:# computed, target_resources:,
                        escalation_*, produced:, wave:). Only the orchestrator writes this
                        file via the update-marker subcommand. Workers never write wave.md.
                        Field contract: needs: in wave.md (forward edges, authoritative);
                        depends_on: in current.md (unchanged). Reverse edges derived on demand
                        via findDependents() — never stored.
      wave-summary.md — key findings, improvement signals, open questions
      wave_summary_compressed.md — prose-stripped findings for planner context
      digests/        — <agent>-<item>.md per execution item
      outputs/        — <agent>-<item>.md per completed item
      findings/       — <agent>-<item>.jsonl per item; findings.jsonl aggregate
      artifact.md     — consolidated wave output
      verify.json     — deterministic post-wave checks
      batch-abort.log — abort decisions
      decision.json   — outcome_risk escalation verdict (exception path only)
      replan-brief.md — outcome_risk replan brief (exception path only)
```

### wave.md marker alphabet

| Marker | State       | Meaning |
|--------|-------------|---------|
| `[ ]`  | pending     | Not yet dispatched |
| `[~]`  | in_progress | Dispatched, STATUS not yet received |
| `[x]`  | complete    | Worker returned STATUS: COMPLETE and verify passed |
| `[!]`  | blocked     | Escalation depth cap hit, cloud unavailable, or judge-tier sentinel |
| `[+]`  | extend      | Worker returned STATUS: PARTIAL; follow-up item needed |

State transitions are written by `node tools/c-thru-plan-harness.js update-marker` with an advisory O_EXCL file lock.

## Worker STATUS contract

All worker agents (`coder`, `coder-fallback`, `tester`, `docs`, `code-reviewer`,
`reviewer-security`, `debugger-hypothesis`, `debugger-investigate`, `debugger-hard`) return a
structured STATUS block, validated by `test/agent-status-schema.test.js` (the executable spec
for this section). Required fields:

```
STATUS: COMPLETE|PARTIAL|ERROR
CONFIDENCE: high|medium|low
UNCERTAINTY_REASONS: <comma-separated rubric bullets; omit when high>
WROTE: <output.md path>
INDEX: <INDEX.md path>
FINDINGS: <findings.jsonl path>
FINDING_CATS: {crisis:N,plan-material:N,contextual:N,trivial:N,augmentation:N,improvement:N}
SUMMARY: <≤20 words>
```

`CONFIDENCE` is worker self-assessment via the rubric embedded in each agent prompt. Absent
CONFIDENCE is treated as `medium` by the driver (migration shim — graceful degradation).

`reviewer-security` is `hard_fail` — no degraded substitute exists. On recusal (missing
threat-model context for a privilege boundary), the item is marked `blocked` and surfaced to
the user; the driver does NOT attempt further escalation.

---

## Complexity & deployability signals

The `coder` (wave executor) evaluates plan complexity before wave emission (Step 2.5) and gates
several behaviors on the result. The authoritative contract is the "Complexity & deployability
contract" section of `skills/c-thru-plan/SKILL.md`.

### Complexity evaluation

Three structural signals determine complexity (first match wins):

| Signal | Source |
|---|---|
| `files_affected` | Count of distinct `target_resources` across all READY_ITEMS |
| `shared_interfaces` | Schemas/types consumed by ≥2 files outside the plan's file set |
| `external_consumers` | Callers not in the plan's file set that reference plan-touched files |

**Rubric:**
- `trivial`: files_affected ≤ 2, shared_interfaces = 0, external_consumers = 0
- `complex`: files_affected ≥ 5 OR external_consumers > 0
- `moderate`: all other cases

Complexity gates the **deployability guard** only. Migration and CI/CD are handled by per-wave self-questions (see below) — not by complexity tier.

`COMPLEXITY` is emitted in the wave executor's STATUS return block. A calibration tuple
`{intent_summary, file_count, classification, downstream_wave_count}` is written to
`$wave_dir/cascade/complexity.jsonl`.

Absent `COMPLEXITY` → treated as `moderate` (safe default — does not skip guards).

### Per-wave self-questions

Before emitting each wave, the wave executor explicitly reasons through two questions:

1. **Migration:** *Does this wave touch any state, data, or files that need to be migrated?* (schema changes, renamed runtime fields, data format changes) → sets `MIGRATION_REQUIRED: yes|no`
2. **CI/CD:** *Could merging this wave break a CI pipeline?* (renamed entry points, changed exports, removed files) → sets `ci_risk: yes` in wave.md frontmatter when yes

These are reasoning steps answered from item descriptions and recon context — not file-pattern scanning or user prompts. Any plan can trigger migration or CI-safety waves regardless of complexity tier.

### Test/CI reconnaissance (TEST_FRAMEWORKS)

The `explore` agent emits a `TEST_FRAMEWORKS` STATUS field: comma-separated
`{framework}@{test-dir}[+ci:{system}]` tokens, or `none`. The driver reads this from
`$plan_dir/discovery/` and forwards it into each worker digest's `## Mission context` section
as `Test infrastructure: <value>`. Absent → `none` (graceful degradation, no behavioral change).

### Deployability guard

For `moderate` and `complex` plans, each wave is validated before emission: no item in wave N may introduce an import/call-site to a module first produced in wave N+1 or later. On violation, the default resolution is **collapse** (merge the pair into the same wave). Split-with-stub is used only when the referenced module exports >1 symbol and only one is needed in the earlier wave.

Guard activations are logged to `$wave_dir/cascade/deployability.jsonl`:
```
{"wave_id":N,"violation_type":"forward-ref","item_id":"<id>","imported_path":"<path>","resolution":"collapse|split-stub"}
```
The guard is skipped entirely for `trivial` plans.

### State migration evaluation (MIGRATION_REQUIRED)

Triggered by the per-wave migration self-question — not by complexity tier. When `MIGRATION_REQUIRED: yes`, a dedicated migration wave is inserted immediately before the schema change wave. Migration items carry `migration_target` and `migration_plan` fields and are dispatched to `coder`. Absent `MIGRATION_REQUIRED` → `no` (graceful degradation).

### CI-safety final wave

Appended as the **last wave of the plan** whenever any wave carries `ci_risk: yes` — regardless of complexity tier. The wave parses `TEST_FRAMEWORKS` tokens to derive test commands, then dispatches items to `tester` and `code-reviewer`. Empty or `none` frameworks → falls back to `node --check` on plan target files.

---

## Escalation paths

Escalation is encoded in each agent's `UNBLOCKED_TASKS:` block — the inter-agent dispatch
graph in the roster table above — and verified end-to-end by `test/agent-dispatch-graph.test.js`
(the executable spec; every `subagent_type` target must resolve agent→capability→model).
The live escalation edges (`↑` rows in the roster):

| Agent | Escalates to | Trigger |
|---|---|---|
| `planner` | `planner-hard` | high-stakes / ambiguous / cross-system plan |
| `code-reviewer` | `reviewer-security` | change touches auth/crypto/input-validation surface |
| `debugger-hypothesis` | `debugger-hard` | hypotheses exhausted |
| `debugger-investigate` | `debugger-hard` | investigation exhausted |

`coder-fallback` has no inbound dispatch edge — it is selected by **description** ("Use when
coder fails or produces incorrect output"), not by an `UNBLOCKED_TASKS` line.

`debugger-hard`, `planner-hard`, and `reviewer-security` are `hard_fail` — no degraded
substitute; on failure or recusal the item is marked `blocked` and surfaced to the user.

---

## RECUSE STATUS contract

All worker agents carry a self-recusal rubric. Recusal is outcome-focused — signal: "cannot verify output satisfies criteria."

```
STATUS: RECUSE
ATTEMPTED: yes|no
RECUSAL_REASON: <one sentence — specific unverifiable outcome condition>
RECOMMEND: <next agent name>
PARTIAL_OUTPUT: <repo-relative path if ATTEMPTED=yes — omit when ATTEMPTED=no>
SUMMARY: <≤20 words>
```

**RECOMMEND is hardcoded per agent** — each agent names its immediate successor only. No agent needs a full escalation table.

**Formatting rules:** Every STATUS block appears AFTER `## Work completed`, `## Findings (jsonl)`, and `## Output INDEX` sections. Each STATUS key on its own line (`^([A-Z_]+): (.*)$`). No markdown formatting inside STATUS key values. `<think>...</think>` blocks appear BEFORE work sections and are stripped by the driver before parsing.

---

## Agent I/O contracts — STATUS value table

Executable spec: `test/agent-status-schema.test.js` (worker shapes) and
`test/planner-return-schema.test.js` (planner + RECUSE fixtures).

| STATUS | Required fields | Notes |
|---|---|---|
| COMPLETE | STATUS, CONFIDENCE, WROTE, INDEX, FINDINGS, FINDING_CATS, SUMMARY | UNCERTAINTY_REASONS omit when high |
| PARTIAL | Same as COMPLETE | Crisis finding — driver marks the item failed |
| ERROR | STATUS, SUMMARY | Unrecoverable setup failure |
| RECUSE | STATUS, ATTEMPTED, RECUSAL_REASON, RECOMMEND, SUMMARY | PARTIAL_OUTPUT only when ATTEMPTED=yes; no WROTE/INDEX/FINDINGS. Exception: `reviewer-security` omits ATTEMPTED, PARTIAL_OUTPUT, and RECOMMEND (recuses before any work; no cascade target) |

## Non-standard STATUS shapes by agent

Agents that don't use the standard worker STATUS block:

| Agent | STATUS shape | Key non-standard fields |
|---|---|---|
| `planner` | `STATUS: COMPLETE\|CYCLE\|ERROR` + `VERDICT: ready\|done` + `READY_ITEMS` + `COMMIT_MESSAGE` + `SUMMARY` (+ `ITEMS` on CYCLE, `PARALLEL_WAVES` annotation) | Validated by `test/planner-return-schema.test.js` rules a–h: VERDICT=ready requires non-empty READY_ITEMS; VERDICT=done forbids READY_ITEMS and COMMIT_MESSAGE |
| `reviewer-plan` | `VERDICT: APPROVED\|NEEDS_REVISION` + `WROTE` + `FINDINGS_COUNT` + `SUMMARY` | No CONFIDENCE |
| `explore` | `STATUS: COMPLETE\|PARTIAL\|ERROR` + `WROTE` + `SUMMARY` (+ `GAPS: N` as gap advisor, `TEST_FRAMEWORKS` on CI questions) | No CONFIDENCE, no FINDING_CATS |

---

## Cross-wave communication

`current.md` only. Agents never read each other's outputs directly.
The deterministic pre-processor applies dep_discoveries from findings to pending items in current.md between waves — this is the structured channel for cross-wave knowledge.

## Skill source

Skills live in `skills/`, agents live in `agents/`. Neither is installed as a persistent
`~/.claude/` symlink — `install.sh`'s `cleanup_old_persistent_config()` actively removes any
legacy `~/.claude/skills/c-thru/` / `~/.claude/agents/c-thru/` symlink it finds. The live
mechanism is ephemeral `--agents`/`--settings` JSON injection per `c-thru` launch (see the
"Injection layer" table in `docs/functionality-map.md`).
