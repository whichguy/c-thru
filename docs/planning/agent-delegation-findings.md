# Agent delegation findings — why the agent fleet is idle, and what's fixable

**Status:** IMPLEMENTED (2026-06-16). **Method:** empirical — real `claude -p` sessions
(Claude Code 2.1.178) through `tools/c-thru`, observed via the PreToolUse hook log, stream-json,
and the proxy journal/`served_by`. The investigation below is preserved as the record; the
implemented design is summarized here.

## Implemented design — the hook→prompt sentinel handshake

The fix carries the agent identity to the proxy **in-band, per-request, statelessly** — so many
agents → many models work concurrently in one session:

- **Hook** (`tools/c-thru-agent-router-hook.sh`), on every Agent call: (1) injects a VALID model
  alias (`C_THRU_AGENT_FALLBACK_ALIAS`, default `sonnet`) to pass Claude Code's enum and as the
  proxy-absent fallback; (2) prepends a full-HMAC-SHA256
  `[[c-thru-agent:<subagent_type>:<signature>]]` marker to the task prompt, which becomes the
  subagent's first user message and rides in `body.messages`.
- **Proxy** (`tools/claude-proxy`), before `resolveBackend`: considers markers only in direct
  user string/`type:"text"` content and requires loopback + a nonempty
  `x-claude-code-agent-id` + a valid signature under the stable per-user 0600
  `proxy.agent-token`. A first-level agent does not carry a parent ID; when a nested agent
  supplies `x-claude-code-parent-agent-id`, the proxy validates it too. If the authenticated
  name resolves, it sets `body.model=<agent>`
  (→ agent→capability→model) and attributes usage to the AGENT. Nested assistant `tool_use`
  and user `tool_result` copies are ignored, and all marker strings are stripped recursively
  before either a primary or fallback upstream request.
- **Part D** (`tools/c-thru`, `C_THRU_PROXY_ALWAYS`, **default ON**, opt out with `=0`): routes the
  whole session through the proxy even in subscription/best-cloud mode (subagents inherit the
  session's `ANTHROPIC_BASE_URL`; the proxy forwards main-thread traffic upstream with the OAuth
  Bearer). Per-agent routing is an everyday feature, so it's on by default; **graceful fallback** —
  if the proxy can't be brought up, the session falls back to direct Anthropic (per-agent routing
  lost for that session only) instead of failing to launch, bounding the blast radius of the proxy
  being load-bearing for every session.

Agent definitions are untouched. The original pre-HMAC handshake was validated end-to-end
(proxy journal `served_by` + subagent self-report, distinguishing non-Anthropic models):
OSS mode — `coder`→`qwen3.6:35b-a3b-coding-nvfp4` and `fast-scout`→`phi4-mini:3.8b` in one
session; subscription mode (`C_THRU_PROXY_ALWAYS=1`) — main→`claude-sonnet-5`
(auth/streaming intact) and `fast-scout`→`phi4-mini:3.8b`. The current authenticated
handshake has gating hook/parser/spawned-proxy tests plus the opt-in strict
`claude-agent-route-live` suite for the real Claude Agent → spawned-agent-ID →
signed-marker seam. It is not part of the credential-free hermetic suite.
The stable agent token is separate from the control token so fixed-port proxies can be reused by
independent sessions. It is a same-user routing-integrity control, not a local privilege boundary:
a process that can read the 0600 token can sign/replay a marker if it also presents the delegated
`x-claude-code-agent-id` header. First-level agents have no parent ID; nested agents supply an additional
parent-agent correlation header. Known limitation: the sentinel lives in `body.messages[0]`, which
a long subagent run could compact away mid-task → graceful fallback to the alias model.

The remaining sections preserve the pre-fix Claude Code 2.1.178 investigation. Their present-tense
statements describe the historical failure state, not the implemented current path above.

## Historical TL;DR (pre-fix, Claude Code 2.1.178)

