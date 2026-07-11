# Architecture diagrams

Visual companion to [functionality-map.md](functionality-map.md) — that doc is the capability
*index*, this doc is the *flow* view for the six sequences most worth seeing end-to-end. Every
diagram has a **Grounding** list of file:line citations immediately below it, verified against
current code at write time. Per functionality-map.md's own convention: treat line numbers as
**approximate anchors, not contracts** — the surrounding function/file names are the durable part.

If you're updating one of these flows, update the diagram in the same commit (see
[`docs/review-methodology.md`](review-methodology.md) rule 9 — doc/code drift after a change is
the default expected outcome unless you actively prevent it).

---

## 1. CLI launch → proxy spawn → claude exec

```mermaid
flowchart TD
    A[c-thru invoked] --> B{native subcommand?<br/>agents / auth / mcp / update / ...}
    B -- yes --> Z1[exec real claude directly,<br/>bypass all routing]
    B -- no --> C[Phase 1 flag pre-parse<br/>cthru_flag_width resolves value-width]
    C --> D[setup_ephemeral_session:<br/>shadow HOME, build agents JSON]
    D --> E{explicit --model?}
    E -- yes --> F[MODEL = explicit_model]
    E -- no --> G{--route given,<br/>or routes.default present?}
    G -- yes --> H[resolve_routes_graph]
    G -- no --> I[MODEL empty]
    F --> J{MODEL resolved?}
    H --> J
    I --> J
    J -- no --> K{--bypass-proxy?}
    K -- yes --> Z2[exec real claude,<br/>talks to api.anthropic.com directly]
    K -- no --> L[transparent path:<br/>still calls build_forwarded_args]
    J -- yes --> M[backend lookup ladder:<br/>exact route -> pattern -> claude-* -> local Ollama]
    M --> N[ensure_proxy_running:<br/>mkfifo + spawn claude-proxy]
    N --> O{READY port received<br/>within timeout?}
    O -- READY_FAILED or timeout --> P[fail loud, non-zero exit]
    O -- READY port --> Q[write_ephemeral_settings:<br/>hooks + MCP JSON, in-memory only]
    Q --> R[build_forwarded_args:<br/>inject --settings --agents --append-system-prompt]
    L --> R
    R --> S[run_real_claude: exec the real claude binary]
```

**Grounding** (`tools/c-thru`, verified against the current file):
- Native-subcommand bypass: `~761-777`, `find_real_claude()` `~738-757`
- Phase 1 flag pre-parse: `~4495-4571`; shared width resolver `cthru_flag_width()` `:3799`
- `setup_ephemeral_session()` `:235`, call site `~4576-4577`
- Model resolution (explicit → route → `routes.default`): `~4585-4609`
- Transparent (no-model) path still routes through `build_forwarded_args`: `~4619-4658`
- Backend lookup ladder: `~4794-4924`
- `ensure_proxy_running()` `:1989` — `mkfifo` `:2024`, FIFO `READY <port>` read (45s default
  timeout) `:2048-2065`, `READY_FAILED`/malformed-line handling `:2053-2062`
- `write_ephemeral_settings()` `:362`
- `build_forwarded_args()` `:3828`
- `run_real_claude()` `:3740`

---

## 2. Model resolution + fallback cascade

```mermaid
flowchart TD
    A["resolveBackend(model, cfg, tier, mode)"] --> B{model_routes exact<br/>or re: pattern match?}
    B -- yes --> C[use matched backend<br/>pickModeTarget if mode-keyed]
    B -- no --> D{claude-via-X alias?}
    D -- yes --> E[synthesize alias -> real backend]
    D -- no --> F{"@backendId sigil?"}
    F -- yes --> G[self-routing to named backend]
    F -- no --> H{resolves via<br/>agent_to_capability?}
    H -- yes --> I["resolveProfileModel(entry, tier, mode)<br/>falls back to best-cloud if mode has no entry"]
    H -- no --> J["synthetic __ollama_fallback__<br/>(blocked if C_THRU_STRICT_MODELS=1)"]
    C --> K[dispatch request]
    E --> K
    G --> K
    I --> K
    K --> L{request succeeds?}
    L -- yes --> M[done]
    L -- no --> N["tryFallbackOrFail()"]
    N --> O{on_failure == hard_fail?}
    O -- yes --> P[hard fail, no cascade]
    O -- no --> Q{per-backend fallback_to<br/>chain has a candidate?}
    Q -- yes, not cooled-down --> R[try next backend in chain] --> L
    Q -- no --> S{capability fallback_chains<br/>has a candidate?}
    S -- yes --> T["try next candidate<br/>(quality_tolerance_pct reorder)"] --> L
    S -- no --> U["tryLocalTerminalFallback():<br/>walk best-local-oss/gov -> best-cloud"]
    U --> V{local terminal resolved?}
    V -- yes --> W[dispatch to local terminal] --> L
    V -- no --> X["tryGlobalDefaultFallback():<br/>resolve routes.default, mode-filtered, cycle-checked"]
    X --> Y{routes.default available<br/>and not already tried?}
    Y -- yes --> Z[dispatch to global default] --> L
    Y -- no --> AA[exhausted: surface error to client]
```

