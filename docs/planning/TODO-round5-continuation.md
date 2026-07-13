# Round 5 continuation — architectural corner cases, streaming robustness, coverage expansion

**Status as of this update (2026-07-12, resumed session):** Phases 0, A, B1, B2, B3 all committed
and verified. Phase B3 finished: Stop hook + absent-only statusLine registered in
`tools/c-thru`'s ephemeral injection, mirrored into the plugin bundle, new
`test/c-thru-statusline-injection.test.js` (4/4), commit `a158122`. **Phases B4/C/D/E are NOT
implemented yet, but a full execution plan for all of them now exists and has been through Plan
Mode's review gate (senior-engineer review + open-unknowns audit + a live empirical investigation,
all passed) — see the "Phase B4/C/D/E execution plan (finalized, 2026-07-12)" section near the end
of this file for the complete, ready-to-execute plan.** The plan-mode plan file also exists at
`~/.claude/plans/radiant-wandering-ocean.md` (machine-local, not in this repo) — the section in
THIS doc is the durable copy in case that file isn't available in a future session. Read this whole
file before resuming — the section below has the exact next action.

**Note on the "Phase B3" section below:** it was written mid-round and describes what was true
at that handoff point, including a "NOT done yet" list that is now stale (superseded by the
"Phase B3 completion" section appended near the end of this file). Read the completion section
for the actual final state; the original section is kept for history/context only.

## How this round started

User asked (in Plan Mode): "Based on learnings, do a review of the pending items and learnings,
create a new improvement plan. Help me identify any architectural issues or corner cases in
design which need to be implemented or tested." Three parallel Explore agents surveyed (1) every
tracked-but-unresolved item across docs/planning, (2) proxy architectural corner cases, (3)
router/hooks tech debt. The draft plan was then cross-model reviewed by Codex (read-only,
senior-engineer pass with repo access) via `codex exec --sandbox read-only`; every load-bearing
Codex claim was independently re-verified against the code before adoption. The full survey
findings and Codex's critique are NOT repeated here (they were consumed into the plan below) —
if you need them again, they are no longer stored anywhere; re-run the survey if needed.

User decisions locked into the plan: scope = fixes + tests only (deferred features go to a
decisions ledger, Phase E); fallback hooks REBUILT on current observability (not retired);
per-session mode isolation done FULLY (not just per-request pinning), gated on a real-client
canary (canary was run and PASSED — see Phase B2 below); statusline injected only when the user
has none of their own; Phases 0/D/E kept in scope (not deferred, per Codex's suggestion, because
Phase 0 was this session's own completed doc work and D is an explicitly user-queued task).

## Concurrent-session caution (read this before touching git)

**A separate Claude Code session shares this working tree throughout this round.** It has been
actively committing its own work in parallel — as of this handoff its commits include:
`660b3b4` (additive hook/permission merge), `375074d` (Stop-hook autonomous-run gate),
`5474a1d` (~/.claude.json symlink fix), `b53f065` (routing validator), `20d4ca6` (hygiene-check +
stale-worktree flagging), plus in-progress uncommitted work on a NEW "plan-page" feature
(`tools/c-thru-plan-visibility-hook.sh`, `tools/plan-dashboard.html`, `tools/plan-state-lib.js`,
`skills/plan-page/`, and matching `plugins/c-thru/...` mirror copies — all untracked `??` in
`git status` as of this handoff, not yet committed by that session).

**Do not run `git add -A`/`-u`/`.` or otherwise broadly stage.** The established technique for
every commit this round (see the 4 already-committed messages for worked examples): for each
file you intend to stage that also carries the OTHER session's hunks —
1. `git diff <file> | grep -n '^@@'` to list every hunk's header/line range.
2. Read each hunk's content to classify mine vs. theirs (their hunks this round have been the
   `plan_visibility_cmd` additions in `tools/c-thru`, a `KNOWN_HOSTS`/`backendHost`/
   `deriveAuthProfile` auth-derivation refactor in `tools/claude-proxy`, and various plan-page
   suite registrations in `test/run-all.sh`).
3. Extract ONLY the foreign hunks into a standalone patch. A hand-written Python helper for this
   (parses `@@ -start,count` headers, keeps/drops whole hunks by exact old-side start) is more
   reliable than ad-hoc `awk` for multi-hunk files — write one fresh each time rather than
   reusing a stale one from a prior round, since hunk boundaries shift as commits land.
