# TODO: Review Ollama service-mode best practices for proxy lifecycle

## Problem

`claude-proxy` currently warms Ollama models via `spawn('ollama', ['run', model, ''], ...)` (see `tools/claude-proxy` around the `warmOllamaModel` function). This invokes Ollama as an interactive CLI — passing an empty prompt, which makes Ollama wait for stdin EOF, then exit. It works as a side-effect trigger but it isn't how a service consumer should drive Ollama.

The proxy should treat Ollama as a long-running HTTP service (which it already is — the proxy talks to `http://localhost:11434/api/...`), and manage warm/unload/keepalive via the Ollama HTTP API rather than by spawning CLI processes.

## Investigation scope

1. **Warm-up**: Ollama's HTTP API accepts `POST /api/generate` with `{"model": "<m>", "prompt": "", "keep_alive": "10m"}` to load a model into VRAM without generating anything. Compare with the current `ollama run <m> ''` spawn — the HTTP call is non-blocking, respects `keep_alive`, and doesn't litter processes. See: `https://github.com/ollama/ollama/blob/main/docs/api.md`.
2. **Keep-alive tuning**: `keep_alive` on each `/api/chat` request controls how long the model stays resident after the call. Proxy currently does not set this — relies on Ollama defaults. For fallback models, a longer keep-alive (e.g. `30m`) would reduce cold-start cost on repeat fallbacks.
3. **Unload**: `POST /api/generate` with `{"model": "<m>", "keep_alive": 0}` unloads immediately. Useful when switching between large models on constrained hardware.
4. **Service liveness**: current code probes via `/api/tags` or similar. Verify this is still the lightest possible liveness check. Consider `GET /api/ps` to see currently-loaded models and make smarter warm/unload decisions.
5. **Auto-start**: on macOS Ollama runs as a launchd agent; on Linux as a systemd service. The proxy should detect when Ollama is unreachable and optionally attempt a platform-appropriate start (`launchctl kickstart` / `systemctl --user start ollama`) rather than spawning `ollama serve` manually.
6. **Model pre-pull**: if `model-map.json` references a model not yet pulled, a `POST /api/pull` at startup (or first-use) is cleaner than failing on first request. Weigh against startup latency.

## Current touch points (to revisit)

- `tools/claude-proxy` — `warmOllamaModel()` uses spawn('ollama', ['run', ...])
- `tools/claude-proxy` — liveness probe loop (`startLivenessProbeLoop`)
- `tools/claude-proxy` — managed-cloud backend health (`ensureBackendHealthEntry`)
- `tools/claude-router` — may have its own Ollama start/stop logic worth auditing for duplication

## Deliverable

A focused plan document (separate from this TODO) that:
- enumerates every place the proxy/router touches Ollama
- maps each to the correct HTTP-API call (no CLI spawns where avoidable)
- specifies `keep_alive` policy per backend kind
- decides if/when we auto-restart the service vs failing fast
- includes a migration with backward-compat (old `warmOllamaModel` keeps working until new path is verified)

## Status

Queued. Not yet started.
