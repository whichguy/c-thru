---
name: schedule-plan-tasks
description: |
  Dispatches READY_ITEMS from a c-thru wave plan to worker agents via TaskCreate.
  Reads current.md to determine ready items and their target agent types, then
  creates one task per item. Returns task IDs so the orchestrator can monitor them.
  Invoked by the plan-scheduler agent.
color: blue
---

# /schedule-plan-tasks — Dispatch Wave Items to Worker Tasks

Dispatches READY_ITEMS from the current plan wave to worker agents using TaskCreate.
Each item becomes one pending task with the appropriate `subagent_type`.

## Input

`$ARGUMENTS` must be a path to the plan directory containing `current.md`:

```
/schedule-plan-tasks <plan_dir> [--wave <NNN>] [--items <id1,id2,...>]
```

- `<plan_dir>` — required. Path to the active plan directory (contains `current.md`).
- `--wave <NNN>` — optional. Zero-padded wave number (e.g. `001`). Defaults to next unused wave in `waves/`.
- `--items <id1,id2,...>` — optional. Comma-separated item IDs to dispatch. Defaults to all READY_ITEMS (pending items with all dependencies met).

## Execution

### Step 1 — Read plan state

```bash
PLAN_DIR="<first argument>"
CURRENT_MD="$PLAN_DIR/current.md"
```

Read `$CURRENT_MD`. Parse all items where `status: pending` and all `depends_on` entries are `[x]` or `depends_on` is empty/absent — these are the READY_ITEMS. If `--items` was given, use those IDs instead (validate each is present in current.md).

If READY_ITEMS is empty, print:
```
schedule-plan-tasks: no READY_ITEMS found in <plan_dir>/current.md — nothing to dispatch
```
and exit 0.

### Step 2 — Resolve wave directory

If `--wave` is given, use `$PLAN_DIR/waves/<NNN>`.
Otherwise, find the next unused zero-padded wave number:
```bash
NNN=$(ls "$PLAN_DIR/waves/" 2>/dev/null | grep -E '^[0-9]{3}$' | sort | tail -1)
NNN=$(printf '%03d' $(( ${NNN:-0} + 1 )))
WAVE_DIR="$PLAN_DIR/waves/$NNN"
```

Create the wave directory:
```bash
mkdir -p "$WAVE_DIR/digests" "$WAVE_DIR/outputs" "$WAVE_DIR/findings"
```

### Step 3 — Resolve agent type per item

For each READY_ITEM, determine the appropriate `subagent_type`. Check in order:
1. Item metadata field `agent:` if present in current.md item block
2. Item type field `type:` mapped via the table below
3. Default: `coder`

| Item type | subagent_type |
|---|---|
| `plan`, `design`, `architecture` | `planner` |
| `code`, `implement`, `feature`, `fix`, `refactor` | `coder` |
| `test`, `tests`, `testing` | `tester` |
| `docs`, `documentation` | `docs` |
| `review` | `code-reviewer` |
| `explore`, `research`, `discovery` | `explore` |
| `debug` | `debugger-hypothesis` |
| (default) | `coder` |

### Step 4 — Create tasks

For each READY_ITEM call TaskCreate:
- **subject**: `<item-id>: <item-title from current.md>`
- **description**: full item body from current.md, plus `wave_dir: <WAVE_DIR>` and `plan_dir: <PLAN_DIR>`
- **activeForm**: present-tense form of the subject (e.g. "Implementing X")

Print each created task:
```
scheduled: <item-id> → <subagent_type> (task #<N>)
```

### Step 5 — Summary

Print:
```
schedule-plan-tasks: dispatched <count> item(s) to wave <NNN>
  wave_dir: <WAVE_DIR>
  tasks: <task-id1>, <task-id2>, ...
```
