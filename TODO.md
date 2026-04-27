# TODO

Items identified from install.sh audit (2026-04-20). Ordered by impact.

## install.sh gaps / automation

**[review] Test-coverage audit — every guard/check should have a quality test**
The codebase has accumulated MANY runtime checks and invariants
(cycle detection, depth caps, content-length scrub, TTFT timeout,
stream-stall watchdog, fallback gates, mode-conditional routing,
error-shape consistency, hard-stall hard-fail, terminal exemption,
cooldown skip, global-default last-resort, half-open stream protection,
client-disconnect timer cleanup, request body parse, etc.) — but
test coverage is uneven.

Senior-engineer review goal: for every defensive check / invariant /
edge-case branch in `tools/claude-proxy`, `tools/c-thru`, and
`tools/model-map-*.js`, answer:
1. Is there a test that EXERCISES this branch (not just covers via grep)?
2. If not, would adding one find a real bug or just rubber-stamp the
   current behavior? (favor tests that prove invariants, not tests that
   re-implement the function).
3. If "yes, would find bugs" → file a sub-TODO with the test sketch.

Concrete audit checklist (pull from a grep of `if (` on the hot paths):
- forwardOllama: 30+ branches; verified for thinking/text transition,
  TTFT, stall, fallback, but no test for: parse_error mid-stream,
  client.disconnect timer-clear, content-length scrub effectiveness,
  ping interval firing, message_stop after empty stream.
- forwardAnthropic: usage extraction tee correctness, 4xx pipeable
  body shape, mid-stream error.
- tryFallbackOrFail: cooldown skip with multi-hop tested, but cooldown
  TTL expiry not tested (would need fake clock or longer test wait).
- model-map-config.js: project-overlay path derivation (just-fixed
  bug), session-scoped hash collision.
- c-thru bash: lock-and-spawn race, stale-pid cleanup, port-in-use
  handling, malformed READY line, ECONNREFUSED on proxy spawn.

Plan output:
- Numbered list of N tests-worth-writing, each with a one-line
  rationale (why this catches bugs vs noise).
- Prioritize by HIGH (would catch real bugs) / MED / LOW.
- Run as a once-per-quarter audit so coverage doesn't drift as the
  codebase evolves.

This pairs with the senior-eng `[review]` TODO above and the
breadcrumb-comments item — together they form a quarterly maintenance
trio: comments → coverage audit → architectural review.

**[docs] Add LLM-token-efficient breadcrumb comments throughout the code**
The codebase has substantial complexity (proxy state machine, fallback
graph, observability ctx, bash router lifecycle, agent contracts) but
inline comments are uneven — some sections heavily annotated (e.g. the
fallback-cycle invariants, the SSE state machine), others bare (the
bash router's lock-and-spawn dance, `model-map-resolve.js` mode handling,
agent contract checker).

Goal: every key function, tricky branch, and subtle invariant should
have a breadcrumb comment that an LLM (or human reading for the first
time) can use to orient quickly. NOT to write Doxygen — to leave
"why" trail markers at decision points.

**Token-efficient breadcrumb style**:
- One concise sentence per breadcrumb. No multi-paragraph essays.
- Lead with the WHY, not the WHAT (the code shows what; the comment
  shows why).
- Cross-reference related code (`see resolveBackend`, `mirrors L450
  in claude-proxy`).
- Mark non-obvious invariants explicitly (`INVARIANT: terminal nodes
  never enter cooldown`).
- Mark known sharp edges (`CAUTION: this clearTimeout races with the
  setTimeout callback if X happens`).
- Avoid restating function signatures, parameter names, or trivial logic.

**Target sites** (audit + annotate):
- `tools/c-thru` lock-and-spawn, ready-pipe handshake, hook
  registration, env var scrubbing, hw-profile detection.
- `tools/claude-proxy` ALS context lifecycle, ssEvent emission,
  mid-stream watchdog, the streaming branch state machine,
  forwardOllama dispatch, fallback chain Set, cooldown invariants
  (already partly annotated — finish the pass).
- `tools/model-map-resolve.js` 16-mode resolveProfileModel switch,
  applyModeFilter, pickBenchmarkBest scoring.
- `tools/model-map-config.js` 3-tier sync, project-overlay path
  derivation (just-fixed pollution bug — annotate why).
