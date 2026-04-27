# TODO

Items identified from install.sh audit (2026-04-20). Ordered by impact.

## install.sh gaps / automation

**[install] Add tools/ to PATH on install**
`install.sh` currently symlinks individual scripts into `~/.claude/tools/`,
but that directory isn't on the user's PATH by default. After install,
running `c-thru` from anywhere requires either typing the full path or
the user manually adding `~/.claude/tools/` (or `<repo>/tools/`) to PATH.

Implementation:
1. Detect the user's shell (`$SHELL`, `~/.zshrc` vs `~/.bashrc` vs
   `~/.config/fish/config.fish`).
2. Append a sourced block to the appropriate rc file:
   ```sh
   # c-thru: tools on PATH (added by install.sh)
   if [[ -d "$HOME/.claude/tools" ]]; then
     export PATH="$HOME/.claude/tools:$PATH"
   fi
   ```
3. Idempotent — guard with a marker comment so re-running install.sh
   doesn't append duplicate blocks.
4. Provide an opt-out: env var `C_THRU_INSTALL_NO_PATH=1` skips the
   PATH edit (CI / containers / users who want to manage PATH manually).
5. Print a clear post-install message: "Run `source ~/.zshrc` (or open
   a new shell) to put c-thru on your PATH" so the user knows what
   happened and how to make it active without restarting their session.
6. Alternative route: install a `c-thru` shim into `~/.local/bin/`
   (which is more commonly on PATH) instead of editing rc files. Less
   invasive but assumes `~/.local/bin/` is already on PATH.



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

**[CRITICAL] [config] Project-local `.claude/model-map.json` pollutes the global profile**
Reproduced this session (2026-04-26): running `c-thru` (or any tool that
calls `resolveSelectedConfigPath` with `syncProfile: true`) from a cwd
whose ancestor contains a `.claude/model-map.json` causes that file to
be MERGED INTO `~/.claude/model-map.json` (the global profile) on every
sync. The merged-in entries persist after the session exits and are
visible to ALL future c-thru invocations from ANY directory.

**Repro** (verified working session):
```sh
mkdir -p test-project/.claude
echo '{"model_routes": {"test-project-model": "ollama_local"}}' > test-project/.claude/model-map.json
cd test-project
node -e "require('/path/to/tools/model-map-config.js').resolveSelectedConfigPath({...})"
# Now ~/.claude/model-map.json contains "test-project-model" — visible
# from every other cwd, even after cd-ing away.
```

**Where the bug lives**:
- `tools/model-map-config.js:67` — `findParentModelMap(cwd)` walks
  upward looking for `.claude/model-map.json`. Returns the first hit.
- `tools/model-map-config.js:74` — `syncArgs` passes `projectPath` as
  the THIRD merge tier into `model-map-sync.js`.
- `tools/model-map-layered.js` — `mergeConfigLayers(defaults, global,
  project)` does a recursive merge, blowing project-local entries into
  the merged effective config that gets WRITTEN BACK to
  `~/.claude/model-map.json`.

**Why this is wrong**:
The CLAUDE.md schema says project-local config should be "selected by
precedence and traversed as its own DAG; it is not merged on top of the
profile graph." But the implementation does merge it (just into the
profile path rather than treating it as a separate selected path).
Every project's local config leaks into the global profile.

**Fix sketch**:
1. STOP writing the merged result back to `~/.claude/model-map.json`
   when project tier is non-null. Either (a) write to a session-scoped
   path like `$TMPDIR/c-thru-effective-<sessionid>.json` and point the
   proxy at it via `CLAUDE_MODEL_MAP_PATH`, OR (b) write to
   `<project>/.claude/model-map.effective.json` and select that path
   when present.
2. Profile sync (system + global overrides) should NEVER include
   project tier. Project-local merges happen at request resolution
   time in the proxy, not at sync time.
3. Add a one-time cleanup script that detects pollution in
   `~/.claude/model-map.json` (anything not in system + global
   overrides) and removes it. Document the cleanup as part of
   install.sh post-upgrade hook.

