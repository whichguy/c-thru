# TODO: Is advisors packaged with the default marketplace setup?

**Status:** open product question (document + decide; do not silently change Shape C without a decision).  
**Opened:** 2026-07-30 (user ask after `/advisors` + fleet agent `advisors` landed).

## Question

Is the **advisors** multi-seat panel (skill `/advisors`, fleet agent `agents/advisors.md`, `advisor_panels` seats) part of the **default marketplace plugin** install path, or **CLI/`cthru` only**?

## Current behavior (as of this TODO)

| Surface | Marketplace plugin (Shape C lean) | CLI (`bash install.sh` + `cthru`) |
|---------|-----------------------------------|-------------------------------------|
| Skill `skills/advisors` | **Not shipped** in `plugins/c-thru/skills/` | Injected / available under `cthru` |
| Agent `agents/advisors.md` | **Not** in lean plugin agent package | Injected via ephemeral `--agents` |
| Slash `/advisors` command | Not a lean marketplace command | Installed by `install.sh` → `~/.claude/commands/advisors.md` |
| `advisor_panels` + resolve | Map may exist in plugin config mirror | Full resolve via `c-thru explain --panel` |

**Enforced lean:** `test/setup-docs-alignment.test.js` lists `advisors` among skills that **must not** ship under `plugins/c-thru/skills/`. Skill/agent docs require **`cthru` fleet inject** and hard-preflight abort otherwise.

So **today: not packaged with default marketplace setup** for runnable panel behavior. Marketplace is discovery/bootstrap; panel execution is CLI fleet.

## Why this might still be a TODO

- User-facing expectation: “I installed the marketplace plugin — do I get `/advisors`?”
- Possible product outcomes:
  1. **Keep CLI-only** (current Shape C) — document more loudly in Shape C quick start / install-cli.
  2. **Ship skill + command in plugin** that only **redirects** to install-cli / aborts with install path (soft surface, no fleet).
  3. **Ship full panel in marketplace** — requires fleet agents + inject redesign (breaks lean Shape C unless fleet moves into plugin).

## Acceptance when closing

- [ ] Explicit product decision recorded (1 / 2 / 3 above).
- [ ] README Shape C matrix + `docs/marketplace-release.md` (or equivalent) match the decision.
- [ ] If still CLI-only: getting-started / `/c-thru:install-cli` mention `/advisors` as CLI-only.
- [ ] If packaging changes: update lean test allowlist, plugin bundle, and skill preflight.

## Related

- `skills/advisors/SKILL.md`, `agents/advisors.md`, `commands/advisors.md`
- `config/model-map.json` → `advisor_panels`, `agent_to_capability.advisors`
- README plugin vs CLI matrix; `test/setup-docs-alignment.test.js` lean skills list
