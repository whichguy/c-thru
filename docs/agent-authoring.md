# Authoring agent descriptions

Claude Code's Agent tool picks a subagent by **matching the task against each agent's
`description`** — the one-line `description:` field in `agents/<name>.md` frontmatter, injected
into the session as `--agents` JSON by `tools/c-thru` and reinforced by an "identify agents by
their descriptions and delegate" `--append-system-prompt`. A vague description means the agent is
never selected, no matter how good its system prompt is. **The description is the agent's only
discovery surface.**

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
   | `Use for <query>` / `Use after` / `Use to` / `Use in` | scoped specialists (`tester`, `edge`, `plan-scheduler`) |

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

## Optional: the routing tail

Many descriptions end with a short note on where the agent routes (`Routes to Opus cloud always;
Kimi K2.6 on best-cloud-oss.`). It's optional and purely informational — the actual mapping lives
in `config/model-map.json#agent_to_capability` + `llm_profiles`, and is verified by
`test/agent-mapping-complete.test.js`. Keep it accurate or omit it.

## Gold-standard templates

Copy the shape of these three:

- **`planner`** — `MUST BE USED` mandate + quoted examples + a routing tail.

  > MUST BE USED for all planning, architecture, and design tasks. Produces detailed
  > implementation plans before any code is written. Use for "plan how to", "design the
  > architecture of", "what's the approach for", "break down this feature". Routes to Fable cloud…

- **`reviewer-security`** — `MUST BE USED for <enumerated scope>` (the mandate+scope pattern; no
  quoted examples needed).

  > MUST BE USED for any change touching authentication, authorization, tokens, crypto, input
  > validation, or external API calls. Security-focused code review: injection, credential leaks,
  > privilege escalation, OWASP Top 10. Hard-fail — no degraded substitute. Routes to Opus cloud…

- **`coder`** — `MUST BE USED` + quoted examples + a precondition + routing tail.

  > MUST BE USED for all code implementation tasks. Writes, edits, and refactors code according
  > to a plan. Use for "implement", "write the code for", "add this function", "edit this file".
  > Requires a plan from planner or clear unambiguous intent. Routes to Sonnet cloud…

## Descriptions are validated for SELECTION, not just form

The four rules above check that a description is *well-formed*. A separate set of tests checks
that it is *discriminable* — i.e. that the description actually causes the right agent to be
picked for a realistic task, and crucially that it does **not** poach tasks meant for a
neighbour. All three tiers are driven by one shared labeled corpus,
`test/fixtures/agent-selection-corpus.json` (entries: `{id, prompt, expect:[primary, …acceptable],
note, ambiguous?}`; `ambiguous:true` entries carry `expect:[]` and assert that *no* specialist is
selected):

| Tier | Test | Cadence | What it checks |
|---|---|---|---|
| 1 — hermetic discriminability lint | `test/agent-selection-discriminability.test.js` | every run (fail-closed) | Each corpus task's wording lines up with its expected agent and is separable from the others — purely offline, no API calls |
| 2a — LLM-judge | `test/agent-selection-llm-judge.test.js` | nightly CI (`C_THRU_LIVE_SELECTION`) | An LLM judge, given only the injected descriptions + a task, picks the expected agent (or `none` for ambiguous tasks) |
| 2b — real-session offload scorecard | `test/agent-offload-coverage.js` | nightly CI (`C_THRU_OFFLOAD` + threshold gate) | Drives real `claude -p` sessions and checks Claude actually delegates to the right subagent from the description alone; ambiguous tasks must stay inline. Advisory locally; threshold-gated on CI |

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

## Brand / named-model leaves (grok, deepseek, kimi, qwen, gemini)

Brand agents are **gateway pin leaves**: the user asks for a vendor by name; the proxy maps
`agent_to_capability` → concrete model. Same Claude Code limits apply under LiteLLM/OpenRouter
(Agent `model` enum is only sonnet/opus/haiku/fable; OpenRouter’s `CLAUDE_CODE_SUBAGENT_MODEL`
is one model for *all* subagents unless the gateway has a per-agent channel like c-thru’s
sentinel).

**Tools:** omit the `tools` field so the subagent **inherits the full parent toolset**
(Claude Code default). Do not put a narrow allowlist on brand leaves. Optional
`disallowedTools` is supported by `build_ephemeral_agents` if you ever need a denylist, but
the shipped brand agents do not deny tools.

| Do in `agents/<brand>.md` | Don’t |
|---|---|
| Omit `tools:` (inherit all) | Restrict brand leaves to Read-only / no tools |
| Description: “Leaf: parent should spawn once… do not chain” | Expect `model: grok` alone to select xAI without the proxy map |
| Identity: report actual model; if not the brand, say routing may have failed | Roleplay “You are Grok” as the only control (masks mis-routing) |

Fleet `--append-system-prompt` also tells the **parent** to one-shot brand agents.

## Don't touch the rest of the frontmatter

`name`, `model`, and `tier_budget` are validated by `tools/c-thru-contract-check.sh` and the
agent→capability tests — leave them exactly as-is when editing a description. Prefer omitting
`tools` so agents inherit the session toolset.
