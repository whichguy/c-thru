# TODO: Align README and install.sh with current c-thru code

## Problem

Both `/Users/jameswiese/src/c-thru/README.md` and
`/Users/jameswiese/src/c-thru/install.sh` were written earlier in the
project's life and may no longer reflect the current code surface. Recent
changes that likely need to be documented/installed:

- `claude-proxy` migrated Ollama CLI spawns to HTTP (`/api/tags`,
  `/api/pull`, `/api/ps`, `/api/generate`); the `ollama` CLI is no longer
  a runtime dependency — README should stop implying it is.
- New env vars: `CLAUDE_PROXY_OLLAMA_PULL_TIMEOUT_MS`,
  `CLAUDE_PROXY_OLLAMA_WARM_TIMEOUT_MS`, `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE`
  (warm behavior) — document in the env-var table.
- `llm-capabilities-mcp.js` MCP server registration — confirm installer
  still wires it into `~/.claude.json` correctly.
- Hook registrations (`c-thru-session-start.sh`,
  `c-thru-proxy-health.sh`, `c-thru-classify.sh`, `c-thru-map-changed.sh`)
  — installer should idempotently add/refresh the `hooks` entries in
  `~/.claude/settings.json` (SessionStart, PostCompact, UserPromptSubmit,
  FileChanged). Verify the hook-port plumbing (`CLAUDE_PROXY_HOOKS_PORT`,
  default 9998) matches what the scripts expect.
- `/hooks/context` HTTP hook registration (referenced in settings.json)
  — confirm installer creates this entry.

## Deeply consider the Claude Code setup

- Which hooks should be GLOBAL (fire on every Claude session) vs
  SCOPED (only when `ANTHROPIC_BASE_URL` points at the proxy)? Today
  some c-thru hooks fire globally and touch the proxy even on non-c-thru
  sessions — see `TODO-user-hook-model-rewriting.md`. The installer
  should reflect the scoping decision when it writes the settings
  entries (e.g., add a trivial guard wrapper or let each script self-gate).
- Which MCP servers does c-thru *require* (`llm-capabilities-mcp`) vs
  *integrate with* (optional: chrome-devtools for UI debugging, gas
  tooling for the user's adjacent work)? README should be explicit.
- What is the uninstall path? Today `install.sh` has no paired
  uninstaller — decide whether to add one or document manual removal
  (delete symlinks in `~/.claude/tools/`, remove settings.json hook
  entries, drop `~/.claude/model-map.json` if user-seeded).
- Should install.sh verify `node >= <version>` and bail loudly if not
  met? (Proxy uses `AbortController`, which requires Node >= 15.0.)
- Does the installer touch `~/.claude/model-map.json` destructively or
  additively? The 3-tier layered lookup (project -> user -> shipped)
  means the user layer should be preserved across upgrades.

## Deliverable

1. Walk the current `tools/`, `config/`, and `wiki/` trees; produce a
   surface inventory.
2. Diff that inventory against what `README.md` currently describes and
   what `install.sh` currently installs.
3. Update README.md: fix the install steps, env-var table, architecture
   diagram, and hook inventory.
4. Update install.sh: idempotent settings.json editing for hook/MCP
   registration, Node version check, non-destructive model-map seeding,
   and — explicitly — handle the "Claude Code setup" scoping question
   resolved above.
5. Add a `--uninstall` flag or a companion `uninstall.sh` that reverses
   the installer's effects cleanly.
6. Dry-run mode (`install.sh --dry-run`) that prints what *would*
   change without mutating `~/.claude/`.

## Recent changes that may require installer updates

- `hookEventName` is now required in all `hookSpecificOutput` emissions
  (Claude Code v2.1.114+). The four hook scripts (`c-thru-session-start.sh`,
  `c-thru-classify.sh`, `c-thru-map-changed.sh`, `c-thru-proxy-health.sh`)
  are fixed. Verify installer symlinks the updated versions and that
  `~/.claude/settings.json` hook entries match the registered event names.
- `c-thru-map-changed.sh` is registered as `PostToolUse` (not `FileChanged`).
  Confirm the settings.json entry uses the correct event name.
- Proxy `requestMeta` crash (fix: 35ccb58) — if any user has an older proxy
  binary cached, `pkill -f claude-proxy` will force a respawn from the updated source.
