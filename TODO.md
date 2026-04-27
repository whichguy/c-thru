# TODO

Backlog of work not yet shipped. Items shipped during sessions are removed
from this file (git log preserves the history); only OPEN or PARTIALLY-OPEN
items remain.

Last cleanup: 2026-04-26

## Reliability

**[refactor] Decompose `forwardOllama` into smaller functions**
`forwardOllama` is ~250 lines doing translation + streaming + state machine
+ pings + watchdog + usage extraction + fallback + TTFT. Should be 3-4
smaller functions (or a class) for clarity. Senior-eng review (1ea41d9) +
breadcrumb pass (9e5a616) made the existing structure clearer but did not
decompose. Scope this for its own session — touches the hottest path in the
proxy and needs a careful test plan around the SSE state machine, fallback
chain Set, TTFT timer handoff to the stall watchdog, and client-disconnect
timer cleanup.

**[fallback] Cooldown spec items #5-#7 — bound cache size + status surface**
Failure-class differentiation (#4) shipped in b79f296. Still open:

5. **Bound the failure cache size.** A misbehaving config could keep adding
   new transient failures and grow `failedBackendUntil`. Cap at ~100
   entries with LRU eviction. Realistic configs have <10 backends, so 100
   is plenty of headroom.

6. **Surface in `/c-thru/status`.** Add `cooldown_backends: [...]` to the
   response so users can see at a glance which backends the proxy is
   currently routing around. Also surface `routes.default` resolution so
   users can see what the absolute last-resort target is.

7. **(Already covered by #6 above — keep grouped.)** Document the
   three-tier fallback story (per-backend chain → cooldown skip → global
   default) in README's reliability section once #6 lands.

## Configuration / capacity

**[capacity] Apply 128gb-tier VRAM audit recommendations**
The audit doc shipped in 7dc6376 (see `docs/128gb-vram-audit.md`).
Recommendations (per-capability `prep_policy: warm-only-on-demand`,
specific evictable models) still need to be applied to
`config/model-map.json` `llm_profiles['128gb']`. Pure config edit; should
be ~30 min of work plus a `node tools/model-map-validate.js` pass.

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

**[testing] Implement HIGH-priority test gaps from coverage audit**
Audit shipped in 9e5a616 (see `docs/test-coverage-audit.md`). The audit
identifies the test sketches but doesn't write them. Estimated 3.3 hours
to implement the top 5 HIGH items:

1. `forwardOllama` parse-error mid-stream — confirm we close the SSE
   stream cleanly with the right error shape rather than leaking bytes.
2. Client-disconnect timer cleanup — assert no zombie timers after the
   client hangs up mid-stream (timer-leak protection).
3. Content-length scrub effectiveness — verify the body rewrite path
   produces a valid `Content-Length` for every shape we send.
4. Cooldown TTL expiry — fake-clock test confirming a backend exits
   cooldown after the TTL window, not before.
5. `model-map-config.js` project-overlay path derivation — regression test
   for the pollution bug fix (956d469).

Lower-priority gaps from the audit (ping interval firing, message_stop
after empty stream, lock-and-spawn race in bash, malformed READY line)
remain open as MED/LOW.

**[testing] `--detect-pollution --strict` mode for CI**
Currently `--detect-pollution` returns 0 either way. Add `--strict` so
CI can fail the build when drift is detected.

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

**[ollama] Document the Ollama / proxy lifecycle boundary in CLAUDE.md**
Today `ollama serve` is a long-running daemon spawning one runner per
loaded model — already independent of c-thru. Goal: ensure Ollama runs
as its own daemon (e.g. macOS app or `launchctl`) while the proxy lives
strictly as a child of `c-thru`. Verify and document:

1. The proxy never spawns/kills ollama runners (confirmed: lives in
   `tools/c-thru` bash, not `claude-proxy`).
2. The proxy connects to `OLLAMA_BASE_URL` (default
   `http://localhost:11434`) assuming external management.
3. `c-thru` startup detects whether Ollama is reachable and either starts
   it (`CLAUDE_ROUTER_OLLAMA_AUTOSTART=1`, default) or warns.
4. When `c-thru` exits, the proxy child exits with it; Ollama persists.

Document the boundary in CLAUDE.md so future contributors don't conflate
the two.

## Minor / awareness

**[node-guard] Node version warning fires on every re-install**
Intentional on first install but noisy on idempotent re-runs. No action
needed unless it becomes a pain point — noting for awareness.

**[debug] Enhance fatal error detection and debug logging**
Improve error detection for fatal scenarios like the proxy failing to
start or configuration being missing. Add more granular debug logs
throughout the startup sequence to aid troubleshooting. (Persistent
logging shipped in 452a50a but does not cover every startup branch.)

**[proxy] Verify proxy readiness with live check**
Implement a `curl` test (or equivalent) in `c-thru` immediately after
proxy startup to verify the listener is actually alive and responding
before handing control back to the caller. (Adjacent to install e2e
work in db915b7 but not implemented in the runtime spawn path.)

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
