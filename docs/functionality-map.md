# c-thru Functionality Map

> **Canonical capability hub.** One row per key capability, organized by subsystem, with the entrypoint
> (CLI flag / env var / config key / hook event / function) and a link to the authoritative detail doc.
> This is a hub — it does **not** restate the detail docs; it points at them. For per-capability
> implementation/test verdicts and known gaps see [functionality-verification.md](functionality-verification.md);
> for the file-level reverse audit (what's live vs orphan) see [orphan-disposition.md](orphan-disposition.md).
>
> Status legend: **full** = implemented + working · **partial** = works but with a known gap · **stub** =
> declared, returns not-implemented · **absent** = documented elsewhere but not in code.
> Line refs are to the working tree; treat them as approximate anchors, not contracts.

## Subsystem index

1. [Launcher / CLI](#1-launcher--cli-toolsc-thru) — `tools/c-thru`
2. [Injection layer](#2-injection-layer-user-design-priority) — how config reaches the spawned `claude` + proxy *(conformance audit)*
3. [Proxy / wire translation](#3-proxy--wire-translation-toolsclaude-proxy) — `tools/claude-proxy`
4. [Backend routing & fallback](#4-backend-routing--fallback)
5. [Model-map config system](#5-model-map-config-system)
6. [Agents & skills](#6-agents--skills)
7. [Hooks](#7-hooks)
8. [Auth & connectivity](#8-auth--connectivity)
9. [Observability & ops](#9-observability--ops)
10. [Headers (`x-c-thru-*`)](#10-headers-x-c-thru-)
11. [Plugin / install](#11-plugin--install)
12. [Architecture diagrams](architecture-diagrams.md) — visual flow view of 6 key sequences
    (CLI launch, model resolution + fallback, wire translation, hook lifecycle, wave lifecycle,
    config layering), each with verified file:line grounding

---

## 1. Launcher / CLI (`tools/c-thru`)

The bash launcher parses c-thru flags, resolves a backend, injects the backend's env/args, spawns the
proxy if needed, and `exec`s the real `claude` binary. Detail: README Appendix B + `c-thru help`.

| Capability | Entrypoint | Status | Impl |
|---|---|---|---|
| c-thru flag parse + strip-before-forward | `build_forwarded_args()` | full | `tools/c-thru:3567`, `:4187` |
| `--route <name>` (named model-map route) | `resolve_routes_graph` | full | `tools/c-thru:4271` |
| `--model <name>` (per-invocation override) | `--model=` forwarded arg | full | `tools/c-thru:3608` |
| `--mode <m>` + synonyms (`--local-only`/`--offline`/`--best-cloud`/…) | `export CLAUDE_LLM_MODE` | full | `tools/c-thru:4191` |
| `--profile <tier>` / `--memory-gb` (force HW tier) | `CLAUDE_LLM_MEMORY_GB` | full | `tools/c-thru:485` |
| `--bypass-proxy` (talk to api.anthropic.com directly) | `CLAUDE_PROXY_BYPASS=1` | full | `tools/c-thru:4290` |
| `--thinking` / `--journal` / `--debug` / `--no-update` / `--no-agents` toggles | env exports | full | `tools/c-thru:4203` |
| Backend selection (5-tier lookup chain) | backend lookup | full | `tools/c-thru:4419` |
| Capability/agent alias → concrete model | `tools/c-thru-resolve` (node) | full | `tools/c-thru-resolve:1` |
| Invoke real `claude` (`exec env VAR=… claude …`) | `run_real_claude` | full | `tools/c-thru:3520` |
| Subcommands: `list`/`explain`/`reload`/`restart`/`stats`/`check-deps`/`help` | `cmd_*` | full | `tools/c-thru:449+` |

---

## 2. Injection layer (USER DESIGN PRIORITY)

**Design principle:** configuration must reach the spawned `claude`/proxy **inline** — env vars, CLI
flags (`--model`, `--settings`, `--agents`, `--append-system-prompt`), in-memory — and **avoid
file-based** mechanisms. This section is the conformance audit of that principle.

**Verdict: the design conforms.** Of 12 injection points plus 1 explicit pass-through, **11 are inline/ephemeral-env/CLI or unavoidable
runtime IPC; 1 is necessary directory-level isolation; 0 are avoidable file writes** (the lone avoidable
one, #10, was converted to an inline `--settings` JSON string).

| # | What is injected | Mechanism | Class | Loc | Necessary / Avoidable |
|---|---|---|---|---|---|
| 1 | `ANTHROPIC_BASE_URL` (provider base) | `export` env | INLINE | `tools/c-thru:4337` | necessary |
| 2 | `ANTHROPIC_AUTH_TOKEN` (route / lifted OAuth) | `export` env | INLINE | `:4351`, `:1405` | necessary |
| 3 | `ANTHROPIC_API_KEY` (route / placeholder) | `export` env | INLINE | `:4359`, `:1421` | necessary |
| 4 | Arbitrary backend `env` JSON keys | `export -- k=v` loop | INLINE | `:4363` | necessary |
| 5 | `CLAUDE_CODE_*` feature/colour flags | `exec env VAR=…` | INLINE | `:3532` | necessary |
| 6 | Model selection | `--model=<m>` CLI arg | INLINE | `:3640` | necessary |
| 7 | `--dangerously-skip-permissions` (user-supplied only; not injected) | CLI arg passthrough | PASSTHROUGH | `:3709` | not an injection |
| 8 | System-info + proxy URL + `/no_thinking` | `--append-system-prompt` CLI arg | INLINE | `:3658` | necessary |
| 9 | `CLAUDE_MODEL_MAP_PATH` → proxy | `env VAR=… claude-proxy` at spawn | INLINE (passes a path, writes nothing) | `:1854` | necessary |
| 10 | Per-session settings (c-thru hooks/permissions additively merged and deduped with user settings; MCP injected; caller `--settings` reconciled with proxy-key warnings) | JSON built in-memory → `--settings <json>` CLI arg | INLINE arg | build `:410`, flag `:3659` | necessary (converted from a temp-file write) |
| 11 | **Ephemeral session dir** shadowing `~/.claude` | **`mktemp -d` + symlinks/cp** → `CLAUDE_CONFIG_DIR` | **FILE-BASED** | `:246` | necessary (isolation) |
| 12 | `--agents <json>` | CLI arg (JSON built from agent `.md`) | INLINE arg | `:3668` | necessary |
| 13 | `proxy.pid` + ready FIFO + startup log | files in profile dir | FILE-BASED (runtime IPC) | `:1848` | necessary (process IPC) |

- **#10 was the one avoidable file write — now converted.** `write_ephemeral_settings` tolerantly reads user
  `settings.json`, additively merges/dedupes hooks and permissions while passing through other preference keys
  except its c-thru/proxy denylist, and reconciles caller `--settings` payloads (warning per rejected proxy-owned
  key) into the `EPHEMERAL_SETTINGS_JSON` shell var. `build_forwarded_args` passes it inline as `--settings "$json"`
  — the flag accepts "a JSON file path **or** a JSON string" (verified against Claude Code 2.1.177), so nothing
  is written to disk. This mirrors the existing inline `--agents "$json"` (#12). Covered by
  `test/cli-e2e-flags.test.js` Test 18 (the inline arg parses and has the expected SessionStart-hook shape) and
  Test 20 (the durable `~/.claude/settings.json` stays byte-identical and mtime-unchanged across a launch).

  `install.sh`'s `cleanup_old_persistent_config()` removes only hook commands prefixed by its `$TOOLS_DEST`
  (normally `~/.claude/tools/`), deliberately leaving user-authored repo-path mirrors alone; in c-thru sessions
  merge dedup prevents those mirrors from double-firing, while their plain-`claude` behavior remains user-owned
  and fail-open. `permissions.defaultMode` passes through verbatim from user settings and, at settings/flag
  precedence, outranks project settings by design rather than as a c-thru routing decision.
- **#11 is genuinely not avoidable.** This is per-session filesystem *isolation* — shadowing `~/.claude`
  so injected agents/skills/settings don't pollute the durable profile — not user-supplied config. Claude
  Code reads a whole `CLAUDE_CONFIG_DIR`; there is no inline equivalent for "a directory." The
  effective(shadow) vs original(durable) split (`cthru_effective_profile_dir` / `cthru_original_profile_dir`,
  `tools/c-thru-lib.sh:74`) is the deliberate encoding of this. Since #10 went inline, the only file
  *content* placed inside the dir is an additive copy of `~/.claude.json` (line 253, to silence a
  config-not-found warning); everything else is symlinks to the user's real files.

Detail: `docs/subscription-auth.md` (auth env), `docs/env-vars.md` (the full env surface).

---

## 3. Proxy / wire translation (`tools/claude-proxy`)

A local HTTP server (~4900 lines) that intercepts Claude Code's API traffic and forwards to the resolved
backend, translating wire shapes where the backend isn't Anthropic-native. Detail:
`docs/anthropic-api-coverage.md`, `docs/headers.md`. Visual dispatch-fork view:
[architecture-diagrams.md § 3](architecture-diagrams.md#3-wire-translation-dispatch-v1messages).

| Capability | Trigger | Status | Impl |
|---|---|---|---|
| Request interception (`/v1/*`, `/c-thru/*`) | HTTP server | full | `tools/claude-proxy:4653` |
| CLI flag parsing (`--flag value` / `=`) | `process.argv` | full | `parseCliFlags:57` |
| **Translation: Anthropic passthrough** (also covers modern `kind:"ollama"` — Ollama 0.4+ serves an Anthropic-shaped `/v1/messages`) | default | full | `forwardAnthropic:1900` |
| **Translation: Anthropic⇄Ollama-legacy** | `format:ollama-legacy` | full (lossy by design — text only) | `forwardOllamaLegacy:4244` |
| **Translation: Anthropic⇄Gemini** (req+stream+non-stream, tool_use/thinking/thoughtSignature/schema-scrub) | `call_style:gemini` | full | `mapAnthropicToGemini:3960`, `forwardGemini:3177` |
| **Translation: Anthropic⇄OpenAI** | `call_style:openai` | **stub (501)** | `tools/claude-proxy:5271` |
| **Translation: Bedrock** | — | **absent** | n/a |
| Vertex (Gemini-over-Vertex URL/auth; no SigV4) | `backend.vertex:true` | full (Gemini reuse) | `tools/claude-proxy:3142` |
| Streaming (Ollama ndjson → Anthropic SSE) + watchdogs (TTFT/stall/wall/ping) | `stream:true` | full | `setupOllamaStream:2207` |
| Usage recording (debounced 5s, lock + atomic rename) | every success | full | `recordUsage:556` |
| Journaling (per-request JSONL) | `CLAUDE_PROXY_JOURNAL=1` | full | `shouldJournal:742` |
| Gemini Files API (`/v1/files`) | `/v1/files` | full (AI Studio; Vertex 501) | `tools/claude-proxy:2807` |
| Anthropic catch-all (`/v1/me`, `/v1/organizations`) | unhandled `/v1/*` | full | `forwardToAnthropicCatchAll:1275` |

---

## 4. Backend routing & fallback

Multi-stage resolution with cooldowns and layered fallback. Detail: `docs/model-map.md`,
`docs/connectivity-modes.md`.

| Capability | Trigger | Status | Impl |
|---|---|---|---|
| Backend resolution (exact/regex/mode-object/v2-alias/`@`-sigil/capability/`model:`-pin) | every `/v1/messages` | full | `resolveBackend:975` |
| Resolution cycle/depth guard (`_seen` + depth 8 → 400) | recursion | full | `tools/claude-proxy:987` |
| Ollama default fallback (unless `C_THRU_STRICT_MODELS=1`) | unrouted model | full | `tools/claude-proxy:1085` |
| Per-backend fallback chain (`fallback_to`, cooldown-skip, cross-dispatch guard) | upstream failure | full | `tryFallbackOrFail:1525` |
| Capability `fallback_chains[tier][cap]` (quality-tolerance reorder) | chain exhausted | full | `tools/claude-proxy:1614` |
| Global default fallback (`routes.default`) | all chains exhausted | full | `tryGlobalDefaultFallback:1655` |
| Cloud→local rewrite (`:cloud` 401/404 → local model, fires once) | Ollama `:cloud` error | full | `tryOllamaCloudLocalFallback:1458` |
| Backend cooldown cache (TTL skip; permanent 401/403/404 never cooled) | post-failure | full | `tools/claude-proxy:157` |

---

## 5. Model-map config system

`config/model-map.json` + `tools/model-map-*.js`. The "3 tiers" are config **layers** (defaults → global
overrides `~/.claude/model-map.overrides.json` → project `$PWD/.claude/model-map.json`), deep-merged.
Detail: `docs/model-map.md`, `docs/hardware-profile-matrix.md`.

| Capability | Entrypoint | Status | Impl |
|---|---|---|---|
| Layered load + deep-merge (defaults→overrides→project) | `loadLayeredConfig` | full | `tools/model-map-layered.js:155` |
| `llm_profiles[capability][mode][hw-tier]` resolution (20 caps, 5 modes) | `resolveProfileModel` | full | `tools/model-map-resolve.js:67` |
| agent→capability alias (2-hop, unknown→passthrough) | `resolveCapabilityAlias` | full | `tools/model-map-resolve.js:160` |
| llm_mode precedence resolution (env→config→autodetect→best-cloud) | `resolveLlmMode` | full | `tools/model-map-resolve.js:101` |
| Active HW-tier resolution (env→config→RAM→`tierForGb`) | `resolveActiveTier` | full | `tools/model-map-resolve.js:144` |
| Gov Chinese-origin model filter (gov modes) | `applyModeFilter` | full | `tools/model-map-resolve.js:246` |
| Validation (schema + auth/url warnings) | `model-map-validate.js` | full | `tools/model-map-validate.js:886` |
| Edit CLI (JSON edit-spec, deep-merge + validate) | `model-map-edit.js` | full | `tools/model-map-edit.js:235` |
| Pollution detect/clean (project entries leaked into profile) | `--detect-pollution`/`--clean-pollution` | full | `tools/model-map-config.js:260` |
| apply-recommendations (inject `recommended-mappings.json`) | — | **removed/retired** (was a permanent no-op; see verification) | n/a |
| `/hooks/context` prompt-submit injection (short control-plane when `prompt` set; long on SessionStart/PreCompact) | `c-thru-classify.sh` / session-start / postcompact → proxy | full *(no LLM classify; body-shape event-split)* | `tools/claude-proxy` `buildHooksContextAdditional` |
| Dynamic role classifier (`CLAUDE_PROXY_CLASSIFY`) | — | **absent (retired surface)** | never implemented; design docs under ARCHIVE banner |

---

## 6. Agents & skills

22 routable agents under `agents/*.md` (each `model:` = its own name), routed by the
`agent_to_capability` map (25 entries) via a CLI-only PreToolUse hook. Detail: `docs/agent-architecture.md`,
`docs/agent-authoring.md`.

- **Routing:** `tools/c-thru-agent-router-hook.sh` rewrites `Agent` tool `model` from `subagent_type` via
  `agent_to_capability` (`config/model-map.json:642`) — workaround for claude-code #44385. Non-LLM tools
  (WebSearch/WebFetch/Monitor/Plan) pass through with logging only.
- **Roster (22):** planner, planner-hard, explore, coder, coder-fallback, tester, docs, code-reviewer,
  reviewer-security, reviewer-plan, plan-scheduler, debugger-hypothesis, debugger-investigate,
  debugger-hard, vision, pdf, writer, edge, generalist, fast-generalist, fast-scout, long-context.
- **Public skills (3, shipped in plugin):** `c-thru-config`, `c-thru-control`, `c-thru-plan`.
- **Dev/internal skills (not shipped in plugin):** `logical-gearbox`, `review-fix`, `review-plan`,
  `update-model-research`. (The dead `competitive-evolution` / `concurrent-evolution` skills and
  `agents/src/supervisor.md` — the un-removed second half of `7b097ca` — were deleted in this audit;
  see [orphan-disposition.md](orphan-disposition.md).)

---

## 7. Hooks

Installed two ways: plugin (`plugins/c-thru/hooks/hooks.json`) and CLI-ephemeral (settings heredoc). Drift
guarded by `test/hooks-declaration-parity.test.js`. Visual event→hook view:
[architecture-diagrams.md § 4](architecture-diagrams.md#4-hook-lifecycle).

| Hook | Event | What | Impl | Registered |
|---|---|---|---|---|
| session-start | SessionStart | Probe proxy+Ollama, inject context, GC sweep | `c-thru-session-start.sh` | hooks.json + ephemeral |
| proxy-health | UserPromptSubmit | Curl `/ping`; advisory on down; **always exit 0** | `c-thru-proxy-health.sh` | hooks.json + ephemeral |
| classify | UserPromptSubmit | POST prompt to `/hooks/context` (short control-plane inject) | `c-thru-classify.sh` | hooks.json + ephemeral |
| map-changed | PostToolUse `Write\|Edit` | Re-validate model-map on edit | `c-thru-map-changed.sh` | hooks.json + ephemeral |
| postcompact-context | PreCompact | Re-inject routing context | `c-thru-postcompact-context.sh` | hooks.json + ephemeral |
| agent-router | PreToolUse `Agent` | subagent_type → capability model rewrite | `c-thru-agent-router-hook.sh` | **CLI-only** |
| enter-plan | PreToolUse `EnterPlanMode` | Advisory `/c-thru-plan` hint (never blocks) | `c-thru-enter-plan-hook.sh` | CLI-only + skill-managed |
| stop | Stop | One systemMessage per new fallback event via `GET /c-thru/recent` (`fallback_from`) | `c-thru-stop-hook.sh` | **manual/ephemeral** (semi-orphan — symlinked, not auto-registered) |

¹ **Round-5 rewrite:** stop-hook and statusline-overlay read the recent-requests ring
(`fallback_from` / `served_by`) rather than grepping dead `proxy.log` tags. Still not
auto-registered in hooks.json — operators opt in via ephemeral settings.

---

## 8. Auth & connectivity

All outbound auth in `applyOutboundAuth`/`deriveAuthProfile` (`tools/claude-proxy:~815`), surfaced via
`x-c-thru-auth-derived`. Fully implemented and documented. Detail: `docs/subscription-auth.md`,
`docs/connectivity-modes.md`, `docs/env-vars.md`.

| Capability | Entrypoint | Status |
|---|---|---|
| Claude subscription (OAuth Bearer, rejects x-api-key) | `anthropic_subscription` endpoint | full |
| bearer_priority / header_env / explicit_object / passthrough auth profiles | `applyOutboundAuth` | full |
| Gemini AI Studio vs Vertex discriminator | `backend.vertex` + host | full |
| OAuth lift (keychain → `ANTHROPIC_AUTH_TOKEN`, survives proxy hop) | `inject_subscription_oauth_from_store` | full |
| Connectivity autodetect (curl+ping, 2s) | `tools/model-map-resolve.js:47` | full |
| 5-mode enum (best-cloud / -cloud-oss / -local-oss / -cloud-gov / -local-gov; gov filters Chinese-origin) | `CLAUDE_LLM_MODE` | full |

---

## 9. Observability & ops

| Capability | Entrypoint | Status | Doc |
|---|---|---|---|
| Journaling (per-request JSONL) | `--journal` / `CLAUDE_PROXY_JOURNAL=1` | full (record-only Phase A) | `docs/journaling.md` |
| Usage stats + live dashboard (`/c-thru/dashboard`, `/status`, `/recent`) | `tools/proxy-dashboard.html` | full | `docs/headers.md` |
| Statusline + fallback overlay | `c-thru-statusline.sh`, `…-overlay.sh` | full | **undocumented** |
| Proxy-health CLI | `c-thru-proxy-health.sh` | full | CLAUDE.md:59 (fail-open, exit 0) |
| Hygiene-check (working-tree hazards) | `c-thru-hygiene-check.sh [dir]` | full | CLAUDE.md |
| HW-profile (`tierForGb` → 16/32/48/64/128gb) | `tools/hw-profile.js` | full | `docs/hardware-profile-matrix.md` |
| Ollama GC / probe | `c-thru-ollama-gc.sh`, `…-probe.sh` | full | partial / undocumented |

---

## 10. Headers (`x-c-thru-*`)

Single source of truth: `docs/headers.md` (stamped from `buildCthruResponseHeaders`, `tools/claude-proxy:~2090`).
Groups: **observability** (`dashboard`, `backend-latency-ms`, `auth-missing`, `auth-derived`,
`tier-detected`/`tier-used`), **routing** (`served-by`, `resolution-chain`, `resolved-via`,
`fallback-from`, `deprecated-model`), **cache** (`cache-status`, `user-id`), **translation gaps**
(`schema-scrubbed`, `redacted-thinking-dropped`, `translation-gap`, `beta-dropped`, `passthrough[-host]`),
**thinking** (`thinking-auto-enabled`, `thinking-level`, `thinking-tokens`).

---

## 11. Plugin / install

Plugin `c-thru` v0.2.0 (depends on planning-suite): 2 commands (`/c-thru-status`, `/cplan`), 3 skills, 5
hooks, bundled runtime tools + config. Detail: README, plugin README.

| Capability | Entrypoint | Status |
|---|---|---|
| install.sh (8 idempotent phases; `--skip-e2e`) | `bash install.sh` | full |
| uninstall.sh (reverses; preserves overrides) | `bash uninstall.sh [--dry-run\|-y\|--purge-models]` | full |
| sync-plugin-bundle.sh (15 source-of-truth artifacts → `plugins/c-thru/`; pre-commit gate) | `tools/sync-plugin-bundle.sh [--check]` | full |
| self-update (debounced ff-only git pull) | `c-thru-self-update.sh` | full |

---

## Known gaps & doc/code divergences

Summarized here, detailed with evidence in [functionality-verification.md](functionality-verification.md):

- **Bedrock is not a backend** (task #20 premise absent — would be a new feature, not a fix).
- **OpenAI translation is a 501 stub** (intentional).
- **Dynamic role classifier**: `docs/dynamic-classification-phase-a.md` says "shipped"; code is absent.
- **`recommended-mappings.json`**: capability names mismatched `llm_profiles` → apply was a permanent no-op; **feature retired in this audit** (config + tool + `--rec` flag removed).
- **`sessionEffectivePath`**: no collision/stale-file guard (negligible probability).
- **Doc bugs**: several ops tools undocumented (statusline/overlay, ollama gc/probe). *(proxy-health
  exit-2 claim — CLAUDE.md:59 + script comment — and `model-map.md`'s old tier-outer schema were both
  fixed in 0345fb8.)*
- **Dead file cluster (removed)**: supervisor / competitive-evolution / tournament / supervisor-benchmark
  — the un-removed second half of commit `7b097ca`, deleted in this audit (see
  [orphan-disposition.md](orphan-disposition.md)).
