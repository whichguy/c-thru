# c-thru

**c-thru** is a transparent routing layer between Claude Code and any model backend — Ollama (local or cloud-relay), OpenRouter, Bedrock, Vertex, or Anthropic. It adds hardware-aware model selection, offline fallback, automatic Ollama fleet management, and a wave-based agentic planning system. You never change your Claude Code workflow.

---

## Getting Started: Redirecting Claude Code

To start Claude Code with a different model, you must redirect its API requests to the c-thru proxy using environment variables. This allows you to use models from providers like OpenRouter, LM Studio, or Ollama while keeping the Claude Code interface.

### Method 1: Quick Redirect (CLI)

You can point Claude Code to a different model by setting two primary environment variables in your terminal before launching the tool:

1.  **Set the Base URL:** Redirect requests to the c-thru proxy.
2.  **Set the Auth Token:** Use the token `"ollama"` (required for local/spoofed backends).
3.  **Launch with Model Flag:** Specify the model name.

**Example using `c-thru` wrapper (automates steps 1 & 2):**
```sh
c-thru --model qwen3.5:27b
```

**Example for manual redirection:**
```sh
export ANTHROPIC_BASE_URL=http://localhost:9997
export ANTHROPIC_AUTH_TOKEN=ollama
claude --model qwen3.5:27b
```

### Method 2: Use Local Models (Ollama or LM Studio)

To use local models, ensure you have a local server running that the c-thru proxy can communicate with.

*   **Ollama:** Install Ollama and pull your model (e.g., `qwen3.5:27b`). `c-thru` automatically handles `ollama serve` and pre-warming.
*   **LM Studio:** Start the LM Studio local server (typically on port `1234`), then add it as a backend in `model-map.json`.

### Method 3: Simplified Shell Functions

For frequent use, add functions to your shell configuration file (e.g., `.zshrc` or `.bashrc`) to switch with one command:

```sh
# Add to ~/.zshrc or ~/.bashrc
function claude-qwen() {
  c-thru --model qwen3.6:35b "$@"
}

function claude-gpt4() {
  c-thru --model openrouter/openai/gpt-4o "$@"
}
```

After adding this, simply run `claude-qwen` or `claude-gpt4` in your terminal to start a session with the respective model.

### Key Commands for Session Control

*   **`/model`**: Within an active session, use this command to see a picker and switch between available models immediately.
*   **`--model <name>`**: Use this flag when starting Claude Code to force a specific model for that session.
*   **`/status`**: Use this to verify which model and backend provider are currently active.

---

## The problem

Claude Code is locked to one vendor and one billing model. Local LLMs via Ollama are capable enough for most tasks — but there's no transparent bridge. You can't route different agents to different models. And when you go offline, your entire workflow stops.

---

## How it works

