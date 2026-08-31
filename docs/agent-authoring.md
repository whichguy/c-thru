# Authoring agent descriptions

Claude Code's Agent tool picks a subagent by **matching the task against each agent's
`description`** — the one-line `description:` field in `agents/<name>.md` frontmatter, injected
into the session as `--agents` JSON by `tools/c-thru` and reinforced by an "identify agents by
their descriptions and delegate" `--append-system-prompt`. A vague description means the agent is
never selected, no matter how good its system prompt is. **The description is the agent's only
discovery surface.**

`agents/CLAUDE.md` and `agents/AGENTS.md` are reserved scoped instruction files, not agent
definitions. The launcher excludes both from the ephemeral agent store and `--agents` payload.

This guide documents the house conventions that make a description discoverable. They are
enforced by `test/agent-description-quality.test.js` (fail-closed), so a new agent must follow
them to land green.

## The four rules

A description must have all four:

1. **Length ≥ ~120 chars.** Enough room for a trigger, an example, and a disambiguation. Too
   short and there's nothing for the matcher to grab.

2. **A trigger phrase** — the "when to pick me" signal. Use one of the recognized forms:

   | Phrase | Use it for |
   |---|---|
   | `MUST BE USED` | the agent that should *always* handle a category (`coder`, `planner`, `reviewer-security`) |
   | `Use PROACTIVELY` | an agent the model should reach for without being asked (`code-reviewer`, `docs`, `explore`, `fast-scout`) |
   | `Use when <X> fails` / `Use when <condition>` | conditional/fallback agents (`coder-fallback`, `debugger-hypothesis`) |
   | `Use for <query>` / `Use after` / `Use to` / `Use in` | scoped specialists (`tester`, `microtask`, `plan-scheduler`) |

3. **At least one concrete example** — quoted phrasings of what the user might actually say, so
   the matcher has literal strings to align against:

   > `Use for "implement", "write the code for", "add this function", "edit this file".`

   (Gold-standard exception: a `MUST BE USED for <enumerated scope of ≥3 terms>` mandate — like
   `reviewer-security` — counts as concrete enough on its own and may omit quoted examples.)

4. **A disambiguation clause** — tell the matcher when *not* to pick this agent and which agent to
   pick instead. This is what stops two agents fighting over the same task:

   > `Not for security audits — use reviewer-security for those.`
   > `Not for multi-step reasoning — use generalist instead.`
   > `Prefer over planner when the task spans >5 files…`

## Keep routing out of selector descriptions

Do not put concrete model names or hand-maintained routing tails in `description`. The selector's
job is to choose the right role; the actual mode × tier mapping lives in
`config/model-map.json#agent_to_capability` + `llm_profiles`, is rendered into the generated README
routing reference, and is verified by `test/agent-mapping-complete.test.js`. Keeping those concerns
separate prevents a stale model name from misleading both the user and the selector.

## Gold-standard templates

Copy the shape of these three:

- **`planner`** — `MUST BE USED` mandate + quoted examples.

  > MUST BE USED for all planning, architecture, and design tasks. Produces detailed
  > implementation plans before any code is written. Use for "plan how to", "design the
  > architecture of", "what's the approach for", "break down this feature".

- **`reviewer-security`** — `MUST BE USED for <enumerated scope>` (the mandate+scope pattern; no
  quoted examples needed).

  > MUST BE USED for any change touching authentication, authorization, tokens, crypto, input
  > validation, or external API calls. Security-focused code review: injection, credential leaks,
  > privilege escalation, OWASP Top 10. Hard-fail — no degraded substitute.

- **`coder`** — `MUST BE USED` + quoted examples + a precondition.

  > MUST BE USED for all code implementation tasks. Writes, edits, and refactors code according
  > to a plan. Use for "implement", "write the code for", "add this function", "edit this file".
  > Requires a plan from planner or clear unambiguous intent.

## Descriptions are validated for SELECTION, not just form

The four rules above check that a description is *well-formed*. A separate set of tests checks
that it is *discriminable* — i.e. that the description actually causes the right agent to be
picked for a realistic task, and crucially that it does **not** poach tasks meant for a
neighbour. All three tiers are driven by one shared labeled corpus,
`test/fixtures/agent-selection-corpus.json` (entries: `{id, prompt, expect:[primary, …acceptable],
note, ambiguous?, inline_ok?}`). Normal entries require an expected delegation;
`ambiguous:true` entries carry `expect:[]` and require no specialist; `inline_ok:true` entries
allow either an expected generalist delegation or an inline answer:

