# c-thru

**A transparent router between Claude Code and the models you actually want —
without patching the vendor CLI.**

```text
Claude Code  ──▶  c-thru  ──▶  Anthropic · Ollama · Gemini · xAI · OpenRouter · …
                    │
          capability × hardware tier × mode
```

| See | Choose | Route |
|---|---|---|
| Unmodified Claude Code | Connectivity mode + RAM tier | Concrete model, translated only when needed |

Requests resolve by **capability**, **hardware tier**, and **connectivity mode**. Wire formats are translated only when the backend requires it.

### Capabilities

- Route Anthropic-shaped traffic to local and cloud backends
- Resolve models per role, tier, and mode
- Mix providers in a single session
- Fall back and reload without restarting Claude
- Observe every decision (`x-c-thru-*`, optional journal)
- Optional 27-agent fleet and `/cplan` waves (CLI install)

### In practice

```bash
cthru --mode best-local-oss     # air-gapped / local Ollama
cthru --mode best-cloud-oss     # cost-aware default
# CLI fleet: /cplan "add JWT auth"
# Or: "ask agent grok to critique this plan"
```

---

## Quick start

**Pick exactly one** marketplace source. Installing both `c-thru@c-thru` and
`c-thru@claude-craft` activates the plugin twice and double-fires its hooks.

### Option A — this repository (standalone)

```
/plugin marketplace add whichguy/c-thru
/plugin install c-thru@c-thru
```

### Option B — family marketplace

```
/plugin marketplace add whichguy/claude-craft
/plugin install c-thru@claude-craft
```

If you already have the other identity installed, remove it first:

```
/plugin uninstall c-thru@claude-craft
# or: /plugin uninstall c-thru@c-thru
```

**`planning-suite` is optional** — only needed for plan-scheduler /
`/schedule-plan-tasks`. Install separately from claude-craft if you want it:

```
/plugin marketplace add whichguy/claude-craft
/plugin install planning-suite@claude-craft
```

Restart Claude Code so the plugin loads. On the first SessionStart after install,
the hook may spawn the proxy and write `ANTHROPIC_BASE_URL` into your settings —
that settings change applies on the **next** launch, so you may need a **second**
restart (or a new session) before the client honors the base URL. Then verify:

```
/c-thru-status
```

You should see the active routing profile, proxy URL, configured routes, and
(if reachable) local Ollama models. If the proxy isn't reachable or the model-map
is missing, run `/c-thru-status fix`.