1. **The agent-router hook is *blocking* delegation to every c-thru agent.** It injects the
   *capability name* (e.g. `planner`) as the Agent tool's `model`. Current Claude Code validates
   that field against a 4-value enum — `sonnet`/`opus`/`haiku`/`fable` — and **rejects** anything
   else, so the delegation fails. Only built-in `general-purpose`/`Explore` (no capability mapping
   → hook passes them through) still work.
2. **Per-agent routing to a specific or non-Anthropic model is not possible in current Claude
   Code.** The only per-call lever (the Agent `model` param) accepts only the 4 aliases.
   Routing to an arbitrary model (e.g. `qwen3:1.7b`) works **only globally**, via
   `CLAUDE_CODE_SUBAGENT_MODEL` (one value for all subagents).
3. **The proxy is bypassed in subscription/best-cloud mode entirely** — c-thru launches Claude
   direct to `api.anthropic.com` with the OAuth token; the proxy is only inserted for
   non-Anthropic backends (Ollama/Gemini/localhost). So proxy `by_agent` stats cannot measure
   delegation in that mode.

Historical conclusion: the agents were not idle because their descriptions were weak — they were
being **blocked** before the authenticated sentinel path was implemented.

## The verified Agent-tool `model` contract (Claude Code 2.1.178)

What Claude Code accepts as a subagent's model, when injected per-call by the hook
(`updatedInput.model`):

| Injected value | Example | Result |
|---|---|---|
| Capability name (**pre-fix c-thru**) | `planner` | **BLOCKED** — orchestrator reports "value outside the allowed enum (sonnet, opus, haiku, fable)"; delegation fails, retries, falls back to `general-purpose` |
| Full Anthropic model id | `claude-opus-4-8` | **BLOCKED** — same enum rejection |
| Non-Anthropic / Ollama id | `qwen3:1.7b` | **BLOCKED** — subagent ran on the mode default, never `qwen3:1.7b` |
| Tier alias | `opus` | ✅ **Works** — delegation succeeds, subagent ran on `claude-opus-4-8` |
| Global env var (not per-call) | `CLAUDE_CODE_SUBAGENT_MODEL=qwen3:1.7b` | ✅ **Works** — subagent ran on `qwen3:1.7b` (confirmed by proxy `served_by` + the subagent's self-report); applies to **all** subagents |

Each row was observed end-to-end; the "works" rows were confirmed both by the subagent's
self-reported identity and (in local-OSS mode) by the proxy journal's `served_by` — so a
non-Anthropic result is genuine routing, not a coincidental Anthropic fallback.

## Root cause

`tools/c-thru-agent-router-hook.sh` exists as a workaround for the long-standing bug where the
Agent tool ignored the subagent definition's `model:` field (issue #44385). The workaround sets
`updatedInput.model = <capability>` per Agent call. Claude Code has since added **strict enum
validation** to that field. A capability name (`planner`, `coder`, `reviewer-security`, …) is not
in the enum, so the tool call is rejected — the workaround became a blocker.

The same invalid value sits in two more places, for the same reason:
- `agents/*.md` frontmatter `model:` is the capability name (`model: planner`, `model: coder`, …).
- the `--agents` JSON `model` field (built in `tools/c-thru` ~L299-329) carries it through.

Real-usage fingerprint: across 127 c-thru-repo sessions, the only c-thru agents that ever
delegated were `planner` (1×) and `reviewer-security` (2×), **all with 0 completed** — the
blocked-then-abandoned signature. Built-in `general-purpose` (10×) and `Explore` (3×) completed
normally because they have no capability mapping.

## The hard limitation

Claude Code 2.1.178 offers exactly two model-selection levers for subagents, and neither gives
per-agent routing to arbitrary models:

- **Per-call (Agent `model` param):** only `sonnet`/`opus`/`haiku`/`fable`. Per-agent, but
  Anthropic-tier only — cannot name a specific id or an OSS model.
- **Global (`CLAUDE_CODE_SUBAGENT_MODEL`):** any string (proxy-routable to OSS/Gemini), but a
  single value for *every* subagent.

Under the tested 2.1.178 supported levers alone, c-thru's design goal — *each* agent transparently
routed to *its own* mapped model, including local/OSS models — was not achievable. The implemented
signed sentinel/proxy handshake above is a c-thru extension around that limitation, not an official
Claude model-selection mechanism.

## Historical proposed interim fix — tier-alias mapping

This proposal was superseded by the authenticated hook→prompt sentinel handshake documented at
the top of this file. The safe alias remains a proxy-absent fallback, while the signed identity
drives per-agent routing when the proxy is present.

Make the hook (and the definition/`--agents` model fields) emit a **valid tier alias** instead of
the capability name.

- **Hook (`tools/c-thru-agent-router-hook.sh`):** after resolving `subagent_type → capability`,
  resolve the capability to its concrete model for the active mode/tier (reuse
  `model-map-resolve.js`), then map that model to its alias:
  `claude-opus-* → opus`, `claude-sonnet-* → sonnet`, `claude-haiku-* → haiku`, `fable → fable`.
  Inject the alias. For a capability that resolves to a **non-Anthropic** model (OSS/Gemini
  modes), there is no valid alias — inject `inherit` (or omit the override) so the call is not
  blocked and the subagent inherits the session model. Keep the existing WebSearch/WebFetch/
  Monitor/Plan passthrough and the observability logging.
- **`agents/*.md` + `--agents` JSON:** replace the capability-name `model:` values with valid
  aliases (or `inherit`) so the definition is independently valid, not reliant on the hook.
- **Docs:** record that per-agent OSS/specific-model routing requires the global
  `CLAUDE_CODE_SUBAGENT_MODEL` (one model for all subagents), and update the #44385 "retirement
  watch" in `docs/derived-artifacts.md` to this new reality (the workaround isn't retired — it's
  re-pointed at aliases).