**Grounding** (`tools/claude-proxy`):
- `resolveBackend()` `:1117` — priority ladder: model_routes exact/pattern, `claude-via-*`
  alias, `@backend` sigil, capability alias (`resolveCapabilityAlias`,
  `tools/model-map-resolve.js:271-283`) → `resolveProfileModel()` (`model-map-resolve.js:176-190`),
  synthetic `__ollama_fallback__` fallthrough
- `tryFallbackOrFail()` `:1694` — hard-fail gate, per-backend `fallback_to` chain (cooldown/mode-
  filter skip), capability `fallback_chains[tier][cap]` scan (`quality_tolerance_pct` reorder)
- `tryLocalTerminalFallback()` `:1665` — uses `resolveLocalFallback` walking
  best-local-oss/best-local-gov/best-cloud
- `tryGlobalDefaultFallback()` `:1838`
- Bash independently mirrors this same ladder for pre-launch env setup:
  `tools/c-thru:4794-4924` (explicit "same semantics as claude-proxy" comment `~4663`)

---

## 3. Wire translation dispatch (`/v1/messages`)

```mermaid
flowchart TD
    A["POST /v1/messages"] --> B["resolveBackend() picks backend + effectiveModel"]
    B --> C{"backend.format ==<br/>'ollama-legacy' or<br/>legacy_ollama_chat?"}
    C -- yes --> D["forwardOllamaLegacy():<br/>full request rebuild -> POST /api/chat"]
    C -- no --> E{"backend.call_style?"}
    E -- gemini --> F["forwardGemini():<br/>schema scrub, thinking-budget mapping,<br/>thought-signature caching, response remap"]
    E -- openai --> G["501 stub<br/>(not implemented)"]
    E -- default/anthropic --> H["forwardAnthropic():<br/>header scrub + auth only, verbatim body<br/>(covers real Anthropic AND modern Ollama)"]
```

**Grounding** (`tools/claude-proxy`):
- Dispatch handler entry: `:5044`; sentinel-based per-agent model override before resolution
  `:5103-5151`; dispatch decision `:5265-5284`, mirrored in `dispatchBackend()` `:3753-3761`
- `isOllamaLegacy()` `:852`
- `forwardAnthropic()` `:1900` — no body translation, covers real Anthropic AND non-legacy
  `kind:"ollama"` backends (modern Ollama serves an Anthropic-shaped `/v1/messages`)
- `forwardOllamaLegacy()` `:4244` — `buildOllamaRequestBody`/`flattenMessagesForOllama`
  (`~2138-2158`), POSTs to Ollama-native `/api/chat`
- `forwardGemini()` `:3177` — heaviest translation: `mapAnthropicToGemini` (`~3960`)
- OpenAI `call_style` 501 stub: `~3271-3283`

See also [`docs/anthropic-api-coverage.md`](anthropic-api-coverage.md) for the full per-endpoint
coverage matrix beyond this one dispatch point.

---

## 4. Hook lifecycle

```mermaid
flowchart TD
    Sess[SessionStart] --> H1["c-thru-session-start.sh<br/>seeds model-map, spawns proxy, probes /hooks/context"]
    Compact[PreCompact] --> H2["c-thru-postcompact-context.sh<br/>re-fetches /hooks/context, re-wraps as PreCompact"]
    Prompt[UserPromptSubmit] --> H3["c-thru-proxy-health.sh (async)<br/>pings proxy, always exits 0"]
    Prompt --> H4["c-thru-classify.sh (async)<br/>static /hooks/context block, no prompt inspection"]
    PostTool["PostToolUse (Write/Edit)"] --> H5["c-thru-map-changed.sh<br/>validates model-map.json"]
    PreToolAgent["PreToolUse (Agent/WebSearch/...)"] --> H6["c-thru-agent-router-hook.sh<br/>CLI-only: rewrites Agent model+sentinel"]
    PreToolPlan["PreToolUse (EnterPlanMode)"] --> H7["c-thru-enter-plan-hook.sh<br/>CLI-only: advisory hint only"]
    Stop["Stop (unregistered)"] -.-> H8["c-thru-stop-hook.sh<br/>intentional semi-orphan, not auto-wired"]
```

**Grounding** — ephemeral hook registry (single source): `tools/c-thru:384-449`. Parity between
this ephemeral registration and `plugins/c-thru/hooks/hooks.json` (which covers only
SessionStart/UserPromptSubmit×2/PostToolUse/PreCompact — the two PreToolUse hooks are
**CLI-only by design**) is enforced by `test/hooks-declaration-parity.test.js`. `c-thru-stop-hook.sh`
is correctly documented elsewhere (`docs/functionality-map.md` §7) as an intentional
"semi-orphan (symlinked, not auto-registered)" — the dashed arrow above reflects that
deliberately, not a bug.

**Known open item** (tracked separately, not a diagram bug): `c-thru-stop-hook.sh` and
`c-thru-statusline-overlay.sh` both watch `proxy.log` for event tags
(`[fallback.candidate_success]`, `[fallback.chain_start]`) confirmed via git history to be from
an old, since-rewritten fallback architecture (commit `10e88d4`) — neither tag is emitted by the
current `tools/claude-proxy`. Both hooks are wired correctly per this diagram; what they watch
for is stale. See the open task tracking this.