This bug compounds with the existing "everything else should be self
contained" audit (TODO above) — both speak to the same architectural
boundary that's currently leaky.

**[ollama] `ollama pull <model>` must block until completion before starting**
When the active model isn't cached and a pull is needed, the launching
shell must wait for the pull to fully finish before proceeding to
`ollama run` / inference. Today the codepath in `ensure_ollama_running`
(`tools/c-thru` ~L2540) does invoke `ollama pull "$model"` synchronously,
which is correct — but two adjacent paths can drift:

1. **Concurrent-session race already mitigated.** The `pgrep -af 'ollama pull '`
   + `awk` + `grep -Fxq` dedup (added in commit f65b8da) prevents a second
   c-thru process from kicking off a parallel pull. But it does NOT make the
   *second process wait* for the first one's pull to finish — it just exits
   the prep step early, and the caller assumes the model is ready when it
   isn't yet. Add a wait loop: if dedup detects an in-flight pull from
   another session, poll `ollama list | grep -Fxq "$model"` until it
   appears (with a sane timeout, e.g. 10 minutes for large models) before
   returning success.

2. **Background prepull jobs** (`ensure_active_tier_prepulled`, fired with
   `( ... ) >/dev/null 2>&1 &; disown`) are intentionally async — they
   warm models for *future* sessions, not the current one. The current
   session's blocking pull (path 1) is what guarantees correctness for
   "I need this model now". Keep this separation; document it.

3. **Verify completion before claiming success.** After `ollama pull`
   returns 0, re-verify with `ollama list | grep -Fxq "$model"` so we
   catch the case where the CLI exits 0 but the model isn't actually
   cached (network-flaky environments, partial downloads).

4. **Pull-failure UX.** If the pull fails, surface a clear error with
   the model name + cause + suggested action (network check / disk space
   / `ollama pull <model>` to retry manually). Today the failure path
   silently returns 0 in some branches.