| Tier | Test | Cadence | What it checks |
|---|---|---|---|
| 1 — hermetic discriminability lint | `test/agent-selection-discriminability.test.js` | every run (fail-closed) | Each corpus task's wording lines up with its expected agent and is separable from the others — purely offline, no API calls |
| 2a — LLM-judge | `test/agent-selection-llm-judge.test.js` | nightly CI (`C_THRU_LIVE_SELECTION`) | An LLM judge, given only the injected descriptions + a task, picks the expected agent (or `none` for ambiguous tasks) |
| 2b — real-session offload scorecard | `test/agent-offload-coverage.js` | scheduled agent shard (`C_THRU_OFFLOAD`; one-run quality advisory) | Drives isolated real `claude -p` sessions and checks Claude actually delegates to the right subagent; ambiguous tasks must stay inline. Invocation and route integrity are mandatory. One-run selection quality becomes blocking only with the explicit `C_THRU_OFFLOAD_GATE=1` compatibility opt-in; promotion decisions use pooled repeated evidence. |

Tier 2b uses a bounded worker pool (`C_THRU_OFFLOAD_CONCURRENCY`, default 4, range 1–8).
Every fixture gets a distinct home, profile, temporary directory, working directory, proxy log,
and small representative code/docs/log artifacts. Explicit Claude credentials stay in the
environment; source subscription OAuth is resolved before home isolation and passed transiently;
a credential file is copied only as a fallback when no usable environment/source token exists.
Scratch cleanup and owned-process cleanup are mandatory, including internal errors and
SIGINT/SIGTERM/SIGHUP.

The harness sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: prompt-level concurrency belongs to
the bounded worker pool, while each selected Agent must finish and emit a completed transcript
result before that fixture can score. An `async_launched` record is launch evidence only and
fails closed instead of being counted as a successful offload.

A parsed `Agent` tool call is not enough to score. The harness joins the bounded tool-use
metadata to the isolated Claude transcript, derives the proxy-safe HMAC reference from the raw
Claude agent ID, and rejects arbitrary prompt prefixes or suffix-only matches.

The transcript join accepts either the exact original Agent prompt or the current Claude
PreToolUse representation: a valid agent-bound signed sentinel, the exact c-thru identity
guidance block when present, and then the exact original prompt. Once joined, the harness
requires a same-request lifecycle consisting of:

1. the matching signed sentinel override;
2. a `POST` whose normalized path is exactly `/v1/messages` (never
   `/v1/messages/count_tokens`);
3. the expected logical-role dispatch;
4. a non-aborted 2xx `request.complete`; and
5. forwarded child text linked to the original tool-use ID.

Any Claude/process error, malformed agent metadata, missing correlation edge, unsuccessful
Messages request, or cleanup failure fails the run even when the selection score is advisory.
The shared suite and every child remain under the repository-wide one-hour wall-clock ceiling.

The corpus is deliberately **non-circular**: prompts are phrased the way a real user would, *not*
by reusing the quoted example phrases from `agents/*.md` descriptions — otherwise Tier 1 and the
judge degrade into circular keyword matching. (Vision/PDF/long-context tasks are exercised by
Tiers 1 and 2a only; the real-session run skips them because the scratch harness can't furnish a
genuine image, PDF, or oversized file.)

