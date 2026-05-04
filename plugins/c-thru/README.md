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
| Hooks | SessionStart proxy+Ollama health check, UserPromptSubmit proxy-health gate + classify_intent context injection, PostToolUse model-map.json validation, PostCompact context re-injection |

## Prerequisite — install c-thru itself

This plugin registers Claude Code surfaces (commands, skills, hooks). The
proxy binary, model-map config, and `~/.claude/tools/c-thru` symlinks come
from this repo's own installer:

```sh
# One-line install (clones to ~/src/c-thru, symlinks tools to ~/.claude/tools)
curl -fsSL https://raw.githubusercontent.com/whichguy/c-thru/main/install.sh | bash
```

Then install the plugin via Claude Code:

```
/plugin marketplace add whichguy/claude-craft
/plugin install c-thru@claude-craft
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