- `tools/c-thru-contract-check.sh` regex-derived contract validation.
- `agents/*.md` — STATUS contract is well-annotated already.
- `skills/c-thru-plan/SKILL.md` wave lifecycle, pre-processor flow.

**Anti-patterns to avoid**:
- "// returns the value" — useless.
- "// added 2026-04-25 to fix X" — rots; the commit log has this.
- "// TODO: figure out why this works" — file a TODO, don't comment.
- Multi-paragraph block comments restating the function body.

**Verification**:
- Use a token-counter on diff output to confirm comments fit budget
  (e.g., total breadcrumbs across the repo < 5K tokens).
- Spot-check: pick a random function, see if the breadcrumb is enough
  to predict what the function does without reading it.
- Annotate the 5 sharpest edges in the codebase (e.g., the
  `messageClosed` flag, the `_seen` recursion guard, the `_fallbackChain`
  Set, the timer-leak protection, the content-length scrub).

This is a maintenance pass, not a feature — best run as a
once-per-quarter audit so the codebase stays self-documenting.

**[docs] Full repo audit + thoughtful README rewrite**
The repo has accumulated significant capability through this session
(observability layer, mode-conditional routing, Anthropic SSE fidelity,
runtime upstream fallback with cooldown + global default + TTFT, agent
contract system, plan/wave orchestration, c-thru bash router, MCP server,
hooks, skills, hardware-tier detection, etc.). The current README likely
doesn't reflect any of this — needs a top-to-bottom rewrite grounded in
what actually exists.

Audit scope (file-by-file):
1. **`README.md`** — current content, what's outdated, what's missing.
2. **All `tools/*`** — name, what it does, who calls it, status (active/
   deprecated/half-extracted). Cross-reference against grep to confirm
   "active" claims.
3. **All `agents/*.md`** — purpose, capability tier, contract status.
4. **All `skills/*/SKILL.md`** — invocation, purpose, scope.
5. **All `hooks/*` + `.claude/settings.json`** — what fires when.
6. **`docs/*` + `wiki/*`** — what's authoritative vs stale vs orphaned.
7. **`config/model-map.json` schema** — actual shape vs CLAUDE.md claims.
8. **Every claim in current README/CLAUDE.md** — verify each is still true
   (e.g., "Claude Code hooks may observe but must not modify
   tool_input.model" — is that still enforced anywhere?).

Goals for the new README:
- **Purpose-first**: what is c-thru, what problem does it solve, what's
  the simplest possible intro example.
- **Architecture diagram(s)**: data flow client → c-thru bash → proxy →
  backend; resolution graph (model_routes / sigil / capability aliases /
  llm_profiles / fallback chain / cooldown / global default); component
  diagram (router, proxy, MCP server, hooks, skills, agents).
- **Agent / capability story**: surface the unique value prop —
  Claude Code agents (planner, auditor, judge, implementer, etc.)
  attract specific cognitive activities (planning vs review vs heavy
  coding vs fast scout vs deep reasoning), and c-thru maps each to an
  appropriate LLM on the back side. This is the killer feature and
  isn't well-documented.
- **Three-tier fallback story**: per-backend chain → cooldown skip →
  routes.default global last-resort. With diagram showing how a hung
  primary becomes a transparent local-rescue.
- **Configuration recipes**: 5-10 common scenarios (cloud-only, local-
  only, cloud-with-local-fallback, mode-conditional model_routes,
  benchmark-driven ranking, hardware-tier defaults).
- **Observability**: req_id grep usage, /c-thru/status fields, what each
  log event means.
- **Install + uninstall** (per the uninstall TODO above).
- **Honest about limits**: what's still rough (project-pollution
  architecture had a CRITICAL bug, the 5 pre-existing test failures,
  the half-extracted journal block, etc.). Don't oversell.