**Adding a new agent therefore means adding ~3–4 corpus tasks for it** in
`test/fixtures/agent-selection-corpus.json`: natural-language prompts (not copies of your
description's examples) whose `expect[0]` is the new agent, plus genuinely-acceptable neighbours
in the rest of `expect`. Without them, the new agent is "never selected" in the scorecard and the
selection tiers can't tell whether its description actually works.

## Brand / named-model leaves (catalog)

Brand agents are **name-gated pin leaves** from `config/brand-agents.json`, generated by
`node tools/gen-brand-agents.js` into `agents/<id>.md` (ownership marker; do not hand-edit).
The proxy maps `agent_to_capability` → `model:<pin>`. Claude Code Agent tool `model` remains
the enum alias (hook injects `sonnet` etc.); routing identity rides the signed sentinel, not
the enum field.

**Do not confuse with role agents.** Roles win on task shape (`planner`, `coder`). Brands win
when the user **names** the model/family (`ask terra`, `what would opus say`). Short names
like `opus` / `sonnet` / `haiku` / `fable` are fleet brand leaves when present in `--agents` —
not a reason to avoid spawning them in favor of a generic built-in type.

**Description template (primaries — enforced by generator):**

> MUST BE USED when the user names &lt;Label&gt; — "ask &lt;id&gt;", …, "what would &lt;id&gt; say",
> "&lt;id&gt;'s take". Not for multi-file implementation — use coder instead. Not for a multi-model
> panel — use advisors instead.

**Aliases:** exact agent id only; never embed the bare primary name (poaches family asks).

**Tools:** omit `tools` (inherit full parent toolset). Shipped brand leaves do not deny tools.

| Do | Don’t |
|---|---|
| Edit `config/brand-agents.json` + regenerate | Hand-edit generated brand `agents/*.md` |
| Name-bound paraphrases only | Shared “second opinion” on every brand (collides with `advisors`) |
| Coder + advisors disambiguation walls | Expect `model: grok` alone to select xAI without the proxy map |
| Identity: report actual model if routing failed | Treat brand Grok as interchangeable with Grok Build CLI (`grok-cc`) |
| Codex sol/terra/luna: OpenAI API (`OPENAI_API_KEY`) | Assume ChatGPT Codex CLI subscription auth for brand leaves |

Fleet `--append-system-prompt` tells the **parent** to one-shot brand leaves for *ask &lt;name&gt;*
and to use `advisors` for multi-model panels. Grok multi-file implement: external `grok-cc` or
`coder`. Full ladder: `docs/agent-architecture.md` § Grok surfaces.

## The rest of the frontmatter

`name`, `model`, and `tier_budget` are validated by `tools/c-thru-contract-check.sh` and the
agent→capability tests — leave them exactly as-is when editing a description. Prefer omitting
`tools` so agents inherit the session toolset.

### `effort` — optional reasoning depth

Agent definitions may set Claude Code's native optional effort field:

```yaml
effort: high
```

Accepted values are `low`, `medium`, `high`, `xhigh`, and `max`. The ephemeral agent builder
copies a valid value into the injected `--agents` JSON and fails before launch on an invalid
value. When `effort` is omitted, the agent inherits the session effort; adaptive-reasoning models
still decide how much thinking an individual prompt needs within that setting. This inherited,
adaptive behavior is the recommended default unless a role has a measured reason to force a
different cost/latency envelope.

Prompt wording can also steer an adaptive model to think more or less for that task, but it does
not make C-Thru infer or rewrite the discrete `effort` field. Omit `effort` when prompt-sensitive
adaptation is desired; set it only when the role itself needs a stable posture.

Use `effort`, not a custom `thinking_level` field. Claude Code does not currently expose effort as
a per-invocation `Agent(...)` argument, and `CLAUDE_CODE_EFFORT_LEVEL` takes precedence over agent
frontmatter. C-Thru therefore does not infer or encode effort in the signed routing sentinel.

Under Claude Code's documented agent/API contract, the selected value is supplied as Anthropic
`output_config.effort`:

- Anthropic, OpenRouter, and modern Ollama Messages routes receive that field unchanged. Current
  Ollama's Anthropic adapter maps `low`/`medium`/`high`/`max` to its native thinking control and
  normalizes `xhigh` to `high`; C-Thru intentionally does not rewrite this to the OpenAI-only
  `reasoning_effort` field. The captured wire test proves transport to Qwen3.8, while whether a
  particular Ollama/Kimi model produces meaningfully different reasoning at every level remains a
  provider/live-inference question. The opt-in legacy Ollama `/api/chat` translator remains lossy
  and does not carry agent effort; shipped Ollama routes use the modern Messages path.
- OpenAI Responses maps it to `reasoning.effort`.
- xAI Responses preserves `low`/`medium`/`high` and clamps `xhigh`/`max` to `high` with an
  `x-c-thru-translation-gap` marker.
- Gemini 3 HTTP APIs map it to the closest supported `thinkingLevel`; Gemini 2.5 HTTP APIs receive
  an approximate `thinkingBudget`. The translator preserves the caller's hard `max_tokens` cap and
  `display: omitted`; model-specific coercions are exposed as translation gaps. This path calls
  Google's API directly and has no Gemini CLI dependency.

### `color` — not used (removed)

c-thru **does not** inject a `color` field into `--agents` JSON. Agent task-list badges render
plain. Any `color:` line left in an agent markdown file is **ignored** by `build_ephemeral_agents`
(skills may still declare their own skill-level `color:` for Claude Code’s skill UI — that path is
unrelated to fleet agent injection).

### Known limitation: same-basename profile shadow

`build_ephemeral_agents` links profile agents (`~/.claude/agents/<name>.md`) into the ephemeral
session dir **first**, so a user profile agent with the same basename as a fleet agent wins — and
the JSON entry is parsed from whatever landed in the session dir. c-thru does **not** override user
profile files for description/prompt/model.
