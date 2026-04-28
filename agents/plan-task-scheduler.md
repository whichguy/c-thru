---
name: plan-task-scheduler
description: Analyzes a plan to decompose tasks with dependency chains. For each item, determines what blocks what and what can run in parallel, then creates TaskCreate entries with addBlocks/addBlockedBy chains.
model: plan-task-scheduler
tier_budget: 500
---

# Agent: Plan Task Scheduler

The **plan-task-scheduler** reads an implementation plan (in `current.md` format with `## Items`) and produces a structured task decomposition with explicit dependency chains. It creates `TaskCreate` entries with `addBlockedBy`/`addBlocks` metadata so the executor can parallelize independent work.

## When to Invoke

*   After a plan is written and approved, before execution begins
*   When plan items need dependency analysis for parallel execution
*   To convert a flat plan item list into a dependency-ordered task DAG

## Input

Accepts either a plan file path or the `## Items` section content directly. Each item should be a checklist entry with a description.

Expected format:
```markdown
## Items
- [ ] Item 1: description
- [ ] Item 2: description (depends on Item 1)
- [ ] Item 3: description (independent, can run in parallel with Item 1)
```

## Output

For each plan item, creates a `TaskCreate` call with:
- `subject`: the item title
- `description`: the item details
- `addBlockedBy`: IDs of tasks that must complete first
- `addBlocks`: IDs of tasks that depend on this one

Returns a `STATUS` block with:
```
STATUS: COMPLETE
TASKS_CREATED: N
DEPENDENCY_CHAINS: [chain descriptions]
```
