# c-thru

**c-thru** is a transparent routing layer between Claude Code and any model backend — Ollama (local or cloud-relay), OpenRouter, Bedrock, Vertex, or Anthropic. It adds hardware-aware model selection, offline fallback, automatic Ollama fleet management, and a wave-based agentic planning system. You never change your Claude Code workflow.

---

## The problem

Claude Code is locked to one vendor and one billing model. Local LLMs via Ollama are capable enough for most tasks — but there's no transparent bridge. You can't route different agents to different models. And when you go offline, your entire workflow stops.

---

## How it works

```
You type: claude-router

Claude Code
    │  Anthropic Messages API (unmodified)
    ▼
claude-router       reads model-map.json, resolves route + backend
    │
    ▼
claude-proxy        translates protocol, manages Ollama, applies fallbacks
    │
    ├──▶ Ollama (local)          qwen3.5:27b, devstral-small:2, ...
    ├──▶ Ollama (cloud relay)    glm-5.1:cloud, qwen3-coder:480b-cloud
    ├──▶ OpenRouter / Bedrock    cloud alternatives
    └──▶ Anthropic               transparent fallback
```

The router wraps `claude`, rewrites `ANTHROPIC_BASE_URL` and credentials per-route, and auto-spawns the proxy. The proxy speaks Anthropic Messages API inbound and translates to whatever the backend needs. You get streaming, tool use, and multi-turn context — all preserved.

---

## Model resolution: the 4-layer graph

Every request goes through four resolution steps. Agents declare a logical name; the proxy finds the right model for the current hardware and connectivity.

```
model: implementer          ← agent declares its own name
    │
    ▼  agent_to_capability
  deep-coder                ← logical capability tier
    │
    ▼  llm_profiles[detected-hw][deep-coder]
  connected_model           ← concrete model tag
    │
    ▼  model_overrides (optional rename)
  devstral-small:2          ← sent to Ollama
```

**What this means in practice:**

- Rebind an agent to a different capability tier → one line in `agent_to_capability`
- Swap a tier's backing model on any hardware → one line in `llm_profiles[hw][alias]`
- Agent files never change for either operation

Capability aliases and the agents that use them:

| Alias | Cognitive tier | Agents |
|---|---|---|
| `judge` | cloud or 27B+ local | planner, auditor, review-plan, final-reviewer |
| `judge-strict` | cloud or 27B+, hard_fail | security-reviewer |
| `orchestrator` | mid-tier local | plan-orchestrator, integrator, doc-writer |
| `local-planner` | local 27B+, never cloud | planner-local |
| `deep-coder` | local coding model | implementer |
| `code-analyst` | local mid-tier | test-writer, reviewer-fix, wave-synthesizer |
| `pattern-coder` | local small | scaffolder, discovery-advisor, learnings-consolidator |

---

## Hardware-aware routing

RAM is auto-detected at proxy startup via `hw-profile.js`. The same agent routes to different models depending on what your machine can run.

| Machine | Connectivity | judge (planner) | orchestrator | deep-coder (implementer) |
|---|---|---|---|---|
| 128 GB | connected | claude-opus-4-6 | qwen3.6:35b | devstral-small:2 |
| 128 GB | offline | qwen3.5:122b | qwen3.5:122b | devstral-small:2 |
| 64 GB | connected | claude-opus-4-6 | qwen3.6:35b | devstral-small:2 |
| 64 GB | offline | qwen3.5:27b | qwen3.5:27b | devstral-small:2 |
| 48 GB | connected | claude-opus-4-6 | qwen3.5:9b | devstral-small:2 |
| 48 GB | offline | qwen3.5:27b | qwen3.5:27b | qwen3.5:27b |
| ≤32 GB | any | qwen3.5:1.7b | qwen3.5:1.7b | qwen3.5:1.7b |

Verify detected tier: `claude-router --list`

Override for testing: `CLAUDE_LLM_MEMORY_GB=48 claude-router --list`

---

## Connected vs disconnected

