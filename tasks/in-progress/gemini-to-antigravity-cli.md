# TODO: Switch Gemini CLI usage to Anti-Gravity CLI

**Status:** open / backlog  
**Priority:** P1 (retired CLI will break any path that still shells out to old `gemini`)  
**Added:** 2026-07-14  

## Goal

Change over from the older **Gemini command-line CLI** (retired / no longer works) to **Anti-Gravity**, and ensure c-thru (and any local tooling/docs) invokes the Anti-Gravity CLI correctly.

## Why

The legacy Gemini CLI has been retired. Continued use of `gemini` (or docs/scripts that assume it) will fail silently or with hard errors. Anti-Gravity is the supported replacement path for Google’s agent/CLI surface.

## Scope (c-thru)

Audit and update every place that assumes the old Gemini CLI:

1. **Shell / install / health**
   - `install.sh` / `c-thru check-deps` / any brew or PATH probes for `gemini`
   - SessionStart / status hooks that report Gemini CLI health
2. **Router / proxy**
   - Confirm proxy `endpoints.gemini_ai` / `gemini_vertex` API paths stay API-key based (no CLI dependency), **unless** we intentionally add a CLI-backed path
   - Document clearly: API routing (proxy) vs CLI agent (Anti-Gravity)
3. **Agents / skills / docs**
   - Brand agent `gemini`, README, `docs/env-vars.md`, `docs/agent-architecture.md`, gemini gap/subscription docs
   - Any “run `gemini …`” examples → Anti-Gravity equivalents
4. **Operator machine**
   - Install/auth for Anti-Gravity CLI
   - Remove or deprioritize broken `gemini` binary from PATH if it is the retired package
5. **Tests / smoke**
   - Replace any e2e that shells to `gemini` with Anti-Gravity commands
   - Smoke: Anti-Gravity non-interactive prompt succeeds with expected model/auth

## Acceptance criteria

- [ ] Inventory: every reference to the old Gemini CLI in this repo is listed (grep + install footprint)
- [ ] Anti-Gravity CLI is the documented install/auth path for Google’s CLI agent
- [ ] No required c-thru path depends on the retired `gemini` binary
- [ ] Docs and brand-agent copy say Anti-Gravity where the CLI is meant
- [ ] Smoke test (or opt-in live suite) proves Anti-Gravity works on this machine
- [ ] Optional: c-thru status surfaces Anti-Gravity version/auth health (not legacy gemini)

## Notes / open questions

- Confirm package name / binary (`antigravity` vs `anti-gravity` vs rebranded `gemini` wrapper) and install source before changing PATH probes.
- Proxy Gemini API translation (`forwardGemini`) is separate from the CLI migration — do not break API routing while swapping the CLI.
- Brand agent `gemini` currently pins to the **proxy** model path (`model:gemini-pro`); only rewire if product intent is CLI spawn, not API routing.

## Out of scope (unless decided later)

- Rewriting Gemini API wire format in `claude-proxy`
- Dropping `gemini_ai` / Vertex endpoints
- Marketplace plugin packaging of Anti-Gravity