Cleanup pass (delete don't deprecate):
- ANY claim, command, env var, file, agent, or skill mentioned in
  README/CLAUDE.md that doesn't have a corresponding callsite in code
  → REMOVE the claim. If the feature should exist, file a TODO; don't
  let docs lie.
- Cross-reference every file under `tools/` against grep — if it's not
  invoked from anywhere active, it goes (or gets a TODO to wire it).
- Same for env vars: if `CLAUDE_PROXY_FOO` is documented but no code
  reads `process.env.CLAUDE_PROXY_FOO`, the doc lies.

Diagrams:
- Mermaid diagrams (renders on GitHub) for architecture + fallback +
  resolution graph.
- ASCII diagram fallback in CLAUDE.md (terminal-friendly).
- Sequence diagram for the agent → capability → LLM mapping showing how
  a single Claude Code session uses 5+ different models simultaneously.

This is a large item — likely a full afternoon of methodical work to
do well. Worth its own dedicated session.

**[install] install.sh should run e2e tests to confirm functionality**
After symlinking tools, seeding configs, and registering hooks,
install.sh should fire a small e2e validation suite to confirm the
install actually works end-to-end. Currently install just prints
"installed!" with no proof the system is functional.

Suggested e2e checks (post-install, pre-success-message):

1. **Syntax + import sanity**: `bash -n` every shell tool, `node --check`
   every .js tool. Catches install-time corruption (failed download,
   permission issues, partial copy).
2. **Validate shipped model-map**: `node tools/model-map-validate.js
   config/model-map.json` (already in CLAUDE.md verify steps but not
   actually run by install).
3. **Spawn proxy + /ping + verify shape**: start proxy on a free port,
   curl /ping, confirm response body contains `"ok":true`. Kill
   proxy. ~3-5s, catches "proxy can't load config" / "proxy can't bind".
4. **Hook registration round-trip**: read `~/.claude/settings.json`
   after install, verify each declared hook (`c-thru-session-start.sh`,
   `c-thru-proxy-health.sh`, etc.) actually exists at the registered
   path AND is executable.
5. **Sample request through proxy**: with no auth and a trivial
   model-map, send a /v1/messages request → proxy attempts to forward
   to Ollama at localhost:11434 → if Ollama is up, get a 200; if not,
   get a clean Anthropic-shape error. Either result confirms the
   proxy's request-handling pipeline works.
6. **Shell PATH check**: if the install-PATH TODO landed, verify
   `c-thru` is now on $PATH after sourcing rc.

UX:
- Print each check with a status: `[ok] proxy /ping verified`,
  `[fail] hook 'c-thru-session-start.sh' missing executable bit`.
- On any failure: rollback (or print remediation) — don't leave the
  user with a half-broken install.
- `--skip-e2e` flag for CI / sandboxed environments where network or
  port-bind isn't available.

This catches the "I ran install.sh but nothing works" class of bug
that's currently invisible until the user actually tries to use c-thru.

**[install] Add an `uninstall.sh` (standard repo convention)**
The repo has `install.sh` that creates symlinks under `~/.claude/tools/`,
seeds `model-map.system.json` + `model-map.overrides.json`, and registers
hooks in `~/.claude/settings.json`. There's no inverse — to fully uninstall,
a user has to manually figure out what was added and undo it.

Standard convention (matches dotfiles repos, brew-style projects, common
GitHub-distributed CLI tools): provide an `uninstall.sh` (or
`scripts/uninstall.sh`) at repo root that reverses every action of
`install.sh`.

What it should remove:
1. **Symlinks in `~/.claude/tools/`** that were created by install — only
   ones whose target points back into the c-thru repo (don't blow away
   unrelated tools the user manually placed there).
2. **`~/.claude/model-map.json`** (the merged effective config — it's
   regenerated by install).
3. **`~/.claude/model-map.system.json`** (install-time copy — not the
   user's data).
4. **NEVER `~/.claude/model-map.overrides.json`** — that's the user's
   data, preserved across re-installs and should be preserved across
   uninstall too. Print a "your overrides preserved at PATH" message.
5. **Hook entries in `~/.claude/settings.json`** that point at c-thru
   tools (`c-thru-session-start.sh`, `c-thru-proxy-health.sh`,
   `c-thru-map-changed.sh`, `c-thru-classify.sh`, etc.). Use `jq` to
   surgically delete those entries while preserving any user-added hooks.
6. **Stop running proxy** (`pkill -f claude-proxy` after a graceful
   `kill -TERM <pid>` from `proxy.pid`) so the next session doesn't have
   a zombie proxy.
7. **Cache/state files**: `proxy.pid`, `proxy.log`, `usage-stats.json`,
   `.prepull-stamp-*`, `ollama-prep-state.json`, `c-thru-ollama-models.json`.
8. **PATH edits in shell rc** if the install-PATH TODO above was
   implemented — remove the c-thru block matching the install marker.
9. **Models pulled by c-thru** — only opt-in via flag (`--purge-models`),
   since those are large and the user might want to keep them. Use
   `c-thru-ollama-gc purge` for this.

UX:
- Default mode: print what will be removed, prompt for confirmation, then act.
- `--yes` / `-y`: skip the confirm prompt (for scripts).
- `--dry-run`: print everything that WOULD be removed without doing it.
- `--purge-models`: also delete the Ollama models c-thru pulled.
- Final message: "uninstall complete. Your overrides at
  ~/.claude/model-map.overrides.json preserved." Plus `git remove` /
  `cd .. && rm -rf c-thru` instructions for the user to remove the repo
  itself if desired.

The contract-checker should also test `install.sh && uninstall.sh` is a
no-op on the user's `~/.claude/` directory (modulo the overrides file
which stays).

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

**[fallback] Bump max hops to ~20 + add backend-failure cooldown cache**
Two related improvements to runtime fallback:

1. **Bump `CLAUDE_PROXY_MAX_FALLBACK_HOPS` default from 3 → 20.** Long
   chains are legitimate when users build redundancy across many
   providers (anthropic → openrouter → bedrock → vertex → glm-cloud →
   local-large → local-medium → local-small → ...). 3 was a
   conservative starting cap; bump it now that the cycle detector is
   load-bearing and well-tested.

2. **Skip-recently-failed cache.** If we bump the cap to 20, the
   pathological case is "primary just failed, dispatcher walks 19
   targets again next request, all of which are still down." Need a
   short-lived `failed_backends` Map keyed by backend id with a TTL
   (e.g. 60s) so subsequent requests skip targets we just learned
   are down.

   **CRITICAL constraint: never cooldown the terminal node of a chain.**
   If a chain is A→B→C→D (D has no `fallback_to`), D must always be
   retried. Otherwise: D fails once, gets cooldowned, every
   subsequent request walks A→B→C→D-skipped → no targets remain →
   request fails entirely. The cooldown cache becomes a footgun that
   makes the system MORE broken than no fallback at all.

   The rule: a backend is cooldown-eligible only if it has a
   `fallback_to` AND that fallback resolves to a non-cooldown'd
   target. The terminal of any chain (whether explicitly designated
   as the final hop, or the last reachable node after cooldown
   skipping) is always tried, even if it just failed.

   ```js
   // module-scope
   const FAILED_BACKEND_TTL_MS = numberFromEnv('CLAUDE_PROXY_FAILED_BACKEND_TTL_MS', 60000);
   const failedBackendUntil = new Map();  // backend.id → timestamp_ms_to_skip_until

   // in tryFallbackOrFail, before resolving the next hop:
   if (failedBackendUntil.has(resolved.backend.id)) {
     const until = failedBackendUntil.get(resolved.backend.id);
     if (Date.now() < until && resolved.backend.fallback_to) {
       // Has a fallback target — safe to skip and descend.
       ctxLog(ctx, 'fallback.skip_cooldown', { backend: resolved.backend.id, expires_in_ms: until - Date.now() });
       backend = resolved.backend;  // continue into THIS backend's fallback_to
       continue;
     } else if (Date.now() < until) {
       // Terminal node — don't skip, retry even if recently failed.
       ctxLog(ctx, 'fallback.retry_terminal', { backend: resolved.backend.id, in_cooldown: true });
     }
     if (Date.now() >= until) failedBackendUntil.delete(resolved.backend.id);
   }

   // in the failure handlers (up.on('error'), non-200 with non-recoverable status):
   // Only cooldown if this backend has a fallback — never cooldown a terminal.
   if (backend.fallback_to) {
     failedBackendUntil.set(backend.id, Date.now() + FAILED_BACKEND_TTL_MS);
   }
   ```

   Skip semantics: when a fallback target is in the cooldown set
   AND has a fallback_to of its own, transparently descend into
   THAT target's fallback_to instead of trying it. So a chain
   A→B→C→D where B is cooling down becomes effectively A→C→D for
   the cooldown window — but D, as terminal, never enters cooldown.

   On success: clear that backend's cooldown entry (it's healthy
   again). On any new failure: refresh the entry's TTL (only if
   the backend has a fallback — terminals stay uncooldown'd).

