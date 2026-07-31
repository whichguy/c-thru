---
description: Multi-model c-thru advisor panel (fleet seats per connectivity mode)
---

# /advisors

Run the **advisors** skill / fleet agent: resolve `advisor_panels` for the active
connectivity mode, fan out to seat agents (pass 1 + pass 2), synthesize a host final.
Prefer `Agent(subagent_type: "advisors")` under `cthru` (see `agents/advisors.md`).

## Usage

```
/advisors <question>
/advisors --panel default <question>
```

**Requires `cthru`** (CLI fleet inject). If a global Grok skill is also named
`advisors`, invoke under `cthru` so fleet preflight and seat routing apply.

Inspect seats:

```bash
c-thru explain --panel default --format json
```

See `skills/advisors/SKILL.md`.
