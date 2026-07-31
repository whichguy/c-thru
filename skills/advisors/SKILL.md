---
name: advisors
description: >
  c-thru multi-model advisor panel: parallel fleet seat agents, optional second
  pass with peer context, host synthesis. Use when the user runs /advisors,
  says "advisors:", "run advisors on", "fleet advisors panel", or wants independent
  c-thru-routed perspectives then a consolidated verdict. Seats come from config
  advisor_panels for the active connectivity mode. Prefer Agent(subagent_type:
  "advisors") under cthru. Requires a cthru CLI launch (fleet inject). If a global
  Grok-native "advisors" skill is also installed, invoke under cthru — hard fleet
  preflight distinguishes this panel.
---

# advisors (fleet multi-agent panel)

Slash entry for the fleet agent **`advisors`** (`agents/advisors.md`).

| Surface | How |
|---------|-----|
| **Skill / slash** | `/advisors <question>` (this skill) |
| **Agent dispatch** | `Agent(subagent_type: "advisors", prompt: …)` |

**Preferred host path:** dispatch the fleet agent (keeps main-session context clean):

```
Agent(
  subagent_type: "advisors",
  description: "advisors panel",
  prompt: <user question, optional --panel role>
)
```

If you are already the `advisors` agent (parent spawned you), run the procedure in
`agents/advisors.md` yourself — do not re-dispatch `advisors`.

**Requires `cthru` CLI fleet inject.** Marketplace plugin alone does not ship this
skill or the seat agent fleet (Shape C lean plugin). Host capability:
`agent_to_capability.advisors` → `planner-hard`.

**Name collision:** A global Grok skill may also be named `advisors`. Under `cthru`
this skill lives at the c-thru inject path (`skills/c-thru/advisors`); fleet
preflight fails closed off CLI fleet inject. Prefer **`/advisors`** after `cthru`.

## Procedure (authoritative: agents/advisors.md)

Two-pass deliberation; seats from `advisor_panels` for the active connectivity mode:

| Pass | Behavior |
|------|----------|
| **1** | Same prompt → each seat **in parallel** as `Agent(subagent_type: <seat>)` |
| **2** | Each seat again **in parallel** with own pass-1 + peer pass-1; may ADOPT / REVISE / REJECT |
| **Host** | **advisors** agent (or this session if running inline) synthesizes `final.md` |

Hard preflight: `c-thru explain --panel <role> --format json` must return ≥2 seats with
empty `errors`, and the session must be a `cthru` launch. Abort — do not invent seats.

```bash
c-thru explain --panel default --format json
```

Change seats via `advisor_panels` (or user overrides), not by editing brand agent files.
