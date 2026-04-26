# TODO

Items identified from install.sh audit (2026-04-20). Ordered by impact.

## install.sh gaps / automation

**[install] PostToolUse hook matcher could be self-documenting**
`c-thru-map-changed.sh` has `# ARCH: FileChanged/PostToolUse hook` in its header. The hook
currently uses `matcher: "*"` (fires on all tools, script exits silently for non-model-map
files). Consider parsing the `# ARCH:` annotation to derive the event name automatically,
so adding a new hook script doesn't require a matching install.sh edit.

**[install] Stale absolute-path hook detection**
`register_hooks` checks for existence of a hook but not whether it points to the current
`$TOOLS_DEST`. If the user moves `~/.claude`, old hooks silently break. Add a check: if the
command exists in settings but doesn't match `$TOOLS_DEST/<name>`, warn and offer to update.

**[install] Automated smoke test**
All install.sh verification steps are manual. A sandboxed test (`CLAUDE_DIR=$(mktemp -d)
./install.sh`) that asserts the expected files/symlinks/hook registrations exist would catch
regressions when new features are added incrementally.

**[install] Plan→implementation audit gap**
This session's plan had §1-§3, §5-§6 but silently omitted §4 (PostToolUse hook). The
`c-thru-contract-check.sh` tool validates agent/skill contracts — consider extending it (or
a companion check) to verify that every audit-table finding in a plan file has a corresponding
numbered implementation section before merging.

**[install] `link_tool` + `chmod` co-location**
`model-map-apply-recommendations.js` gets `chmod +x` but no `link_tool`. The `link_tool`
helper silently skips non-executable files (`[ -x "$want" ] || return 0`), so if a `link_tool`
entry is added later without a matching `chmod`, it silently no-ops. Consider making `link_tool`
emit a warning when the source file exists but isn't executable, rather than silently skipping.

## Consolidation / simplification

**[hooks] Consolidate hook registration into declarative table**
`register_hooks` has ~150 lines of near-identical jq+mv patterns for 5 hooks. Extract to a
`register_hook <event> <matcher> <cmd> [flags...]` helper so each new hook is one line. Reduces
copy-paste bugs and makes the full hook inventory visible at a glance.

**[model-map] Auto-run `model-map-apply-recommendations` at install time**
The recommendations file exists but is only applied at router launch. Running it during install
and printing `(rec)` annotations in the post-install summary would make the recommendations
visible immediately — without waiting for first `c-thru --list`.

**[summary] Post-install summary: show active route bindings**
The Quick reference now explains where to look, but doesn't show what's actually configured.
Adding a 3-5 line "Active routes" block (like `c-thru --list` compact output) would let users
verify the install worked without running a separate command.

## Reliability

**[node-guard] Node version warning fires on every re-install**
The Node version warning is intentional on first install but noisy on idempotent re-runs where
the user already knows about the version. No action needed unless it becomes a pain point —
noting for awareness.

**[debug] Enhance fatal error detection and debug logging**
Improve error detection for fatal scenarios like the proxy failing to start or configuration being missing. Add more granular debug logs throughout the startup sequence to aid troubleshooting.

**[proxy] Verify proxy readiness with live check**
Implement a `curl` test (or equivalent) in `c-thru` immediately after proxy startup to verify that the listener is actually alive and responding before handing control back to the caller.

## UX / Polish

**[ux] Professionalize messaging across all tools**
- [x] Consolidate path discovery into `tools/model-map-config.js --shell-env`.
- [x] Create standalone `tools/c-thru-control` utility for agentic and CLI control.
- [x] Implement `/c-thru-control` interceptor in `tools/c-thru`.
- [ ] Refactor `tools/c-thru` and related scripts to use more professional, standardized messaging (consistent prefixes, clearer status updates).

**[ux] Advanced startup feedback (fancier spinner)**
Implement a more sophisticated spinner and dynamic status updates during the "warming up" phase in `c-thru`. Ensure the user is kept informed of specific progress markers while waiting.
- [x] Use fancy Braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` for Ollama warming.
