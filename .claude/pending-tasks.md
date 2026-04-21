# Pending Tasks — c-thru

Last updated: 2026-04-20

---

## Task 4 — At session start, load pending-tasks.md into the active TODO list

At the start of each session (or after /clear), read `.claude/pending-tasks.md`
and populate the in-context task list so pending work is visible without manual
prompting.

---

## Task 1 — Phase 2: Extract `resolveProfileModel` into shared module

**Blocks:** Phase 3 (depends on shared module being stable)

Extract `resolveProfileModel` (`claude-proxy:428`) and `resolveLlmMode`
(`claude-proxy:403`) into `tools/model-map-resolve.js` as a stdlib-only shared
module. Update `claude-proxy` to `require('./model-map-resolve')` and remove
the Phase-1 `// TODO: dedupe` markers in `skills/c-thru-config/SKILL.md`.

**Spike gate (required before merge):**
1. Run `tools/verify-lmstudio-ollama-compat.sh` — confirm proxy still starts and routes.
2. Send 20 capability-alias requests each (`judge`, `deep-coder`, `orchestrator`,
   `local-planner`) across all 4 modes. Confirm `x-c-thru-resolved-via` headers
   are byte-identical to pre-spike baseline.
3. Only merge once parity is confirmed.

**New file:** `tools/model-map-resolve.js` — exports `resolveProfileModel`,
`resolveLlmMode`, `resolveActiveTier`, `resolveCapabilityAlias`. Stdlib-only
(no external deps).

**New test:** `test/resolve-capability.test.js`
- Unit: pure-function cartesian product (4 modes × all tiers × all capabilities
  in fixture). No env, no CONFIG global.
- Integration: spawn `node tools/c-thru-resolve <cap>` with `CLAUDE_LLM_MODE`
  + `CLAUDE_MODEL_MAP_DEFAULTS_PATH` set to fixture; assert stdout matches
  pure-function result.

**Callers to update on extraction:**
- `tools/claude-proxy` — `resolveLogicalAlias` (`claude-proxy:462`)
- `skills/c-thru-config/SKILL.md` — inline `resolve` and `diag` node blocks

---

## Task 2 — Phase 3: Add `route` / `backend` / `reload --reload` wrappers

**Blocked by:** Task 1 (Phase 2) — not strictly, but cleaner to do after extraction

Add three thin subcommands to `skills/c-thru-config/SKILL.md`:

- **`route <model> <backend>`** — shells to `model-map-edit.js` with
  `{model_routes: {"<model>": "<backend>"}}`.
- **`backend <name> <url> [--kind <kind>] [--auth-env <VAR>]`** — shells to
  `model-map-edit.js` with `{backends: {"<name>": {kind, url, auth_env}}}`.
- **`--reload` flag** on `remap` and `mode` — opt-in inline SIGHUP after a
  successful edit (Phase 1 already has standalone `reload` subcommand).

Also consider: add Ollama `/api/tags` drift probe to `diag` output — one-line
summary of capability-referenced models not present in `ollama list`.

**Git commit:** `feat: /c-thru-config route|backend|--reload wrappers (Phase 3)`

---

## Task 3 — Audit `review-plan` skill for `/c-thru-plan` alignment

**Source:** Persistent memory — flagged as pending since PR #15.

Check `skills/review-plan/SKILL.md` (interactive skill) vs
`agents/review-plan.md` (headless agent invoked by c-thru-plan Phase 3) for
drift:

- Phase 8 exit path in the interactive skill — still coherent with headless
  `APPROVED` / `NEEDS_REVISION` verdict vocabulary?
- `allowedPrompts` list in the interactive skill — still covers the tools that
  the c-thru-plan Phase 3 loop actually needs?
- Does the headless agent's prompt schema match what `c-thru-plan` passes
  (`current.md`, `INDEX`, `round`, `review_out`)?

Flag any divergence. If clean, remove the pending memory entry.

---

## Task 5 — Security: verify proxy only binds to 127.0.0.1

Both HTTP listeners currently bind to `127.0.0.1` (main API: line 2587, hooks: line 2714),
but there is no test or documented invariant enforcing this.

**Audit checklist:**
- Confirm `server.listen` and `hooksServer.listen` both pass `'127.0.0.1'` — not `'0.0.0.0'` or omitted.
- Check any future server/socket created inside the proxy follows the same invariant.
- Search for `listen(` calls that lack a hostname argument — Node defaults to `0.0.0.0` when omitted.

**Regression test** (`test/proxy-lifecycle.test.js` or new file):
- After spawn, parse `READY <port>` and verify `net.connect({ host: '0.0.0.0', port })` is refused
  while `net.connect({ host: '127.0.0.1', port })` succeeds — confirming loopback-only binding.
- Same check for hooks port.

**Documentation:**
- Add comment near each `server.listen` call noting that loopback-only binding is a security invariant.
- Add to CLAUDE.md Proxy Lifecycle section: "Both listeners (API + hooks) bind to 127.0.0.1 only. Do not change to 0.0.0.0."

---

## Completed

- **PR #26** (2026-04-20) — Phase 1: `/c-thru-config` skill + `llm_profiles`
  editor + 14 unit tests. Merged to main.
- **Task 2** (2026-04-20) — Phase 3: `route`, `backend`, `--reload` wrappers added to `/c-thru-config` skill. Diag Step 4 Ollama drift probe added.
- **Task 1** (2026-04-20) — Phase 2: extracted `resolveProfileModel`, `resolveLlmMode`,
  `resolveActiveTier`, `resolveCapabilityAlias` → `tools/model-map-resolve.js`. Removed 7
  local defs from `claude-proxy`; removed 3 TODO markers from SKILL.md. New `tools/c-thru-resolve`
  CLI + `test/resolve-capability.test.js` (61 tests). ⚠ Spike gate (live proxy parity) still needed.
