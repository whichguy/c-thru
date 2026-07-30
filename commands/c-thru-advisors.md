---
description: Multi-model c-thru advisor panel (fleet seats per connectivity mode)
---

# /c-thru-advisors

Run the **c-thru-advisors** skill: resolve `advisor_panels` for the active
connectivity mode, fan out to seat agents (pass 1 + pass 2), synthesize a host final.

## Usage

```
/c-thru-advisors <question>
/c-thru-advisors --panel default <question>
```

**Requires `cthru`** (CLI fleet inject). Not the global Grok skill `/advisors`.

Inspect seats:

```bash
c-thru explain --panel default --format json
```

See `skills/c-thru-advisors/SKILL.md`.
