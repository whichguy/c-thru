# Runtime / invocation-time injection — research

Goal (user): *"inject things at runtime/invocation time as much as possible"* rather than
writing durable config. This catalogs the full Claude Code CLI invocation surface, marks what
c-thru already injects, and ranks the high-value args it does **not** yet inject — all consistent
with the **inline-override principle** (launch-time overrides are inline/ephemeral args + env,
never permanent file writes).

Captured against the local `claude --help` surface on 2026-06-17. Re-run `claude --help` before
acting — the CLI surface moves.

---

## What c-thru injects today

**Flags** (built in `build_forwarded_args`, `tools/c-thru`):
- `--model <resolved>` — concrete model from the capability/mode/tier resolution.
- `--append-system-prompt <info>` — routing summary + proxy control-plane URL (optionally `/no_thinking`).
- `--settings <json>` — **inline JSON string, never written to disk**: `mcpServers` (llm-capabilities) + `hooks` (SessionStart, PreCompact, PreToolUse agent-router, …).
- `--agents <json>` — inline ephemeral agent definitions.

**Pass-through only** (not injected):
- `--dangerously-skip-permissions` — forwarded only when the user explicitly passes it; no longer auto-prepended.

**Env** (exported into the `claude` process):
- `ANTHROPIC_BASE_URL` → the proxy; `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` (proxied placeholder).
- `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL` — background-slot capability names (local-enforcing modes).
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, `C_THRU_SESSION_ID=$$`, c-thru-private `CLAUDE_LLM_MODE` / `CLAUDE_LLM_PROFILE` / `CLAUDE_LLM_MEMORY_GB`.

This already covers the big four injection channels: **model, system prompt, MCP+hooks (settings), agents.**

---

## High-value args NOT yet injected (ranked)

| # | Arg | Why it fits c-thru | Maps to | Caveat |
|---|---|---|---|---|
| 1 | `--fallback-model <m1,m2>` | Native CC-level failover when the primary is overloaded/unavailable — c-thru already computes a local fallback. | `resolveLocalFallback(entry,tier,mode)` | **`--print` only**; re-tries primary each turn. |
| 2 | `--effort <low…max>` | Tie effort to mode/capability (e.g. high-stakes `planner-hard`/`reviewer-security` → `high`/`xhigh`; fast-scout → `low`). | per-capability/mode field | session-wide; consider per-agent via hook. |
| 3 | `--mcp-config <json>` + `--strict-mcp-config` | Inject the llm-capabilities MCP as its own config and **isolate** it from ambient `.mcp.json`, instead of embedding under `--settings.mcpServers`. | current `EPHEMERAL_SETTINGS_JSON.mcpServers` | `--strict-mcp-config` drops user MCP servers — opt-in. |
| 4 | `--setting-sources <user,project,local>` | Hermetic, reproducible routed launches — decide exactly which durable setting layers leak in. | new flag | omitting a source changes behavior; document. |
| 5 | `--exclude-dynamic-system-prompt-sections` | Moves per-machine sections out of the system prompt → better **prompt-cache reuse** through the proxy (c-thru caches). | proxy caching | ignored when `--system-prompt` is set. |
| 6 | `--betas <…>` | Per-model/capability beta headers at launch (API-key users). | model_extra_params analog | API-key auth only. |
| 7 | `--max-budget-usd <amt>` | Hard cost ceiling for cloud/offload sessions. | cost-control modes | **`--print` only**. |

**#1, #2, #3 are the strongest fits** — each maps to a capability c-thru already models
(fallback resolution, per-role tiers, MCP injection) and is purely ephemeral.

---

## Situational / opt-in

- `--system-prompt` / `--system-prompt-file` / `--append-system-prompt-file` — full replace vs. the current append; file form avoids huge argv.
- `--agent <name>` — set the *session* agent (distinct from `--agents` definitions).
- `--add-dir <dirs…>` — extra tool-access dirs.
- `--allowedTools` / `--disallowedTools` / `--tools` — tool gating per mode (e.g. a read-only review mode).
- `--permission-mode <plan|acceptEdits|…>` — softer alternative to the blanket skip for specific modes.
- `--json-schema <schema>` — structured output (with `--print`).
- `--plugin-dir` / `--plugin-url` — session-only plugins.
- `--name` / `--session-id` / `--fork-session` — session identity (c-thru already sets `C_THRU_SESSION_ID`; a CC `--name` could mirror the active mode).
- `--max-turns`-style controls live in `--settings`; already reachable via the inline settings JSON.

## Minimal / troubleshooting modes (mutually exclusive with c-thru's model)

- `--bare` — skips hooks, plugin sync, CLAUDE.md, auto-memory, keychain; Anthropic auth restricted to API key / apiKeyHelper. **Conflicts** with c-thru's hook-driven routing (SessionStart context, agent-router hook) — would disable per-agent routing. Not for normal use.
- `--safe-mode` — disables all customizations. Same conflict; troubleshooting only.

## Not applicable to c-thru launches

`-c/--continue`, `-r/--resume`, `--from-pr`, `--ide`, `--tmux`, `--worktree`, `--chrome`,
`--remote-control*`, `--replay-user-messages`, `--include-*` / `--input-format` / `--output-format`
(stream-json plumbing) — user/session choices, not routing injections (c-thru forwards them
through untouched via the `*)` passthrough in `build_forwarded_args`).

---

## Env-channel injection (complements flags)

Already used: `ANTHROPIC_BASE_URL`, `ANTHROPIC_*_MODEL`, `CLAUDE_CODE_ATTRIBUTION_HEADER`.
Candidates aligned with the goal:
- `MAX_THINKING_TOKENS` / thinking-budget envs — pair with `--effort` / `--thinking`.
- `CLAUDE_CODE_SUBAGENT_MODEL` — deliberately **left unset** today (pinning it would override the
  per-agent hook's `updatedInput.model` and collapse all subagents to the parent backend — see
  `apply_background_model_overrides`). Keep unset.
- `DISABLE_*` background-traffic toggles — only if a mode wants to suppress specific background calls.

---

## Recommendation

Pursue **#1 `--fallback-model`** and **#2 `--effort`** first: both are pure runtime injections that
reuse resolution c-thru already performs, add resilience/quality knobs per mode, and write nothing
durable. **#3 `--mcp-config` + `--strict-mcp-config`** is a clean refactor of today's
`--settings.mcpServers` embedding with real isolation value. Each is independently shippable behind
a `--mode`/capability field and an env opt-out, and each needs a forwarder-strip + a parity/e2e test
(mirror `cli-e2e-flags`). Gate `--print`-only flags (#1, #7) on the presence of `-p/--print` in
`ORIG_ARGS` so interactive launches don't get a silently-ignored flag.