> **The marketplace plugin gives you proxy + routing, not the full agentic
> workflow.** `/cplan` and the 27-agent fleet depend on agent files injected via
> `--agents` on the CLI path. See [Appendix A](#appendix-a-cli-install-for-contributors-and-advanced-users).
> Prefer **one** of plugin vs CLI inject — both together can double-fire hooks.
> Details: [Appendix C](#appendix-c-plugin-vs-cli--entry-points).

### Cloud backends (optional)

Local-only routing needs no cloud keys. Subscription-backed Claude: see
[`docs/subscription-auth.md`](docs/subscription-auth.md).

Optional environment variables (set values in your shell profile — do not commit keys):

- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `GOOGLE_API_KEY` — Gemini AI Studio
- `XAI_API_KEY` — Grok routes

Full list: [`docs/env-vars.md`](docs/env-vars.md).

---

## How c-thru works

The bash entrypoint selects a model-map and routing mode, spawns the Node proxy (unless
`CLAUDE_PROXY_BYPASS=1` is set), and execs the real `claude` binary with ephemeral session
injection. The proxy translates Anthropic ↔ Gemini / Ollama and forwards everything else; agent
files declare logical capability names (`planner`, `coder`, ...) that the proxy resolves to
concrete models at request time.

<!-- BEGIN shared-diagram:launch-flow -->
```mermaid
flowchart TD
    A[c-thru invoked] --> B[resolve model-map + route/model]
    B --> C{backend needs a proxy?}
    C -- yes --> D[spawn claude-proxy<br/>FIFO READY-port handshake]
    C -- no --> E[transparent: skip proxy spawn]
    D --> F[inject --settings / --agents /<br/>--append-system-prompt]
    E --> F
    F --> G[exec real claude binary]
```
<!-- END shared-diagram:launch-flow -->

Full flow with every branch (native-subcommand bypass, `--bypass-proxy`, backend lookup ladder,
FIFO handshake failure modes): [docs/architecture-diagrams.md § 1](docs/architecture-diagrams.md#1-cli-launch--proxy-spawn--claude-exec).

claude-proxy (Node.js, stdlib only):
  - resolves capability alias → llm_profiles[capability][mode][tier] → concrete model
  - rewrites: model field, URL/Host, auth headers, model_overrides, @sigil
  - translates Anthropic ↔ Gemini and OpenAI-compatible Responses (OpenAI/xAI Responses translator)
  - forwards Ollama via /v1/messages (Ollama 0.4+) — preserves tool_use, thinking
  - catch-all passthrough for anything not explicitly handled
  - stamps x-c-thru-* response headers (resolved-via, translation-gap, …)

> The `--settings`, `--agents`, and `--append-system-prompt` injections only happen on the CLI install path. Plugin users get the proxy and `ANTHROPIC_BASE_URL` registration only — agent files and the `llm-capabilities` MCP are not loaded that way.

Two components, both in `tools/`:

- **`tools/c-thru`** (bash) — entrypoint. Config selection, Ollama lifecycle, agent injection, exec into claude.
- **`tools/claude-proxy`** (Node.js) — long-running HTTP server. Capability resolution, auth, fallback chains, SIGHUP reload, translation. **No external Node deps** — stdlib only.

> Translation gaps surface via `x-c-thru-translation-gap`. Full matrix: [`docs/anthropic-api-coverage.md`](docs/anthropic-api-coverage.md).

---

## Architecture: how a prompt becomes a model call

Three views of the same path. **View 1** is the map. **View 2** walks a single request end to end.
**View 3** shows what happens when the chosen backend fails.

All three follow the same real request — the `coder` agent under the default shipped config — so
the names line up across diagrams.

> Prefer clicking through it? [`docs/request-flow.html`](docs/request-flow.html) is a self-contained
> interactive step-through of View 2 and View 3. Open it in any browser.

### View 1 — the whole picture

```mermaid
flowchart TB
    subgraph HARNESS["Claude Code harness — hosts the context window"]
        CTX["Context window<br/>your conversation, tools, and the injected fleet"]

        subgraph FLEET["Agent fleet, injected at launch as ephemeral --agents JSON"]
            LOGICAL["LOGICAL agents — a role, not a model<br/>planner · planner-hard · explore<br/>coder · coder-fallback · tester · docs<br/>code-reviewer · reviewer-plan · reviewer-security<br/>debugger-hypothesis · -investigate · -hard"]
            UTILITY["UTILITY agents — also logical<br/>vision · pdf · writer · edge · generalist<br/>fast-generalist · fast-scout · long-context<br/>plan-scheduler"]
            NAMED["NAMED agents — the agent IS the model<br/>grok · deepseek · qwen · kimi · gemini"]
        end

        CTX -->|"you or the main loop pick an agent"| FLEET
    end

    FLEET --> HOOK

    subgraph HOOKBOX["PreToolUse hook — tools/c-thru-agent-router-hook.sh"]
        HOOK["Prepend a signed sentinel to the PROMPT<br/>c-thru-agent : coder : HMAC-SHA256<br/><br/>Hooks must never rewrite body.model —<br/>the agent name rides in the prompt text instead"]
    end

    HOOK -->|"POST /v1/messages to ANTHROPIC_BASE_URL<br/>127.0.0.1 : proxy port"| PROXYBOX

    subgraph PROXYBOX["claude-proxy — Node, stdlib only"]
        P1["1 · Read the prefix<br/>parse sentinel, verify HMAC, strip it from the body"]
        P2["2 · Agent to capability<br/>coder to coder · reviewer-plan to code-reviewer<br/>grok to model:grok-4.5 — pins skip the profile"]
        P3["3 · Capability to concrete model<br/>llm_profiles, then mode, then hardware tier<br/>coder + best-cloud + 64gb to gemini-pro"]
        P4["4 · Model to endpoint<br/>url, auth, wire format"]
        P1 --> P2 --> P3 --> P4
    end

    P4 --> ANT["anthropic<br/>forwardAnthropic"]
    P4 --> GEM["gemini_ai / gemini_vertex<br/>forwardGemini"]
    P4 --> XAI["xai / openai<br/>forwardOpenAI, Responses API"]
    P4 --> ORT["openrouter<br/>forwardAnthropic"]
    P4 --> OLL["ollama_local / ollama_cloud<br/>forwardAnthropic, or forwardOllamaLegacy"]
```

**The one idea worth internalizing:** most agents name a *job*, not a model. `coder` is a role. Which
model actually serves it is a runtime decision made by the proxy from three inputs — the capability,
the [routing mode](#routing-modes), and the detected hardware tier. Swapping a model is a one-value
edit in `config/model-map.json`; **agent files are never touched.**

The five named agents (`grok`, `deepseek`, `qwen`, `kimi`, `gemini`) are the deliberate exception:
they map to a `model:` pin and bypass capability resolution entirely, so "ask agent grok" always
reaches Grok.

**How the agent name survives the trip.** Claude Code validates the Agent tool's `model` field
against a fixed enum (`sonnet` / `opus` / `haiku` / `fable`), and c-thru's own rule forbids hooks from
rewriting `body.model` — a second rewriting path would silently drift from `config/model-map.json`.
So the hook does something narrower: it prepends a signed marker to the *prompt text*. The proxy
reads that prefix off the first message, verifies the HMAC against a `0600` secret at
`~/.claude/proxy.agent-token`, strips it, and only then decides which API to call. The model field
stays untouched end to end; **the proxy is the only component that picks a model.**

### View 2 — step-through of one request

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant CC as Claude Code harness
    participant Hook as PreToolUse hook
    participant Proxy as claude-proxy
    participant Map as model-map.json
    participant Up as Upstream API

    You->>CC: "implement the JWT middleware"
    CC->>CC: main loop picks the coder agent
    CC->>Hook: Agent tool call, subagent_type coder

    rect rgb(238, 244, 255)
    Note over Hook: TAG — the prefix is added here
    Hook->>Hook: HMAC-SHA256 over the agent name
    Hook-->>CC: prompt = sentinel + original prompt<br/>model = sonnet, a placeholder for the harness enum
    end

    CC->>Proxy: POST /v1/messages

    rect rgb(240, 248, 240)
    Note over Proxy,Map: RESOLVE — the only place a model is chosen
    Proxy->>Proxy: parse prefix, verify HMAC, strip from body
    Proxy->>Map: agent_to_capability, key coder
    Map-->>Proxy: capability coder
    Proxy->>Map: llm_profiles coder, mode best-cloud, tier 64gb
    Map-->>Proxy: gemini-pro
    Proxy->>Map: which endpoint serves gemini-pro
    Map-->>Proxy: gemini_ai — url, auth, format gemini
    end

    rect rgb(255, 248, 236)
    Note over Proxy,Up: TRANSLATE — Anthropic wire format in, Gemini out
    Proxy->>Up: forwardGemini, generateContent
    Up-->>Proxy: 200, streamed response
    end

    Proxy->>Proxy: translate Gemini SSE back to Anthropic SSE
    Proxy-->>CC: stream + header x-c-thru-resolved-via<br/>capability coder, served_by gemini-pro, tier 64gb, mode best-cloud
    CC-->>You: the coder agent's answer
```

The response leg is not a mirror image. Going out, c-thru **resolves**; coming back, it **normalizes**
— Gemini or OpenAI-shaped responses are translated into Anthropic SSE so the harness never learns it
was talking to anything else. Two observability details ride along: `x-c-thru-resolved-via` names who
actually served the request, and because headers cannot be set once streaming has begun, Gemini
thinking-token counts arrive as a custom `c-thru-thinking-tokens` SSE event rather than a header.

That header is the honest answer to "which model actually ran?" — see
[Verifying which agent ran](#verifying-which-agent-ran).

### View 3 — when a backend fails

Failover is the reason the indirection earns its keep. The client asked for `coder`; it never asked
for Gemini, so the proxy is free to serve `coder` from somewhere else.

```mermaid
flowchart TD
    START["Upstream call fails<br/>connection error, 401, 403, 404, 429, or any 5xx"] --> WINDOW

    WINDOW{"Have bytes already<br/>streamed to the client?"}
    WINDOW -->|"yes — too late to reroute"| SURFACE["Surface the error<br/>a half-sent stream cannot be rewound"]
    WINDOW -->|"no"| GATE

    GATE{"on_failure for<br/>this capability"}
    GATE -->|"hard_fail<br/>reviewer-security, debugger-hard"| STOP["Clean error, no substitute<br/>a weaker model here would be worse than failing"]
    GATE -->|"cascade — the default"| S1

    S1["1 · Endpoint fallback_to<br/>gemini_ai to claude-sonnet-5"] --> S2
    S2["2 · Capability fallback_to<br/>coder to coder-fallback · planner to planner-hard"] --> S3
    S3["3 · Capability fallback chain for this tier<br/>ordered by quality_tolerance_pct"] --> S4
    S4["4 · Local terminal fallback<br/>best-local modes step out to best-cloud"] --> S5
    S5["5 · Global default route"] --> EXHAUST["Every hop exhausted — return the error"]

    S1 -.->|"a hop answers"| OK
    S2 -.-> OK
    S3 -.-> OK
    S4 -.-> OK
    S5 -.-> OK

    OK["Serve the response normally<br/>x-c-thru-resolved-via names who really answered"]
```

Walking the shipped config for our example: `coder` resolves to `gemini-pro` on the `gemini_ai`
endpoint. If Gemini 500s, stage 1 fires — `endpoints.gemini_ai.fallback_to` is `claude-sonnet-5` — and
the same request is transparently re-sent to Anthropic. The subagent never sees an error; only
`x-c-thru-resolved-via` records that `served_by` changed.

Three properties are worth calling out, because they are what make this safe rather than merely
clever:

- **Failover crosses vendors, not just models.** Stage 1 hops to a different provider, wire format
  and all. That is only possible because the proxy owns translation.
- **A 400 is not retried.** Malformed requests fail the same way on every backend; retrying would
  just multiply the error. Only connection errors, 401/403/404, 429, and 5xx cascade.
- **Some capabilities refuse to degrade.** `reviewer-security` and `debugger-hard` ship with
  `on_failure: "hard_fail"`. For a security review, a quietly-substituted weaker model is a worse
  outcome than a visible failure, so the cascade is skipped entirely.

Every branch and guard, with source anchors:
[docs/architecture-diagrams.md § 2](docs/architecture-diagrams.md#2-model-resolution--fallback-cascade).

---

## Routing modes

Set with `CLAUDE_LLM_MODE` (or `--mode <name>` on the CLI):

| Mode | Description |
|---|---|
| `best-cloud` | Anthropic + Gemini cloud; local fallback at 64 GB+ |
| `best-cloud-oss` | **Default.** Cloud OSS (DeepSeek, Kimi, GLM via `*:cloud` / OpenRouter) |
| `best-local-oss` | Fully local (Phi, Qwen, Devstral) |
| `best-cloud-gov` | US-Gov compliant cloud (non-Chinese-origin) |
| `best-local-gov` | US-Gov compliant local |

Hardware tier is auto-detected from `os.totalmem()`; override with `CLAUDE_LLM_PROFILE` (or `--profile <tier>`): `16gb` / `32gb` / `48gb` / `64gb` / `128gb`.

---

---

## Use cases

What c-thru is *for* — the scenarios the router/proxy/fleet exist to serve. Each maps to a [routing mode](#routing-modes) and exercises a representative slice of the [agent fleet](#agents); the [Agent routing reference](#agent-routing-reference) shows exactly which model each agent lands on.

| # | Use case | Mode(s) | Representative agents |
|---|---|---|---|
| 1 | **Fully-local / air-gapped dev** — no cloud egress; everything on local Ollama | [`best-local-oss`](#routing-modes) | `planner`, `coder`, `tester`, `docs` |
| 2 | **Cost-optimized mixed cloud** — OSS cloud for bulk work, Anthropic only for the hard tiers | [`best-cloud-oss`](#routing-modes) | `coder`, `debugger-hard`, `planner-hard` |
| 3 | **Max-quality cloud** — Opus / Sonnet / Gemini per role | [`best-cloud`](#routing-modes) | `planner-hard`, `reviewer-security`, `coder` |
| 4 | **Compliance / data-sovereignty** — Chinese-origin models filtered out | [`best-cloud-gov`](#routing-modes) / [`best-local-gov`](#routing-modes) | `planner`, `code-reviewer`, `tester` |
| 5 | **Hardware-tiered auto-scaling** — same config; `16gb`→`128gb` resolves to different concrete models | any (varies by `--profile`) | whole fleet |
| 6 | **Agentic wave planning** — `/cplan` drives a planner→coder→reviewer→tester→docs pipeline with state | any | `plan-scheduler`, `planner`, `coder`, `code-reviewer`, `tester`, `docs` |
| 7 | **Role-based model mixing in one session** — Claude plans, local Qwen codes, Gemini debugs | [`best-cloud`](#routing-modes) | `planner` (Anthropic), `coder`/`tester` (Ollama), `debugger-investigate` (Gemini) |
| 8 | **Fallback-chain resilience** — primary backend down → cascade to the next; `hard_fail` tiers opt out | any | `coder`→`coder-fallback`, `reviewer-security` (`hard_fail`) |
| 9 | **Runtime remap without restart** — edit the model-map + SIGHUP reload | any | whole fleet |
| 10 | **Observability / audit** — journaling + `x-c-thru-*` headers + usage-stats for routing forensics | any | whole fleet — see [Verifying which agent ran](#verifying-which-agent-ran) |

---

---

## Configuration

Three-tier merge for the profile graph at `~/.claude/`:

1. `model-map.system.json` — shipped defaults (overwritten on each install)
2. `model-map.overrides.json` — your customizations (created empty, never overwritten)
3. `model-map.json` — derived merge (regenerated by the proxy on startup)

A project can opt out of the global graph by placing its own `model-map.json` at `$PWD/.claude/model-map.json` — that file is selected as its own DAG rather than merged on top of the profile graph. `CLAUDE_MODEL_MAP_PATH` overrides everything.

Schema reference, route/endpoint/profile structure, and the full `model_overrides` semantics: [`CLAUDE.md`](CLAUDE.md).

---

---

## Agents

27 agents declare `model: <agent-name>` in frontmatter (brand agents pin via `model:` to a concrete model). The proxy resolves
`agent-name → agent_to_capability → llm_profiles[capability][mode][tier] → concrete model`
at request time. Agent files are never edited when you remap models.

The fleet ships with the **CLI install** (it depends on `--agents` injection by `tools/c-thru`):

- **Pipeline (13):** `planner`, `planner-hard`, `explore`, `coder`, `coder-fallback`, `tester`, `docs`, `code-reviewer`, `reviewer-plan`, `reviewer-security`, `debugger-hypothesis`, `debugger-investigate`, `debugger-hard`.
- **Utility (9):** `vision`, `pdf`, `writer`, `edge`, `generalist`, `fast-generalist`, `fast-scout`, `long-context`, `plan-scheduler`.

Pipeline agents end each response with an `UNBLOCKED_TASKS` block of `Task()` calls naming the next agent(s) — the inter-agent dispatch graph is verified by `test/agent-dispatch-graph.test.js`. Full wave lifecycle and STATUS contracts: [`docs/agent-architecture.md`](docs/agent-architecture.md).

Agents are selected by matching the task against each agent's frontmatter `description`. To write one that gets picked, follow [`docs/agent-authoring.md`](docs/agent-authoring.md) (enforced by `test/agent-description-quality.test.js`).

### Agent routing reference

The full mapping, all the way through the implementation: **agent → capability → concrete model (per mode) → endpoint**. Models shown at the reference tier **`64gb`**; the columns are the three primary [routing modes](#routing-modes). The endpoint column is for `best-cloud` (**table column**; product default mode is [`best-cloud-oss`](#routing-modes)); `test/agent-mapping-complete.test.js` verifies that *every* agent resolves to a live endpoint across all 5 modes × 5 tiers, so this table can't silently drift.

> This table is **generated** from `config/model-map.json` — do not hand-edit the rows between the sentinel
> markers. Regenerate after any config bump with `make docs` (or `node tools/gen-routing-doc.js`).
> Drift is caught by `node tools/gen-routing-doc.js --check`, registered in the hermetic suite
> (`make test` / `test/run-all.sh`). See [`docs/derived-artifacts.md`](docs/derived-artifacts.md).

<!-- BEGIN routing-table (generated by tools/gen-routing-doc.js — run it, don't hand-edit) -->
| Agent | Capability | `best-cloud` | `best-cloud-oss` | `best-local-oss` | Endpoint (`best-cloud`) |
|---|---|---|---|---|---|
| `code-reviewer` | `code-reviewer` | `claude-sonnet-5` | `kimi-k2.7-code:cloud` | `qwen3.6:35b` | `anthropic` |
| `coder` | `coder` | `gemini-pro` | `kimi-k2.7-code:cloud` | `qwen3.6:35b` | `gemini_ai` |
| `coder-fallback` | `coder-fallback` | `gemini-pro-latest` | `kimi-k2.7-code:cloud` | `qwen3.6:35b` | `gemini_ai` |
| `debugger-hard` | `debugger-hard` | `claude-opus-4-8` | `kimi-k2.7-code:cloud` | `qwen3.6:35b` | `anthropic` |
| `debugger-hypothesis` | `debugger-hypothesis` | `gemini-pro` | `kimi-k2.7-code:cloud` | `qwen3.6:35b` | `gemini_ai` |
| `debugger-investigate` | `debugger-investigate` | `gemini-pro` | `kimi-k2.7-code:cloud` | `qwen3.6:35b` | `gemini_ai` |
| `deepseek` &nbsp;⚠ | `model:deepseek-v4-pro:cloud` | `—` | `—` | `—` | `—` |
| `docs` | `docs` | `gemma4:26b` | `gemma4:26b` | `qwen3.6:35b` | `ollama_local` |
| `edge` | `edge` | `gemma4:e4b` | `gemma4:e4b` | `gemma4:e4b` | `ollama_local` |
| `explore` | `explore` | `gemini-pro-latest` | `qwen3.6:35b-a3b-coding-nvfp4` | `qwen3.6:35b-a3b-coding-nvfp4` | `gemini_ai` |
| `fast-generalist` | `fast-generalist` | `gemma4:e4b` | `qwen3.6:35b` | `gemma4:e4b` | `ollama_local` |
| `fast-scout` | `fast-scout` | `phi4-mini:3.8b` | `phi4-mini:3.8b` | `phi4-mini:3.8b` | `ollama_local` |
| `gemini` &nbsp;⚠ | `model:gemini-pro` | `—` | `—` | `—` | `—` |
| `generalist` | `generalist` | `claude-sonnet-5` | `glm-5.2:cloud` | `qwen3.6:35b` | `anthropic` |
| `grok` &nbsp;⚠ | `model:grok-4.5` | `—` | `—` | `—` | `—` |
| `kimi` &nbsp;⚠ | `model:kimi-k2.7-code:cloud` | `—` | `—` | `—` | `—` |
| `long-context` | `long-context` | `claude-sonnet-5` | `deepseek-v4-pro:cloud` | `qwen3.6:35b` | `anthropic` |
| `pdf` | `pdf` | `claude-sonnet-5` | `qwen3.6:35b` | `qwen3.6:35b` | `anthropic` |
| `plan-scheduler` &nbsp;⚠ | `fast-generalist` | `gemma4:e4b` | `qwen3.6:35b` | `gemma4:e4b` | `ollama_local` |
| `planner` | `planner` | `claude-fable-5` | `deepseek-v4-pro:cloud` | `qwen3.6:35b` | `anthropic` |
| `planner-hard` | `planner-hard` | `claude-fable-5` | `deepseek-v4-pro:cloud` | `qwen3.6:35b` | `anthropic` |
| `qwen` &nbsp;⚠ | `model:qwen3.6:35b` | `—` | `—` | `—` | `—` |
| `reviewer-plan` &nbsp;⚠ | `code-reviewer` | `claude-sonnet-5` | `kimi-k2.7-code:cloud` | `qwen3.6:35b` | `anthropic` |
| `reviewer-security` | `reviewer-security` | `claude-opus-4-8` | `deepseek-v4-pro:cloud` | `qwen3.6:35b` | `anthropic` |
| `tester` | `tester` | `qwen3.6:35b-a3b-coding-nvfp4` | `qwen3.6:35b-a3b-coding-nvfp4` | `qwen3.6:35b-a3b-coding-nvfp4` | `ollama_local` |
| `vision` | `vision` | `claude-sonnet-5` | `qwen3.6:35b` | `qwen3.6:35b` | `anthropic` |
| `writer` | `writer` | `claude-sonnet-5` | `glm-5.2:cloud` | `qwen3.6:35b` | `anthropic` |
<!-- END routing-table -->

**⚠ Non-1:1 rows.** Two agents intentionally route to a *different* capability than their own name:
`reviewer-plan` → `code-reviewer` and `plan-scheduler` → `fast-generalist`. Every other agent maps 1:1.

**Utility passthroughs.** `WebSearch`, `WebFetch`, and `Monitor` are not agent files — they're tool calls mapped to `fast-scout` in `agent_to_capability` for observability only; the [router hook](#verifying-which-agent-ran) logs their capability but does **not** override their model (doing so would corrupt the tool's input).

**Gov modes.** `best-cloud-gov` / `best-local-gov` apply the same mapping but block Chinese-origin models (`qwen*`, `deepseek*`, `glm*`, …), substituting the next non-blocked model in the chain.

### Verifying which agent ran

"Which agent actually ran?" is observable on three surfaces — pick the cheapest for your purpose:

| Surface | Where | Carries |
|---|---|---|
| **Response headers** | `x-c-thru-resolved-via` (JSON), `x-c-thru-served-by` on every proxied response | resolved `capability`, `served_by` model, `tier`, `mode` |
| **Journal** | `~/.claude/journal/<date>/<capability>.jsonl` (opt-in: `CLAUDE_PROXY_JOURNAL=1`) | per-request `capability` + `served_by`, auth-scrubbed |
| **Usage stats** | `~/.claude/usage-stats.json` → `by_agent[name].served_by` | cumulative per-agent model + call counts |

The prompt→agent seam itself lives in `tools/c-thru-agent-router-hook.sh` (a `PreToolUse` hook): because Claude Code's Agent tool ignores the frontmatter `model:` field ([bug #44385](https://github.com/anthropics/claude-code/issues/44385)), the hook rewrites an Agent call's `subagent_type` → `agent_to_capability[…]` → the request `model`. That's the deterministic point where "a prompt picked agent X" becomes a concrete model on the wire.

Tests: `test/agent-mapping-complete.test.js`, `test/agent-invocation-headers.test.js`, `test/agent-router-hook.test.js`, optional `test/agent-scenarios-e2e.sh`. See [Appendix D](#appendix-d-tests-and-contributor-checks).


---

---

## Reliability features

- **Catch-all forwarder** — anything not explicitly translated is passed through to the configured Anthropic endpoint (or returns a structured 501 if none is configured). Long-lived SSE and slow batch endpoints have idle-timeout carve-outs.
- **`x-c-thru-translation-gap` header** — when Gemini translation drops a content-block type (`redacted_thinking`, `server_tool_use`, MCP blocks, etc.), the dropped types are surfaced on the response so callers see the loss instead of guessing.
- **`fallback_to` retry chains** — endpoint-level fallback on 5xx / 429 / network errors. Cycle detection per-request; resets on SIGHUP config reload (`CONFIG_VERSION` bump). `on_failure: "hard_fail"` opts out for security-sensitive capabilities.
- **Per-request journaling** — opt-in via `CLAUDE_PROXY_JOURNAL=1`. Writes JSONL to `~/.claude/journal/YYYY-MM-DD/<capability>.jsonl` with auth headers scrubbed. See [`docs/journaling.md`](docs/journaling.md).
- **SIGHUP-safe reload** — `c-thru reload` triggers a config re-read; read errors keep the previous live config rather than crashing.

---

---

## Further reading

- [`docs/getting-started.md`](docs/getting-started.md) — onboarding for new contributors (clone → first change → green suite)
- [`CLAUDE.md`](CLAUDE.md) — full developer reference (env vars, runtime control, model-map schema, contributor invariants)
- [`docs/anthropic-api-coverage.md`](docs/anthropic-api-coverage.md) — endpoint × backend coverage matrix, content-block sub-matrix, server-tool sub-matrix
- [`docs/openai-gap-roadmap.md`](docs/openai-gap-roadmap.md) — OpenAI / Responses-path coverage inventory and gap roadmap
- [`docs/headers.md`](docs/headers.md) — every `x-c-thru-*` response header (routing, cache, translation gaps, thinking observability, deprecation)
- [`docs/env-vars.md`](docs/env-vars.md) — full environment variable reference
- [`docs/subscription-auth.md`](docs/subscription-auth.md) — using Claude.ai subscription instead of API billing
- [`docs/agent-architecture.md`](docs/agent-architecture.md) — wave lifecycle, STATUS contracts, escalation chain
- [`docs/journaling.md`](docs/journaling.md) — per-request JSONL schema and storage layout

---

---

## Appendix A: CLI install (for contributors and advanced users)

The CLI install adds the `c-thru` terminal binary and the surfaces that depend on it (agent fleet, MCP server, control subcommands, flag-driven routing). Use it if you want flag-driven mode/profile selection, want to inspect resolution with `c-thru explain`, or you're contributing to the repo. First-contribution walkthrough: [`docs/getting-started.md`](docs/getting-started.md).

```bash
git clone https://github.com/whichguy/c-thru.git
cd c-thru
bash install.sh
```

(`install.sh` is invoked with `bash` so a fresh checkout works without a git executable bit.)

`install.sh` symlinks a curated tool set into `~/.claude/tools/` and seeds `~/.claude/model-map.system.json` from `config/model-map.json`. User overrides go in `~/.claude/model-map.overrides.json` and are preserved across upgrades. Full filesystem footprint: see the "Filesystem footprint" section of [`CLAUDE.md`](CLAUDE.md).

To reverse the install (overrides preserved):

```bash
bash uninstall.sh --dry-run
bash uninstall.sh
```

Verify:

```bash
~/.claude/tools/c-thru list                      # show active profile, routes, Ollama models
c-thru                                           # launch Claude Code with default routing
c-thru --mode best-local-oss                     # force fully-local Ollama routing
c-thru --mode best-cloud-oss                     # OSS cloud via OpenRouter
c-thru --route background --model gemma4:26b     # named route + explicit model
```

---

---

## Appendix B: CLI reference

`cthru` is installed as a convenience alias for `c-thru` — the two are identical (`cthru -p …` ≡ `c-thru -p …`).

| Subcommand | Effect |
|---|---|
| `c-thru list` | Active profile, routes, custom modes, Ollama models |
| `c-thru reload` | SIGHUP proxy, wait for `/ping`, print new tier |
| `c-thru restart [--force]` | Stop + re-spawn proxy |
| `c-thru explain --capability X --mode M [--tier T]` | Print resolution chain, no real request |
| `c-thru stats` / `c-thru stats clear` | Per-agent/model usage stats |
| `c-thru check-deps [--fix]` | Audit system dependencies |
| Native Claude Code subcommands (`agents`, `auth`, `auto-mode`, `doctor`, `gateway`, `install`, `mcp`/`plugin`/`plugins`, `project`, `setup-token`, `ultrareview`, `update`/`upgrade`) | Pass through untouched to the real `claude` binary |

| Flag | Sets env | Effect |
|---|---|---|
| `--route <name>` | — | Use a named route from `model-map.json` |
| `--model <name>` | — | Override model for this invocation |
| `--mode <m>` | `CLAUDE_LLM_MODE` | Routing mode |
| `--profile <t>` | `CLAUDE_LLM_PROFILE` | Force hardware tier |
| `--memory-gb <n>` | `CLAUDE_LLM_MEMORY_GB` | Override RAM detection |
| `--bypass-proxy` | `CLAUDE_PROXY_BYPASS=1` | Skip proxy entirely on the native `api.anthropic.com` path; other explicit routes fail fast because their protocol/auth/path adaptation requires the proxy |
| `--journal` | `CLAUDE_PROXY_JOURNAL=1` | Per-request journaling |
| `--proxy-debug [N]` | `CLAUDE_PROXY_DEBUG=N` | Proxy verbose logs |
| `--router-debug [N]` | `C_THRU_DEBUG=N` | Router verbose logs |
| `--no-update` | `C_THRU_NO_UPDATE=1` | Skip git self-update |

**Flag precedence**, when combined on one invocation:
1. `--model <name>` forces a concrete model for this invocation, overriding `--route` if both are passed.
2. `--route <name>` resolves to a model via `model-map.json`, used when `--model` is absent.
3. `--mode <m>` and `--profile <t>` are orthogonal — they select the hardware-tier slot the *proxy* uses to resolve capability-based routing (agents, fallbacks), independent of any explicit `--model`/`--route` pin.

Full env-var reference: [`docs/env-vars.md`](docs/env-vars.md). Runtime control details: [`CLAUDE.md`](CLAUDE.md).

---

---

## Appendix C: Plugin vs CLI + entry points

The marketplace plugin is the right starting point for most users. The CLI install path (`bash install.sh`, see [Appendix A](#appendix-a-cli-install-for-contributors-and-advanced-users)) adds a `c-thru` terminal binary and the surfaces that need it: the agent fleet, the `llm-capabilities` MCP server, runtime control subcommands, and flag-driven mode/profile selection.

| Surface | Plugin (marketplace) | CLI (`bash install.sh`) |
|---|:---:|:---:|
| `claude-proxy` runtime + auto-spawn on session start | ✓ | ✓ |
| Model-map seeding (`model-map.system.json`, overrides preserved) | ✓ | ✓ |
| `ANTHROPIC_BASE_URL` auto-registration in settings | ✓ | (set per launch) |
| Slash command `/c-thru-status` | ✓ | ✓ |
| Slash command `/cplan` (needs `planning-suite`; full 27-agent fleet is CLI inject only — see row below) | ✓ | ✓ |
| Skills `c-thru-plan`, `c-thru-config`, `c-thru-control` | ✓ | ✓ |
| User-wide hooks — fire in every Claude Code session (SessionStart, UserPromptSubmit, PostToolUse, PreCompact) | ✓ | — |
| Ephemeral hooks — injected per `c-thru` launch only (no static project `.claude` hooks) | — | ✓ |
| `c-thru` binary on PATH | — | ✓ |
| Control subcommands (`list`, `reload`, `restart`, `explain`, `stats`, `check-deps`) | — | ✓ |
| Flags (`--mode`, `--profile`, `--bypass-proxy`, `--journal`, `--router-debug`) | (use env vars) | ✓ |
| Agent fleet (27 agents) injected via `--agents` | — | ✓ |
| `llm-capabilities` MCP server injected via `--settings` | — | ✓ |
| Contributor checks (`c-thru-contract-check`, `c-thru-hygiene-check`) | — | ✓ |

Plugin hooks fire globally in every Claude Code session; the CLI injects the same shared fleet ephemerally on each `c-thru` launch (`install.sh` strips durable c-thru fleet hooks from `~/.claude/settings.json`; project `.claude/settings.json` does not register c-thru hooks). Prefer **one** of plugin vs CLI inject — both together can double-fire the same hooks.

TUI garble / input junk under c-thru: see [`docs/tui-troubleshooting.md`](docs/tui-troubleshooting.md).

Plugin users can still drive routing via environment variables — `CLAUDE_LLM_MODE`, `CLAUDE_LLM_PROFILE`, `CLAUDE_LLM_MEMORY_GB`, `CLAUDE_PROXY_BYPASS`, `CLAUDE_PROXY_JOURNAL` all work the same way the CLI flags do. The flags are a CLI convenience, not a capability difference at the proxy layer.

### Entry points: what each path actually guarantees

Hooks and agent scripts live **in the git repo** (`tools/c-thru-*.sh`, mirrored under `plugins/c-thru/hooks/`). They are **enabled** either by the marketplace plugin (user-wide, always-on) or by **`c-thru` ephemeral inject** (CLI path only — not durable project settings).

| Entry point | Proxy | Fleet `--agents` / system-prompt inject | Brand `--model` (e.g. `grok`) | Hooks |
|---|:---:|:---:|:---:|---|
| `cthru` (main chat) | ✓ | ✓ | ✓ (resolved on wire) | CLI ephemeral inject per launch |
| `cthru agents --model grok` | ✓ (brand models) | — (commander rejects) | Re-inserted; proxy resolves | No CLI ephemeral inject (plugin hooks only if installed) |
| `cthru agents --model sonnet` | optional / not forced | — | Claude-native alias kept | No CLI ephemeral inject (plugin hooks only if installed) |
| Brand Agent tool inside main `cthru` (“ask grok”) | ✓ (sentinel + map) | Parent has fleet; leaf is one-shot | Via `agent_to_capability` | Parent session hooks |
| `grok-cc` / Grok Build CLI | external | n/a | CLI login (preferred) or API-key fallback | n/a |
| Plain `claude` (no plugin, no `cthru`) | — | — | Anthropic only | none from c-thru |
| Plain `claude` + marketplace plugin | ✓ (plugin SessionStart) | — (no CLI fleet inject) | map if proxy routes | Plugin always-on |

**Pick the right entry point:** full planner/coder fleet → main `cthru` chat (CLI install). Brand opinion leaf → “ask agent grok” inside that chat. Subscription-backed Grok-owned implement/review loop → `grok-cc`.

**Routing forensics without fleet inject:** use `c-thru list` or `/c-thru-status` (needs a live proxy — started by main `cthru` or a native brand `agents` launch). Port discovery uses `proxy.pid` / `CLAUDE_PROXY_PORT` / `ANTHROPIC_BASE_URL`; agent-view does not inject SessionStart control-plane hooks.

---

### Brand agents and Grok surfaces

Brand-name agents (`grok`, `deepseek`, `qwen`, `kimi`, `gemini`) ship with the
**CLI install** only: say "ask agent grok …" inside a `cthru` session. Definitions
are runtime-injected via ephemeral `--agents` JSON — not installed into
`~/.claude/agents/`. Chinese-origin brands are filtered under `best-cloud-gov` /
`best-local-gov`.

Grok has three surfaces (see
[docs/agent-architecture.md § Grok surfaces](docs/agent-architecture.md#grok-surfaces-brand-vs-gov-vs-cli)):
(A) brand leaf for short opinions via the Anthropic↔xAI Responses translator,
(B) silent `best-cloud-gov` routing of `generalist`/`writer`, and (C) the separate
**Grok Build CLI** (`grok-cc`) for subscription/login-backed implement/review.
Prefer `grok-cc` for multi-file Grok-owned work.

Anthropic does not officially support routing Claude Code to non-Claude models —
any full-session non-Claude path is an opt-in compatibility surface, not an
Anthropic-supported configuration.

---

## Appendix D: tests and contributor checks

```bash
make check              # syntax checks (bash -n, node --check) + schema validation
make test               # hermetic suite (proxy + model-map; skip slow smoke) (~2 min)
make test-all           # full suite including smoke / long e2e
make test-live-all      # strict full suite with every live/provider/model gate enabled
make test-fast          # deprecated alias for `make test`

# Targeted:
node test/anthropic-api-coverage.test.js     # endpoint × backend coverage matrix
node test/model-map-v12-adapter.test.js      # adapter regression
bash test/c-thru-bootstrap-auth-env.test.sh  # interactive auth bootstrap (TTY-mocked)
```

The plugin bundle at `plugins/c-thru/` must mirror the source `tools/` and `skills/` directories. After editing a source file, sync with `tools/sync-plugin-bundle.sh`.

### Suite gates (run by hand or via `make test`)

There is no required repo-local pre-commit / pre-push hook tree for c-thru today. The hermetic suite (`make test` / `test/run-all.sh --skip-smoke`) is the always-on gate and includes drift **Validators** such as:

- `tools/sync-plugin-bundle.sh --check`
- `node tools/gen-routing-doc.js --check`
- `node tools/check-diagram-sync.js`
- agent/skill **contract check** (`tools/c-thru-contract-check.sh`) and related harnesses

Run any piece directly:

```bash
bash tools/c-thru-contract-check.sh   # exit 0 = clean; exit 1 = contract violations
bash tools/c-thru-hygiene-check.sh    # working-tree hygiene check (not gated)
bash test/run-all.sh --skip-smoke     # default hermetic suite (or: make test)
bash test/run-all.sh                  # full suite including smoke (or: make test-all)
```

---

---

## License

MIT