```
You type: c-thru

Claude Code
    │  Anthropic Messages API (unmodified)
    ▼
c-thru               reads model-map.json, resolves route + backend
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
| `code-analyst` | local mid-tier | test-writer, wave-reviewer, wave-synthesizer |
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

Verify detected tier: `c-thru list`

Override for testing: `c-thru --memory-gb 48 list` (or `CLAUDE_LLM_MEMORY_GB=48 c-thru list`)

---

## Connectivity modes

### I want to…

| Goal | Use |
|---|---|
| **Save money** — minimise cloud calls | `--mode local-best-quality` (or `local-only` if no internet) |
| **Best quality regardless of cost** | `--mode cloud-best-quality` |
| **Cloud only for high-stakes decisions** (planner, auditor) | `--mode cloud-judge-only` |
| **Cloud for thinking-class tasks**, local for workers | `--mode cloud-thinking` |
| **Local for review/security**, cloud for everything else | `--mode local-review` |
| **Use only Claude** (no GLM, no openrouter, no local) | `--mode claude-only` |
| **Avoid Claude** — open-source models only | `--mode opensource-only` |
| **Must be cloud** — hard-fail if no cloud option | `--mode cloud-only` |
| **Fastest model that's still good** | `--mode fastest-possible` |
| **Smallest model that fits the role** | `--mode smallest-possible` |
| **Best open-source model** for the task | `--mode best-opensource` |
| **Audit my agent's outputs** | `CLAUDE_PROXY_JOURNAL=1` (see [docs/journaling.md](docs/journaling.md)) |
| **Force a specific model** for one invocation | `--model <model-name>` |
| **Force a specific hardware tier** (testing) | `--profile 16gb`/`32gb`/`48gb`/`64gb`/`128gb` |

Every capability alias has model slots for each mode and a failure policy:

```json
"judge": {
  "connected_model":  "claude-opus-4-6",
  "disconnect_model": "qwen3.5:27b",
  "cloud_best_model": "claude-opus-4-6",
  "local_best_model": "qwen3.5:27b",
  "modes": {
    "semi-offload":    "qwen3.6:35b",
    "cloud-judge-only": "claude-opus-4-6"
  },
  "on_failure": "cascade"
}
```

The proxy selects the right slot based on the active mode. Switch mode with `--mode` or `CLAUDE_LLM_MODE`. Full reference: [docs/connectivity-modes.md](docs/connectivity-modes.md).

| Mode | Slot used | When to use |
|---|---|---|
| `connected` | `connected_model` | Normal operation with cloud access |
| `offline` | `disconnect_model` | No internet; local models only |
| `local-only` | `disconnect_model` (alias of `offline`) | Force local even when online (e.g. cost or privacy) |
| `semi-offload` | `modes.semi-offload` → `disconnect_model` | Local workers, cloud for high-stakes decisions |
| `cloud-judge-only` | `modes.cloud-judge-only` → `disconnect_model` | Cloud for judge/audit only; everything else local |
| `cloud-thinking` | `modes.cloud-thinking` → `disconnect_model` | Cloud for thinking-class capabilities (judge, planner, reasoner); workers stay local |
| `local-review` | `modes.local-review` → `connected_model` | INVERSE: review/security/code-analysis stays local; logic + orchestration go cloud |
| `cloud-best-quality` | `cloud_best_model` → `connected_model` | Force best cloud model regardless of tier |
| `local-best-quality` | `local_best_model` → `disconnect_model` | Force best local model; no cloud calls |

> **6 more modes** (`cloud-only`, `claude-only`, `opensource-only`, `fastest-possible`,
> `smallest-possible`, `best-opensource`) are *not* slot-based — they apply post-resolution
> filters or benchmark-driven ranking against `model_routes`. See
> [`docs/connectivity-modes.md`](docs/connectivity-modes.md) for the full reference and
> [`docs/benchmark.json`](docs/benchmark.json) for the data the ranking modes consult.

`on_failure: cascade` walks the fallback chain to the next available model if the primary fails. `on_failure: hard_fail` (used by `judge-strict`) returns an explicit error instead of silently substituting a weaker model.

---

## Ollama lifecycle management

c-thru manages the Ollama fleet. You never run `ollama pull` or `ollama run` manually.

**From launch to first response:**

```
c-thru starts
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
  │  │  topo-sort + resource-conflict batch → wave.md        │  │
  │  │                                                       │  │
  │  │  dispatch workers in parallel:                        │  │
  │  │    implementer   → writes code                        │  │
  │  │    scaffolder    → stubs, boilerplate                 │  │
  │  │    test-writer   → tests                              │  │
  │  │    wave-reviewer → review + fix loop                  │  │
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
    wave.md               ← orchestrator markdown manifest (wave_id, batches:, needs:, state markers)
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

The installer symlinks `c-thru` (also aliased as `claude-router`), `claude-proxy`, and model-map helpers into `~/.claude/tools/`, seeds `~/.claude/model-map.json` from `config/model-map.json` on first run (never overwritten on upgrade), and registers the `llm-capabilities-mcp` server and hook scripts in `~/.claude/settings.json`.

Add `~/.claude/tools` to your `PATH`:

```sh
export PATH="$HOME/.claude/tools:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

Verify:

```sh
bash -n tools/c-thru-classify.sh          # shell syntax check
node --check tools/claude-proxy           # node syntax check
node tools/model-map-validate.js config/model-map.json
c-thru check-deps                         # audit system dependencies
c-thru list                               # runtime smoke-test (active profile + routes)
c-thru explain --capability workhorse --mode best-opensource   # show resolution chain
c-thru --help                             # show all flags and subcommands
```

If any optional dependencies (jq, ollama) are missing, run `c-thru check-deps --fix` to install them via brew on macOS.

---

## Usage

### Subcommands (operate on c-thru itself)

```sh
c-thru list                           # show active hw profile, routes, local Ollama models
c-thru explain --capability X         # print routing resolution chain for a hypothetical request
c-thru reload                         # SIGHUP running proxy; confirm via /ping
c-thru restart [--force]              # stop + respawn proxy
c-thru check-deps [--fix]             # audit system deps; --fix installs missing optional tools
c-thru help                           # show full reference (also: --help, -h)
```

### Launch flags (modify how the next claude invocation is routed)

```sh
c-thru                                # routes.default, or transparent Anthropic fallback
c-thru --route background             # named route from model-map
c-thru --model devstral-small:2       # explicit Ollama model (highest precedence)
c-thru --mode offline                 # set connectivity / routing mode (15 modes; see below)
c-thru --profile 64gb                 # force hardware tier (16gb/32gb/48gb/64gb/128gb)
c-thru --memory-gb 48                 # override RAM detection (= CLAUDE_LLM_MEMORY_GB)
c-thru --bypass-proxy                 # skip proxy (= CLAUDE_PROXY_BYPASS=1)
c-thru --journal                      # enable per-request journaling (= CLAUDE_PROXY_JOURNAL=1)
c-thru --proxy-debug [N]              # proxy verbose logs N=1|2 (= CLAUDE_PROXY_DEBUG)
c-thru --router-debug [N]             # router verbose logs (= CLAUDE_ROUTER_DEBUG)
c-thru --no-update                    # skip git self-update (= CLAUDE_ROUTER_NO_UPDATE=1)
/c-thru-plan <intent>                 # (Claude skill) launch wave-based task orchestrator
```

The router strips all its own flags (`--route`, `--model`, `--mode`, `--profile`,
`--memory-gb`, `--bypass-proxy`, `--journal`, `--proxy-debug`, `--router-debug`,
`--no-update`) before forwarding to the real `claude` binary — they never reach
Claude Code's own argument parser.

Each `--<flag>` listed above sets the equivalent `CLAUDE_*` env var; flag wins over env var.

### Flag precedence

When multiple selection flags are passed:

```
--model <X>      → forces concrete model X for this invocation (highest precedence on selection)
--route <name>   → uses the named route from model-map.json (used when --model not given)
--mode <M>       → orthogonal: picks WHICH SLOT of the resolved capability is used
                   (connected/disconnect/cloud-best/etc.)