---

## 5. `/c-thru-plan` wave lifecycle

```mermaid
stateDiagram-v2
    [*] --> Phase0
    Phase0: Phase 0 - pre-check / resume
    Phase0 --> Phase1
    Phase1: Phase 1 - discovery (explore fan-out)
    Phase1 --> Phase2
    Phase2: Phase 2 - plan construction (planner)
    Phase2 --> Phase3
    Phase3: Phase 3 - review loop (reviewer-plan)
    Phase3 --> Phase2 : NEEDS_REVISION
    Phase3 --> Phase4 : APPROVED
    state Phase4 {
        [*] --> CoderExecutes
        CoderExecutes --> Classify
        Classify --> CoderExecutes : clean
        Classify --> CoderExecutes : dep_update (calls planner)
        Classify --> CoderExecutes : outcome_risk (calls planner)
        Classify --> [*] : no READY_ITEMS left
    }
    Phase4: Phase 4 - wave loop (coder + deterministic pre-processor)
    Phase4 --> Phase5
    Phase5: Phase 5 - final review (code-reviewer + planner)
    Phase5 --> Phase4 : gaps found
    Phase5 --> [*]
```

**Grounding** (`skills/c-thru-plan/SKILL.md`, `docs/agent-architecture.md`):
- 6 phases total (0–5), not 5 as sometimes loosely described — Phase 0 pre-check/resume
  (`SKILL.md:21-56`), Phase 2 plan construction (`SKILL.md:116-149`), Phase 3 review loop
  (20-round cap shared with Phase 5, `SKILL.md:151-193`) + aftermath materializing `READY_ITEMS`
  (`SKILL.md:195-208`)
- Phase 4's deterministic pre-processor (classifies each transition `clean`/`dep_update`/
  `outcome_risk`; only the latter two call `planner`) lives in `tools/c-thru-plan-harness.js`,
  not in a prompt — see `docs/agent-architecture.md:89-101`
- Phase 5 final review: `docs/agent-architecture.md:102-103`
- Agent resolution within every phase follows the same 4-layer chain as Flow 2 above
  (`docs/agent-architecture.md:52-65`)

---

## 6. Config layering

Two genuinely different operations, split into two diagrams deliberately — the previous single
paragraph in `docs/model-map.md` conflated them, which produced a real doc bug (see the note
below Flow 6b).

### 6a. Build-time: layered profile sync

```mermaid
flowchart TD
    A["maybeSyncLayeredProfileModelMap()"] --> B{shipped config newer<br/>than system.json?}
    B -- yes --> C[validate + refresh system.json<br/>from shipped config]
    B -- no --> D
    C --> D["Pass 1 - PROFILE:<br/>system.json + overrides.json<br/>-> ~/.claude/model-map.json"]
    D --> E{project-local<br/>.claude/model-map.json<br/>found walking up from cwd?}
    E -- no --> F["done: profile file is the effective config"]
    E -- yes --> G["Pass 2 - PROJECT OVERLAY:<br/>system + overrides + project<br/>-> session-scoped temp file"]
    G --> H["profile file untouched;<br/>overlay used for THIS session only"]
```

**Grounding**: `tools/model-map-config.js:maybeSyncLayeredProfileModelMap()` `:91-172`. Pass 1
`:136` (`profileSyncArgs`, project slot deliberately `''` — "the profile file is shared across
all sessions from all directories... always sync only the persistent layers"). Pass 2 `:151-169`
(`sessionEffectivePath(projectPath)`, only runs when `findParentModelMap(cwd)` finds a project
config). Invoked from `tools/c-thru` via `eval "$(node model-map-config.js --shell-env)"`
(`tools/c-thru:781,816`).

### 6b. Request-time: 3-tier precedence lookup

```mermaid
flowchart TD
    A["resolveSelectedConfigPath()"] --> B{"CLAUDE_MODEL_MAP_PATH set?"}
    B -- yes --> C["use override path (Tier 1)"]
    B -- no --> D{project overlay path<br/>from the build-time sync?}
    D -- yes --> E["use session-scoped project overlay (Tier 2)"]
    D -- no --> F["use profile ~/.claude/model-map.json (Tier 3)"]
```

**Grounding**: `tools/model-map-config.js:resolveSelectedConfigPath()` `:179-202`.

**Doc-accuracy note (fixed alongside these diagrams):** `docs/model-map.md` previously stated
project-local config "is selected as-is... not merged with the profile graph." That's **only**
true of `claude-proxy`'s own cheap SIGHUP-reload path (`resolveConfigSelectionForReload()`,
`tools/claude-proxy:4463-4479` — deliberately re-derives Tier 2 by walking ancestors directly,
skipping the 2-pass sync, for reload speed). On a **normal `c-thru` launch**, Flow 6a's Pass 2
*does* merge system + overrides + project before the proxy ever starts — the two flows above are
genuinely different operations, and the old single-paragraph description picked only one of
them.
