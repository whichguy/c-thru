# Agent fleet reference

Loaded automatically when working with files under `agents/`. Root `CLAUDE.md` covers `/c-thru-plan` invocation basics; this file covers the agent fleet itself.

### Pipeline agents (13 + 10 utility + brand leaves from catalog)

The agent fleet uses an identity mapping for most role agents: each agent's `model` frontmatter field equals its capability key in `agent_to_capability`, which equals its key in `llm_profiles`. Three role exceptions alias to a different capability: `reviewer-plan` → `code-reviewer`, `plan-scheduler` → `fast-generalist`, `advisors` → `planner-hard`. Generated brand leaves from `config/brand-agents.json` instead pin directly to vendor models through `model:` mappings; primary shorthands include `grok`, `deepseek`, `qwen`, `kimi`, and `gemini` (see `docs/agent-architecture.md`).

**Delivery:** fleet definitions are repo `agents/*.md`, runtime-injected each `c-thru` launch as ephemeral `--agents` JSON — never installed into Claude's durable agent store (`~/.claude/agents/`).

For full dispatch-graph and role detail, see `docs/agent-architecture.md`. That document defers to `config/model-map.json#agent_to_capability` and the generated README "Agent routing reference" table as canonical; if it disagrees with either, they win. For full tier-resolution detail, see `docs/hardware-profile-matrix.md`.

**13 pipeline agents (planner → coder → tester → reviewer flow):**

tier_budget values are hand-copied from each `agents/*.md` frontmatter — update here when an agent's `tier_budget:` changes.

| Agent / Capability | Tier budget |
|---|---|
| `planner` | 999999 |
| `planner-hard` | 999999 |
| `explore` | 10000 |
| `coder` | 50000 |
| `coder-fallback` | 10000 |
| `tester` | 10000 |
| `docs` | 10000 |
| `code-reviewer` | 50000 |
| `reviewer-plan` | 50000 |
| `reviewer-security` | 999999 |
| `debugger-hypothesis` | 50000 |
| `debugger-investigate` | 50000 |
| `debugger-hard` | 999999 |

**10 retained utility agents:**

| Agent | Purpose |
|---|---|
| `vision` | Image/screenshot analysis |
| `pdf` | PDF reading and extraction |
| `writer` | Long-form prose |
| `edge` | Minimal-footprint tasks |
| `generalist` | General-purpose |
| `fast-generalist` | Fast/cheap background work |
| `fast-scout` | Latency-optimized search |
| `long-context` | Large context window tasks |
| `plan-scheduler` | Dispatches wave READY_ITEMS to worker agents via /schedule-plan-tasks |
| `advisors` | Multi-seat panel host (`/advisors`; seats from `advisor_panels`; host → planner-hard) |

**Brand model-pin agents** (leaf; invoke by shorthand or full-name alias — “ask agent opus …”, “ask devstral …”; require vendor keys / local Ollama tags as applicable):

See `config/brand-agents.json` (written into `agents/*.md` via `node tools/gen-brand-agents.js`).
Includes Claude-family shorthands (`opus` / `sonnet` / `haiku` / `fable` with mode-conditional
`model_routes`), existing pins (`grok`, `deepseek`, `qwen`, `kimi`, `gemini`), Ollama-family
leaves (`devstral`, `glm`, `gemma`, `phi`, `gpt-oss`, `nemotron`, `minimax`, `hermes`, `mistral`, …),
and Claude-safe full-name aliases for concrete tags.

### Pipeline orchestration

Each pipeline agent ends its response with an `UNBLOCKED_TASKS` block containing
`Task()` calls for the next agent(s). The orchestrator follows these breadcrumbs
rather than memorizing a fixed pipeline sequence.

Typical flow:
  planner → (UNBLOCKED_TASKS) → coder
  coder   → (UNBLOCKED_TASKS) → tester → code-reviewer
  any agent → (UNBLOCKED_TASKS) → debugger-hypothesis (on failure)

Debug subloop (triggered by coder/tester failure):
  debugger-hypothesis → debugger-investigate → (loop) → debugger-hard on exhaustion

See docs/agent-architecture.md for the full wave lifecycle and worker STATUS contract.

### agent_to_capability resolution

See docs/agent-architecture.md for agent_to_capability traversal and identity mapping details.

### Adding/rebinding

- Swap a capability's model for one mode×tier cell: one value change in `llm_profiles[cap][mode][tier]`.
- Swap all tiers for a mode: replace the entire mode-value object.
- Agent files are never modified for either operation.

### Model tags

Current cloud-OSS tags via Ollama Cloud: `deepseek-v4-pro:cloud`,
`deepseek-v4-flash:cloud`, `kimi-k3:cloud`, and `glm-5.2:cloud`.
Local Ollama tags are injected dynamically by the SessionStart hook (`ollama list`).