3. **Global default model is the ultimate last-resort fallback.**
   Distinct from per-backend `fallback_to` chains — `routes.default`
   in model-map.json acts as the system-wide safety net. If a
   request's declared chain runs out (no `fallback_to` configured,
   or chain exhausted, or all hops in cooldown AND terminal also
   just failed), try the global default before surfacing the error
   to the client.

   The mental model is three tiers:
   ```
   Tier 1: per-backend fallback_to chain (user's declared graph)
   Tier 2: skip-cooldown'd intermediate nodes (transparent shortcut)
   Tier 3: global default model (catches anything that falls off
           the end of every declared chain)
   ```

   Implementation: after `tryFallbackOrFail` exhausts the configured
   chain (depth cap hit / cycle detected / terminal-and-cooldown'd /
   no fallback_to set), make ONE more attempt against the model
   resolved by `routes.default` — but only if the default's resolved
   backend isn't already in the visited set for this request (to
   avoid re-trying the same target twice).

   The default-model fallback ALSO never enters cooldown. It's the
   absolute terminal of the system. If even the default fails, the
   client gets the error — but only after the proxy has genuinely
   exhausted every path.

   ```js
   // Inside tryFallbackOrFail, after all per-backend options exhausted:
   if (chain.size > 0 && CONFIG.routes?.default) {
     const defaultModel = CONFIG.routes.default;
     const defaultResolved = resolveBackend(defaultModel, CONFIG, requestMeta.hwTier, requestMeta.activeMode);
     if (!defaultResolved.error && !chain.has(defaultResolved.backend.id)) {
       ctxLog(ctx, 'fallback.global_default', { default_model: defaultModel, resolved_backend: defaultResolved.backend.id });
       chain.add(defaultResolved.backend.id);
       body.model = defaultResolved.effectiveModel;
       if (defaultResolved.backend.kind === 'ollama') {
         forwardOllama(ctx, req, res, body, defaultResolved.backend, defaultResolved.effectiveModel, requestMeta);
       } else {
         forwardAnthropic(ctx, req, res, body, defaultResolved.backend, defaultResolved.effectiveModel, requestMeta);
       }
       return true;
     }
   }
   return false;  // genuinely nowhere left to go
   ```

   Importantly: this means EVERY request, even one with no
   `fallback_to` configured anywhere, gets a free retry on the
   global default if the primary fails. The user-facing contract
   becomes: "as long as `routes.default` resolves to a working
   model, your request will get answered."

