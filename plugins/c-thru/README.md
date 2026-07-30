# c-thru — Claude Code plugin

Surfaces c-thru as a Claude Code plugin. c-thru lets Claude Code talk to
alternative model providers (Ollama, OpenRouter, Bedrock, Vertex, Gemini,
LiteLLM) without changing the vendor CLI.

This package lives in the **c-thru** git repository (private/product marketplace
root). It is also listed from the
[claude-craft](https://github.com/whichguy/claude-craft) family catalog as a
**git-subdir** of this repo — not vendored. Not submitted to Anthropic’s public
plugin directories.

Install from **exactly one** marketplace identity — installing both activates
the plugin twice and double-fires its hooks.

## Install (pick one source)

### From this repository (primary)

```
/plugin marketplace add whichguy/c-thru
/plugin install c-thru@c-thru
```

### From the family marketplace (same package)

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
the **namespaced** command:

```
/c-thru:c-thru-status
```

(Plugin skills are namespaced. The command uses the live proxy HTTP API and
bundled tools under `${CLAUDE_PLUGIN_ROOT}` — it does not require the CLI.)

## What this plugin gives you

| Surface | What it adds |
|---|---|
| `/c-thru:c-thru-status` | Proxy status, recent requests, dashboard URL (plugin-root tools) |
| `/cplan` skill files | Present; full multi-agent waves need CLI fleet inject |
| Skills | `c-thru-plan`, `c-thru-config`, `c-thru-control` (config/control prefer CLI tools when present) |
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

## Removing c-thru

1. `/plugin uninstall c-thru@c-thru` (or `c-thru@claude-craft` if that identity).
2. Clear durable loopback base URL if still set — otherwise plain `claude` targets a dead port:
   - Remove `env.ANTHROPIC_BASE_URL` from `~/.claude/settings.json` when it is
     `http://127.0.0.1:…` or `http://localhost:…`.
   - CLI users: `bash uninstall.sh` does this automatically for loopback URLs.
3. Optional: `pkill -f claude-proxy`

See also [SECURITY.md](../../SECURITY.md) in the repo root.

## Plugin bundle maintenance

`plugins/c-thru/{hooks,skills,tools,config,commands}/` are synced from
`tools/`, `skills/`, `config/`, and `commands/`. Keep them in sync:

```sh
tools/sync-plugin-bundle.sh
```

This is also gated in the hermetic suite via `tools/sync-plugin-bundle.sh --check`.

## Reporting issues

Proxy / model routing / agent definitions / this plugin package →
[c-thru](https://github.com/whichguy/c-thru).
Family marketplace packaging → [claude-craft](https://github.com/whichguy/claude-craft).