Every capability alias has two model slots and a failure policy:

```json
"judge": {
  "connected_model": "claude-opus-4-6",
  "disconnect_model": "qwen3.5:27b",
  "on_failure": "cascade"
}
```

The proxy detects connectivity at startup and selects the right slot automatically. Unplug your internet — it switches. No config change, no restart. `on_failure: cascade` walks the fallback chain to the next available local model if the primary fails. `on_failure: hard_fail` (used by `judge-strict`) returns an explicit error instead of silently substituting a weaker model.

---

## Ollama lifecycle management

c-thru manages the Ollama fleet. You never run `ollama pull` or `ollama run` manually.

**From launch to first response:**

```
claude-router starts
    │
    ├─▶ detect hardware tier from RAM
    ├─▶ detect connectivity (connected / disconnected)
    ├─▶ resolve profile → model slots for all 5 capability aliases
    │
    └─▶ background Ollama prep (non-blocking, runs while you read the banner)
             │
             ├─▶ GET /api/tags    → which models are already cached locally?
             ├─▶ GET /api/ps      → which are currently loaded in VRAM?
             └─▶ POST /api/generate (keep_alive, empty prompt)
                     → pre-warm profile models into GPU memory

First request arrives:
    │
    ├─▶ model cached?  no  → POST /api/pull  (transparent; concurrent pulls deduplicated)
    ├─▶ role changed?  yes → POST /api/generate (keep_alive=0) to unload previous model
    ├─▶ model warm?    no  → POST /api/generate (fire-and-forget pre-warm)
    └─▶ forward request → stream response back to Claude Code
```

**Five behaviors, zero manual steps:**

| Behavior | What happens |
|---|---|
| **Background warm-up** | Profile models pre-loaded into VRAM while startup banner displays |
| **Auto-pull** | Missing model pulled via `/api/pull` before request proceeds; concurrent pulls for the same model are deduplicated — one download, multiple waiters |
| **Pre-warming** | After pull, model loaded into VRAM via fire-and-forget request so it's ready before inference starts |
| **Role exclusivity** | When a capability role switches to a different model, the previous model for that role is evicted — automatic VRAM budget management on memory-constrained machines |
| **GC tracking** | `c-thru-ollama-gc` records every model c-thru pulled (distinct from models you pulled manually). `sweep` purges tags the current profile no longer references |

> All Ollama management runs via the HTTP API. The `ollama` CLI is not a runtime dependency.

---

## The agentic planning system: `/c-thru-plan`

`/c-thru-plan` is a wave-based task orchestrator. It breaks any intent into a structured plan, executes it in parallel waves using specialized agents, and adapts when findings change what needs to happen next — all while keeping cloud costs minimal.

```sh
/c-thru-plan add a palindrome checker to the auth module
```

### The plan as living state

The plan lives in a single file: `current.md`. It has two parts:

- **`## Outcome`** — written once by the initial planner call, never modified. Every subsequent decision is checked against it.
- **`## Items`** — a dependency-ordered list of work items. Each item tracks: id, description, target file paths, depends_on, success criteria, assumption state, and status. This section is updated after every wave.

The planner's job is not just to write the initial plan — it maintains the dep map across the entire run. After each wave, findings flow back in and the planner updates affected items before selecting what executes next. `current.md` is the single source of truth that all agents read and the planner owns.

### End-to-end flow

