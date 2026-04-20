# model-map.json

The router reads a layered stack of `model-map.json` files and merges them:

1. `$PWD/model-map.json` — per-project override (optional).
2. `$HOME/.claude/model-map.json` — user profile (seeded by `install.sh`).
3. `<repo>/config/model-map.json` — shipped defaults.

## Shape

```json
{
  "backends":            { "<name>": { "kind": "anthropic|ollama", "url": "...", "auth_env": "..." } },
  "model_routes":        { "<model-name>": "<backend-name>" },
  "routes":              { "<route-name>": "<model-name-or-alias>" },
  "llm_mode":            "connected|semi-offload|cloud-judge-only|offline",
  "llm_profiles":        { "<hw-tier>": { "<capability>": { "connected_model": "...", "disconnect_model": "...", "on_failure": "cascade|hard_fail", "modes": { "<llm_mode>": "<model>" } } } },
  "agent_to_capability": { "<agent-name>": "<capability-alias>" },
  "model_overrides":     { "<concrete-model>": "<replacement>" },
  "models":              [ { "name": "<model-name>", "equivalents": ["<fallback-model>"] } ]
}
```

- **backends** — connection metadata (URL, auth strategy, kind). `kind` defaults to `anthropic`; use `ollama` for local/Ollama-compat providers. Add `@<backend-id>` suffix to model names in `model_routes` to route the same tag to two different backends.
- **model_routes** — flat map of concrete model name → backend ID. Supports `re:^pattern$` regex keys and `@<backend>` routing sigil suffix.
- **routes** — named presets (flat string→string) resolved via `c-thru --route <name>`. `routes.default` is used when no explicit route or model flag is passed.
- **llm_mode** — connectivity mode for this config layer: `connected` (cloud as configured), `semi-offload` (judge/orchestrator cloud, rest local), `cloud-judge-only` (only judge cloud), `offline` (all local). Overridden by `CLAUDE_LLM_MODE` env.
- **llm_profiles** — per-hw-tier (`16gb`…`128gb`), per-capability-alias model slots. Each entry selects a concrete model based on `llm_mode`. Optional `modes` sub-map overrides per mode. See `docs/hardware-profile-matrix.md`.
- **agent_to_capability** — 2-hop resolution: agent-name → capability-alias → `llm_profiles[hw][alias]`. Agents declare `model: <agent-name>`; the proxy resolves the concrete model at request time.
- **model_overrides** — unconditional tag rename applied before route graph traversal. Covers both primary requests and fallback candidates.
- **models** — sparse array; each entry has `name` and optional `equivalents[]` for per-request fallback cascade on failure.

Validate with `model-map-validate <path>`. See `tools/model-map-validate.js` for the full schema and `tools/model-map-layered.js` for the merge order.
