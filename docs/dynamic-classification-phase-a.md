# Dynamic Classifier — Phase A (observe-only)

Status: **shipped** — opt-in via `CLAUDE_PROXY_CLASSIFY=1`. No routing changes; observability only.

## What it does

When enabled, the proxy runs a small role classifier on every prompt's last user message
*before* forwarding to the upstream model. The classifier predicts which **role** the
prompt fits best — one of:

```
coder, debugger, logic, generalist, orchestrator,
reviewer, test_writer, doc_writer, agentic_coder
```

Result is recorded in two places:

1. **Response headers**:
   - `x-c-thru-classified-role`: the predicted role (e.g. `debugger`)
   - `x-c-thru-classifier-confidence`: float in [0, 1]
   - `x-c-thru-classifier-skipped`: present only when classifier was skipped, with reason

2. **Journal entries** (when `CLAUDE_PROXY_JOURNAL=1` is also enabled):
   - `classified_role`, `classifier_confidence`, `classifier_skipped` fields

In Phase A, this **does not change routing**. Use it to gather data on classifier accuracy
before Phase B (shadow routing) or Phase C (real routing).

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `CLAUDE_PROXY_CLASSIFY` | unset (off) | Set to `1` to enable |
| `CLAUDE_PROXY_CLASSIFY_MODEL` | `gemma4:e2b` | Classifier model tag |
| `CLAUDE_PROXY_CLASSIFY_OLLAMA_URL` | `OLLAMA_BASE_URL` or `http://localhost:11434` | Where to send classifier requests |
| `CLAUDE_PROXY_CLASSIFY_TIMEOUT_MS` | `5000` | Hard timeout for the classifier call |

## Behavior

- **Off by default** — zero overhead when disabled.
- **Cold-start skip** — the very first request after proxy start is *not* classified.
  Header reports `x-c-thru-classifier-skipped: cold_start`. Phase B will pre-warm the
  model at proxy startup to eliminate this.
- **Sync** — classifier runs before forwarding. Adds ~50-500ms per request depending
  on classifier model + Ollama warm state. Latency cost is the trade-off for getting
  the role into the response header.
- **Cache** — keyed on SHA-256 of the user prompt. Up to 1000 entries; oldest evicted
  on overflow. Identical prompts within a session classify exactly once.
- **Soft-fail** — if Ollama is unreachable / times out / returns garbage, the request
  proceeds normally. Header reports `x-c-thru-classifier-skipped` with one of:
  - `cold_start` — first request of session
  - `network_error` — couldn't reach Ollama
  - `timeout` — classifier didn't respond within `CLAUDE_PROXY_CLASSIFY_TIMEOUT_MS`
  - `response_invalid` — Ollama returned non-JSON envelope
  - `parse_failed` — envelope OK but role wasn't in the allowlist or confidence out of range

## Privacy

The classifier sees the **full text of the user's last message**, exactly the same as the
upstream model would. No new privacy surface — just one extra hop to the local Ollama
classifier. The classifier prompt itself contains the user's text:

```
You classify a user prompt into ONE of these roles: coder, debugger, ...
Reply ONLY with a JSON object: {"role":"<role>","confidence":<0..1>}.

Prompt to classify:

<the user's prompt, truncated to 2000 chars>
```

When `CLAUDE_PROXY_JOURNAL=1` is also on, the classifier output is recorded in the journal
alongside the request. See [`docs/journaling.md`](./journaling.md) for journal privacy.

## Why this exists

Routing today is keyed on the agent's `model:` field — fixed at agent-definition time. A
`coder` agent given a debugging task gets routed to a coder model, even though a debugger
model would do better. Phase A measures *how often* this mismatch happens in real traffic.

When a user types something agentic-coder-shaped, what role does the classifier think it
is? If the classifier reliably says `debugger` for "trace this race condition" and `coder`
for "implement this function", we can use that signal to override agent-driven routing in
Phase C.

Phase A is purely observational — gather labeled data, calibrate the classifier's
confidence threshold, and decide whether re-routing is worth it. See
[`docs/dynamic-classification-design.md`](./dynamic-classification-design.md) for the
full Phase B / C / D plan.

## Verification

```sh
# Enable + run a request
CLAUDE_PROXY_CLASSIFY=1 c-thru -p "trace this race condition in middleware" 2>&1 | head

# Check the response headers (need a routed request, see proxy logs)
tail ~/.claude/proxy.log | grep classifier

# With journal: capture every prompt+role pair
CLAUDE_PROXY_CLASSIFY=1 CLAUDE_PROXY_JOURNAL=1 c-thru ...
jq -c '{capability, classified_role, classifier_confidence, prompt: .request.messages[-1].content}' \
  ~/.claude/journal/$(date +%F)/*.jsonl
```

## What's NOT in Phase A

- **Routing change** — classifier output is not used for routing decisions
- **Pre-warm** — no startup warmup; first request always pays cold-start cost
- **Speculative parallel** — classifier runs sync; doesn't overlap with the upstream call
- **Threshold gating** — Phase C territory

## Implementation

- `tools/claude-proxy` — `classifyRole()`, `_classifyParseResponse()`, `_classifyExtractPrompt()`
  helpers near the top of the file (next to journal helpers)
- Dispatch hook in `/v1/messages` handler: `await classifyRole(prompt)` before filter/rank
- Result attached to `resolved._classifier` then propagated through `requestMeta.classifier`
- `addResolvedViaHeader` reads classifier from `resolved.classifier`, injects 3 response headers
- `finalizeTrackedUsage` reads classifier from `meta.classifier`, writes to journal entry
- Tests: `test/proxy-classify.test.js` (7 cases / 28 assertions) using `classifierStub`
  helper in `test/helpers.js`
