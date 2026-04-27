# TODO

Backlog of work not yet shipped. Items shipped during sessions are removed
from this file (git log preserves the history); only OPEN or PARTIALLY-OPEN
items remain.

Last cleanup: 2026-04-26

## Reliability

**[refactor] Extract `handleOllamaFallback` from `forwardOllama` error handler**
`forwardOllama` has been partially decomposed: `setupOllamaStream`,
`handleOllamaNonStream`, `handleOllamaError`, and `buildOllamaRequestBody`
are all extracted. The remaining function is ~120 lines. The one dense section
still in the main function body is the `up.on('error')` handler (~40 lines)
which manages mid-stream vs pre-stream fallback, cloud→local rewrite, and
`tryFallbackOrFail`. Extracting it as `handleOllamaFallback` requires passing
8+ closed-over variables as parameters. Defer to its own session — needs a
test plan covering the TTFT/timeout/stall split, fallback chain deduplication,
and SSE mid-stream error frame path. Any regression breaks streaming for all
Ollama backends.

## Configuration / capacity

## Documentation

**[docs] Breadcrumb pass on bash router and resolver**
Proxy is done (9e5a616). Still open:
- `tools/c-thru` (bash) — lock-and-spawn dance, ready-pipe handshake, hook
  registration, env var scrubbing, hw-profile detection, ensure-ollama-
  running flow.
- `tools/model-map-resolve.js` — 16-mode `resolveProfileModel` switch,
  `applyModeFilter`, `pickBenchmarkBest` scoring.
- `tools/model-map-config.js` — 3-tier sync, project-overlay path
  derivation (annotate why the pollution fix matters).

Token-efficient breadcrumb style (one concise sentence, lead with WHY,
mark invariants and sharp edges explicitly, no Doxygen). Verify with a
spot-check: pick a random function and confirm the breadcrumb is enough
to predict its purpose without reading the body.

**[docs] Full repo audit + thoughtful README rewrite — round 2**
First-pass README rewrite shipped in b79f296. Still open:

1. Verify every claim in the new README against current code (env vars,
   commands, file paths, behavior). Anything that no longer matches
   reality → remove or fix.
2. Audit every `tools/*` file: who calls it, status (active / deprecated /
   half-extracted). Cross-reference against grep to confirm "active"
   claims.
3. Audit every `docs/*` and `wiki/*` for stale vs orphaned content.
4. Add Mermaid diagrams (renders on GitHub) for: architecture, fallback
   chain, agent → capability → LLM resolution. ASCII fallback in CLAUDE.md.
5. Sequence diagram for the agent → capability → LLM mapping showing how
   a single Claude Code session uses 5+ different models simultaneously
   (the killer feature; currently underdocumented).
6. Cleanup pass: any env var, command, file, agent, or skill mentioned in
   README/CLAUDE.md without a matching callsite → remove or file a TODO.

This is a half-day-plus item. Worth its own dedicated session.

## Testing

**[testing] Review + update tests/mocks for per-shell dynamic-port proxy design**

Follows the per-shell proxy redesign (port 0, no shared proxy, system-prompt
URL injection). Several tests assumed port 9997 or the shared flock/reuse model:

1. **Audit all test files for hardcoded port 9997** — `test/smoke-check.sh` and
   `test/e2e-plan-execution.sh` explicitly set `CLAUDE_PROXY_PORT=9997`. Decide
   whether each test legitimately wants a fixed port (keep) or should use a
   free port (update).
2. **`proxy-lifecycle.test.js`** — add assertions: (a) proxy binds exclusively to
   `127.0.0.1` (not `0.0.0.0`); (b) two concurrent proxy spawns land on different
   ports; (c) proxy exits when its parent node process exits.
3. **`install-smoke.test.sh`** — verify settings.json is written correctly after the
   proxy READY handshake (contains the real port, no placeholder). May require a
   minimal stub proxy that writes `READY <port>` to exercise the write_ephemeral_settings
   path in the router.
4. **Mocks in Node tests** — any test that stubs `server.listen` or hard-codes the
   proxy base URL should be updated to handle dynamic ports.