4. `git apply -R --check <patch>` to verify the foreign patch reverses cleanly against HEAD.
5. `git add <files...>` (stages everything currently unstaged, including foreign hunks), then
   `git apply -R --cached <patch>` (reverses ONLY the foreign hunks out of the INDEX, leaving the
   working tree untouched — the other session's WIP stays exactly as they left it on disk).
6. **Verify before committing:** `git diff --cached | grep -c '<foreign marker string>'` must be
   `0`; also confirm the working tree's foreign hunks are still present
   (`git diff <file> | grep -c '<foreign marker>'` should be nonzero) and that the STAGED content
   still passes a syntax check (`git show :<file> | node --check /dev/stdin` or write to a temp
   file and check — `node --check` can't read stdin directly on some Node versions, write to a
   temp file first).
7. Also unstage any file that ended up in the index from a broad-ish prior `git add` but isn't
   actually yours this round (e.g. `.claude/scheduled_tasks.lock` showed up staged once from an
   earlier `git add tools/... test/...` sweep purely because it was already dirty — always
   `git diff --cached --stat` before committing and sanity-check every listed file belongs to
   THIS commit's story).

Watch especially for **new unstaged hunks appearing in files you already edited** between when
you last staged and when you're about to commit — the concurrent session edits fast. Re-run the
`git diff <file> | grep '^@@'` check immediately before every `git add`, don't trust an earlier
check from a few tool-calls ago.

## What's committed so far (this round)

```
ba24c79 feat(proxy): per-session mode isolation on shared proxies                    [Phase B2]
a57a562 fix(proxy): proxy.pid honors CLAUDE_PROFILE_DIR                              [Phase B1]
6548c5d fix(proxy): terminate committed responses on upstream transport failure...   [Phase A]
9935a10 docs(c-thru): review methodology + test authoring guides; visual arch docs   [Phase 0]
```
(Concurrent-session commits `660b3b4` through `20d4ca6` are interleaved after `ba24c79` in
`git log` — not part of this round, don't touch/revert them.)

### Phase 0 — commit the finished documentation round
Done. Committed the methodology + visual-architecture-docs work from the PRIOR planning session
(review-methodology.md, test-authoring.md, architecture-diagrams.md, check-diagram-sync.js,
README/CLAUDE.md shared Mermaid embed, doc-rot fixes). Nothing left to do here.

### Phase A — P1 streaming robustness
Done and verified. Added `terminateCommittedResponse()` (tools/claude-proxy, near `sseWrite`) —
shared idempotent post-commitment failure handler: SSE gets a terminal `error` frame + end, JSON
gets a socket destroy. Wired into `forwardAnthropic` (fixed the actual proxy-killing P1: no
`upRes.on('error')` on the streaming path could reach `uncaughtException` → `process.exit(1)`,
killing the shared proxy for every session), `forwardGemini` (stream + a newly-bounded
non-stream buffer, `UPSTREAM_NONSTREAM_BODY_CAP` env `CLAUDE_PROXY_NONSTREAM_BODY_CAP`, default
64MB), and `handleOllamaNonStream` (same bounded-buffer + error-handler treatment). Test:
`test/proxy-upstream-midstream-failure.test.js` (17 assertions, registered in run-all.sh).

### Phase B1 — proxy.pid profile-dir fix
Done and verified. `PID_FILE` in tools/claude-proxy now resolves `CLAUDE_PROXY_PID_FILE` env →
`$CLAUDE_PROFILE_DIR/proxy.pid` → `~/.claude/proxy.pid` default, matching `PROXY_LOG_FILE`'s
existing pattern (previously hardcoded to `~/.claude`, breaking `c-thru reload`/`restart` for
ephemeral/named profiles). Test: `test/proxy-pid-file-profile.test.js` (9 assertions).

### Phase B2 — per-session mode isolation (canary-gated)
Done and verified — this was the largest single piece of work this round. Real-client canary
(launched the actual vendor `claude` binary at `/Users/dadleet/.local/bin/claude`, independent of
any c-thru wrapper, against a path-echoing stub server) confirmed Claude Code's real
`/v1/messages` traffic preserves a `/s/<session-id>` path prefix on `ANTHROPIC_BASE_URL` (both
trailing-slash and bare forms) — **canary passed**, so the full path-prefix design was built (not
just the fallback per-request-pinning-only option).

Implementation:
- `tools/c-thru`: `ensure_proxy_http_base()` now calls a new `apply_session_scope_suffix()` that
  appends `/s/$C_THRU_SESSION_ID` (opt-out: `C_THRU_SESSION_SCOPED_MODE=0`). Single change point
  — every real launch path already flows through `ENSURED_PROXY_HTTP_BASE`.
- `tools/claude-proxy`: strips + validates `/s/<id>` from `req.url` before ANY dispatch (so every
  existing `req.url === '/xyz'` check keeps working); pins `{sessionId, mode}` into a NEW
  `AsyncLocalStorage` (`requestContextStorage`, separate from the pre-existing `configStorage`),
  resolved once per request via `resolveActiveModeForRequest()`. Mode precedence: session
  override → proxy-wide override (bare `POST /c-thru/mode`, no longer mutates `process.env`) →
  `resolveLlmMode`'s own env/config fallback (unchanged for CLI/offline callers). New globals:
  `SESSION_MODES` (FIFO-capped + TTL-swept Map, mirrors the existing `failedBackendUntil`
  cooldown-map idiom), `GLOBAL_MODE_OVERRIDE`, `REQUEST_SESSION_ID`/`REQUEST_MODE` getters (same
  pattern as the existing `CONFIG` getter). The old C48 `detectOrphanedGovDegrade()` was
  generalized into `invalidateOrphanedModes()` — covers the legacy env-mode path (preserved
  exactly, still tested), the proxy-wide override, AND every per-session override
  independently, each with its own degrade-advisory (`mode_degraded*` stays global;
  `session_mode_degraded*` in `/c-thru/status` is scoped to the request's own session).
- `tools/c-thru-lib.sh`: new `cthru_hook_base_url()` — same port-discovery ladder as
  `cthru_hook_listen_port()` but returns the FULL base URL including
  `/s/$C_THRU_SESSION_ID` when set (opt-out mirrors the one above). **This constructs the suffix
  from `C_THRU_SESSION_ID`, NOT by re-parsing a path out of `ANTHROPIC_BASE_URL`** — matters for
  anyone testing it (see Phase B3's debugging note below, this exact confusion caused a test bug).
- `tools/c-thru-session-start.sh`, `tools/c-thru-classify.sh`,
  `tools/c-thru-postcompact-context.sh`: switched from constructing
  `"http://127.0.0.1:$PORT/hooks/context"` directly to using `cthru_hook_base_url()`, so their
  `/hooks/context` calls reflect THIS session's own mode instead of the proxy's global default.

Test: `test/proxy-session-mode-isolation.test.js` (28 assertions — two-session isolation via both
`/ping` AND actual model routing, in-flight pin, unkeyed backward-compat, reload-invalidation for
both global and session scopes). `test/cli-e2e-flags.test.js` extended (real e2e c-thru launch)
to assert `ANTHROPIC_BASE_URL` actually carries the `/s/<C_THRU_SESSION_ID>` suffix. Broad
regression sweep after the request-handler restructuring (14 suites, ~900 assertions) — zero
regressions.

**Gotcha for anyone extending this:** `llm_profiles` schema is `llm_profiles[capability][mode]
[tier] = model` (capability-outer) — NOT `llm_profiles[tier][capability][mode]`. Got this backwards
once while writing the B2 test and it silently 502'd; the correct shape is documented in
`test/proxy-config-reload.test.js`'s `mkConfig()` if you need a worked example.

## What's IN PROGRESS right now — Phase B3 (fallback-notification hooks)

**This is the exact point execution stopped. Read carefully before continuing.**

### Already done (uncommitted, verified working):

1. **`tools/claude-proxy`** — two small additions to the ALREADY-EXISTING recent-requests ring
   (Codex's finding: a ring + `GET /c-thru/recent` already existed with `served_by`/
   `fallback_from`/`mode` fields — B3 extends it, never built a second ring):
   - `pushRecentRequest()`: added `session_id: REQUEST_SESSION_ID` to the pushed record.
   - `GET /c-thru/recent` handler: when the request itself carries a `/s/<id>` prefix
     (`REQUEST_SESSION_ID` set), filters `RECENT_REQUESTS` to just that session's entries before
     paginating; response gains a `session` field. Bare/unkeyed access is UNCHANGED (all entries)
     — deliberately no `?session=` query-param selector (Codex: the endpoint has no auth, so a
     query-param selector would let any local client read another session's activity; path-based
     scoping via the already-trusted `/s/<id>` prefix is the safe version).
   - Regression-checked: `test/proxy-recent-requests.test.js` still 56/56 after both additions.

2. **`tools/c-thru-stop-hook.sh`** and **`tools/c-thru-statusline-overlay.sh`** — fully rewritten.
   Old versions grepped `~/.claude/proxy.log` for `[fallback.candidate_success]`/
   `[fallback.chain_start]` — event names the fallback engine stopped emitting years ago (task
   #38's finding: green tests over a dead feature, watching strings that don't exist). New
   versions: source `tools/c-thru-lib.sh`, call `cthru_hook_base_url()` to get the session-scoped
   proxy URL, `curl` `GET $BASE_URL/c-thru/recent?n=<N>`, `jq`-filter for
   `.requests[]? | select(.fallback_from != null)` (ring is newest-first, so `head -1` gives the
   most recent fallback), use `.model` (client's originally-requested name) + `.served_by`
   (what actually served) for the message. `c-thru-stop-hook.sh` keeps its existing dedup
   mechanism (`$HOME/.claude/.c-thru-stop-hook-last-ts` tracker file, unchanged logic, just now
   sourced from the ring's `.ts` field instead of a parsed log timestamp) and its existing
   120-second staleness window. Both still `set +e; trap 'exit 0' ERR` and fail-open identically
   to before when `jq` is absent or no proxy is discoverable.

3. **New tests, fully passing:**
   - `test/c-thru-stop-hook.test.js` (11/11) — replaces the deleted `.test.sh`. Spawns a REAL
     proxy with a primary-fails(500)/secondary-serves `fallback_to` config (same recipe as
     `proxy-recent-requests.test.js` Test 5), drives an actual `/s/session-a/v1/messages` request
     through it, then invokes the real hook script (via `spawnCapture`, in a scratch copy
     alongside a copy of `c-thru-lib.sh`) with `CLAUDE_PROXY_PORT` + `C_THRU_SESSION_ID` set to
     match. Covers: real fallback → correct systemMessage; second invocation of the SAME
     fallback → silent (dedup tracker); a different session that never fell back → silent
     (session isolation); no discoverable proxy → silent (fail-open).
   - `test/c-thru-statusline-overlay.test.js` (8/8) — same recipe, asserts the printed badge
     text and session isolation.
   - **Two real bugs found and fixed while writing these tests** (both instructive if you write
     more tests against these hooks):
     a. The test must set BOTH `CLAUDE_PROXY_PORT` (or `PROXY_PORT`) AND `C_THRU_SESSION_ID` —
        NOT a pre-built `ANTHROPIC_BASE_URL` string with a manually-appended path. Because
        `cthru_hook_base_url()` constructs its `/s/<id>` suffix FROM `C_THRU_SESSION_ID`
        directly (matching how `tools/c-thru` always sets both together at real launch time),
        NOT by re-parsing a path out of an existing `ANTHROPIC_BASE_URL` value. Setting only
        `ANTHROPIC_BASE_URL` with a hand-appended `/s/session-a` silently produced a base URL
        with NO suffix (since `C_THRU_SESSION_ID` was unset), and the hook queried the wrong
        (unscoped, but here just "no session" since it's the SAME proxy) endpoint — took a
        `bash -x` trace against a live reproduction to find.
     b. The fake `$HOME` used by the test must have a `.claude/` subdirectory created (`fs.mkdirSync(path.join(homeDir, '.claude'), {recursive: true})`) BEFORE running `c-thru-stop-hook.sh`
        — its dedup tracker file lives at `$HOME/.claude/.c-thru-stop-hook-last-ts` and the
        script's `mv` of a temp file into place fails silently (caught by the `trap 'exit 0' ERR`)
        if the parent directory doesn't exist. `c-thru-statusline-overlay.sh` has no tracker file
        so its test didn't need this — only `c-thru-stop-hook.sh`'s test did.
   - Both new suites registered in `test/run-all.sh` in place of the old bash invocations (same
     line position, `bash .../*.test.sh` → `node .../*.test.js`, labels updated).

4. **Old fixture-based tests deleted**: `test/c-thru-stop-hook.test.sh` and
   `test/c-thru-statusline-overlay.test.sh` — `rm`'d from the working tree (shows as `D` in
   `git status`; not yet part of a commit).

### NOT done yet — pick up here:

1. **`tools/c-thru` hook registration** (the actual next edit — was mid-read of the
   `write_ephemeral_settings()` function, around line 385-440, when this handoff was written).
   Currently NO `Stop` event is registered in the ephemeral `--settings` injection at all (grep
   confirms zero `"Stop"` matches in `tools/c-thru`) — this is WHY the fallback hooks were dead
   even before the event-name rot (Codex's finding). Need to:
   - Add `stop_hook_cmd="$(find_tool_path c-thru-stop-hook)"` alongside the other
     `find_tool_path` calls (~line 392-401).
   - Add a `Stop: [{ matcher: "*", hooks: [cmdHook(stopHookCmd, <timeout>)] }],` entry to the
     `hooks: { ... }` object (~line 619-635) — check whether a `Stop` key already exists there
     from the CONCURRENT session's `c-thru-autonomous-gate.sh` work (commit `375074d` "opt-in
     Stop-hook autonomous-run integrity gate" — **re-check this first**, since that commit landed
     AFTER this round started; if a `Stop` array already exists, ADD to it rather than
     overwriting, and check whether `c-thru-autonomous-gate.sh`'s own hook is
     ephemerally-injected or opt-in-via-local-config-file only — CLAUDE.md's Autonomous-runs
     section suggests the latter, i.e. `.claude/autonomous-gate.local.json`-gated, so it may NOT
     already be in the ephemeral hooks object; verify by grepping `tools/c-thru` for
     `autonomous-gate`/`autonomous_gate` fresh, since this doc's own grep (done at handoff time)
     found ZERO matches, meaning it's likely NOT ephemerally injected and this Stop-hook slot is
     genuinely free — but re-verify, don't trust a stale grep).
   - Update the hook-inventory comment table (~line 430-436) with a new
     `# Stop              *               c-thru-stop-hook          fallback systemMessage advisory` line.
   - **statusLine — absent-only injection** (user's explicit decision from the Codex-review
     Q&A this round: "inject only when the user has none of their own"). Need to find where
     `write_ephemeral_settings` merges other top-level user-settings keys (grep for
     `USER_SETTINGS_DENYLIST` / the additive-merge logic added by the CONCURRENT session's commit
     `660b3b4` — that commit may have changed the merge shape since this plan was written, so
     read the CURRENT merge code fresh, don't assume the shape described in earlier planning).
     Add: if the user's own `settings.json` has no `statusLine` key, inject one pointing at
     `c-thru-statusline-overlay.sh` (check how the EXISTING statusline (if c-thru ships one
     today — verify, may not) or a fresh minimal `{"type": "command", "command": "<path>"}"`
     shape is expected by Claude Code's settings schema; grep test fixtures / Claude Code docs
     skill if unsure of the exact statusLine JSON shape). If the user HAS their own `statusLine`,
     leave it untouched — do not compose/wrap it (per the plan's explicit decision; composition
     was explicitly deferred as extra complexity not yet designed).
   - Sync mirrored copies: `tools/sync-plugin-bundle.sh` copies `tools/c-thru-stop-hook.sh` and
     `tools/c-thru-statusline-overlay.sh` into `plugins/c-thru/hooks/` — run it (or `--check`
     first to see current drift state; the concurrent session's own edits to
     `plugins/c-thru/hooks/*.sh` earlier in `git status` may already be unrelated in-progress
     drift from THEIR work, so `--check` output needs reading carefully to distinguish "drift
     because I haven't synced my B3 hook rewrites yet" from "drift because the other session's
     mid-edit" — do NOT run the sync script blind if it would clobber their in-progress plugin
     files; consider running it only for the two specific files you touched if the script
     supports a scoped mode, else coordinate/verify their files are stable first).
   - Add/update a dashboard column: the plan mentions surfacing `session_id`/`was_fallback`
     columns in `tools/proxy-dashboard.html`'s recent-requests view — check current dashboard
     test (`test/proxy-dashboard.test.js`) for the existing column set before adding; this is
     lower-priority polish, can be deferred to Phase D if time is short, but was in the original
     Phase B3 scope.

2. **Verification once the above lands:**
   - `bash -n tools/c-thru` (syntax).
   - Extend/add a small test asserting the `Stop` hook entry appears in the ephemeral
     `--settings` JSON (look at `test/cli-e2e-flags.test.js` or `test/hooks-declaration-parity.test.js`
     for the pattern other hooks use to assert their own registration — `hooks-declaration-parity`
     in particular cross-checks `tools/c-thru`'s injected hooks against
     `plugins/c-thru/hooks/hooks.json`, so a new Stop-hook entry may need BOTH sides updated to
     keep that parity test green — check it explicitly).
   - Re-run `test/c-thru-stop-hook.test.js` and `test/c-thru-statusline-overlay.test.js` (should
     be unaffected by the registration change since they invoke the hook script directly, not
     through a live c-thru launch — but re-run anyway as a sanity check).
   - `node --check tools/claude-proxy`.

3. **Commit Phase B3** once the above is done and green — use the same hunk-separation
   technique (check `tools/c-thru`, `tools/claude-proxy`, `test/run-all.sh`, and now also
   `tools/sync-plugin-bundle.sh` if you ran it, for foreign hunks before staging). Include in the
   commit: the two rewritten hook `.sh` files, the two new `.test.js` files, the two deleted
   `.test.sh` files, the `tools/claude-proxy` ring extension (session_id field + recent scoping —
   already written, just needs re-verifying it's still the current unstaged diff), the
   `tools/c-thru` registration changes (new), `test/run-all.sh`'s two label swaps (already made),
   and any `plugins/c-thru/hooks/*.sh` sync if you did it safely.

## Phase B3 completion (2026-07-11, resumed session)

Finished the "NOT done yet" list above. Delegated implementation to `codex-worker` (Sonnet-tier
default per CLAUDE.md), then independently re-verified every acceptance criterion natively rather
than trusting the subagent's self-report.

- `tools/c-thru`: added `stop_hook_cmd`/`statusline_cmd` resolution, a `Stop: [{matcher:"*",
  hooks:[cmdHook(stopHookCmd,5)]}]` entry, and absent-only `statusLine` injection — right after
  the caller-`--settings` merge loop and before the final `mergeSettings(settings, cThruInjected)`
  call, `if (!own(settings, "statusLine")) cThruInjected.statusLine = {...}`, so an existing user-
  or caller-provided `statusLine` is never touched (relies on `mergeSettings`'s shallow spread —
  no special-casing needed beyond leaving the key undefined).
- The statusLine target is `tools/c-thru-statusline.sh` (the pre-existing FULL default statusline,
  `<model> | <cwd>` + fallback badge) — NOT the bare overlay script this doc originally guessed at
  (line ~246 above); the bare overlay alone would show nothing but a fallback badge, blank most of
  the time. Fixed `c-thru-statusline.sh`'s hardcoded `$HOME/.claude/tools/c-thru-statusline-overlay`
  sibling-script call to use the same symlink-following `ROUTER_REPO_ROOT` resolution as
  `c-thru-stop-hook.sh`/`c-thru-statusline-overlay.sh`, so it works under ephemeral/named
  `CLAUDE_PROFILE_DIR` profiles (same bug class as the B1 `PID_FILE` fix).
- `plugins/c-thru/hooks/hooks.json` + `tools/sync-plugin-bundle.sh`: mirrored ONLY the `Stop` hook
  (added `c-thru-stop-hook.sh` to the `HOOKS` array, copied the file into `plugins/c-thru/hooks/`).
  `statusLine` has NO plugin-bundle counterpart — a plugin's `hooks.json` can only declare
  `hooks:`-block hooks, not the top-level `statusLine` settings key, so plugin-only installs never
  get the default statusline (this is an accepted, pre-existing asymmetry, not a gap introduced
  here). This doc's original B3 section (line ~253) speculated `c-thru-statusline-overlay.sh` also
  needed a bundle-sync entry — checked, it never did and doesn't need one for the same reason.
- New test: `test/c-thru-statusline-injection.test.js` (4/4) — extracts the same embedded
  `node -e` script `test/hooks-declaration-parity.test.js` already extracts, runs it against a
  temp user `settings.json` with/without a pre-existing `statusLine` key, asserts absent → injected,
  present → untouched.
- `test/run-all.sh`: registered the new suite; the two `.test.sh`→`.test.js` label swaps this doc
  described as "already made" were confirmed still correct and required no further changes.
- Collateral fix applied and then reverted out of scope: a just-landed `statusLine` key made
  `test/c-thru-ephemeral-settings.test.sh`'s hardcoded baseline-key assertion
  (`hooks,mcpServers,permissions`) stale. Fixed it live (now passing, `hooks,mcpServers,permissions,
  statusLine`) but did NOT include this file in the B3 commit — by commit time it had also grown
  new test sections for the concurrent session's in-flight `build_ephemeral_agents`/
  `settings.local.json` work, making it too entangled to cleanly carve out. The one-line fix
  remains live/uncommitted on disk; it's correct and will ride along whenever that session commits
  its own work to this file.
- Full verification: all 5 brief acceptance criteria (bash -n, `hooks-declaration-parity.test.js`
  62/62, `c-thru-stop-hook.test.js` 11/11, `c-thru-statusline-overlay.test.js` 8/8,
  `c-thru-statusline-injection.test.js` 4/4) plus a native `make test-fast` run — 2 failures, both
  independently confirmed pre-existing and unrelated: `sync-plugin-bundle --check` drift on
  `tools/claude-proxy` (caused by the concurrent session's uncommitted auth-derivation refactor,
  confirmed already present comparing HEAD's bundle copy against HEAD's source before any of this
  round's work) and `test/c-thru-target-launch.test.js`'s "explicit target uses proxy mediation
  instead of direct provider URL" (reproduces on a clean disposable worktree at committed HEAD —
  a genuine Phase-B2-era gap, not caused by anyone's uncommitted work this round; the `/s/<id>`
  session-scope suffix breaks this test's assumption that "explicit target" mode produces a bare
  URL. Not fixed here — flagging as a Phase C candidate, see below).

**Concurrent-session note for whoever resumes next:** by the time B3 finished, the concurrent
session's footprint had grown well beyond the plan-visibility feature described earlier in this
doc — it now also includes a `settings.local.json` support feature and a `build_ephemeral_agents()`
extraction refactor (pulling the inline `EPHEMERAL_AGENTS_JSON` construction in `setup_ephemeral_
session` out into its own function), both live-editing `tools/c-thru` and
`test/c-thru-ephemeral-settings.test.sh` in real time while B3's commit was being prepared. The B3
commit (`a158122`) was staged via constructed blobs (`git hash-object` + `git update-index
--cacheinfo`) rather than `git add` on the working-tree files, specifically to avoid capturing any
of that in-flight work — verified via `git diff --cached | grep` for every known foreign token
(`plan_visibility`, `userLocalSettings`, `isCommandHook`, `build_ephemeral_agents`,
`settings.local.json`) before committing, 0 matches. If tools/c-thru still shows a large uncommitted
diff when you resume, that's this other session's continuing work, not drift from B3.

**New Phase C candidate surfaced this round:** `test/c-thru-target-launch.test.js`'s explicit-target
test asserts a bare provider URL but Phase B2's `/s/<session-id>` path suffix is now always present
on `ANTHROPIC_BASE_URL` — the test (or the explicit-target code path, needs investigation to
determine which is "correct") needs updating. Reproduces on clean committed HEAD, unrelated to any
of this round's other uncommitted work.

## What's NOT started yet

### Phase B4 — install.sh real-file collision
`install.sh:93-94`ish (verify current line — this file hasn't been touched yet this round, so
line numbers should still match the original survey): a real (non-symlink) file at
`~/.claude/tools/<x>` is warned-and-skipped forever, so upgrades silently no-op for that tool.
Fix: back up (using a **collision-resistant/unique suffix**, not the existing
timestamp-only `${file}.bak.<timestamp>` convention at install.sh:146-148 which races under
concurrent installs — add a pid or uniqueness loop) then replace with the symlink. Extend
`test/install-smoke.test.sh` with the collision branch + a backup-preserved assertion.

### Phase C — corner-case fixes + coverage expansion (C1-C13)
Full table is in the approved plan (not reproduced here in full — see git history if you need the
exact original wording, or re-derive from the survey since the underlying code hasn't changed).
Summary of the 13 items:
- C1: A→B→A mutual fallback-cycle test (only self-loop A→A currently covered).
- C2: `MAX_FALLBACK_HOPS=20` boundary test — state the contract explicitly (1 initial attempt +
  20 fallback transitions) and drive a SMALL configured cap, asserting exact attempt count (not
  just "not more than 20").
- C3: missing-capability-profile 503 — currently only a static invariant test, never runtime-driven.
- C4: 413 body-too-large — `req.socket.destroy()` currently runs BEFORE the outer catch can
  respond, so clients see ECONNRESET not the 413 JSON envelope. Reorder: send the
  `request_too_large` envelope FIRST, then close/drain. Remove the existing test's
  reset-as-success escape hatch (`test/proxy-body-size-cap.test.js` — tighten it to REQUIRE the
  413, not accept a reset as a pass).
- C5: `/ping` accepts any HTTP method — add a GET/HEAD guard.
- C6: flag missing-value inconsistency in `tools/c-thru` — `--route`/`--model`/`--memory-gb`
  silently drop a missing/flag-looking value while `--mode`/`--profile` hard-error. Unify on
  hard-error.
- C7: `sessionEffectivePath` (model-map-config.js) has no provenance/collision guard and isn't
  even exported (untestable). Export it; add a `{project_path}` provenance check +
  mismatch-regenerate; unit test.
- C8-C13: six characterization/regression tests for older audit gaps — mid-stream bad-NDJSON
  continue behavior, usage-tee-regex-on-malformed-SSE silent stats loss, invalid `re:` route
  regex silently skipped, `markBackendFailed` FIFO eviction at >100 entries,
  `loadPersistentUsage` old-schema migration (missing `by_backend`), `scrubCthruHeaders`
  actually stripping `x-c-thru-*` before forwarding upstream.

### Phase D — tech debt + doc reconciliation (subsumes the already-queued task #51)
- Delete dead `resolve_model_map_config()` in `tools/c-thru` (verify it's STILL dead — zero
  callers — before deleting; re-grep fresh, don't trust the original survey given how much
  `tools/c-thru` has churned this round from both sessions).
- Delete `config/model-map.json.bak` (untracked leftover, pre-migration schema) — confirm the
  concurrent session isn't using/depending on it first (check its current mtime vs. when this
  round started; if it's been touched recently by the OTHER session, leave it alone and ask
  rather than deleting).
- `docs/gemini-gap-roadmap.md`: mark G1-G3, G5-G9 shipped (verified against the coverage matrix
  during the original survey).
- `docs/orphan-disposition.md`: fix a stale note about `model-map.md`'s schema being stale
  (already fixed in an earlier round, 0345fb8) and record the B3 hook-rebuild disposition (they
  were rebuilt, not retired).
- `docs/planning/holistic-review-findings.md`: reconcile a stale "deferred" line against
  `surfaced-fixes-plan.md` (which marks the same items C37/C44/C46/C31/C43 as already fixed).
- Remove two dangling doc references found during the survey: `TODO-user-hook-model-rewriting.md`
  (referenced from `TODO-readme-installer-alignment.md` but the file never existed) and a
  dangling CLAUDE.md-TODO pointer at `docs/test-coverage-audit.md:308`.
- Resolve ownership of `test/c-thru-ephemeral-settings.test.sh` — it shows modified in
  `git status` throughout this round without me having touched it; it's very likely the
  concurrent session's own file (they authored it per their `2e01121` commit from before this
  round started) — do NOT stage/commit changes to it as part of Phase D without confirming.

### Phase E — decisions ledger (write, don't implement)
Create `docs/planning/TODO-round5-deferred-decisions.md` recording, each with one-line rationale:
N10 (401/403 primaries never cool down but always cascade — doubled upstream calls per request
until config is fixed; policy decision needed: skip fallback for permanent failures, or cool them
anyway), N8 (config reload takes effect one request late — ALS snapshot captured before
`refreshConfigIfChanged`; likely just needs documenting as intended, not fixing), the `:TODO`
model-version placeholders still in `config/model-map.json` (~3 model defs + ~40 route refs),
Bedrock backend go/no-go (design doc exists, `docs/bedrock-backend-design.md`, not built), OpenAI
translation 501 stub (intentional), header-regex fallback TODO
(`docs/planning/TODO-header-regex-fallback.md`), runtime-injection args worth adding
(`--fallback-model` first, per `docs/planning/runtime-injection-research.md`), confidence-cascade
Wave-2 calibration gate (never recorded as having been run —
`docs/planning/confidence-cascade-plan.md`), dynamic-classification docs stale pending an author
decision on whether the feature is still on the roadmap, and the `check-doc-refs.js`
doc-citation-linter idea (proposed at some point, no record of it actually existing in the repo —
re-file if still wanted).

## Final verification (once all phases land)

- Per-fix: fail-then-pass regression discipline (already the pattern used in every commit so
  far in this round — keep using it).
- Per-phase: `make test-fast` + syntax gates.
- End of round: one full `test/run-all.sh` (takes the exclusive mkdir-lock — will queue if the
  concurrent session is mid-run), `tools/c-thru-contract-check.sh`,
  `tools/c-thru-hygiene-check.sh` (expect the `config/model-map.json.bak` warning to clear once
  Phase D deletes it), `tools/sync-plugin-bundle.sh --check`.
- B2/B3 end-to-end sanity (already done once this round, worth repeating after B3's registration
  change lands): launch a real `c-thru` session against a stub forced into fallback, confirm the
  statusline badge appears, confirm a `c-thru-control` mode switch in one session leaves a second
  session's `/ping active_mode` untouched.

## Where to find things

- No plan file exists outside this document — the original Plan Mode plan lived in a
  session-scoped temp path (`/var/.../c-thru-session.<id>/plans/...md`) that a new session
  cannot read. This file is the durable replacement; update it in place as you make progress
  rather than relying on any other saved state.
- `docs/review-methodology.md`, `docs/test-authoring.md`, `docs/architecture-diagrams.md` (all
  committed in Phase 0) are the house-style references for how to run further review work and
  write more tests in this repo.
- Task list: this session had an in-memory TaskList (TaskCreate/TaskUpdate) tracking tasks #52-#59
  for phases 0/A/B1/B2/B3/B4/C/D+E — that task list is NOT visible to a new session/client. If you
  want task tracking in the new session, recreate equivalent tasks from the phase breakdown above.

## Update — plugin-mode session scoping (hooks)

Plugin-mode session scoping for `tools/c-thru-session-start.sh`, `tools/c-thru-classify.sh`, and
`tools/c-thru-postcompact-context.sh` is closed via a hook-payload `session_id` stdin fallback.
`tools/c-thru-stop-hook.sh` and `tools/c-thru-statusline-overlay.sh` have the identical gap for
their `GET /c-thru/recent` calls and were deliberately left untouched because Phase B3 owns them.

## Phase B4/C/D/E execution plan (finalized, 2026-07-12)

**Not yet implemented — this section is the plan, not a completion record.** Written in Plan Mode
after: (1) three parallel investigation forks re-verified every remaining backlog item against live
code (several of the original claims below in this doc had drifted or were wrong), (2) an
independent adversarial review from Grok (`grok-cc`), (3) a Plan agent designed a concrete,
collision-aware batching/dispatch sequence, (4) Plan Mode's own review gate — a senior-engineer
pass, then an "open unknowns" audit that forced direct investigation rather than assumptions,
including one live empirical probe (see Batch 3) and one product decision routed to the user via
AskUserQuestion (see Batch 1, item 1b). The plan below is the exact, gate-approved final version —
implement it as designed, don't re-derive it.

**How to resume from a fresh session:** read this whole section, then start at Batch 0's standing
procedure before touching anything. Per this repo's CLAUDE.md, code implementation on
Sonnet/Opus/Fable tiers routes through `codex-worker` with bounded task specs by default.

### Standing environmental fact

A separate, live Claude Code session may still share this working tree, actively editing
`tools/claude-proxy`, `tools/c-thru`, and plugin-bundle mirror files for its own unrelated feature
work (a "plan-page" feature, as of this writing). Treat this as a constant, not a one-time hazard —
Batch 0's standing procedure applies before every single bounded task below, every time, for the
whole duration of executing this plan, however many sessions it takes.

### Batch 0 — standing procedure (before every task below, every time)

Immediately before writing or dispatching any bounded task: `git status --porcelain`, `git diff
--stat -- <target files>`, and re-grep the specific function/line anchors cited below. Treat every
line number in this plan as "verify near line X, function Y" — not as ground truth frozen at
planning time; this repo's `tools/c-thru` has been observed to change its diff between two
consecutive `git status` calls seconds apart.

### Batch 1 — zero/near-zero collision hygiene (shared checkout, 4 parallel bounded tasks)

| Task | Item | Scope | Detail |
|---|---|---|---|
| 1a | **D1** | `tools/c-thru`, delete `resolve_model_map_config()` (~line 173, comment ~167) | Confirmed dead: zero call sites anywhere in the repo (repo-wide grep confirms the only other hit is this very doc's own description of it as dead), live path is `model-map-config.js --shell-env`. Delete the function and its stale "ARCH" comment block. Re-grep for callers fresh immediately before deleting. Do not touch `build_ephemeral_agents()` (~line 233) even though it's immediately adjacent — that's the co-tenant's active refactor. |
| 1b | **B4** | `install.sh` (`link_tool()`, lines 74-99) + `test/install-smoke.test.sh` | The `elif [ -e "$dest" ]` branch (line 93-94) just warns and skips forever on a real-file collision — no backup, no fix, ever. Add: `mv "$dest" "${dest}.bak.$$.$(date +%s)"` (pid+timestamp — plain timestamp races under concurrent installs) then fall through to the same `ln -sfn "$want" "$dest"` the other two branches already use; change the message accordingly. **Directory case (user-confirmed via AskUserQuestion):** `[ -e "$dest" ]` matches directories too — user chose to treat directories identically to files (mv the whole thing aside with the same naming, then symlink), not special-cased. New test cases: (a) pre-create a real file at the destination, run install, assert a `.bak.*` file exists with the original content and the destination is now a symlink; (b) same but with a real *directory* (containing a file) at the destination, confirming the whole directory moves intact and the destination becomes a symlink. (The original backup-convention line reference in an earlier draft of this doc, ~145-148, is a different unrelated function — nothing to reuse there.) |
| 1c | **C7 (narrowed)** | `tools/model-map-config.js`, export `sessionEffectivePath()` (~19-34, `module.exports` ~405-413) | Scope is EXPORT + a unit test of its path-layout output ONLY. Do **not** implement full `{project_path}` provenance/mismatch-regenerate this round — existing docs already rate that collision risk as negligible/accepted; the fuller design goes into the Batch 5 decisions ledger instead. |
| 1d | **D3 + D5** | `docs/gemini-gap-roadmap.md`, `docs/orphan-disposition.md`, `docs/planning/holistic-review-findings.md`, the dangling `TODO-user-hook-model-rewriting.md` reference, the dangling CLAUDE.md-TODO pointer in `docs/test-coverage-audit.md` (re-grep for current line, don't trust any specific number carried over from an older survey) | Mark G1-G3, G5-G9 shipped in the roadmap doc (all confirmed present in code); also reconcile G6/G8 in the same pass — appear shipped too, don't leave half-stale. Fix the stale orphan-disposition note, reconcile holistic-review-findings against surfaced-fixes-plan, remove the two dangling doc references. |

**Dispatch:** shared checkout, 4 bounded codex-worker tasks in one wave — file scopes are mutually
disjoint. Apply pathspec-only staging with an immediate pre-stage re-diff on every file regardless
of whether the co-tenant appears to be touching it right now.

**Verification:** `bash -n tools/c-thru` (1a) · `bash test/install-smoke.test.sh` (1b) · new
model-map-config test + `tools/sync-plugin-bundle.sh --check` then a real sync (1c) · grep-confirm
stale strings/refs are gone (1d) · batch close: `make check && make test-fast`.

**Commits:** 4 separate commits, pathspec-scoped, each preceded by a fresh `git status`. 1c's
commit must include BOTH `tools/model-map-config.js` and its plugin-bundle mirror
`plugins/c-thru/tools/model-map-config.js` — confirmed present in `tools/sync-plugin-bundle.sh`'s
copy list (line 63) — run the real sync (not just `--check`) and stage both together.

### Sandbox constraint (from `AGENTS.md`) — reshapes self-verification in Batches 2 & 3

Confirmed via direct read of `AGENTS.md`'s "Sandbox limitations" section: codex-worker's
workspace-write sandbox **cannot bind loopback TCP ports** (`listen EPERM` on `127.0.0.1`). Any
suite that spawns the proxy or a stub server fails with EPERM in that sandbox *even when the code
under test is correct* — AGENTS.md requires reporting those as "blocked: needs native
verification," never reworking a test to avoid the port bind, never claiming pass/fail from a
sandboxed EPERM run.

| Item | Spawns a live proxy/stub server? | Verification path |
|---|---|---|
| 2a (C1+C2) | **Yes** | codex-worker implements + reports blocked; main loop runs `node test/proxy-fallback-reload.test.js` natively afterward |
| 2b (C10) | No — static/config-level regex validation | codex-worker self-verifies |
| 2c (C3) | **Yes** — explicitly a live spawned-proxy request by design | codex-worker implements + reports blocked; main loop verifies natively |
| 2d (C9) | Likely — confirm at dispatch time | assume native verification needed unless dispatch-time inspection shows otherwise |
| 2e (C13) | Likely — confirm at dispatch time | assume native verification needed unless dispatch-time inspection shows otherwise |
| 2f (C8) | Ambiguous | classify at dispatch time by reading the existing test file's pattern before writing the brief |
| 2g (C11) | No — source-extraction harness, no port bind | codex-worker self-verifies |
| 2h (C12) | No — file read/write only | codex-worker self-verifies |
| Batch 3 (C4+C5) | **Yes** — both `proxy-body-size-cap.test.js` and the new `/ping` test | codex-worker implements + reports blocked; main loop runs both tests natively before the commit lands |

For every "native verification required" item: the bounded task runs whatever it can inside the
sandbox and explicitly reports EPERM-blocked tests as blocked; the main loop then runs the actual
test natively as a mandatory step before that item is considered done and before its commit lands.

### Batch 2 — claude-proxy coverage gaps, test-file-only (shared checkout, up to 8 bounded tasks)

9 of the original 10 "claude-proxy items" (C1, C2, C3, C8, C9, C10, C11, C12, C13) are achievable
as **test-file-only changes** — this repo already has a precedent
(`test/proxy-quality.test.js:379`, `loadApplyOutboundAuth()`) for extracting a pure function's
source text via `fs.readFileSync` + brace-balanced parsing and running it through `new
Function(...)`, zero edits to `tools/claude-proxy` itself. Only **C4 and C5** (Batch 3) need an
actual source edit.

| Task | Item(s) | Target file | Detail |
|---|---|---|---|
| 2a | **C1 + C2** | `test/proxy-fallback-reload.test.js` (existing, cycle-detection Test 2 ~line 129, `MAX_FALLBACK_HOPS` ref ~line 224) | Add an A→B→A mutual-cycle test (only A→A self-loop exists today) and a small-configured-cap boundary test for `MAX_FALLBACK_HOPS` (env `CLAUDE_PROXY_MAX_FALLBACK_HOPS`, enforced `claude-proxy:~1889/1909`). **"Attempt" = count of distinct upstream dispatch calls** (actual HTTP requests sent to a backend), measured via a stub/spy at the dispatch call site — NOT `chain`-Set size or `hopsWalked` (internal bookkeeping that could diverge). Disable `tryLocalTerminalFallback`/`tryGlobalDefaultFallback`/capability `fallback_chains` in the fixture so only the configured chain can fire. Both new tests spin up their own isolated proxy instance/config, not shared/module-level fixture state. |
| 2b | **C10** | `test/resolution-coverage.test.js` (~line 203) | Feed an actually-invalid `re:` route regex, assert the runtime silently skips it (`claude-proxy:~1605,1616`, `model-map-resolve.js:~326,442`) — existing coverage only validates the shipped config's regexes are valid. |
| 2c | **C3** | new file, e.g. `test/proxy-missing-capability-live.test.js` | Drive an actual live request through a spawned proxy to hit the missing-capability-profile 503 path (`claude-proxy:~1370`) — existing coverage is static/config-level only. |
| 2d | **C9** | `test/proxy-usage-large-stream.test.js` (existing) | Add a deliberately malformed/garbled SSE frame case — the usage-tee regex (`claude-proxy:~2244-2253`) silently defaults to 0/0 tokens on a no-match and still records usage. |
| 2e | **C13 (narrowed)** | `test/proxy-content-length-scrub.test.js` (existing) | Only the residual gap: a client spoofing an `x-c-thru-*` header must be stripped before forwarding upstream. `content-length` scrubbing is already covered. |
| 2f | **C8 (narrowed)** | new/extended Ollama-specific test | Scope strictly to the Ollama NDJSON mid-stream parser at `claude-proxy:~2617`. Exclude `~902` (`parseSseEvents`, generic SSE) and `~3657` (Gemini SSE) — an earlier survey conflated all three under "Ollama." |
| 2g | **C11** | new file, unit-extraction test for `markBackendFailed` | `FAILED_BACKEND_CACHE_MAX = 100` is hardcoded (`claude-proxy:~239-241`). Use the `loadApplyOutboundAuth`-style extraction harness rather than standing up 100+ cooldowned backends. |
| 2h | **C12** | new/extended test for `readUsageFileFresh` (`claude-proxy:~586-592`) | Correct function name (an earlier survey called it `loadPersistentUsage`, which doesn't exist). Tests the old-schema `by_backend` backfill on load. |

**Dispatch:** shared checkout, up to 8 bounded tasks in one wave, each scoped to exactly one target
test file. Every task's brief explicitly excludes `test/run-all.sh`.

**Registrar step (mandatory, after 2a-2h, serialized on its own):** one follow-up bounded task adds
`run_suite` lines to `test/run-all.sh` for whichever of {2c, 2f, 2g, 2h} needed a genuinely new
file. This file is a documented recurring co-tenant touchpoint — use the pathspec/hunk-extraction
discipline from Batch 3 below, and re-verify `run-all-coverage` passes afterward.

**Verification:** each task self-verifies via direct `node test/<file>.test.js` (safe concurrently
— unit suites bind random free ports). After the registrar step: `make test-fast`.

**Commits:** 8 task commits (plain `git add <file>` per file, preceded by a fresh `git status`) + 1
registrar commit on `test/run-all.sh` using full pathspec/hunk-extraction discipline.

### Batch 3 — claude-proxy source edit: C4 + C5 (the one real hot-file batch)

**Scope:** `tools/claude-proxy` — `readBody()` (~1712-1727) + its outer catch (~5620-5623) for C4;
the `/ping` handler (~4961) for C5. Plus `test/proxy-body-size-cap.test.js` (remove the
ECONNRESET/ECONNABORTED/EPIPE escape hatch at ~lines 36-39) and a new `/ping` method-guard test.

**C4's post-413 connection policy was resolved via a live empirical probe (already run, not
deferred).** A standalone repro server (matching the proposed fix: latch flag, no destroy-on-data,
reject-without-destroy, `res.end()` with no explicit cleanup) was built and tested: with a client
that eventually terminates its own stream, the connection behaved safely; with a client that
**abandons the request mid-body** (writes past the cap, never calls `req.end()` — the realistic
abuse case this guard defends against) and no explicit socket close, a second request forced onto
the same reused connection (`http.Agent({keepAlive:true, maxSockets:1})`) **hung indefinitely**
(confirmed via local-port tracking). **Conclusion: destroy is still required, only its order
changes** — respond first, destroy immediately after.

- **C4 fix:** today `req.socket?.destroy()` runs *before* the promise rejects with `{status:413}`,
  so the outer catch's 413 JSON never reaches the client — they see `ECONNRESET`. Fix: add a
  `tooLarge`/`rejected` latch flag; once tripped, `data` events stop growing `chunks` and don't
  re-reject. `readBody(req)` has exactly 3 callers (`claude-proxy:3055,5121,5362`), all
  `await readBody(req)` with no `res` in scope — do **not** change its signature to accept `res`
  (would ripple into all 3 call sites). `readBody` rejects with 413 *without* destroying the
  socket; the existing outer catch (~5620-5623, which has `res`) sends the JSON response and
  **must destroy the socket immediately after** the response is written/flushed
  (`res.end(json, () => req.socket?.destroy())` or equivalent) — per the probe above, skipping the
  destroy entirely risks hanging a reused connection on an abandoned upload. Tighten the test to
  require the actual 413 body; keep the ~100MB allocation, assert cleanly on status/body.
- **C5 fix:** `/ping` (`claude-proxy:4961`) has no method guard. GET returns JSON via `send()`
  (`claude-proxy:1398`, confirmed it always writes+ends a body); HEAD must mirror the existing
  `HEAD /` route at `claude-proxy:4974` (`if (req.method === 'HEAD' && req.url === '/')`) —
  headers-only, no `send()` call; any other method → 405.

**Dispatch:** shared checkout, **one** bounded task covering both C4 and C5 — not worktree
isolation. These are the only 2 of 10 claude-proxy items needing a source diff (no internal
overlap to isolate against); this round's own Phase B3 precedent (see "Concurrent-session caution"
section above) proves shared-checkout + pathspec/blob staging works on this exact file under this
exact collision condition; worktree isolation wouldn't remove the merge-back hunk-surgery step
anyway, and would add a stale-base risk (`WorktreeCreate`'s default `fresh` base-ref branches from
`origin/main`, well behind this repo's local commits). **Escalate to worktree only if**, at
dispatch time, `git diff -- tools/claude-proxy | grep -n '^@@'` shows the co-tenant has already
touched `readBody` or its outer catch directly — branch from local HEAD if so, never the default.

**Acceptance criteria:** re-read the current file first (line numbers will have drifted); implement
the latch/order fix exactly as designed; touch nothing else in the file; do not commit.

**Verification:** `node --check tools/claude-proxy` · `node test/proxy-body-size-cap.test.js`
(must show a real 413 JSON body, not ECONNRESET) · new `/ping` method test ·
`tools/sync-plugin-bundle.sh --check` then a real sync (`claude-proxy` IS mirrored, unlike
`tools/c-thru`) · `make test-fast`.

**Commit strategy:** same pathspec/hunk-extraction discipline as Phase B3 — diff, classify hunks
mine-vs-theirs, extract foreign hunks to a patch, stage, reverse-apply the patch against the index
only, verify zero foreign markers (`KNOWN_HOSTS`, `backendHost`, `deriveAuthProfile` as of this
writing — re-check for new ones) before committing. Stage + commit the resynced
`plugins/c-thru/tools/claude-proxy` mirror in the same commit or an immediate follow-up.

### Batch 4 — c-thru source edit: C6

**Scope:** `tools/c-thru` — main collect stage (~4953-5040, where `--route`/`--model`/
`--memory-gb` are parsed) only. Leave the strip/width-collection stage (~4243-4251,
`cthru_flag_width` case) untouched — it must keep just consuming width for the main stage's later
re-parse. Plus `test/cli-e2e-flags.test.js`.

**Fix:** unify `--route` (4953-4960), `--model` (4961-4965), `--memory-gb` (5027-5035) onto the
same hard-error-on-missing-value pattern `--mode`/`--profile` already use. Confirmed via direct
read: `--memory-gb` currently only errors when a value *is* present but fails `^[0-9]+$` — a
missing/flag-looking value silently no-ops exactly like `--route`/`--model`. Deliberate behavior
change (scripts passing these bare, previously silently ignored, will now fail) — call it out in
the commit message.

**Scope correction (not purely additive):** `test/cli-e2e-flags.test.js`'s existing Test 24
(~560-603) has three assertions — 24a/24b/24e (bare `--model`/`--route`/`--memory-gb`) — that
assert the *current* silent-no-op behavior. This fix breaks all three unless rewritten to expect
hard-error in the same change. Keep 24c/24d/24f unchanged. Use the existing `--settings`/`--agents`
hard-error blocks (4969-4987) as the template.

**Collision note:** watch for an uncommitted co-tenant Test 25 appended immediately after Test 24 —
re-diff immediately before staging.

**Dispatch:** shared checkout, single bounded task. `tools/c-thru` is not in the plugin-bundle
mirror list — no bundle resync needed.

**Verification:** `bash -n tools/c-thru` · `node test/cli-e2e-flags.test.js` · `make check` ·
`make test-fast`.

**Commit strategy:** pathspec/hunk-extraction discipline on both files.

### Batch 5 — Phase E decisions ledger (run last)

New file `docs/planning/TODO-round5-deferred-decisions.md`, pure additive, zero collision. Run
after Batches 2-4 so it can record the judgment calls actually made during execution (C2's
"attempt" definition, C11's cap staying hardcoded), plus: N10 (401/403/404 already skip cooldown —
open question is cascade-vs-fail-fast for genuinely permanent failures), N8 (config-reload
one-request-late, likely just needs documenting as intended), the `:TODO` model-version
placeholders in `config/model-map.json`, Bedrock backend go/no-go, the OpenAI translation 501 stub
(intentional), the header-regex fallback TODO, worthwhile runtime-injection args
(`--fallback-model` first), the confidence-cascade Wave-2 calibration gate, dynamic-classification
docs staleness, the never-built `check-doc-refs.js` idea, and the full `sessionEffectivePath`
provenance design demoted out of C7 in Batch 1.

### Final milestone (after all 5 batches)

- `tools/sync-plugin-bundle.sh --check` — should be clean.
- `bash tools/c-thru-contract-check.sh` (part of `make check`).
- One full `test/run-all.sh` (no `--fast`; takes the exclusive lock, will queue if the co-tenant is
  mid-run — a wait isn't necessarily a hang).
- Final `git log`/`git status` sweep confirming no batch accidentally staged a co-tenant file (as of
  this writing: plan-page feature files, `test/c-thru-ephemeral-settings.test.sh`).

### Known residual risks

1. C6's Batch 4 task must rewrite 3 existing passing assertions, not just add new ones.
2. `test/run-all.sh` is a second same-file collision surface, handled via the single serialized
   registrar step in Batch 2.
3. D1's deletion range sits immediately before the co-tenant's active `build_ephemeral_agents()`
   refactor — non-overlapping today, hunk-boundary near-miss worth care at staging time.
4. If Batch 3 ever escalates to worktree isolation, it must branch from local HEAD, not the default
   stale `origin/main` base-ref.

### Provenance of this plan

Machine-local plan-mode file: `~/.claude/plans/radiant-wandering-ocean.md` (may not survive a
machine change or `~/.claude/plans/` cleanup — this doc section is the durable copy). Passed Plan
Mode's senior-engineer review gate and open-unknowns audit; the only `[investigate]`-tagged item
(C4's connection policy) was resolved via the live probe described above rather than skipped —
recorded via a `/waive-investigation` sentinel only because the formal `/investigate-plan` command
wasn't available in this session, not because the investigation itself was skipped.