5. **Mirror to `ollama run` warmup.** When `ollama_run_warm` is called and
   the model isn't yet resident in VRAM, the warmup should also block until
   the runner reports it's loaded (currently fires a background `curl
   -sf -X POST /api/generate` and returns immediately). For prompt-time
   warming this is fine; for "must be ready before inference" paths,
   block.

**[deps] `brew install` must block until completion before continuing**
When `c-thru check-deps --fix` (or any path that auto-installs missing
optional tools via `brew install`) runs, the calling script must wait for
brew to fully finish before proceeding — including post-install scripts
and any `brew link` steps. Risks if not waited:
- Subsequent `command -v <tool>` checks return false even though the
  install is in-flight, leading to spurious "tool missing" warnings.
- Re-runs of `c-thru` may launch concurrent `brew install` processes for
  the same package (the same race that bit `ollama pull` earlier this
  session).
- PATH cache in the parent shell may not reflect newly-installed binaries
  until the shell re-hashes (`hash -r` or new shell).

Implementation in `tools/c-thru` and any `--fix` paths:
1. Always invoke `brew install <pkg>` synchronously (no `&` / `nohup` /
   background). The default `brew install` does block, but watch for any
   `&`-suffixed invocations that may have crept in.
2. After install: `hash -r` (bash builtin) to refresh PATH cache so
   subsequent `command -v` calls see the new binary in the same shell.
3. Re-verify: `command -v <tool>` must return success before continuing
   to the next step. If not, abort with a clear error rather than
   silently passing.
4. For multiple packages, install one-at-a-time (not `brew install a b c`)
   so a failure on one doesn't leave the others in a partial state.
5. Mirror the `pgrep`-based dedup we added for `ollama pull`: check
   `pgrep -af 'brew install <pkg>'` before starting a new install,
   skip if one is already in flight from another c-thru session.

**[capacity] Audit 128gb-tier model fleet for VRAM oversubscription**
On a 128GB unified-memory machine, this session observed three concurrent
models loaded (≈95GB total VRAM) leaving only ~33GB for the OS + everything
else, which slowed inference dramatically. Audit `config/model-map.json`
`llm_profiles['128gb']` for what gets prepulled / warmed / kept resident:

1. Count the distinct models referenced across all capabilities at 128gb tier
   (connected_model, disconnect_model, cloud_best_model, modes[*]).
2. Sum their VRAM footprints (approximate — `ollama list` size or model card
   data) for the worst-case "all loaded simultaneously" scenario.
3. Compare against the 128GB headroom budget (target: ≤60GB resident at any
   one time so 60GB+ is left for OS/buffers/prompt-eval).
4. The `prep_policy: skip` field on backends already exists — extend
   `ensure_active_tier_prepulled` (`tools/c-thru` ~L2152) to honor a
   per-capability `prep_policy: warm-only-on-demand` so cold capabilities
   don't get prepulled.
5. Consider a scheduled eviction: if VRAM exceeds budget, evict the
   least-recently-used resident model. Ollama's `keep_alive: 0` does this
   per-model; could be wired to a watchdog.

Not urgent but a real bottleneck — observed during this session: 3 models
× ~30GB each = inference contention even on the supposedly-roomy 128gb tier.

**[stats] Wire up token-usage tracking and surface via /c-thru/status**
The proxy already has scaffolding for persistent usage tracking but it's
**dead code today** — `recordUsage()`, `persistentUsage`, and
`flushPersistentUsageNowSync()` exist at `tools/claude-proxy` L121–145, load
`~/.claude/usage-stats.json` on boot, but **nothing ever calls `recordUsage()`**.
The new observability events (`ollama.stream.done`, `ollama.nonstream.done`,
`backend_response`) already capture `prompt_tokens` and `output_tokens` per
request — we just need to feed them into the stats file and expose via the
REST API.

**Implementation:**

1. **Hook into the stream-done paths** (in `forwardOllama` end-of-stream and
   end-of-nonstream handlers). Add `recordUsage(effectiveModel, promptTokens,
   outputTokens)` call alongside the existing `ctxLog(...'ollama.*.done', ...)`.
   Also hook `forwardAnthropic` — extract usage from the upstream response
   (Anthropic emits it in `message_delta` for streams, in `usage` field for
   non-streams). For `forwardAnthropic`, extracting from the streamed body
   needs minor parsing — currently we just `pipe()` upstream straight to client.

2. **Switch `flushPersistentUsageNowSync` → async** to avoid blocking the
   event loop on the hot path. Use `fs.promises.writeFile` with a debounce:
   coalesce multiple `recordUsage()` calls within a 5-second window and only
   flush once. Pattern:
   ```js
   let flushTimer = null;
   function scheduleFlush() {
     if (flushTimer) return;
     flushTimer = setTimeout(async () => {
       flushTimer = null;
       await fs.promises.writeFile(USAGE_STATS_FILE, JSON.stringify(persistentUsage));
     }, 5000);
   }
   ```
   Crash-safety: also flush on `SIGTERM`/`SIGINT` synchronously in the existing
   shutdown handler so we don't lose the last 5s window.

3. **Track per-LLM AND per-backend.** Extend the schema beyond the current
   `{total_input, total_output, by_model:{}}` to include backend:
   ```json
   {
     "total_input": 12345,
     "total_output": 6789,
     "by_model": {
       "qwen3.6:35b-a3b-coding-nvfp4": { "input": 1200, "output": 800, "calls": 5 },
       "claude-haiku-4-5-20251001":    { "input": 4000, "output": 2000, "calls": 3 }
     },
     "by_backend": {
       "ollama_local": { "input": 1200, "output": 800, "calls": 5 },
       "anthropic":    { "input": 4000, "output": 2000, "calls": 3 }
     },
     "first_recorded": "<iso8601>",
     "last_recorded":  "<iso8601>"
   }
   ```
   `calls` count + `first_recorded` + `last_recorded` are useful for rate-of-use
   inference. `by_backend` lets `/c-thru-status` show "you spent N tokens on
   anthropic vs M tokens on local" at a glance.

4. **Surface via `/c-thru/status` REST endpoint.** The endpoint already returns
   `{ok, mode, hardware_tier, config_source, active_capabilities}`
   (`tools/claude-proxy` L546–553). Add a `usage` field with the persistentUsage
   snapshot. Optional query param `?usage=since:<iso8601>` could compute a
   delta; defer that to a follow-up.

5. **Surface in `/c-thru-status` skill.** The skill (`skills/c-thru-status/`)
   currently shows routes/models/health. Add a "Token usage" block that reads
   from `/c-thru/status` and renders a compact table. Keep it brief — top 5
   models by token count, with totals.

**Privacy note:** the existing journal feature (`CLAUDE_PROXY_JOURNAL=1`)
already captures full request bodies, so adding aggregate counts is strictly
less sensitive. Stats file is local-only and not transmitted anywhere.

**Won't track:** request latency (separate file?), thinking-token counts vs
content-token counts (deferred), per-session attribution (no session-id field
in the dispatched events).

**[benchmarks] Keep model benchmark data fresh via daily fetch + proxy reload**
On c-thru startup, do a daily-debounced fetch of the upstream benchmark JSON
and `SIGHUP` the proxy so it picks up fresh data. The proxy reads `BENCHMARK`
once at module load (`tools/claude-proxy` ~L267), so updates need a reload to
take effect.

**Origin discovery at script start (NOT hardcoded):**
Resolve the upstream benchmark URL dynamically each run from the c-thru repo's
own git config — this way forks, mirrors, and self-hosted clones all get the
right source without env-var configuration.

```sh
# Discover origin URL of the c-thru repo (the script knows its own location)
remote=$(git -C "$ROUTER_REPO_ROOT" config --get remote.origin.url)
# Normalize to https form (handle git@github.com:foo/bar.git → https://github.com/foo/bar)
case "$remote" in
  git@github.com:*) https="https://github.com/${remote#git@github.com:}"; https="${https%.git}" ;;
  https://*) https="${remote%.git}" ;;
  *) echo "c-thru: unsupported remote scheme '$remote' — skipping benchmark refresh" >&2; exit 0 ;;
