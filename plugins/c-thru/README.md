# c-thru — Claude Code plugin

Surfaces c-thru as a Claude Code plugin. c-thru lets Claude Code talk to
alternative model providers (Ollama, OpenRouter, Bedrock, Vertex, Gemini,
LiteLLM) without changing the vendor CLI.

This package lives in the **c-thru** git repository and is also listed from
the [claude-craft](https://github.com/whichguy/claude-craft) family marketplace
as a git-subdir. Install from **exactly one** marketplace source — installing
both activates the plugin twice and double-fires its hooks.

## Install (pick one source)

### From this repository (standalone)

```
/plugin marketplace add whichguy/c-thru
/plugin install c-thru@c-thru
```

### From the family marketplace

```
/plugin marketplace add whichguy/claude-craft
/plugin install c-thru@claude-craft
```

If you previously installed the other identity, uninstall it first:

```
/plugin uninstall c-thru@claude-craft
# or: /plugin uninstall c-thru@c-thru
```

### Optional: wave scheduler

`planning-suite` is **optional**. Install it only if you want
`/schedule-plan-tasks` / plan-scheduler:

```
/plugin marketplace add whichguy/claude-craft
/plugin install planning-suite@claude-craft
```

On your first Claude Code session after install, the SessionStart hook may:
- Seed `~/.claude/model-map.json` with default routing config
- Start the proxy on port 10017 (override: `C_THRU_PLUGIN_PORT`)
- Register `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`

That settings change applies on the **next** launch, so you may need a
**second** restart before the client honors the base URL. Then verify with
`/c-thru-status`.

## What this plugin gives you

| Surface | What it adds |
|---|---|
| `/c-thru-status` | Show active profile, agent → model assignments, proxy URL, Ollama state, per-model usage stats |
| `/cplan <intent>` | Planner skill (full multi-agent waves need CLI fleet inject) |
| Skills | `c-thru-plan` (planner/coder/tester/reviewer pipeline), `c-thru-config`, `c-thru-control` |
| Hooks | SessionStart proxy+Ollama health check, UserPromptSubmit proxy-health gate + static control-plane context injection, PostToolUse model-map.json validation, PreCompact context re-injection |

## Plugin-only limitations

Plugin install provides: proxy runtime, routing config, hooks, and the public skills above.

**Not included in the plugin bundle** (requires CLI install from this repo):
- `c-thru` CLI — terminal drop-in for `claude` with `--mode`, `--profile`, `--route` flags
- `c-thru list`, `c-thru explain`, `c-thru reload` control commands
- `c-thru-hygiene-check`, `c-thru-statusline` monitoring scripts
- `llm-capabilities-mcp.js` MCP server (model capability queries)
- Full 27-agent fleet injection via `--agents`

### Full install (CLI + all tools)

```sh
git clone https://github.com/whichguy/c-thru.git
cd c-thru
bash install.sh
```

## Plugin bundle maintenance

`plugins/c-thru/hooks/` and `plugins/c-thru/skills/` are copies of the
canonical files in `tools/` and `skills/`. Keep them in sync by running:

```sh
tools/sync-plugin-bundle.sh
```

This is also gated in the hermetic suite via `tools/sync-plugin-bundle.sh --check`.

## Reporting issues

Proxy / model routing / agent definitions / this plugin package →
[c-thru](https://github.com/whichguy/c-thru).
Family marketplace packaging → [claude-craft](https://github.com/whichguy/claude-craft).
