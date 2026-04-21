---
name: Claude Code Hook Channels
type: entity
description: "Which Claude Code hook channels reach the user and which don't (systemMessage, statusline, additionalContext, stderr, osascript)"
tags: [hooks, claude-code, channels, systemMessage, statusline]
confidence: high
last_verified: 2026-04-18
created: 2026-04-18
last_updated: 2026-04-21
sources: [b50c3df0, 2a5c31f5]
related: [c-thru-statusline, hook-safety-posture, fallback-event-system]
---

# Claude Code Hook Channels

Research into which Claude Code hook output channels actually reach the end user, and which are invisible or misleading. This maps the viable surface area for any hook that needs to surface state to the person running Claude Code.

- **From Session b50c3df0:** Channels that reach the user: (1) **Stop hook `systemMessage`** — shown inline after the assistant response AND added to Claude's context for the next turn. Fires exactly once per assistant response. Best for event-moment notifications. (2) **Statusline** — persistent bottom-of-terminal display, refreshes on each assistant message + `refreshInterval`. Best for persistent state. (3) **`osascript`/`terminal-notifier`** — native macOS toast, transient, good for AFK backup. (4) **UserPromptSubmit `additionalContext`** — injected as `<system-reminder>`, Claude sees it but user doesn't directly. Supporting role only.
- **From Session b50c3df0:** Channels that do NOT work: (1) **Custom `x-claude-*` HTTP response headers** — proxy already sets them, Claude Code ignores them entirely. (2) **SessionStart stdout** — regressed in Claude Code 2.1.37 (issue #24425), no longer displayed. (3) **PreToolUse/PostToolUse `additionalContext`** — only fires on tool use, not on plain Q&A turns. (4) **Stop hook stdout** — goes to debug log only, not user-visible. (5) **ANSI escape sequences** — Claude Code TUI doesn't process them (issue #10666). (6) **Hook stderr + exit 2** — shown as "hook error" in transcript, misleading (looks like a bug, not information).
- **From Session b50c3df0:** For out-of-process readers (shell scripts), `~/.claude/proxy.log` is the primary state transport — not a separate snapshot file and not HTTP. The Stop hook and statusline both tail the log. Adding an HTTP round-trip per invocation is unacceptable latency for synchronous hooks with tight stdout budgets. The `/hooks/context` HTTP path (port 9998) is only viable for hooks that already make an HTTP call (e.g. `c-thru-classify.sh` piggybacks the classify-intent round-trip).

- **From Session 2a5c31f5:** PreToolUse hooks on `EnterPlanMode` can reach the user via stderr as a non-blocking advisory — the hook emits a hint and exits 0, so the original tool call (EnterPlanMode) proceeds. This is distinct from the general "hook error" exit-2 path: exit-0 stderr is advisory (user sees the message), exit-2 stderr is error-coded. The `EnterPlanMode` advisory pattern avoids blocking because hard-blocking would break `review-plan`'s Phase 8 contract.

- **From Session 9c6ed72e:** The `/hooks/context` HTTP endpoint (port 9998) was emitting `hookSpecificOutput.additionalContext` for ALL events including `PostCompact` (side-effect-only), causing "Hook JSON output validation failed — Invalid input" on every `/compact`. Fix: `SIDE_EFFECT_EVENTS` set in `claude-proxy` routes those events to top-level `systemMessage` instead. Review-fix also hoisted the set to module scope (was per-request) and made the unknown-eventName fallback emit `{}` instead of schema-invalid output. Commits: `77641a4`, `2cbd954`.

→ See also: [[c-thru-statusline]], [[hook-safety-posture]], [[fallback-event-system]], [[planner-default-integration]]