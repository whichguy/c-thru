# Design: dynamic prompt classification → quality-aware routing

Status: **proposed** (design doc; not implemented).
Cross-references: task #12; depends on benchmark.json (#10/Phase A) + journaling (#11/Phase A).

## Motivation

Routing today is driven by the **agent's `model:` field** — set at agent-definition time,
fixed per agent. This has a known limitation: a `coder` agent with what's actually a
debugger task gets routed to a coder model (suboptimal). A `judge` agent answering a
trivial Q&A gets routed to opus (overkill, expensive).

A **content-aware** routing layer would inspect the prompt and override the agent-declared
model when the content suggests a different role would be better-suited. The classifier
becomes a "second opinion" that can correct routing without changing agent definitions.

## Architecture

### Three-stage pipeline

```
prompt → classifier → role + confidence → benchmark.json lookup → ranked-best model
```

1. **Classifier** — fast local model takes the prompt, returns `{role, confidence}` where
   role is one of: `coder`, `debugger`, `logic`, `generalist`, `orchestrator`, `reviewer`,
   `test_writer`, `doc_writer`, `agentic_coder`. Confidence in [0, 1].

2. **Threshold gate** — if `confidence < THRESHOLD` (default 0.6), fall back to original
   agent_to_capability routing. Below-threshold classifications shouldn't override
   explicit user/agent intent.

3. **Quality-aware routing** — for the classified role, look up the highest
   `quality_per_role` from `benchmark.json`, filter by current hardware tier RAM
   availability, return the best.

### Composable with existing modes

The classifier is one input among several. Compose with existing modes:

- `--mode dynamic-classify` — alone: shadow mode (logs the alternate routing, doesn't apply)
- `--mode dynamic-classify+route` — apply: actually swap to classifier-suggested model
- `--mode cloud-best-quality + dynamic-classify` — within cloud-best-quality, use classifier
  to pick the role, then pick the best cloud model for that role

### Model choice for the classifier

User preference: any classifier works, local preferred. Three viable options:

| Option | Latency | RAM | Notes |
|---|---|---|---|
| `gemma4:e2b` | ~150ms | 2GB | Already routed for explorer/fast-scout; small enough to keep warm |
| `qwen3:1.7b` | ~100ms | 1.5GB | Tiny; fits 16gb tier; routing only |
| Dedicated tiny classifier (e.g. distilbert via Ollama) | ~50ms | 0.5GB | Would require new Ollama tag; possibly too narrow |

**Recommendation: `gemma4:e2b`.** Already in shipped config, fast enough, generalist
enough to classify prompts across roles. Re-uses existing infrastructure.

### Classification taxonomy

Mirror `benchmark.json`'s `role_minimums` keys:

| Role | Trigger phrases (informative) |
|---|---|
| `coder` | "implement", "write a function that", "fix bug", "add method" |
| `debugger` | "trace", "why is this failing", "find the bug", "race condition" |
| `logic` | "prove", "complexity of", "edge case", "verify invariant" |
| `generalist` | open-ended, "help me think through", "trade-offs of" |
| `orchestrator` | "plan and execute", "coordinate", "decompose" |
| `reviewer` | "review this PR", "find bugs in", "code quality" |
| `test_writer` | "write tests for", "add coverage" |
| `doc_writer` | "document", "write README" |
| `agentic_coder` | "build feature end-to-end", multi-step verbs |

Output: `{role, confidence, reasoning}` (latter optional, for debugging).

### Integration points

- **Existing `classify_intent` hooks layer** (port 9998) — already inspects prompts.
  Extends naturally; reuse the channel.
- **`docs/benchmark.json`** — provides `quality_per_role` and `role_minimums` (already
  shipped Phase A).
- **`x-c-thru-resolved-via` header** — extend with `classified_role` and
  `classifier_confidence` fields so users can verify routing decisions.
- **Journal (#11/Phase A)** — records classifier outputs alongside requests; feeds the
  classifier's improvement loop (next-iteration training data).

## Phasing

### Phase A — observe-only (1 day)

- Add classifier endpoint or in-process call to the proxy
- Run classifier on every request; record `classified_role` + `confidence` in journal
  AND in a new `x-c-thru-classified-role` header
- Don't actually re-route — just log what the classifier WOULD have suggested
- Compare against actual routing in journal entries: how often does the classifier
  disagree?

### Phase B — shadow routing (3 days)

- Compute the classifier-suggested model alongside the actual route
- Log "would have used: <model>" in headers/journal
- Still no behavior change; pure observability
- After 1 week of shadow data, evaluate: is the classifier accurate? Does it pick
  measurably better models?

### Phase C — opt-in real routing (2 days)

- Add `--mode dynamic-classify` (or `--classify` flag)
- When enabled, the classifier-suggested model is used IF confidence ≥ threshold
- Below threshold: fall through to original routing
- Log a `mode.classify_route_applied` proxy event for each swap

### Phase D — A/B harness integration (1-2 weeks)

- Combine with #11 Phase C (A/B test harness): for the same captured prompt, compare:
  - Original agent-driven routing
  - Classifier-driven routing
- Score with cloud judge; refine the classifier or the threshold based on results

## Open design questions

### 1. Latency overhead

Adding ~100-500ms classifier call per request. Speculative parallel-dispatch could hide
it (start primary AND classifier in parallel; if classifier finishes first AND suggests
a different model, cancel primary mid-request). Adds complexity but eliminates the
latency cost. Defer to Phase B.

### 2. Confidence threshold tuning

Initial guess: 0.6. Real number depends on classifier accuracy. Phase A's observation
window will provide the data to calibrate.

### 3. Caching

Same prompt → same classification (deterministic with temperature=0). Cache by prompt
hash. Useful for repeated agent calls in a wave system.

### 4. Cold-start handling

First prompt of session has no warm classifier. Two options:
- Pre-warm classifier at proxy start (`/api/generate keep_alive=5m` style — already
  patterned in preflight code)
- Skip classification on the first request (route normally, use it as priming)

Phase A: skip first request. Phase B: pre-warm.

### 5. Privacy

Classifier sees the full prompt (same as the model would). No new privacy surface beyond
what journaling (#11) already raises. Document in Phase A rollout.

### 6. Composability with other modes

How does `--mode dynamic-classify` interact with `--mode cloud-only`? Two interpretations:

- **Compose AND**: classify, then filter by cloud-only constraint. Classifier picks role,
  ranking picks best cloud model for that role.
- **Override**: dynamic-classify wins, ignores cloud-only.

Recommend AND-composition. Same pattern as filter+ranking interaction in Phase 2/3 work.

## Risks

- **Classifier misclassifies:** wrong role → wrong model. Mitigated by confidence
  threshold + Phase B shadow window for tuning.
- **Latency regression:** classifier adds 100-500ms per request even when not used (if
  always running for shadow). Mitigated by speculative parallel dispatch in Phase B.
- **Classification taxonomy drift:** as we add roles to benchmark.json, the classifier's
  output set must grow. Tightly coupled. Document the dependency.
- **Bypass for debugging:** users may want to disable classifier explicitly (e.g. when
  testing a specific agent). Provide `--no-classify` or `CLAUDE_DYNAMIC_CLASSIFY=0` to
  skip the classifier even when the mode is on.

## Implementation plan summary

Implementation should land in 4 tasks:

1. **#16 — Phase A observe-only**: add classifier hook in proxy + journal capture
   classified role for every request. Plumbs the channel without changing routing.

2. **#17 — Phase B shadow routing**: surface classifier suggestion in
   `x-c-thru-resolved-via` header and proxy logs. Compare with actual routing.

3. **#18 — Phase C opt-in real routing**: add `--mode dynamic-classify` flag, threshold
   gating, actual swap when classifier ≥ threshold confidence.

4. **#19 — Phase D A/B harness**: ties to #11 Phase C; not designable until #11 lands.

Each phase is independently shippable. Phase A is the foundation and unblocks the rest.

## Cross-references

- Builds on benchmark.json structure (#10 Phase A — shipped)
- Composes with journal (#11 Phase A — shipped) for labeled data
- Shares the classify_intent hooks layer pattern (existing in proxy)
- Phase D ties to journal Phase C A/B harness (#11/Phase C, not yet planned)