5. **README test-running section** — verify instructions for running the full test
   suite are accurate and complete. Add a standard `npm test` or `make test` entry
   point if one doesn't exist so contributors can run all tests with one command.
6. **Contract check** — run `bash tools/c-thru-contract-check.sh` after all test
   changes and confirm exit 0.

## Reliability — smaller items

**[install] PostToolUse hook matcher could be self-documenting**
`c-thru-map-changed.sh` has `# ARCH: FileChanged/PostToolUse hook` in its
header. Currently uses `matcher: "*"` (fires on all tools, script exits
silently for non-model-map files). Consider parsing the `# ARCH:`
annotation to derive the event name automatically, so adding a new hook
script doesn't require a matching install.sh edit.

**[install] Stale absolute-path hook detection**
`register_hooks` checks for existence of a hook but not whether it points
to the current `$TOOLS_DEST`. If the user moves `~/.claude`, old hooks
silently break. Add a check: if the command exists in settings but doesn't
match `$TOOLS_DEST/<name>`, warn and offer to update.

**[install] Automated install smoke test**
The new e2e validation suite (db915b7) covers the happy path. Still
missing: a sandboxed test (`CLAUDE_DIR=$(mktemp -d) ./install.sh`) that
asserts the expected files/symlinks/hook registrations exist in a clean
environment. Catches regressions when new install steps are added.

**[install] Plan→implementation audit gap**
A past plan had §1-§3, §5-§6 but silently omitted §4 (PostToolUse hook).
The `c-thru-contract-check.sh` tool validates agent/skill contracts —
consider extending it (or a companion check) to verify every audit-table
finding in a plan file has a corresponding numbered implementation
section before merging.

**[install] `link_tool` + `chmod` co-location**
`link_tool` silently skips non-executable files. If a `link_tool` entry
is added later without a matching `chmod`, it silently no-ops. Make
`link_tool` emit a warning when the source file exists but isn't
executable, rather than silently skipping.

## Consolidation / simplification

**[hooks] Consolidate hook registration into declarative table**
`register_hooks` has ~150 lines of near-identical jq+mv patterns. Extract
to a `register_hook <event> <matcher> <cmd> [flags...]` helper so each
new hook is one line. Reduces copy-paste bugs and makes the full hook
inventory visible at a glance.

**[model-map] Auto-run `model-map-apply-recommendations` at install time**
The recommendations file is only applied at router launch. Running it
during install and printing `(rec)` annotations in the post-install
summary would make the recommendations visible immediately, without
waiting for first `c-thru list`.

**[summary] Post-install summary: show active route bindings**
The Quick reference explains where to look but doesn't show what's
actually configured. Add a 3-5 line "Active routes" block (like
`c-thru list` compact output) so users can verify the install worked
without running a separate command.

## Learning / patterns extraction

**[learning] Senior-review findings — systemic issues to address**

These came out of multi-pass senior-engineer code reviews during the
Ollama-lifecycle + per-shell-proxy session. Each finding points to a
pattern that could recur.

1. **`$(awk ...)` in `set -euo pipefail` scripts silently exits 2.**
   Contrary to the common assumption that variable assignments suppress
   `set -e`, `var=$(failing_cmd)` with `set -euo pipefail` does propagate
   the failure exit code in bash (verified: exit 2 from awk). All
   `c-thru-contract-check.sh`-style scripts that use awk on files that may
   not exist need `2>/dev/null || true`. Audit `tools/*.sh` for unprotected
   `var=$(awk ... $FILE)` patterns where `$FILE` may be absent in test
   fixtures or CI.

2. **Test fixture drift when new contract checks are added.** Check 9
   (tier_budget) and check 10 (preflight skeleton) were added to
   `c-thru-contract-check.sh` without updating the test fixtures in
   `test/c-thru-contract-check.test.sh`. Pattern: when adding a new check,
   always update the "clean" fixtures to satisfy it so they still return
   exit 0. Consider adding a lint step: run the checker against each fixture
   and assert the expected exit code directly, so new checks fail the test
   immediately rather than silently passing until someone runs the test.

