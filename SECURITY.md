# Security notes — c-thru

c-thru is a **local** router/proxy for Claude Code. It does not send traffic to
c-thru-operated cloud services. Review this before marketplace install.

## What the plugin does

| Action | Detail |
|---|---|
| Local proxy | Spawns Node `claude-proxy` on loopback (default port `10017` for plugin mode) |
| Settings write | SessionStart may set `env.ANTHROPIC_BASE_URL` to `http://127.0.0.1:<port>` in `~/.claude/settings.json` so Claude Code talks to the local proxy |
| Model map | Seeds `~/.claude/model-map.system.json` / derived map from shipped defaults |
| Upstream | Forwards requests only to backends **you** configure (Anthropic, Ollama, OpenRouter, Gemini, xAI, etc.) |

## Auth and secrets

- No API keys are required for local-only Ollama routing.
- Cloud keys (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …) are read from **your** environment if set — c-thru does not embed or phone-home credentials.
- Do not commit keys; document env **names** only.

## Dual install

Prefer **one** of:

- Marketplace plugin inject (user-wide hooks), **or**
- CLI `bash install.sh` / `cthru` ephemeral inject

Installing both can double-fire hooks. See README.

## Removing c-thru safely

Marketplace uninstall alone does **not** always clear a durable base URL:

1. `/plugin uninstall c-thru@…` (or CLI `bash uninstall.sh`)
2. If `~/.claude/settings.json` still has `env.ANTHROPIC_BASE_URL` pointing at `127.0.0.1` / `localhost`, remove that key (CLI uninstall does this for loopback URLs).
3. Optional: `pkill -f claude-proxy`

Leaving a loopback `ANTHROPIC_BASE_URL` after uninstall makes plain `claude` talk to a dead port.

## Reporting issues

Security-sensitive reports: open a private report or GitHub security advisory on
[whichguy/c-thru](https://github.com/whichguy/c-thru) if available; otherwise a
high-level issue without exploit detail.