4. **Probe semantics for cloud backends.** Cloud failures (auth-class)
   shouldn't necessarily put a backend in cooldown — they're
   permanent until config changes. Network/5xx-class failures should.
   Ranking the failure types and only adding to cooldown for transient
   ones avoids a "subscription missing" turning into "perpetually skip
   cloud."

5. **Bound the failure cache size.** A misbehaving config could keep
   adding new transient failures and grow the Map. Cap at, say, 100
   entries with LRU eviction. Realistic configs have <10 backends so
   100 is way headroom.

6. **Surface in /c-thru/status.** Add `cooldown_backends: [...]` to
   the response so users can see at a glance which backends the proxy
   is currently routing around. Also surface the `routes.default`
   resolution so users see what the absolute last-resort target is.

Why this matters: at 20-hop default, a fully-broken primary causes
20 requests' worth of latency (TTFT × 20 = 220s) on the FIRST
request. Without cooldown, the SECOND request through the same
primary also burns 220s. With cooldown, second request skips the
cooling-down target and goes straight to the next healthy hop —
~11s instead of 220s.

**[ollama] Separate "first response" timeout from total timeout**
Today `OLLAMA_UPSTREAM_TIMEOUT_MS` (default 5min) is a single timer
covering the entire request lifecycle — connect, send, response, and
all streaming bytes. Want to fail fast if Ollama can't even start
generating: target ~11s for first-byte/first-chunk, but keep the long
total-timeout for actual generation runs.

Two distinct cases:
1. **Cold/loading**: Ollama is loading the model from disk → VRAM.
   First chunk can legitimately take 5-30s for big models. We don't
   want to abort on these.
2. **Stuck/down**: Ollama daemon is unreachable, model can't be loaded
   (OOM, missing tag), or the upstream chat endpoint is hanging
   waiting on something. First chunk never arrives. **This is what
   we want to detect quickly** so the client (Claude Code) can fall
   back, retry, or surface the failure.

These cases share the same observable shape (no bytes from upstream
yet) but with very different healthy/unhealthy boundaries. The trick:
distinguish "model is loading" from "Ollama is broken."

**Implementation sketches:**

