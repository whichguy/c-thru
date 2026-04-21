---
title: Planner Default Integration
tags: [c-thru-plan, hooks, planning, enter-plan-mode, install]
---

## Summary

`/c-thru-plan` is surfaced as the default planning path via a soft-redirect architecture: an `EnterPlanMode` PreToolUse advisory hook emits a hint to stderr whenever Shift+Tab is pressed, suggesting `/c-thru-plan <intent>` for multi-wave feature work. The hook never blocks — native plan mode continues to function identically, which is required for `review-plan`'s Phase 8 `ExitPlanMode` flow.

## Components

| Component | Path | Role |
|---|---|---|
| Hook script | `tools/c-thru-enter-plan-hook.sh` | Reads stdin (payload), emits advisory to stderr, exits 0 always |
| Command shortcut | `~/.claude/commands/cplan.md` | `/cplan <intent>` → `Skill("c-thru-plan", args)` |
| Skill subcommand | `skills/c-thru-config/SKILL.md` § `planning` | `on`/`off`/`status` toggle for hook + opt-out override |
| Install wiring | `install.sh` `install_planner_hint_hook()` + `install_cplan_command()` | Idempotent registration on `./install.sh` |

## Hook shape (settings.json)

```json
{
  "matcher": "EnterPlanMode",
  "hooks": [{"type": "command", "command": "~/.claude/tools/c-thru-enter-plan-hook", "timeout": 3}]
}
```

Registered under `hooks.PreToolUse` — same event surface as the existing `ExitPlanMode` gate.

## Opt-out paths

1. **Per-session env:** `CLAUDE_ROUTER_PLANNER_HINT=0` — suppresses hint without touching settings.
2. **Persistent toggle:** `/c-thru-config planning off` — removes hook from `settings.json`, writes `planner_hint: false` to `model-map.overrides.json`.
3. **Install-time skip:** if `planner_hint: false` is already in overrides, `install_planner_hint_hook()` silently skips registration.

## Global scope note

`settings.json` is the user-global Claude Code config (`~/.claude/settings.json`). The `EnterPlanMode` hook fires in **every Claude Code session on the machine**, not only inside c-thru projects. `install.sh` prints a disclosure on first registration:

> `Note: this hook fires in all Claude Code sessions on this machine. Disable: /c-thru-config planning off`

Idempotent re-runs suppress the notice.

## Why non-blocking

Hard-blocking `EnterPlanMode` would break `review-plan`, which calls `EnterPlanMode` as part of its Phase 8 contract (plan mode is entered so `ExitPlanMode` can be gated by the review marker). Blocking would require `review-plan` to carry a bypass credential, adding coupling. Advisory-only is strictly simpler.

## Cross-references

- `wiki/entities/c-thru-plan` — the skill being surfaced
- `wiki/entities/sighup-config-reload` — proxy reload pattern used by `planning on/off`
- `~/.claude/hooks/exit-plan-mode-gate.sh` — existing `ExitPlanMode` PreToolUse hook (shape reference)
