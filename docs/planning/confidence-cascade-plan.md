# c-thru CONFIDENCE + Cascade — Wave Plan

> **Wave-1 status: COMPLETE** (merged PR #33). Wave-2 design settled; implementation pending
> Wave-1 gate. §§ Appendix A–B contain original research. This document is the living plan.

---

## 0. Why this plan exists

The cascade design depends on one unproven assumption: **local worker models can
self-report CONFIDENCE in a way that correlates with test outcomes**. Wave-1 tested
that assumption before writing cascade code. It passed. Wave-2 builds the routing on
top of that validated signal.

---

## 1. Pre-validation results (completed before Wave-1 branch)

### Experiment A — Local rubric calibration
Model: `qwen3.5:9b`  
Ground truth set in advance: good output → `high`, bad output → `low`

| Output | Expected | Got | Match |
|---|---|---|---|
| null-guard following existing pattern, test confirmed | `high` | `high` | ✓ |
| JWT crypto, no spec, inferred algorithm, no caller site | `low` | `low` | ✓ |

**Gate A: PASSED.** Signal exists in local models. Proceed.

### Experiment B — Cloud materiality check
Model: `qwen3.6:35b` (large-local proxy; `ollama_cloud` degraded at run time)

| Output | Expected | Got | Match |
|---|---|---|---|
| Good output | `high` | `high` | ✓ |
| Bad output | `low` | `low` | ✓ |

**Gate B: BOTH MATCH.** Local adequate; cloud decider is optimization not requirement.  
Re-run with real cloud judge when `ollama_cloud` recovers.

### Pre-experiment S0 — Parser safety
`parsePlannerReturn` uses regex `^([A-Z_]+):\s*(.*)$` — unknown keys silently ignored.  
`CONFIDENCE` and `UNCERTAINTY_REASONS` are valid `[A-Z_]+` keys. Safe.  
**Constraint:** `UNCERTAINTY_REASONS` must be single-line (comma-separated). Multi-line
values are truncated by the regex parser.  
**Gate S0: PASSED.**

### Pre-condition check (step 0)
Phase 1 Stage 1 reads `CLAUDE.md` into `recon.md`; Stage 3 merges into planner context.
§5.2 planner re-read is **redundant** — skip. Noted in PR #33.

**Decision: A passes + B both-match → proceed as planned.**

---

## 2. Wave-1 implementation (COMPLETE — PR #33, merged to main)

### What shipped

| File | Change |
|---|---|
| `agents/implementer.md` | CONFIDENCE rubric + STATUS schema (includes role-canonical medium bullet: "guessed at API surface") |
| `agents/reviewer-fix.md` | CONFIDENCE rubric + STATUS schema + `ITERATIONS: N`; medium/low bullets role-adapted for review+fix work |
| `agents/test-writer.md` | CONFIDENCE rubric + STATUS schema; medium/low bullets role-adapted for test-writing (no ITERATIONS — single-pass role) |
| `agents/scaffolder.md` | Scaffold-specific rubric variant + STATUS schema (no ITERATIONS — single-pass role; tracked separately) |
| `agents/plan-orchestrator.md` | Step 5: extract CONFIDENCE (absent→`medium`); Step 6b: emit calibration tuples |
| `docs/agent-architecture.md` | STATUS contract section |
| `CLAUDE.md` | CONFIDENCE field note |

### Key implementation notes

- `UNCERTAINTY_REASONS` single-line only (parser constraint from S0)
- Scaffolder rubric tracks separately — if scaffolder `low`-rate exceeds other workers
  by >2×, it needs its own rubric variant
- Test fixtures: no worker STATUS fixtures in `test/` — no additions needed
- Orchestrator step 6b emits `$wave_dir/cascade/<item>.jsonl`:
  `{item, agent, confidence, verify_pass, compliance}`

### Calibration formula

```
eligible   = items where CONFIDENCE present AND verify_pass ≠ null
high_items = eligible WHERE confidence = "high"
high_fail  = high_items WHERE verify_pass = false

calibration_rate = (high_items - high_fail) / high_items
compliance       = items_with_CONFIDENCE / total  (target ≥80%)
```

`verify_pass: null` excluded — items without tests produce meaningless signal.
Note: `high_items` is computed as a subset of `eligible` — the `verify_pass ≠ null`
guard is inherited. Any code implementation must apply the `eligible` filter before
computing `high_items` or the null-exclusion silently breaks.

### Wave-1 measurement steps (pending — run after merge)

```
6. Run 3 real /c-thru-plans (≥50 items total, spread across worker types)
   After plan 1 (optional early-exit): prompt local judge over cascade/*.jsonl
   If judge AUC < 0.65 → signal not in output text → exit Wave-1 early

7. Compute calibration per worker type from cascade/*.jsonl

8. Decision gate (require 2 consecutive runs):
   >30% of high-confidence items fail verify → iterate rubric 1 wave, retry
   Fail ×2 → abandon cascade; rely on existing reviewer-fix loop
   PASS → merge to Wave-2
```

---

## 3. Wave-2 target architecture (build after Wave-1 gate passes)

### 3.1 Core cascade design

Every local worker output is a candidate draft. The orchestrator pre-classifies
items before dispatch (Step 4b) and handles agent self-recusal during dispatch (Step 5).

```
Step 4b — Tactical pre-dispatch classification (NEW)
Step 5  — Dispatch (local workers or pre-escalated cloud workers)
Step 5r — Self-recusal handling: walk escalation chain on STATUS: RECUSE
Step 6b — Calibration logging (already in Wave-1)
```

### 3.2 Step 4b — Tactical pre-dispatch classification

The orchestrator reads each assembled digest and annotates `escalation_policy` in
`wave.json` before dispatching. Default is `local`. Escalate only on clear signals.

**Recusal rubric for orchestrator (outcome-focused, not domain-label):**

```
pre-escalate — ANY of:
  - No existing pattern cited by file path, line, or function name for the core operation
  - Success criteria cannot be verified by available means (no test, no structural check)
  - Two or more valid interpretations of the task exist — choosing wrong one fails verify
  - Success criteria contain judgment language: "appropriately", "correctly handle",
    "determine how to", "choose a/the", "design a", "decide between"
  - Item creates a new external interface with no existing equivalent to copy exactly
  - Approach unspecified: "figure out", "implement a solution", "handle X" without
    naming which existing pattern to apply

local — otherwise (the default)
```

**Recusal rule:** when ANY `pre-escalate` signal fires, annotate and move on.
Do not reason about whether the local model "might" handle it.

Wave.json item gains field: `escalation_policy: "local" | "pre-escalate" | "never-cloud"`

### 3.3 Self-recusal pattern (all agents)

Every agent that can run at a local tier carries a self-recusal rubric. The agent
reads its own input, applies the rubric, and returns `STATUS: RECUSE` before spending
tokens on work it cannot verify.

**Recusal is based on confidence in achieving the outcome — not on domain area.**
A local model can handle cryptography if it's applying a tested existing pattern.
It cannot handle a trivial string operation if the success criterion is ambiguous.
The rubric question is always: *can I produce a verifiably correct output?*

**Self-recusal rubric (embedded in every worker + orchestrator prompt):**

```
Recuse if ANY of:
  - I cannot identify the specific existing pattern I would follow to satisfy
    the success criteria
  - The success criteria cannot be verified by means available to me
    (no test, no assertion, no structural check I can apply)
  - Two or more valid interpretations of the task exist and choosing wrong
    would produce an output that fails verification
  - I attempted this and cannot confirm the result satisfies the criteria —
    I have produced output but cannot establish it is correct

Do not hedge. When a signal fires, recuse. The orchestrator handles re-routing.
```

**RECUSE STATUS block:**

```
STATUS: RECUSE
ATTEMPTED: yes|no
RECUSAL_REASON: <one sentence — names the specific unverifiable outcome condition>
RECOMMEND: <next agent name>
PARTIAL_OUTPUT: <path if ATTEMPTED=yes, else omit>
SUMMARY: <≤20 words>
```

`RECOMMEND` is hardcoded per agent — each agent knows its own successor on the
escalation spine. The orchestrator reads `RECOMMEND` and dispatches accordingly.

### 3.4 Escalation chain — capability spine

Escalation never terminates early. The chain exhausts all capability tiers before
surfacing to the user. Surface to user only when judge tier (highest) also recuses —
indicating genuine definitional ambiguity requiring human input.

Tiers marked † are Wave-2 additions — not yet in `config/model-map.json`.
See §3.8 for required config changes before activating.

```
pattern-coder    (live — scaffolder, discovery-advisor)
      ↓ recuse
code-analyst     (live — test-writer, reviewer-fix)
      ↓ recuse
deep-coder       (live — implementer)
      ↓ recuse
deep-coder-cloud (†Wave-2 — implementer-cloud)
      ↓ recuse
judge            (live — planner, auditor, review-plan)
      ↓ recuse ← only here: genuine ambiguity, needs human
surface to user
```

**Per-role escalation paths:**

| Agent | Recuses to | Reason |
|---|---|---|
| `scaffolder` | `implementer` | Task type changes: design decision needed |
| `implementer` | `uplift-decider` → `implementer-cloud` | Reads partial work, patch\|restart |
| `reviewer-fix` | `implementer-cloud` | Recuse = approach broken, not style; restart |
| `test-writer` | `test-writer-cloud` | Same role, higher tier |
| `planner-local` | `planner` | Cloud judge; already natural `outcome_risk` path |
| `implementer-cloud` | `judge` | Cloud judge as high-capability implementer |
| `judge` | surface to user | Last resort only |

### 3.5 Orchestrator escalation tracking

Orchestrator tracks per-item escalation depth in `wave.json`:

```json
{
  "item": "item-B",
  "escalation_policy": "local",
  "escalation_depth": 1,
  "max_escalations": 3,
  "escalation_log": [
    {
      "agent": "implementer",
      "tier": "deep-coder",
      "status": "RECUSE",
      "reason": "cannot confirm signing algorithm satisfies success criteria",
      "attempted": true,
      "partial_output": "outputs/implementer-item-B.md"
    }
  ]
}
```

Each escalation passes accumulated context forward: original digest + all prior
attempts + all recusal reasons. The receiving agent decides: patch partial output
or restart clean.

Only when `escalation_depth == max_escalations` AND last agent was judge tier →
surface to user with full escalation log.

### 3.6 Cloud worker CONFIDENCE

`implementer-cloud` carries the same §12.1 CONFIDENCE rubric as `implementer`.
Cloud models also self-assess. This catches items where even cloud cannot establish
correctness — and triggers further escalation rather than silent `STATUS: COMPLETE`.

`uplift-decider` additionally emits `CLOUD_CONFIDENCE: high|medium|low` alongside
its routing decision (`accept|uplift|restart`). This separates the routing decision
from the confidence signal, enabling offline calibration:

```json
// cascade/<item>.jsonl — extended for Wave-2
{
  "item": "item-B",
  "agent": "implementer",
  "confidence": "low",          // local worker self-report
  "verify_pass": null,
  "compliance": true,
  "escalated": true,
  "cloud_agent": "implementer-cloud",
  "cloud_confidence": "high",   // cloud worker self-report
  "uplift_decision": "restart", // uplift-decider routing
  "cloud_verify_pass": true
}
```

### 3.7 New agents (Wave-2)

| Agent | Capability alias | Role |
|---|---|---|
| `uplift-decider` | `judge` | Reads partial local output; emits accept\|uplift\|restart + CLOUD_CONFIDENCE. Judge-tier intentional: routing errors on bad local output propagate silently — expensive triage is preferable to wrong escalation decision |
| `implementer-cloud` | `deep-coder-cloud` | Two prompt modes: uplift (patch) vs restart (clean); returns CONFIDENCE |
| `converger` | `code-analyst` | Aggregates parallel explorer/implementer outputs |

### 3.8 New config (Wave-2)

`config/model-map.json` additions:
- `agent_to_capability`: `uplift-decider → judge`, `implementer-cloud → deep-coder-cloud`,
  `converger → code-analyst`
- `llm_profiles[hw]`: add `deep-coder-cloud` alias → cloud-backed model per tier

### 3.9 Budget and policy

- `WAVE_CLOUD_ESCALATION_BUDGET: 3` per wave; overflow → `blocked` item flagged for
  user review (not silent failure)
- `escalation_policy` per item: `local | pre-escalate | never-cloud`
- CONFIDENCE field optional for 1 release post-Wave-1; absent → `medium` (migration shim)

---

## 4. Git lifecycle

```
Wave-1: feat/confidence-field — MERGED (PR #33)

Wave-2 branch: feat/cascade-routing
  agents/plan-orchestrator.md   — Step 4b tactical classifier + escalation tracking
  agents/implementer.md         — self-recusal rubric + RECUSE STATUS block
  agents/reviewer-fix.md        — same
  agents/test-writer.md         — same
  agents/scaffolder.md          — same
  agents/uplift-decider.md      — NEW
  agents/implementer-cloud.md   — NEW
  agents/converger.md           — NEW
  config/model-map.json         — deep-coder-cloud alias + new agent_to_capability entries
  docs/agent-architecture.md    — escalation chain + RECUSE contract
  test/planner-return-schema.test.js — RECUSE STATUS fixtures
```

---

## 5. Key architectural decisions (settled)

**D1. Test the load-bearing assumption first.**
Wave-1 + Experiments A+B tested the CONFIDENCE signal at near-zero cost before cascade
code was written. Both passed.

**D2. Recusal is outcome-focused, not domain-label.**
"I can't do this because it's cryptography" is wrong. The right signal: "I cannot
verify that my output satisfies the success criteria." Domain area is a proxy that
sometimes correlates; the rubric targets outcome verifiability directly.

**D3. No premature user escalation.**
The escalation chain exhausts all capability tiers (pattern-coder → code-analyst →
deep-coder → deep-coder-cloud → judge) before surfacing to user. User escalation
is reserved for genuine definitional ambiguity after judge tier also recuses.

**D4. Self-recusal is a general agent capability, not orchestrator-only.**
Every worker and orchestrating agent carries the recusal rubric. The mechanism is
identical to CONFIDENCE: embed rubric in prompt, agent applies mechanically, result
is decisive. Pre-execution (recusal) and post-execution (CONFIDENCE) bracket the work.

**D5. Pre-dispatch tactical classification (Step 4b) and agent self-recusal are complementary.**
Step 4b catches obviously strategic items before any local inference is spent.
Self-recusal catches cases Step 4b missed, mid-execution. Both are needed; neither
replaces the other.

**D6. No separate `strategic-coder` agent.**
The tactical/strategic distinction is an item property (captured in `escalation_policy`),
not an agent identity. `implementer-cloud` handles both well-scoped cloud items and
strategic items requiring design decisions. One agent, one capability alias.

**D7. Cloud worker CONFIDENCE closes the loop.**
`implementer-cloud` returns CONFIDENCE using the same rubric. If cloud also returns
`low`, escalation continues to judge tier. Silent `STATUS: COMPLETE` at cloud level
is prevented by the same mechanism that prevents it at local level.

**D8. Orchestrator holds escalation state; agents hold escalation path.**
Each agent's RECUSE names its own successor (`RECOMMEND` field). The orchestrator
tracks depth, budget, and accumulated context. Neither needs global routing knowledge.

**D9. Two-run gate persistence prevents noise at small n.**
At n_high ≈ 10–20 per worker, the 95% CI on a 30% failure rate is ~±23pp. A single
failing run is hypothesis-generating, not gate-failing.

**D10. UNCERTAINTY_REASONS must be single-line.**
STATUS block parser uses `^([A-Z_]+):\s*(.*)$` — drops lines not matching.
Bullets must use comma or `/` separator. Enforced in all agent prompts.

---

## Appendix A — Cascade expansion proposals (post-Wave-1)

| ID | Name | Status |
|---|---|---|
| E2 | Converger role | Wave-2 |
| E3 | Confidence routing (CONFIDENCE-graded orchestrator) | Wave-2 — Step 4b |
| E3b | Self-recusal chain | Wave-2 — §3.3–3.5 |
| E4 | Best-of-N implementer | Deferred Wave-3 |
| E5 | Local pre-reviewer (7B screen before reviewer-fix) | Deferred Wave-3 |
| E6 | Test-first path | Deferred Wave-3 |
| E7 | Dual-channel audit | Deferred Wave-3 |
| E8 | Explorer convergence | Deferred Wave-3 |

---

## Appendix B — §12.1 Confidence rubric (implementer canonical)

> **Note:** This is the implementer-canonical rubric. `reviewer-fix.md`,
> `test-writer.md`, and `scaffolder.md` use role-adapted variants — see those
> files directly. The medium bullet "guessed at an API surface" is implementer-specific;
> other roles substitute an equivalent signal appropriate to their job.

```markdown
## Confidence self-assessment

Before returning STATUS, apply this rubric:

high — ALL of:
  - You reused existing patterns visible in the codebase.
  - The success_criteria map directly to concrete code changes you made.
  - You can state, in one sentence each, why each success criterion is satisfied.
  - You made no assumptions that weren't listed in the digest.

medium — ANY of:
  - You improvised a pattern not seen elsewhere in the codebase.
  - One or more success_criteria required interpretation.
  - You guessed at an API surface and didn't verify it (no Read, no tests).
  - You added error handling or edge-case logic you weren't sure was needed.

low — ANY of:
  - You hit an unfamiliar domain and inferred behavior rather than verified it.
  - A required resource (spec, API doc, upstream dep) was missing or vague.
  - The item's description could be read two or more ways and you picked one.
  - You couldn't find the calling site of what you built.

UNCERTAINTY_REASONS must name the specific rubric bullet(s) that triggered
medium or low (comma-separated, single line). Omit when high.
```

---

## Appendix C — Self-recusal rubric (all agents)

```markdown
## Self-recusal

Before starting work, apply this check to your input.
If ANY signal fires, return STATUS: RECUSE — do not attempt the work.

Recuse if ANY of:
  - I cannot identify the specific existing pattern I would follow to satisfy
    the success criteria
  - The success criteria cannot be verified by means available to me
    (no test, no assertion, no structural check I can apply)
  - Two or more valid interpretations of the task exist and choosing wrong
    would produce an output that fails verification
  - I attempted this and cannot confirm the result satisfies the criteria —
    I have produced output but cannot establish it is correct

Do not hedge. When a signal fires, recuse. The orchestrator handles re-routing.

STATUS: RECUSE
ATTEMPTED: yes|no
RECUSAL_REASON: <one sentence — names the specific unverifiable outcome condition>
RECOMMEND: <next agent>
PARTIAL_OUTPUT: <path if ATTEMPTED=yes>
SUMMARY: <≤20 words>
```
