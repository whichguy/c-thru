# c-thru

**claude-router** + **claude-proxy**: a transparent routing layer that lets Claude Code talk to alternative model providers (Ollama, OpenRouter, Bedrock, Vertex, LiteLLM) without changing the vendor CLI.

The router wraps `claude`, rewrites the upstream endpoint (and credentials) on a per-invocation basis, and — for Ollama-backed routes — auto-spawns the local proxy that translates between Anthropic's Messages API and the backend's native API.

## Install

```sh
git clone https://github.com/jameswiese/c-thru.git
cd c-thru
./install.sh
```

The installer symlinks `claude-router`, `claude-proxy`, and the `model-map-*` helpers into `~/.claude/tools/`, and seeds `~/.claude/model-map.json` from `config/model-map.json` on first run.

## Usage

```sh
claude-router                           # use routes.default if present, else transparent fallback
claude-router --route background        # named route → --model (see model-map routes)
claude-router --model gemma4:26b        # Ollama (auto-detected)
claude-router --model bedrock-opus      # Bedrock (from model-map.json)
claude-router --model opus              # Ollama if not in model-map (name passed through)
claude-router --list                    # show all available models
```

## Environment

- `CLAUDE_PROXY_BYPASS=1` — skip the proxy; transparent path only.
- `CLAUDE_ROUTER_DEBUG=1` — verbose router logging.
- `CLAUDE_PROXY_DEBUG=1` — verbose proxy logging.

Logs land at `~/.claude/proxy.*.log`. Kill a stuck proxy with `pkill -f claude-proxy`.

## Model map

`config/model-map.json` declares providers, per-model endpoints, and named routes. On install it is copied to `~/.claude/model-map.json` (profile-level); per-project overrides can live in `$PWD/model-map.json`. The router walks a layered lookup (project → profile → repo default).

Helpers:
- `model-map-validate <path>` — lint a model-map file.
- `model-map-sync` — pull upstream capability data into the map.
- `model-map-edit` — interactive edit.

See [`docs/model-map.md`](docs/model-map.md) for the schema.

## License

MIT