```
/c-thru-plan <intent>
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Phase 0 — Pre-check                                        │
  │  Prior state exists? → resume / restart / abort             │
  │  Fresh start → create state directory                       │
  └─────────────────────────────────────────────────────────────┘
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Phase 1 — Discovery (read-only, no code changes)           │
  │                                                             │
  │  orchestrator reads codebase → recon.md                     │
  │      │                                                      │
  │      ▼                                                      │
  │  discovery-advisor → gaps.md (what's still unknown?)        │
  │      │                                                      │
  │      ▼  (one agent per gap, in parallel)                    │
  │  explorer  explorer  explorer → discovery/*.md              │
  └─────────────────────────────────────────────────────────────┘
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Phase 2 — Plan construction                                │
  │                                                             │
  │  planner  (signal=intent, cloud judge)                      │
  │  reads:   intent + all discovery context                    │
  │  writes:  current.md                                        │
  │           ├─ ## Outcome  (immutable from this point)        │
  │           └─ ## Items    (dep-ordered, first wave selected) │
  │  returns: READY_ITEMS[] for wave 001                        │
  └─────────────────────────────────────────────────────────────┘
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Phase 3 — Plan review loop (max 20 rounds total)           │
  │                                                             │
  │  review-plan agent reads current.md                         │
  │  ├─ APPROVED → proceed to wave loop                         │
  │  └─ NEEDS_REVISION                                          │
  │       │                                                     │
  │       ▼                                                     │
  │       planner (signal=wave_summary, reads review findings)  │
  │       updates current.md → loop back to review-plan         │
  └─────────────────────────────────────────────────────────────┘
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Phase 4 — Wave loop  (repeats until no ready items)        │
  │                                                             │
  │  ┌───────────────────────────────────────────────────────┐  │
  │  │  plan-orchestrator executes one wave                  │  │
  │  │                                                       │  │
  │  │  topo-sort + resource-conflict batch → wave.json      │  │
  │  │                                                       │  │
  │  │  dispatch workers in parallel:                        │  │
  │  │    implementer   → writes code                        │  │
  │  │    scaffolder    → stubs, boilerplate                 │  │
  │  │    test-writer   → tests                              │  │
  │  │    reviewer-fix  → review + fix loop                  │  │
  │  │    doc-writer    → documentation                      │  │
  │  │                                                       │  │
  │  │  concat findings → findings.jsonl                     │  │
  │  │  verify (bash/node, zero LLM)                         │  │
  │  │  git commit  (trailer: Wave: NNN)                     │  │
  │  └───────────────────────────────────────────────────────┘  │
  │                          │                                  │
  │                          ▼                                  │
  │  ┌───────────────────────────────────────────────────────┐  │
  │  │  Deterministic pre-processor  (zero LLM cost)         │  │
  │  │                                                       │  │
  │  │  reads findings.jsonl                                 │  │
  │  │  marks completed items [x] in current.md              │  │
  │  │  applies dep_discoveries to pending items             │  │
  │  │  computes newly-unblocked items                       │  │
  │  │  classifies transition →                              │  │
  │  └───────────────────────────────────────────────────────┘  │
  │            │                                                │
  │     ┌──────┼──────────────────────┐                        │
  │     ▼      ▼                      ▼                        │
  │  clean  dep_update          outcome_risk                   │
  │     │      │                      │                        │
  │     │      │ planner-local        │ planner                │
  │     │      │ (local 27B+,         │ (cloud judge)          │
  │     │      │  never cloud)        │ may invoke:            │
  │     │      │                      │   auditor              │
  │     │      │ reads: affected      │   wave-synthesizer     │
  │     │      │ items + discoveries  │                        │
  │     │      │ updates current.md   │ re-evaluates outcome   │
  │     │      │ dep map only         │ may revise plan scope  │
  │     │      │ DELTA_ADDED: 0       │ updates current.md     │
  │     │      │                      │                        │
  │     ▼      ▼                      ▼                        │
  │  READY_ITEMS[] for next wave ─────────────────────────────▶│
  │  (empty → Phase 5)                                         │
  └─────────────────────────────────────────────────────────────┘
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Phase 5 — Final review                                     │
  │                                                             │
  │  final-reviewer reads current.md + journal.md              │
  │  ├─ COMPLETE → archive plan, print summary                  │
  │  └─ needs_items                                             │
  │       │                                                     │
  │       ▼                                                     │
  │       planner (signal=final_review) appends gap items       │
  │       re-enter Phase 4                                      │
  └─────────────────────────────────────────────────────────────┘
```