--profile <T>    → orthogonal: forces hardware tier (overrides RAM auto-detection)
```

The first two are about **which model**; the second two are about **which slot of that
model's capability**. They compose. `c-thru --route deep-coder --mode cloud-best-quality
--profile 128gb` is well-defined.

---

## Configuration

### model-map.json — config selection precedence

```
$CLAUDE_MODEL_MAP_PATH         ← explicit override path
$PWD/.claude/model-map.json    ← selected project graph
~/.claude/model-map.json       ← selected profile graph (seeded by install.sh, never clobbered)
config/model-map.json          ← shipped defaults, synced into the profile graph via model-map.system.json + model-map.overrides.json
```

The router/proxy traverses the selected `model-map.json` as the full DAG for that launch. Project-local configs are selected by precedence; they are not merged on top of the profile graph.

Top-level keys: `backends`, `routes`, `llm_profiles`, `agent_to_capability`, `model_overrides`, `targets`.

- **`backends`** — connection metadata (url, auth, kind). `kind: "ollama"` or `kind: "anthropic"`.
- **`routes`** — named string→string graph edges. `routes.default` used when no flag passed.
- **`llm_profiles`** — per-hardware-tier, per-capability-alias model slots (`connected_model` / `disconnect_model`).
- **`agent_to_capability`** — maps agent names to capability aliases. One line to rebind an agent.
- **`model_overrides`** — unconditional tag rename before route resolution. Example: `{"gemma4:26b": "gemma4:31b"}`.
- **`targets`** — optional final mapping layer from terminal label → backend/model/request defaults. Unmatched terminal labels continue through `targets.default` in the proxy only.

See [`docs/model-map.md`](docs/model-map.md) for full schema.

### Environment variables

| Variable | Effect |
|---|---|
| `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely — transparent Anthropic path |
| `CLAUDE_LLM_MODE` | Connectivity / routing mode (see [docs/connectivity-modes.md](docs/connectivity-modes.md)). 16 modes: `connected` | `offline` | `local-only` | `semi-offload` | `cloud-judge-only` | `cloud-thinking` | `local-review` | `cloud-best-quality` | `local-best-quality` | `cloud-only` | `claude-only` | `opensource-only` | `fastest-possible` | `smallest-possible` | `best-opensource` | `best-opensource-cloud` |
| `CLAUDE_LLM_MEMORY_GB` | Override RAM detection for hardware-tier selection |
| `CLAUDE_ROUTER_DEBUG=1` | Verbose router logging to stderr |
| `CLAUDE_ROUTER_DEBUG=2` | + proxy port, Ollama vars, route keys |
| `CLAUDE_PROXY_DEBUG=1` | Verbose proxy logging |
| `CLAUDE_PROXY_DEBUG=2` | + full request/response tracing |
| `CLAUDE_PROXY_HOOKS_PORT` | Fixed port for HTTP hooks listener (default `9998`) |
| `CLAUDE_ROUTER_NO_UPDATE=1` | Disable git self-update at startup |
| `CLAUDE_PROXY_OLLAMA_PULL_TIMEOUT_MS` | Timeout for model pull via HTTP API (default 1 800 000 ms) |
| `CLAUDE_PROXY_OLLAMA_WARM_TIMEOUT_MS` | Timeout for model warm-up (default 60 000 ms) |
| `CLAUDE_PROXY_OLLAMA_KEEP_ALIVE` | Keep-alive duration passed to Ollama on warm requests |
| `CLAUDE_PROXY_JOURNAL=1` | Record every request/response to `~/.claude/journal/YYYY-MM-DD/<capability>.jsonl` (see [docs/journaling.md](docs/journaling.md)) |
| `CLAUDE_PROXY_CLASSIFY=1` | Phase A dynamic classifier — observe-only role classification on every prompt; output in `x-c-thru-classified-role` header + journal (see [docs/dynamic-classification-phase-a.md](docs/dynamic-classification-phase-a.md)) |
| `NO_COLOR` | Disable colored output in c-thru CLI (follows [no-color.org](https://no-color.org/)) |

Proxy logs: `~/.claude/proxy.*.log`. Kill a stuck proxy: `pkill -f claude-proxy`.

### Skill surface

| Skill | Purpose |
|---|---|
| `/c-thru-status` | Read-only snapshot: routes, models, backend health |
| `/c-thru-config diag` | Full diagnostics: mode, tier, capability→model table, proxy status |
| `/c-thru-config resolve <cap>` | What does a capability or agent name resolve to right now? |
| `/c-thru-config mode [<mode>]` | Read or persistently set connectivity mode |
| `/c-thru-config remap <cap> <model>` | Rebind a per-capability model in `llm_profiles` |
| `/c-thru-config validate` | Schema-check the effective model-map |
| `/c-thru-config reload` | SIGHUP the running proxy to apply config changes |
| `/c-thru-plan <intent>` | Wave-based agentic planning orchestrator |

**Note on `/model-map`:** The external `/model-map edit` subcommand has a known argument mismatch and is non-functional. Use `/c-thru-config remap` instead. The `/model-map show` and `/model-map reload` subcommands continue to work if you have that skill installed.

---

## Further reading

- [`docs/agent-architecture.md`](docs/agent-architecture.md) — full agent roster, wave lifecycle, cross-wave communication
- [`docs/hardware-profile-matrix.md`](docs/hardware-profile-matrix.md) — complete 6-profile × 5-alias model table
- [`docs/model-map.md`](docs/model-map.md) — model-map schema reference

---

## License

MIT