A. **TTFT (time-to-first-token) timeout** = ~11s. Track when the first
   chunk arrives via the existing `ollama.stream.first_chunk` event.
   If first_chunk hasn't fired by 11s AND the model isn't actively
   loading, abort. Detection-of-loading: poll `/api/ps` or check the
   request response (Ollama returns `loading` events in some flows).
   Cleaner: use `/api/show` to check model size + estimate cold-load
   time before even firing the chat request, and pick the timeout
   accordingly.

B. **Two-tier watchdog**: 11s "fast-fail-if-no-bytes-AND-no-load-evidence"
   + 5min "total upstream lifetime". If 11s hits and no chunks have
   arrived, check `/api/ps` — if the target model is in
   `loading`/`starting` state, extend timeout to total. Otherwise
   abort with `timeout_error` shape.

C. **Header-only first response**: `up.setTimeout(11000)` rearms on
   socket activity (data flowing); but `upRes` only fires once the
   FIRST byte arrives. Set a separate one-shot timer between
   `up.write()` and `upRes` callback. If `upRes` doesn't fire in 11s,
   destroy. Once it fires, switch to the existing `lastChunkAt`
   stall watchdog.

C is the simplest and matches real fallback semantics — "if Ollama
can't even respond with HTTP headers in 11s, give up." Pull off via:
```js
let ttftTimer = setTimeout(() => up.destroy(...), TTFT_TIMEOUT_MS);
const up = http.request(..., upRes => {
  clearTimeout(ttftTimer);  // first response received, switch to stall watchdog
  ...
});
```

Add `CLAUDE_PROXY_OLLAMA_TTFT_MS` env var (default 11000) so users
can tune. The runtime upstream-fallback (commit 66e3a71) will then
fire faster on Ollama-down scenarios — the user gets a clean fallback
in 11s instead of waiting 5min.

