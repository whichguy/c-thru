# Agentic Plan/Wave Architecture

The `/c-thru-plan` skill drives complex tasks through a wave-based execution loop using
specialized agents (see `agents/` directory). Each agent declares its own name as its
`model:` — the c-thru proxy resolves it to a hardware-appropriate concrete model at
request time.

<!-- canonical list: config/model-map.json#agent_to_capability -->

## Agent roster

| Agent | Capability alias | Role |
|---|---|---|
| discovery-advisor | pattern-coder | Reads recon summary, produces prioritized gap questions |
| explorer | pattern-coder | Read-only reconnaissance; surveys codebase for gap questions |
| planner | judge | Unified signal-based planner; reads outcome + findings + pending items; updates living dep map; returns READY_ITEMS[] |
| planner-local | local-planner | Dep-update planner (local 27B+); applies dep_discoveries to affected items on dep_update transition; never on intent or outcome_risk |
| auditor | judge | Exception-path wave direction (continue/extend/revise); invoked by cloud judge on outcome_risk escalation only |
| final-reviewer | judge | End-of-plan gap analysis |
| review-plan | judge | Plan quality review (max 20 rounds) |
| journal-digester | judge | Out-of-band: synthesizes improvement suggestions → CLAUDE.md proposals |
| security-reviewer | judge-strict | Security-focused code review; hard_fail on cascade |
| plan-orchestrator | orchestrator | Pure executor: topo-sort → batch → progressive injection → workers → verify → commit |
| integrator | orchestrator | Wires completed units (routes, exports, DI) |
| doc-writer | orchestrator | User-facing documentation from implemented code |
| wave-synthesizer | code-analyst | Exception-path: produces replan-brief.md when cloud judge needs context compression on outcome_risk/revise scenarios |
| learnings-consolidator | pattern-coder | Refreshes learnings.md from prior findings; spawned by planner (step 2 of algorithm) |
| scaffolder | pattern-coder | Mechanical file/directory scaffolding (stubs, boilerplate) |
| test-writer | code-analyst | Tests that catch subtle bugs; reads implementation first |
| reviewer-fix | code-analyst | Iterative review+fix loop (max 5 rounds per item) |
| implementer | deep-coder | Core business logic; multi-file aware |

## 4-layer resolution

```
Claude Code sends  model: implementer
                          │
                          ▼  agent_to_capability (config/model-map.json)
                   deep-coder
                          │
                          ▼  llm_profiles[<detected-hw>][deep-coder]
                   connected_model / disconnect_model
                          │
                          ▼
                   devstral-small:2  (or tier-appropriate equivalent)
```

See `docs/hardware-profile-matrix.md` for the full 6-profile × 5-alias table.

## Wave lifecycle (7 phases)

0. **Pre-check** — resume/restart/abort if prior plan state exists; contract-version detection for pre-refactor plans
1. **Discovery** — reconnaissance + gap-fill via `explorer` agents (read-only)
2. **Plan construction** — `planner` (signal=intent, cloud judge) writes `current.md` with `## Outcome` section + all items
3. **Plan review loop** — `review-plan` up to 20 rounds
4. **Wave loop** — three-branch driver loop repeats until no ready items:
   - `plan-orchestrator` (pure executor per wave):
     - Topological sort + resource-conflict batching → `wave.json` (from READY_ITEMS input)
     - Assemble digest files (reads learnings.md internally)
     - Dispatch worker batches in parallel with progressive batch injection
     - Concat findings → `findings.jsonl`; concat outputs → `artifact.md`
     - Verify (no LLM) → `verify.json`
     - Write `wave-summary.md`
     - Append `journal.md`
     - `git commit` (trailer: `Wave: NNN`)
   - **Deterministic pre-processor** classifies transition (zero LLM):
     - `clean` → local 7B generates commit_message; no planner call; next wave proceeds
     - `dep_update` → `planner-local` (local 27B+) updates affected items' deps; local only
     - `outcome_risk` → `planner` (cloud judge) re-evaluates outcome integrity; may invoke `auditor` and `wave-synthesizer`
   - Driver receives compact STATUS block per wave; READY_ITEMS[] drives next wave
5. **Final review** — `final-reviewer` gap analysis; `planner` (signal=final_review) if gaps found

## Local-first cost pyramid

```
COMPONENT               COST         MODEL           FREQUENCY
──────────────────────────────────────────────────────────────
initial planning        cloud        judge           once/plan
dep-map update          local 27B+   local-planner   per wave if dep_update
commit_message          local 7B     commit-message-generator  per wave (clean)
[x] marking             zero         deterministic   per wave
ready-item selection    zero         deterministic   per wave
topo-sort / batching    zero         deterministic   per wave
findings injection      zero         deterministic   per batch
verification            zero         bash/node       per wave
git commit              zero         bash            per wave
learnings summary       local 7B     learnings-consolidator    per wave
workers: code           local        devstral-small  N per wave
workers: scaffolding    local        qwen3.5:1.7b    N per wave
workers: tests          local        qwen3.5:9b      N per wave
workers: docs           local        qwen3.5:9b      N per wave
outcome risk check      cloud        judge           rare, on flag
```

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
  plan/snapshots/     — p-NNN.md per wave
  discovery/          — explorer summaries from Phase 1
  pre-processor.log   — structured log of each wave transition classification
  .c-thru-contract-version  — value 2 = refactored contract (v1 plans absent this marker)
  waves/
    NNN/
      wave.json       — orchestrator-internal batch plan (wave_id, commit_message, batches[])
      wave-summary.md — key findings, improvement signals, open questions
      wave_summary_compressed.md — prose-stripped findings for planner context
      digests/        — <agent>-<item>.md per execution item
      outputs/        — <agent>-<item>.md per completed item
      findings/       — <agent>-<item>.jsonl per item; findings.jsonl aggregate
      artifact.md     — consolidated wave output
      verify.json     — deterministic post-wave checks
      batch-abort.log — abort decisions
      decision.json   — auditor verdict (exception path only)
      replan-brief.md — wave-synthesizer output (exception path only)
```

## Worker STATUS contract

All worker agents (implementer, reviewer-fix, test-writer, scaffolder) return a structured STATUS block. Required fields:

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

`CONFIDENCE` is worker self-assessment via the §12.1 rubric embedded in each agent prompt. Absent CONFIDENCE is treated as `medium` by the orchestrator (migration shim — graceful degradation). The orchestrator logs `{item, agent, confidence, verify_pass, compliance}` tuples to `$wave_dir/cascade/<item>.jsonl` after step 6 for Wave-1 calibration measurement.

`reviewer-fix` additionally returns `ITERATIONS: N`.

---

## Cross-wave communication

`current.md` only. Agents never read each other's outputs directly.
The deterministic pre-processor applies dep_discoveries from findings to pending items in current.md between waves — this is the structured channel for cross-wave knowledge.

## Skill source

Skills live in `skills/` and are installed to `~/.claude/skills/c-thru/` by `install.sh`.
Agents live in `agents/` and are installed to `~/.claude/agents/c-thru/`.