**What this restores:** delegation to all agents stops being blocked; each agent runs on its
tier's Anthropic model in cloud modes.
**What it does not restore:** per-agent routing to specific ids or OSS/Gemini models (a Claude
Code limitation, not a c-thru one).

### Verification (don't get fooled by coincidental Anthropic mapping)
- **Unblock:** force a delegation to `planner`/`coder`/`reviewer-security`; each completes (no
  "blocked by pre-tool hook"), and the subagent self-reports the tier's model.
- **Distinguishing check:** in `best-local-oss`, confirm that a capability mapping to a
  non-Anthropic model degrades to `inherit` (subagent runs on the OSS session model, observed via
  proxy `served_by`) rather than silently claiming an Anthropic model — i.e. the harness reports
  the *real* served model, so an inert mapping can't masquerade as success.
- **Re-run** `test/agent-offload-coverage.js` (transcript/decision signal) to confirm the fleet
  now actually gets delegated to on natural prompts.

## Alternatives considered

- **Retire the hook injection entirely; rely on global `CLAUDE_CODE_SUBAGENT_MODEL`.** Simplest;
  unblocks delegation; but zero per-agent differentiation (every subagent on one model). Viable
  fallback if tier-alias mapping proves fragile.
- **Proxy fingerprints the agent by its injected system prompt.** The hook injects a benign
  accepted alias; the proxy recovers which agent it is from the (unique) agent body in the request
  and routes to the truly-mapped model. This is the *only* path to per-agent arbitrary/OSS routing
  on current Claude Code — but it's a real proxy feature and fragile (prompt-text matching).
  Deferred unless per-agent OSS routing is a hard requirement.

## References
- Empirical tests: this session's hook-log + stream-json + proxy-journal runs (table above).
- The frontmatter-`model:`-ignored bug (#44385) and the subsequent strict-enum validation are the
  upstream behaviors; the *enum rejection* is confirmed here directly rather than from issue text.
- Supersedes the proxy-stats measurement plan in `~/.claude/plans/purrfect-weaving-spark.md`
  (proxy stats can't measure delegation in subscription mode — see point 3).
