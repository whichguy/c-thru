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
  "llm_mode":            "best-cloud|best-cloud-oss|best-local-oss|best-cloud-gov|best-local-gov|<custom-mode>",
  "custom_modes":        { "<custom-mode>": { "base": "<built-in-mode>", "description": "..." } },
  "llm_profiles":        { "<capability>": { "<llm_mode-or-custom-mode>": { "<hw-tier>": "<model>" }, "on_failure": "cascade|hard_fail", "fallback_to": "<capability>" } },
  "fallback_chains":     { "<hw-tier>": { "<capability>": [ { "model": "<model-name>", "quality_score": 0, "speed_score": 0 } ] } },
  "agent_to_capability": { "<agent-name>": "<capability-alias>" },
  "model_overrides":     { "<concrete-model>": "<replacement>" },
  "targets":             { "<terminal-label>": { "backend": "<backend-id>", "model": "<provider-model>", "request_defaults": { "...": "..." } } },
  "models":              [ { "name": "<model-name>", "equivalents": ["<fallback-model>"] } ]
}
```

- **backends** — connection metadata (URL, auth strategy, kind). `kind` defaults to `anthropic`; use `ollama` for local/Ollama-compat providers. Add `@<backend-id>` suffix to model names in `model_routes` to route the same tag to two different backends. **Credential safety:** the proxy fronts Claude Code, so incoming requests carry the user's Anthropic OAuth/API key. For a non-localhost backend with no auth config (no `auth`/`auth_env`/`auth` object), the proxy now **strips** that incoming Anthropic credential rather than forwarding it to a third party — unless the backend declares `kind:"anthropic"` or opts in with `auth_passthrough: true`. Configure third-party backends with their own `auth_env`/`auth` so they authenticate correctly.
- **model_routes** — flat map of concrete model name → backend ID. Supports `re:^pattern$` regex keys and `@<backend>` routing sigil suffix.
- **routes** — named presets (flat string→string) resolved via `c-thru --route <name>`. `routes.default` is used when no explicit route or model flag is passed.
- **llm_mode** — active model-selection mode for this config layer, one of the 5 built-ins (`best-cloud`, `best-cloud-oss`, `best-local-oss`, `best-cloud-gov`, `best-local-gov` — the `-gov` modes exclude Chinese-origin models) **or a declared custom mode**. Overridden by `CLAUDE_LLM_MODE` env. See `docs/connectivity-modes.md`.
- **custom_modes** — user-definable named modes: a label mapping capabilities → models via a `base` built-in mode plus per-capability overrides in `llm_profiles`. Capabilities not overridden resolve under `base`, then `best-cloud`. `base` is required and must be a built-in; the name can't shadow a built-in/legacy mode; a gov `base` rejects Chinese-origin overrides. Select with `--mode <name>`; list via `c-thru list`. See `docs/connectivity-modes.md` § Custom modes.
- **llm_profiles** — keyed by capability alias, then by `llm_mode`, then by hw tier (`16gb`…`128gb`) → concrete model. Sibling `on_failure` (`cascade|hard_fail`) and `fallback_to` (next capability to try) keys live alongside the per-mode maps. See `docs/hardware-profile-matrix.md`.
- **fallback_chains** — keyed by hw tier, then by capability, to an ORDERED array of candidate objects (`{model, quality_score, speed_score}`) consulted when `llm_profiles`'s per-backend `fallback_to` chain is exhausted (see `tryFallbackOrFail` in `tools/claude-proxy`). Each `model` must resolve through `model_routes` (a direct entry, a matching `re:` pattern, or a self-routing `@<backend>` sigil) — the validator (`validateFallbackChains`, `tools/model-map-validate.js`) rejects any candidate that doesn't. `quality_score`/`speed_score` are optional 0–100 values; candidates must be quality-monotonic non-increasing down the array (a ±1 tolerance allows one speed-for-quality trade-off before flagging an inversion). **The last entry in every chain must resolve to a local (Ollama) backend** — chains may not terminate on a cloud endpoint, so a chain always has a survivable floor.
- **agent_to_capability** — 2-hop resolution: agent-name → capability-alias → `llm_profiles[alias][mode][hw]`. Agents declare `model: <agent-name>`; the proxy resolves the concrete model at request time.
- **model_overrides** — unconditional tag rename applied before route graph traversal. Covers both primary requests and fallback candidates.
- **targets** — final proxy-only terminal mapping. If a resolved terminal label matches a target id, the proxy uses that target’s backend/model/request defaults; otherwise the proxy uses `targets.default` as the pass-through backend for the terminal label.
- **models** — sparse array; each entry has `name` and optional `equivalents[]` for per-request fallback cascade on failure.

Validate with `model-map-validate <path>`. See `tools/model-map-validate.js` for the full schema and `tools/model-map-layered.js` for the profile-layer sync behavior.
