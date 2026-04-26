# Connectivity modes — full reference

c-thru supports 9 connectivity modes that control how each capability resolves to a concrete
model. Set the active mode with `--mode <name>` on the c-thru CLI, with the
`CLAUDE_LLM_MODE` environment variable, or by setting `llm_mode` in `model-map.json`.

The mode is applied **per-capability**: `judge` and `coder` may resolve to different concrete
models in the same session under the same mode, depending on each capability's slot
configuration in `llm_profiles[<tier>][<capability>]`.

---

## Resolution model

Every capability entry in `llm_profiles[<tier>]` has these slots:

```jsonc
{
  "connected_model":   "...",   // primary cloud option
  "disconnect_model":  "...",   // primary local option
  "cloud_best_model":  "...",   // best cloud (used by cloud-best-quality)
  "local_best_model":  "...",   // best local (used by local-best-quality)
  "modes": {                    // per-mode overrides
    "semi-offload":     "...",
    "cloud-judge-only": "...",
    "cloud-thinking":   "...",
    "local-review":     "..."
  },
  "on_failure": "cascade"       // or "hard_fail"
}
```

`resolveProfileModel(entry, mode)` consults the slots in this order:

1. If `entry.modes[mode]` exists → use it (explicit override always wins)
2. Otherwise, mode-specific default per the table below

---

## Mode reference

| Mode | Default slot | Override slot | Intent |
|---|---|---|---|
| `connected` | `connected_model` | — | Normal cloud-when-available routing |
| `offline` | `disconnect_model` | — | No internet; all local |
| `local-only` | `disconnect_model` | — | Force local even when online (cost / privacy / latency) |
| `semi-offload` | `disconnect_model` | `modes['semi-offload']` | Local workers; cloud for tagged capabilities |
| `cloud-judge-only` | `disconnect_model` | `modes['cloud-judge-only']` | Cloud only for judge/audit |
| `cloud-thinking` | `disconnect_model` | `modes['cloud-thinking']` | Cloud for thinking-class (judge, reasoner, planner); workers stay local |
| `local-review` | `connected_model` | `modes['local-review']` | INVERSE: review/security/code-analysis stays local; logic + orchestration cloud |
| `cloud-best-quality` | `cloud_best_model` ?? `connected_model` | — | Best available cloud regardless of cost |
| `local-best-quality` | `local_best_model` ?? `disconnect_model` | — | Best available local |
| `cloud-only` | `cloud_best_model` ?? `connected_model` | (post-filter) | Exclusively cloud — hard_fails if no cloud option for capability |
| `claude-only` | `connected_model` | `modes['claude-only']` | Exclusively Anthropic Claude models |
| `opensource-only` | `disconnect_model` | `modes['opensource-only']` | Excludes Claude; allows local Ollama + cloud-relayed OS (GLM, qwen-coder-next:cloud, etc.) |
| `fastest-possible` | `connected_model` (then ranked) | `modes['fastest-possible']` | Highest tokens/sec model meeting role minimum quality (from benchmark.json) |
| `smallest-possible` | `disconnect_model` (then ranked) | `modes['smallest-possible']` | Lowest RAM model meeting role minimum quality |
| `best-opensource` | `disconnect_model` (then ranked) | `modes['best-opensource']` | Highest-quality open-source model; ties broken by tokens/sec |
| `best-opensource-cloud` | `cloud_best_model` (then ranked) | `modes['best-opensource-cloud']` | Highest-quality open-source model IN THE CLOUD |

---

## What each mode is useful for

### `connected`
Default. Use when you have internet and want the proxy to make sensible routing decisions.

### `offline`
No internet available. The proxy uses every capability's `disconnect_model`. Set this
explicitly via `--mode offline` if connectivity detection misfires.

### `local-only`
Same routing as `offline` but with a different intent: "I have internet, I just don't want
to use it." Useful for:
- Privacy-sensitive sessions where no data should leave the machine
- Cost control during development
- Testing local-only deployments

The `mode` field in `x-c-thru-resolved-via` reports `local-only` (not `offline`), so logs
and tooling can distinguish the two.

### `semi-offload`
Most work runs locally; a small number of high-value capabilities are tagged in
`modes['semi-offload']` to use cloud. Configure on a per-capability basis. The shipped
config tags `judge`, `judge-strict`, `orchestrator`, `local-planner` for cloud at 48gb+.

### `cloud-judge-only`
Only judge-tier work goes cloud. Workers, coders, reviewers stay local. Used when you want
final-decision auditing from a cloud model but don't want cloud costs for the bulk of work.

### `cloud-thinking`
Thinking-class capabilities (judge, judge-strict, large-general, reasoner, planner) go
cloud; everything else stays local. Broader than `cloud-judge-only` — covers all "deep
thinking" roles, not just judging.

The shipped config tags `judge` and `judge-strict` for cloud at 48gb+. Add
`modes['cloud-thinking']` entries to other thinking-class capabilities if you want them
cloud-routed too.

### `local-review`
**Inverse of `cloud-judge-only`**: review/security/code-analysis stays local; logic and
orchestration go cloud. Use this when you want cloud for the heavy lifting (planning,
implementation) but trust your local model enough for code review and security audits.

The shipped config tags `reviewer`, `code-analyst` for local at 48gb+.

### `cloud-best-quality`
Use the best cloud model available for every capability, regardless of cost. If
`cloud_best_model` isn't defined, falls back to `connected_model`.

### `local-best-quality`
Use the best local model available for every capability. Differs from `offline` /
`local-only` because it consults `local_best_model` (intentional best-quality slot) rather
than `disconnect_model` (the survival fallback). At higher tiers these may be different
models.

### `best-opensource-cloud`
Use the best open-source model available in the cloud for each capability. This
filters for models that satisfy both `isOpenSource` (non-proprietary weight families) 
and `isCloud` (non-localhost backends), then ranks them by quality.

---

## Verifying the mode worked

Every response includes the `x-c-thru-resolved-via` header with `mode`, `served_by`,
`capability`, `tier`, and `backend_id`. Use it to confirm routing:

```sh
curl -i -H 'x-api-key: ignored' http://127.0.0.1:9997/v1/messages \
  -d '{"model":"workhorse","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
# Look for: x-c-thru-resolved-via: {"capability":"workhorse","mode":"local-review","served_by":"...",...}
```

The proxy also exposes `/v1/active-models` which returns the resolved model list for the
current tier and mode without sending a real message:

```sh
curl http://127.0.0.1:9997/v1/active-models | jq
```

---

## How to add a new mode override per capability

Add a `modes[<mode-name>]` entry to a capability in `model-map.overrides.json`:

```json
{
  "llm_profiles": {
    "64gb": {
      "judge": {
        "modes": {
          "cloud-thinking": "claude-opus-4-6"
        }
      }
    }
  }
}
```

The override stacks on top of the system defaults. Reload with `c-thru reload` (or
`/c-thru-config reload` from a Claude session) to apply without restarting.

---

## See also

- [`tournament_2026-04-25.md`](./tournament_2026-04-25.md) — model rankings used to inform
  mode-default choices in shipped config
- [`model-map-research-2026-04-25.md`](./model-map-research-2026-04-25.md) — how the report
  influenced the current capability assignments
