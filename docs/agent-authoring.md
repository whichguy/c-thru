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
  > architecture of", "what's the approach for", "break down this feature". Routes to Opus cloud…

- **`reviewer-security`** — `MUST BE USED for <enumerated scope>` (the mandate+scope pattern; no
  quoted examples needed).

  > MUST BE USED for any change touching authentication, authorization, tokens, crypto, input
  > validation, or external API calls. Security-focused code review: injection, credential leaks,
  > privilege escalation, OWASP Top 10. Hard-fail — no degraded substitute. Routes to Opus cloud…

- **`coder`** — `MUST BE USED` + quoted examples + a precondition + routing tail.

  > MUST BE USED for all code implementation tasks. Writes, edits, and refactors code according
  > to a plan. Use for "implement", "write the code for", "add this function", "edit this file".
  > Requires a plan from planner or clear unambiguous intent. Routes to Sonnet cloud…

## Don't touch the rest of the frontmatter

`name`, `model`, and `tier_budget` are validated by `tools/c-thru-contract-check.sh` and the
agent→capability tests — leave them exactly as-is when editing a description.
