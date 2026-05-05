# c-thru — Claude Code plugin

Surfaces c-thru as a Claude Code plugin via the
[claude-craft marketplace](https://github.com/whichguy/claude-craft).
c-thru lets Claude Code talk to alternative model providers (Ollama,
OpenRouter, Bedrock, Vertex, Gemini, LiteLLM) without changing the vendor CLI.

## What this plugin gives you

| Surface | What it adds |
|---|---|
| `/c-thru-status` | Show active profile, agent → model assignments, proxy URL, Ollama state, per-model usage stats |
| `/cplan <intent>` | Wave-based agentic planner (shortcut for `/c-thru-plan`) |
| Skills | `c-thru-plan` (planner/coder/tester/reviewer pipeline), `c-thru-config`, `c-thru-control` |
| Hooks | SessionStart proxy+Ollama health check, UserPromptSubmit proxy-health gate + classify_intent context injection, PostToolUse model-map.json validation, PreCompact context re-injection |

## Install

```
/plugin marketplace add whichguy/claude-craft
/plugin install c-thru@claude-craft
```

On your first Claude Code session after install, the SessionStart hook automatically:
- Seeds `~/.claude/model-map.json` with default routing config
- Starts the proxy on port 10017 (override: `C_THRU_PLUGIN_PORT`)
- Registers `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`

**Restart Claude Code once** after install to activate model routing.

### CLI use (optional)

To invoke `c-thru` from the terminal as a drop-in replacement for `claude`:

```sh
git clone https://github.com/whichguy/c-thru.git ~/src/c-thru
cd ~/src/c-thru && ./install.sh
```

## Plugin bundle maintenance

`plugins/c-thru/hooks/` and `plugins/c-thru/skills/` are copies of the
canonical files in `tools/` and `skills/`. Keep them in sync by running:

```sh
tools/sync-plugin-bundle.sh
```

This is also gated in pre-commit via `tools/sync-plugin-bundle.sh --check`.

## Reporting issues

Plugin issues → [claude-craft repo](https://github.com/whichguy/claude-craft).
Proxy / model routing / agent definitions → this repo.
