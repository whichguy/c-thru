# model-map.json

The router/proxy selects one active `model-map.json` graph by precedence:

1. `CLAUDE_MODEL_MAP_PATH` — explicit override path.
2. `$PWD/.claude/model-map.json` — project-local selected graph.
3. `$HOME/.claude/model-map.json` — profile selected graph.

Only the profile graph is layered. `install.sh` seeds `model-map.system.json`, user changes live in `model-map.overrides.json`, and those are synced into the effective profile `model-map.json`. A project-local `model-map.json` is selected as-is and traversed as its own DAG; it is not merged with the profile graph.

## Shape

```json
{
  "backends":            { "<name>": { "kind": "anthropic|ollama", "url": "...", "auth_env": "..." } },
  "model_routes":        { "<model-name>": "<backend-name>" },
  "routes":              { "<route-name>": "<model-name-or-alias>" },
  "llm_mode":            "best-cloud|best-cloud-oss|best-local-oss|best-cloud-gov|best-local-gov",
  "llm_profiles":        { "<capability>": { "<llm_mode>": { "<hw-tier>": "<model>" }, "on_failure": "cascade|hard_fail", "fallback_to": "<capability>" } },
  "agent_to_capability": { "<agent-name>": "<capability-alias>" },
  "model_overrides":     { "<concrete-model>": "<replacement>" },
  "targets":             { "<terminal-label>": { "backend": "<backend-id>", "model": "<provider-model>", "request_defaults": { "...": "..." } } },
  "models":              [ { "name": "<model-name>", "equivalents": ["<fallback-model>"] } ]
}
```

- **backends** — connection metadata (URL, auth strategy, kind). `kind` defaults to `anthropic`; use `ollama` for local/Ollama-compat providers. Add `@<backend-id>` suffix to model names in `model_routes` to route the same tag to two different backends.
- **model_routes** — flat map of concrete model name → backend ID. Supports `re:^pattern$` regex keys and `@<backend>` routing sigil suffix.
- **routes** — named presets (flat string→string) resolved via `c-thru --route <name>`. `routes.default` is used when no explicit route or model flag is passed.
- **llm_mode** — active model-selection mode for this config layer, one of `best-cloud`, `best-cloud-oss`, `best-local-oss`, `best-cloud-gov`, `best-local-gov` (the `-gov` modes exclude Chinese-origin models). Overridden by `CLAUDE_LLM_MODE` env. See `docs/connectivity-modes.md`.
- **llm_profiles** — keyed by capability alias, then by `llm_mode`, then by hw tier (`16gb`…`128gb`) → concrete model. Sibling `on_failure` (`cascade|hard_fail`) and `fallback_to` (next capability to try) keys live alongside the per-mode maps. See `docs/hardware-profile-matrix.md`.
- **agent_to_capability** — 2-hop resolution: agent-name → capability-alias → `llm_profiles[hw][alias]`. Agents declare `model: <agent-name>`; the proxy resolves the concrete model at request time.
- **model_overrides** — unconditional tag rename applied before route graph traversal. Covers both primary requests and fallback candidates.
- **targets** — final proxy-only terminal mapping. If a resolved terminal label matches a target id, the proxy uses that target’s backend/model/request defaults; otherwise the proxy uses `targets.default` as the pass-through backend for the terminal label.
- **models** — sparse array; each entry has `name` and optional `equivalents[]` for per-request fallback cascade on failure.

Validate with `model-map-validate <path>`. See `tools/model-map-validate.js` for the full schema and `tools/model-map-layered.js` for the profile-layer sync behavior.