### The planner's three signals

The planner is invoked three different ways across the lifecycle, always reading `current.md` and always leaving `## Outcome` and completed `[x]` items untouched:

| Signal | When | Input | What changes in current.md |
|---|---|---|---|
| `intent` | Once at start | User intent + full discovery context | Writes `## Outcome` + all items + first READY_ITEMS |
| `wave_summary` | After `dep_update` or `outcome_risk` wave | Compressed findings for affected items | Updates dep map, enriches pending items, selects next wave |
| `final_review` | After final-reviewer finds gaps | Gap list | Appends new items with deps on completed work |

After every write, the planner emits a compact STATUS block (≤20 lines) — not file contents. The driver holds pointers, not bodies. Context stays bounded regardless of plan size.

### The three wave transitions

After each wave, the deterministic pre-processor reads findings and classifies the transition. This is where the system decides how much intelligence to spend on the next step:

```
Wave N completes
     │
     ▼  deterministic pre-processor (zero LLM)
     │  reads findings.jsonl
     │  marks [x] items, applies dep_discoveries, computes ready set
     │
     ├─▶ clean
     │     all dep_discoveries high-confidence, no outcome_risk flags
     │     commit message generated by local 7B
     │     next READY_ITEMS computed from dep graph
     │     → Wave N+1 starts immediately. No planner call.
     │
     ├─▶ dep_update
     │     some dep_discovery is low-confidence, or implies a dep change
     │     between pending items (not just resource enrichment)
     │     → planner-local (local 27B+, never cloud)
     │          reads only affected items + their discoveries
     │          updates target_resources and dep links
     │          DELTA_ADDED always 0 — cannot add items
     │          → READY_ITEMS for Wave N+1
     │
     └─▶ outcome_risk
           any finding flags outcome_risk=true
           OR an unrecoverable finding was detected
           → planner (cloud judge)
                re-reads ## Outcome (north star)
                may invoke auditor (continue/extend/revise verdict)
                may invoke wave-synthesizer (context compression)
                may revise plan scope, add blocking prerequisites
                → READY_ITEMS for Wave N+1, or VERDICT: done
```

### Cost pyramid

Cloud is called once to write the plan. After that, it's involved only when something genuinely threatens the outcome.

```
OPERATION                   COST       MODEL                    FREQUENCY
─────────────────────────────────────────────────────────────────────────
Initial planning            cloud      judge (Opus / qwen122b)  once / plan
Plan review                 cloud      judge                    up to 20 rounds
Outcome risk re-plan        cloud      judge                    rare — on flag
────────────────────────────────────────────────────────────────── ↑ cloud ──
Dep-map update              local      local-planner 27B+       per dep_update wave
Workers: code               local      devstral-small:2         N per wave
Workers: tests              local      qwen3.5:9b               N per wave
Workers: scaffolding        local      qwen3.5:1.7b             N per wave
Workers: docs               local      qwen3.5:9b               N per wave
Commit message              local 7B   commit-msg-gen           per clean wave
Learnings consolidation     local 7B   learnings-consolidator   per wave
────────────────────────────────────────────────────────────────── ↓ zero ──
[x] marking                 zero       deterministic            per wave
Dep graph traversal         zero       deterministic            per wave
Topo-sort / batching        zero       deterministic            per wave
Verification                zero       bash / node              per wave
Git commit                  zero       bash                     per wave
```

### Plan state layout

```
/tmp/c-thru/<repo>/<slug>/
  current.md              ← single source of truth (Outcome + Items)
  meta.json               ← slug, wave_count, revision_rounds, status
  journal.md              ← append-only wave log
  learnings.md            ← cross-wave wiki; refreshed by planner
  pre-processor.log       ← structured transition log per wave
  plan/snapshots/         ← p-NNN.md after each wave commit
  discovery/              ← recon.md, gaps.md, per-gap explorer outputs
  waves/NNN/
    wave.json             ← orchestrator batch plan
    findings.jsonl        ← per-item structured findings
    wave-summary.md       ← key findings + signals
    verify.json           ← deterministic post-wave checks
    wave_summary_compressed.md  ← prose-stripped for planner context
```

