# Fix plan — surfaced/deferred holistic-review findings

Plan for the 10 items left as "surfaced for decision" in `holistic-review-findings.md`. Each was
investigated live (read-only) by a per-item agent; verdicts + premises below. Grouped into batches by
risk/coherence. Recommended decision defaults are marked **(default)**; the genuinely user-facing choices
are called out under "Decisions to confirm" at the end.

## Batch A — security (behavior-changing; confirm posture first)

### C19 — agent-sentinel spoofing (confirmed; premise verified live)
Any `/v1/messages` body containing `[[c-thru-agent:<known-agent>]]` anywhere reroutes that request; with
`C_THRU_PROXY_ALWAYS` on, main-thread traffic (tool results, pasted text, fetched pages) can forge it.
**Fix:** per-session HMAC over the agent name + a first-message-position pre-filter.
- `tools/c-thru`: `export C_THRU_AGENT_HMAC_KEY=$(openssl rand -hex 32 || /dev/urandom)` once (next to `C_THRU_SESSION_ID`); both proxy and hook inherit it.
- `tools/c-thru-agent-router-hook.sh`: stamp `[[c-thru-agent:<name>:<hmac16>]]`.
- `tools/agent-sentinel.js`: parse optional `:<hmac>` group, return `{name, tag}` (widen `READ_WINDOW`→~80).
- `tools/claude-proxy`: honor a body marker only if `crypto.timingSafeEqual` verifies the HMAC (or it's at the start of the first user message under the key); else log `sentinel_rejected`.
- Risk medium / effort medium. Update `test/proxy-sentinel-detection.test.js` (return-shape change) + a proxy-level verify test.

### C23 — unauthenticated control plane (confirmed; premise verified live)
`POST /c-thru/mode` (process-wide mode flip), `/c-thru/reload`, `/c-thru/stats/clear` are unauthenticated on
the shared loopback port — any same-host process can flip a shared proxy out of gov mode.
**Fix:** a shared-secret control token. Launcher writes `~/.claude/proxy.control-token` (0600, mirrors
`proxy.pid`); proxy requires header `X-C-Thru-Control: <token>` on the **mutating** routes (read routes
`/ping`, `/status`, `/v1/active-models`, `/hooks/context` stay open). Bash callers (`c-thru-control.js`, `c-thru`) read the file and send the header.
- Risk medium / effort medium. Fail-closed (403) on mutating routes when token missing/mismatched **(default)**.

### C48 — reload silently degrades an orphaned gov mode (confirmed; premise verified live)
If a reload drops the pinned custom mode, `resolveLlmMode` degrades it to `best-cloud` with only a stderr
line — a silent gov downgrade.
**Fix:** on reload (and the fs-watcher path), if the active `CLAUDE_LLM_MODE` is no longer in `validModes`
and the outgoing snapshot says it was gov, **fail closed** for `/v1/messages` (refuse, prominent log) instead
of degrading; auto-clear when a later reload restores a valid mode. Non-gov orphan → keep degrade + loud log **(default)**.
- `tools/claude-proxy` reload handler + `tools/model-map-resolve.js`. Risk medium / effort medium.

## Batch B — correctness (low risk, recommendations clear)

### C30 — mid-request `_fallbackChain` reset (ADJUDICATED: finder right)
`CONFIG` is per-request-pinned via `configStorage.run(snapshot)` (claude-proxy:229-232, 4449-4450), so the
graph the hops traverse can't change mid-request; the `_configVersion !== CONFIG_VERSION` reset (~1588-1591)
is dead-to-harmful (it would wipe cycle detection). The G6 "it fires on reload" fact is true but doesn't
justify the code. **Fix:** delete the reset block + the orphaned `_configVersion` stamp; correct the wrong
comment. Risk low / effort small / **no behavior change** on the supported (pinned) path.

### C1 — bash profile leak (confirmed; premise verified — bash DOES pass the project path)
`sync_layered_profile_model_map` (c-thru:146) passes `_discovered_project_config` as the project tier,
merging project config into the **shared** `~/.claude/model-map.json` and defeating Node's two-pass design.
**Fix:** pass `''` for the project tier (mirror Node Pass 1), keeping the line-770 exit-code guard. Optionally
retire the now-dead `_discovered_project_config` export (model-map-config.js:259-264; c-thru:146 is its only
consumer). Risk low / effort small. Node-level regression test.

### C44 — terminal-fallback de-dup (confirmed)
`tryLocalTerminalFallback` de-dups a logical model name against the set of concrete (rewritten) names →
can re-dispatch an already-tried terminal. **Fix:** resolve `termModel` to its `effectiveModel` first, then
`triedM.has(effectiveModel)`. Risk low / effort small.

### C46 — explain↔proxy gov parity, with-chain case (confirmed)
`c-thru-explain` shows `served_by:(null)` for a gov-blocked primary even when the proxy walks
`fallback_chains` to a compliant model. **Fix:** in explain (single-capability + `--all` branches), call the
already-imported `applyModeFilter` over the chain and report the first compliant model with a "primary
gov-blocked" note. Risk low / effort small. Fixture test (shipped config has no fallback_chains).

## Batch C — validation / policy

### C35 — partial-tier → 503 (ADJUDICATED: keep, Option A)
A present-but-tier-incomplete mode object returns null→503 rather than cross-tier fallback. This is the
intended contract ("no mode does cross-TIER fallback"; `resolve-capability.test.js` case 5 codifies it, and
cross-tier fallback would break offline/gov guarantees). **Fix:** keep the 503; **tighten
`model-map-validate.js`** to catch a present-but-active-tier-missing mode object at config time (warn on
interior gaps, error on the pinned active tier missing). Risk low / effort small.

### C37 — validate llm_profiles models vs model_routes (confirmed; noise-checked)
An `llm_profiles` model with no route + no `@sigil` silently falls through to localhost Ollama. **Fix:** add a
**reachable-scoped WARN** in `validateCapabilityEntry` (not a hard error) accepting `model_routes` keys,
`re:` patterns, `@sigil`, capability aliases, `model:` pins, `claude-via-*` — verified to produce **zero new
warnings on the shipped config**. Risk low / effort small.

## Batch D — test gaps (after the above)

### C31 (partial — most closed by Batch 3) + C43
Batch 3 (`bb449e1`) already covers Gemini-no-`fallback_to`→routes.default (C9) and conn-error→502 (C11). Add
only the genuinely-uncovered cells: **C31a** (Gemini non-2xx, no `fallback_to`, capability `fallback_chains`)
and **C31c** (conn-error→routes.default). **C43** (SIGHUP mid-in-flight-cascade liveness) depends on C30 —
write it to assert the cascade still terminates (the behavior C30 leaves intact), with generous settle waits
(known proxy-spawn flake). Risk low / effort small.

## Sequencing
1. **Batch B** first (C30, C1, C44, C46) — low-risk, no posture decisions, clears the conflicted items.
2. **Batch C** (C35, C37) — validation tightening.
3. **Batch A** (C19, C23, C48) — security, after the posture decision is confirmed; each its own commit.
4. **Batch D** (C31a/C31c, then C43 once C30 lands).
Each item: source edit + test, `sync-plugin-bundle` for shipped files, `make test-fast` + contract-check, commit (explicit paths, local). Behavior-changing items (A, C1, C35, C48) get a docs note.

## Decisions to confirm (the only genuine forks)
1. **Security posture (C19/C23/C48):** fail-closed by default with an env/flag escape hatch (e.g.
   `C_THRU_AGENT_ALLOW_UNSIGNED=1`, missing-token-grace) for standalone-proxy / old-launcher / shared-daemon
   transition? **(recommended: fail-closed + documented escape hatch)** — this is the one big call; it can
   break a proxy started outside `c-thru` or an old launcher against a new proxy until both upgrade.
2. **C35:** confirm Option A (keep 503 + validate) over Option B (cross-tier fall-through). **(recommended: A)**
3. **Scope/order:** do all four batches now, or stage (e.g. B+C+D now, A after explicit sign-off)?