**[ollama] Treat Ollama cloud models like local models with fallback**
Ollama supports `:cloud`-suffixed models (e.g. `glm-5.1:cloud`,
`deepseek-v4-flash:cloud`, `kimi-k2.6:cloud`) that route to Ollama's
hosted infrastructure rather than the local runner. Most users won't
have an Ollama subscription, so a `:cloud` model invocation will fail
with auth errors (or 404, depending on Ollama's gating).

The runtime upstream-fallback feature (commit 66e3a71) handles this
for the `anthropic` backend kind via `backends.anthropic.fallback_to`,
but Ollama cloud models route through `kind: ollama` to the same
`localhost:11434`. The local Ollama daemon then proxies the cloud
call. Failure cases:
- User has no Ollama account / not signed in → cloud model returns
  401/403/404 from `localhost:11434`. The proxy currently surfaces
  this as an error to Claude Code.
- User has an account but the cloud model isn't on their plan →
  same failure shape.
- Network down → `localhost:11434` returns network error from its
  upstream call.

**Goal**: when an Ollama cloud model fails, fall back to the
configured local default for the same capability tier. Three sub-tasks:

1. **Detect cloud-model failures** specifically. Ollama's error body
   for "you need a subscription" looks different from "model not
   pulled" or "GPU OOM" — the proxy needs to disambiguate so we only
   fall back on subscription/auth-class failures, not GPU-OOM (which
   means "stop launching this on cloud, but not 'no subscription'").

2. **Wire `fallback_to` for ollama backends.** Currently the
   `tryFallbackOrFail` machinery is attached only to `forwardAnthropic`
   (commit 66e3a71). Mirror it into `forwardOllama` for cloud-model
   failures: re-resolve through the user's local default for the
   same capability.

3. **Mark cloud models in the model-map as auto-fallback candidates.**
   Either via a flag (`backend.kind: 'ollama-cloud'` to distinguish
   from local Ollama) or a model-name heuristic (`/:cloud$/` pattern).
   The ollama_local backend currently doesn't differentiate
   `qwen3.6:35b` from `glm-5.1:cloud` — the proxy treats both as
   talk-to-localhost-11434.

The `:cloud` model UX needs to "just work" without a subscription —
falling back to a comparable local model preserves the contract
("this capability runs SOMEWHERE") even when the cloud option isn't
available.

**[review] Senior-engineer review of `tools/claude-proxy`**
The proxy has accumulated significant complexity through this session
(observability layer, mode-conditional routing, Anthropic SSE fidelity
state machine, runtime upstream fallback with cycle detection,
debounced async usage stats, request-correlated logging, hard-stall
watchdog, content-length-scrub for body rewrites). It's now ~1000+
lines doing real work and worth a fresh senior-engineer pass that's
NOT just incremental review of recent diffs.

What such a review should produce:
1. **Architecture diagram**: client → dispatch → resolveBackend →
   forwardOllama / forwardAnthropic → response shaping → client. Show
   the cycle-detection sets, fallback chain, observability ctx, and
   where each layer's invariants live. Currently spread across the
   file with no high-level map.
2. **Single-responsibility audit**: identify functions with >1 reason
   to change. `forwardOllama` is ~250 lines doing translation +
   streaming + state machine + pings + watchdog + usage. Likely
   should be 3-4 smaller functions (or a class) for clarity.
3. **Magic numbers**: 120000ms watchdog, 15000ms ping, 5000ms stall,
   5000ms debounce, 256KB usage buffer, 8 cycle-depth, 60m keep_alive,
   65536 num_ctx, 5min upstream timeout. Promote to named constants
   at top of file with comments justifying each value.
4. **Test coverage gaps**: anthropic backend is only smoke-tested
   (proxy-streaming.test.js has 5 pre-existing failures). Add
   coverage for: streaming Anthropic happy path, usage extraction
   from SSE, mid-stream error event, content-length scrub.
5. **Backwards-compat paths**: anything we're carrying for older
   Claude Code versions or model-map schemas? Document or remove.
6. **Failure mode ranking**: list every code path that calls
   `sendAnthropicError` or writes a non-200, and verify the
   response shape is faithful to the real Anthropic API.
7. **Concurrency review**: shared mutable state — persistentUsage,
   GLOBAL_CONFIG, UNRECOGNIZED_CLI_FLAGS, the fallback chain Set per
   request. Are there any cross-request leaks?
8. **Dead-code sweep** (post-removal of the warmup machinery): is
   anything else unused since the simplification? Re-grep for orphans.

Acceptance: a written review document (~500-800 words) covering
the eight points above, plus a prioritized list of suggested
refactors (none required to land, but each scored low/medium/high
on payoff and effort).

**[config] Pollution-detection follow-ups (from senior-eng review of cleanup helper)**
The `--detect-pollution` / `--clean-pollution` mode in `tools/model-map-config.js`
(commit closing the CRITICAL pollution bug) was approved by senior-eng review
with five gap-followups worth filing:

1. **Widen detection beyond `model_routes`.** Current scan only checks
   `model_routes` for drift. A polluted profile could equally leak
   `agent_to_capability`, `llm_profiles`, `backends`, or `model_overrides`
   entries. Either widen detection to all top-level keys, or document
   the limitation in the helper's header.
2. **Auto-surface pollution at session start.** Users with legacy
   pollution will never run `--detect-pollution` unsolicited. Add a
   one-line drift check to `c-thru-session-start.sh` (existing SessionStart
   hook, silent on happy path) that emits a single advisory when leaks
   detected.
3. **Warn on missing `model-map.system.json`.** `repoDefaultsPath()` falls
   back silently if the system file is absent. Print a stderr warning so
   broken installs surface.
4. **Test coverage.** Add `test/model-map-pollution.test.js` with a
   profile containing 2 leaked routes; assert detect/clean behavior +
   strict-mode exit codes.
5. **`--detect-pollution --strict`** for CI: exit 1 when drift is found.
   Currently returns 0 either way.

**[learning] Reusable patterns from session work (from senior-eng review)**
Key patterns identified during the cleanup-helper review that are worth
extracting and reusing:

1. **`detectConfigDrift(canonical[], actual)` utility.** The "anything in
   derived not in (canonical sources) is drift" pattern applies to
   `~/.claude/settings.json` vs system+local, agents/ files vs source
   manifest, etc. Extract a generic helper.
2. **`--detect-X` / `--clean-X` twin-flag CLI convention.** Dry-run that
   prints the exact apply command is good UX. Standardize across all
   destructive helpers in `tools/` (e.g. `c-thru-ollama-gc.sh sweep`
   currently lacks dry-run; should gain one).
3. **"Rebuild, don't patch" derived files.** When cleaning the profile,
   we re-sync from canonical sources rather than `delete`-ing keys.
   Guarantees byte-identical state to fresh install. Worth a wiki entry
   in `wiki/entities/declared-rewrites.md` as the canonical rule for
   any derived/cached file.

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