Plans are resumable across sessions. Completed plans are archived to `~/.claude/c-thru-archive/<slug>-<timestamp>/`.

---

## Install

```sh
git clone https://github.com/whichguy/c-thru.git
cd c-thru
./install.sh
```

The installer symlinks `claude-router`, `claude-proxy`, and model-map helpers into `~/.claude/tools/`, seeds `~/.claude/model-map.json` from `config/model-map.json` on first run (never overwritten on upgrade), and registers the `llm-capabilities-mcp` server and hook scripts in `~/.claude/settings.json`.

Add `~/.claude/tools` to your `PATH`:

```sh
export PATH="$HOME/.claude/tools:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

Verify:

```sh
bash -n tools/c-thru-classify.sh          # shell syntax check
node --check tools/claude-proxy           # node syntax check
node tools/model-map-validate.js config/model-map.json
claude-router --list                      # runtime smoke-test
```

---

## Usage

```sh
claude-router                             # routes.default, or transparent Anthropic fallback
claude-router --route background          # named route from model-map
claude-router --model devstral-small:2   # explicit Ollama model
claude-router --list                      # show resolved profile + all routes
/c-thru-plan <intent>                     # launch wave-based task orchestrator
```

---

## Configuration

### model-map.json — three-tier lookup

```
$PWD/.claude/model-map.json     ← per-project overrides
~/.claude/model-map.json        ← user profile (seeded by install.sh, never clobbered)
config/model-map.json           ← shipped defaults
```

Top-level keys: `backends`, `routes`, `llm_profiles`, `agent_to_capability`, `model_overrides`.

- **`backends`** — connection metadata (url, auth, kind). `kind: "ollama"` or `kind: "anthropic"`.
- **`routes`** — named presets mapping to `{model, backend}`. `routes.default` used when no flag passed.
- **`llm_profiles`** — per-hardware-tier, per-capability-alias model slots (`connected_model` / `disconnect_model`).
- **`agent_to_capability`** — maps agent names to capability aliases. One line to rebind an agent.
- **`model_overrides`** — unconditional tag rename before route resolution. Example: `{"gemma4:26b": "gemma4:31b"}`.

See [`docs/model-map.md`](docs/model-map.md) for full schema.

### Environment variables

| Variable | Effect |
|---|---|
| `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely — transparent Anthropic path |
| `CLAUDE_ROUTER_DEBUG=1` | Verbose router logging |
| `CLAUDE_ROUTER_DEBUG=2` | + proxy port, Ollama vars, route keys |
| `CLAUDE_PROXY_DEBUG=1` | Verbose proxy logging |
| `CLAUDE_PROXY_DEBUG=2` | + full request/response tracing |
| `CLAUDE_PROXY_HOOKS_PORT` | Fixed port for HTTP hooks listener (default `9998`) |
| `CLAUDE_LLM_MEMORY_GB` | Override RAM detection for hardware-tier selection |
| `CLAUDE_PROXY_OLLAMA_PULL_TIMEOUT_MS` | Timeout for model pull via HTTP API (default 1 800 000 ms) |
| `CLAUDE_PROXY_OLLAMA_WARM_TIMEOUT_MS` | Timeout for model warm-up (default 60 000 ms) |
| `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE` | Keep-alive duration passed to Ollama on warm requests |

Proxy logs: `~/.claude/proxy.*.log`. Kill a stuck proxy: `pkill -f claude-proxy`.

---

## Further reading

- [`docs/agent-architecture.md`](docs/agent-architecture.md) — full agent roster, wave lifecycle, cross-wave communication
- [`docs/hardware-profile-matrix.md`](docs/hardware-profile-matrix.md) — complete 6-profile × 5-alias model table
- [`docs/model-map.md`](docs/model-map.md) — model-map schema reference

---

## License

MIT