3. **`HOOKS_PORT` defined but never used in `claude-proxy`.**
   `tools/claude-proxy` line 77: `const HOOKS_PORT = numberFromEnv(...)`.
   The hooks listener on a separate port was designed but never implemented.
   The hooks endpoint (`/hooks/context`) is on the main proxy server.
   Three proxy-lifecycle tests were testing this non-existent feature.
   Either implement the separate hooks server or remove the dead constant
   and update docs/CLAUDE.md where the `--hooks-port` flag is documented.

4. **`return "$ec"` in EXIT trap has no effect on process exit code.**
   `cleanup_router_children` uses `return "$ec"` which only matters when
   called as a regular function. When called from the `trap ... EXIT`
   handler, the return value is irrelevant — the process exits with the
   code passed to `exit`. The misleading `return` could cause future
   contributors to incorrectly believe they can change the exit code via
   the cleanup function. Remove or comment.

5. **`exec` skips EXIT traps — document as a bash sharp edge in CLAUDE.md.**
   The c-thru control dispatch was using `exec c-thru-control` which
   silently skips all EXIT traps, leaving proxy orphans. Now fixed with
   foreground-child + `exit $?`. This pattern (exec = EXIT trap bypass)
   is a sharp edge that should be documented explicitly in CLAUDE.md for
   future contributors who might be tempted to add `exec` for "efficiency".


**[learning] Reusable patterns from session work (from senior-eng review)**

1. **`detectConfigDrift(canonical[], actual)` utility.** The "anything in
   derived not in (canonical sources) is drift" pattern applies to
   `~/.claude/settings.json` vs system+local, agents/ files vs source
   manifest, etc. Extract a generic helper.
2. **`--detect-X` / `--clean-X` twin-flag CLI convention.** Standardize
   across all destructive helpers in `tools/` (e.g. `c-thru-ollama-gc.sh
   sweep` currently lacks dry-run; should gain one).
3. **"Rebuild, don't patch" derived files.** When cleaning the profile,
   re-sync from canonical sources rather than `delete`-ing keys —
   guarantees byte-identical state to a fresh install. Worth a wiki
   entry in `wiki/entities/declared-rewrites.md` as the canonical rule
   for any derived/cached file.

## Setup / self-containment

**[setup] Audit installer / setup paths for stale "self-contained" violations**
The repo is meant to be self-contained — only user-chosen config writes
should land in profile (`~/.claude/`) or project (`<cwd>/.claude/`)
directories; everything else must live inside the repo. Audit:
- `install.sh`: any persistent files written outside the symlinks +
  `~/.claude/model-map.overrides.json`?
- `tools/c-thru-self-update.sh`: does it touch state outside the repo?
- `tools/model-map-config.js` `profileClaudeDir()` discovery: confirm it
  only *reads* from non-profile paths and never *writes*.
- `~/.claude/.*-stamp-*` and cache files: all justified, documented, and
  cleanable?
- Hooks registered in `~/.claude/settings.json`: any contain absolute
  paths that drift if the repo moves?

Goal: a fresh user can clone the repo, run `install.sh`, and have exactly
two persistent files in `~/.claude/` outside vendor stuff:
`model-map.overrides.json` and `model-map.system.json`. Everything else
should be derived/cached/symlinked.

## Architecture / boundaries

## UX / Polish

**[ux] Professionalize messaging across all tools**
- [x] Consolidate path discovery into `tools/model-map-config.js --shell-env`.
- [x] Create standalone `tools/c-thru-control` utility for agentic and CLI control.
- [x] Implement `/c-thru-control` interceptor in `tools/c-thru`.
- [ ] Refactor `tools/c-thru` and related scripts to use more professional,
      standardized messaging (consistent prefixes, clearer status updates).

**[ux] Advanced startup feedback (fancier spinner)**
- [x] Use fancy Braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` for Ollama warming.
- [ ] Dynamic status updates during the "warming up" phase with specific
      progress markers (which model is loading, % progress if available).
