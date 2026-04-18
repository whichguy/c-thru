# TODO: Logical-role exclusivity for loaded Ollama models

## Problem

`model-map.json` resolves a logical role (e.g. `heavy-worker`, `classifier`, `default`) to a concrete model name (e.g. `qwen3:6b`, `gemma4:26b-a4b`). When the role-to-model binding changes — either via a config edit or a route override — Ollama can end up with the *previous* binding's model still resident in VRAM alongside the new one. On constrained hardware this leads to thrashing, OOM evictions, and slow first-token latency.

Requirement: for each logical role, **at most one physical model is loaded in Ollama at any given time**. When a request for role `R` resolves to model `M_new` and Ollama currently has `M_old` loaded under `R`, the proxy should:

1. Issue a targeted unload of `M_old` (`POST /api/generate {model: M_old, keep_alive: 0}`).
2. Warm `M_new` (`POST /api/generate {model: M_new, prompt: "", keep_alive: <policy>}`).
3. Serve the request from `M_new`.

## Worked example

Config before:
```json
{"routes": {"heavy-worker": {"model": "qwen3:6b", "backend": "ollama-local"}}}
```
Then user edits to:
```json
{"routes": {"heavy-worker": {"model": "gemma4:26b-a4b", "backend": "ollama-local"}}}
```
Next request → role `heavy-worker` resolves to `gemma4:26b-a4b`. `/api/ps` shows `qwen3:6b` still loaded under the `heavy-worker` logical binding tracked by the proxy. Action: unload `qwen3:6b`, warm `gemma4:26b-a4b`, then forward the request.

## Design notes

- **Tracking state**: proxy needs an in-memory `roleBindings: Map<role, currentModel>` keyed by logical role. Populated on first resolution, updated whenever the resolved model differs from the stored binding.
- **Scope**: exclusivity is per-role, not global. Two *different* roles may each have their own model loaded concurrently (e.g. `classifier: llama3.2:1b` + `heavy-worker: gemma4:26b` is valid). Only same-role swaps trigger an unload.
- **Cross-backend**: logical-role exclusivity only makes sense within a single Ollama instance (VRAM boundary). If two roles target different Ollama hosts, each tracks independently.
- **Fallback interaction**: when a chain fallback fires (e.g. `glm-5.1:cloud` dead → served by `gemma4:26b-a4b`), the fallback model is bound to the same logical role temporarily. On recovery, swap back to the primary.
- **Race**: if two concurrent requests for role `R` resolve to different models (edit mid-flight), serialize the swap — second request blocks on the first's warm completing.
- **Pinning**: users may want a role's model to stay resident across idle periods. Expose a `keep_alive` per-route in `model-map.json`, default `10m`.

## Touch points (to revisit when planning)

- `tools/claude-proxy` — model resolution path (where logical role → model happens)
- `tools/claude-proxy` — `warmOllamaModel()` (part of the same Ollama-lifecycle audit, see `TODO-ollama-service-lifecycle.md`)
- `tools/model-map-layered.js` — the resolution layer; may need to expose the logical-role key alongside the resolved model so the proxy can key its tracking map
- `config/model-map.json` — schema extension for per-route `keep_alive`

## Relationship to other TODOs

- **`TODO-ollama-service-lifecycle.md`**: prerequisite — that plan replaces `ollama run` CLI spawns with HTTP-API calls, which is what this TODO needs (explicit unload via `keep_alive: 0`).
- Recommend landing the ollama-service-lifecycle work first, then layering role-exclusivity on top.

## Open questions

- Does Ollama's `/api/ps` give us enough information to reconcile state on proxy restart, or do we always trust our in-memory binding map?
- Should we eagerly swap on config change (file-watch), or lazily on next request? Lazy is simpler; eager avoids first-request latency spike.
- What's the right behavior if `M_new` fails to load? Roll back to `M_old` (which we just unloaded) or fall through the fallback chain?

## Status

Queued. Blocked on `TODO-ollama-service-lifecycle.md`.