esac
# raw.githubusercontent.com/<owner>/<repo>/<branch>/docs/benchmark.json
branch=$(git -C "$ROUTER_REPO_ROOT" rev-parse --abbrev-ref HEAD)
raw_url="${https/github.com/raw.githubusercontent.com}/${branch}/docs/benchmark.json"
```

This means the discovered URL will track whatever fork/branch the user
installed from. If origin is GitLab/Bitbucket, add cases or fall back to a
shallow `git fetch` of just the benchmark path.

**Implementation sketch — `tools/c-thru-benchmarks-update.sh`** (or extend
`tools/c-thru-self-update.sh`):
1. Stat `$CLAUDE_PROFILE_DIR/.benchmarks-stamp`. If <24h old, skip silently.
2. Discover raw URL as above.
3. `curl -fsSL --max-time 5 "$raw_url" -o /tmp/benchmark.json.new` —
   fail-soft (best-effort, never blocks startup on network issues).
4. Validate JSON: `node -e 'JSON.parse(fs.readFileSync(...))'` — drop on parse error.
5. **Compare hashes** of `/tmp/benchmark.json.new` and the current
   `$ROUTER_REPO_ROOT/docs/benchmark.json` (e.g. `shasum -a 256` on each, or
   `cmp -s` for byte-equality). Two paths:
   - **Identical** → discard the temp file, touch the stamp file, exit silently.
     **Do not signal the proxy.**
   - **Different** → atomic `mv` over the existing file, touch the stamp,
     `c-thru reload` to SIGHUP the proxy. Log a single line summarizing the
     diff (e.g. "benchmarks refreshed: +3 models, -1 model").
6. Extend `reloadConfigFromDisk` in `tools/claude-proxy` to also re-read
   `docs/benchmark.json` on SIGHUP (one extra `JSON.parse(fs.readFileSync(...))`
   block — currently it only re-reads model-map).
7. Opt-out via `CLAUDE_ROUTER_NO_BENCHMARK_UPDATE=1` (mirrors existing
   `CLAUDE_ROUTER_NO_UPDATE` pattern).

**Why hash-gate the reload:** SIGHUP forces the proxy to reparse model-map +
benchmark.json + reset internal state. If the upstream JSON is unchanged
(common case — benchmarks change weekly at most), there's no benefit to
disrupting in-flight requests or invalidating any cached resolution state.
Touch the stamp regardless so we don't re-fetch for 24h, but only trigger
reload when the data actually changed.

Why fetch-a-single-file instead of `git pull`: surgical, avoids touching
working-tree state if the user has uncommitted changes in the repo.

Why dynamic discovery: forks, mirrors, branches, and contributor checkouts
all get correct upstream tracking without env vars. The script's own location
is the source of truth.

**[setup] Audit installer / setup paths for stale "self-contained" violations**
The repo is meant to be self-contained — only user-chosen config writes should
land in profile (`~/.claude/`) or project (`<cwd>/.claude/`) directories;
everything else must live inside the repo. Audit:
- `install.sh`: are any persistent files written outside the symlinks +
  `~/.claude/model-map.overrides.json`? Anything stale from earlier iterations?
- `tools/c-thru-self-update.sh`: does it touch state outside the repo?
- `tools/model-map-config.js` `profileClaudeDir()` discovery: confirm it only
  *reads* from non-profile paths and never *writes*.
- Any `~/.claude/.*-stamp-*` or cache files: are they all justified, documented,
  and cleanable?
- Hooks registered in `~/.claude/settings.json`: do any contain absolute paths
  that drift if the repo moves? (`tools/c-thru-self-update.sh` should validate at
  startup.)
Goal: a fresh user should be able to clone the repo, run `install.sh`, and have
exactly two persistent files in `~/.claude/` outside of vendor stuff:
`model-map.overrides.json` and `model-map.system.json` (system is install-time
seeded). Everything else should be derived/cached/symlinked.

**[git] Commit and push all session work**
Outstanding uncommitted changes from this session: timeout fixes, proxy
simplification (remove warmup machinery), forwardAnthropic path fix,
content-length scrub, observability layer (req_id + ctxLog/ctxDebug + new events),
mode-conditional `model_routes` schema extension, Anthropic-fidelity SSE rewrite
(unique IDs, event prefixes, ping keepalives, stop_reason mapping, thinking
blocks, cache_*_tokens fields, error shape consistency, mid-stream watchdog,
client-disconnect timer cleanup, recursion cycle detection, validator hardening,
pgrep precision fix). Run `git add -p` to stage selectively, write a coherent
commit message that lists the major axes, push to main.

**[ollama] Investigate Ollama process-per-model architecture & decouple from proxy lifecycle**
Question: does Ollama strictly require one runner process per loaded model, or is there a
shared/embedded mode? Today `ollama serve` is a long-running daemon and spawns one
`ollama runner` child per loaded model — that's already independent of c-thru. Goal: ensure
Ollama runs as its own daemon (started/managed independently, e.g. via the Ollama macOS
app or `launchctl`) while the proxy lives strictly as a child of `c-thru`. Verify:
1. The proxy never spawns or kills ollama runners (confirmed: `ensure_ollama_running` lives
   in `tools/c-thru` bash, not in `claude-proxy`).
2. The proxy connects to `OLLAMA_BASE_URL` (default `http://localhost:11434`) and assumes
   it's externally managed.
3. `c-thru` startup detects whether Ollama is reachable and (a) starts it if `CLAUDE_ROUTER_OLLAMA_AUTOSTART=1`,
   or (b) warns and continues if not.
4. When `c-thru` exits, the proxy child exits with it; Ollama persists.
Document the boundary in CLAUDE.md so future contributors don't conflate the two.

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
