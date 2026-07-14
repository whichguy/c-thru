# TODO: `cthru agents --model grok` does not use proxy / model not applied

**Status:** argv hygiene **landed** (strip c-thru flags on native subcommands); proxy-for-agents still open  
**Priority:** P0–P1 (silent wrong path: looks like c-thru, is bare Claude)  
**Added:** 2026-07-14  
**Corrected:** 2026-07-14 — command is **`cthru agents --model grok`** (Claude Code `agents` subcommand, not “clod”)

## Exact user command

```sh
cthru agents --model grok
```

(`cthru` → `~/.claude/tools/c-thru` → repo `tools/c-thru`)

## Reporter hypothesis

When running the above, the model is not applied as expected and the session is not going through the c-thru proxy. Suspect argv handling or c-thru not wrapping that path.

## Strongly indicated root cause (code read 2026-07-14)

In `tools/c-thru` **before** proxy spawn / model resolution / fleet inject:

```bash
# ~L1155–1164
# Native Claude Code subcommands must reach the real binary untouched — the
# proxy/banner/session-injection path (build_forwarded_args) appends
# --append-system-prompt/--settings/--agents, which are invalid for
# subcommands and make commander error out.
case "${1:-}" in
  agents|auth|auto-mode|doctor|gateway|install|mcp|plugin|plugins|project|setup-token|ultrareview|update|upgrade)
    REAL_CLAUDE="${CLAUDE_BIN:-$(find_real_claude)}"
    exec "$REAL_CLAUDE" "$@"
    ;;
esac
```

So:

| User runs | What actually runs |
|---|---|
| `cthru agents --model grok` | `exec claude agents --model grok` **verbatim** |

Implications:

1. **No proxy** — no `ANTHROPIC_BASE_URL` to c-thru, no spawn of `claude-proxy`.
2. **No fleet brand inject** — repo `agents/grok.md` / ephemeral `--agents` JSON never applied.
3. **`--model grok` is Claude Code’s flag**, not c-thru’s: from `claude agents --help`:  
   *“Default model for sessions dispatched from agent view”* — Anthropic/picker vocabulary, **not** `model_routes` / `model:grok-4.5` → xAI.
4. Help text already documents this: *“Native Claude Code subcommands (agents, mcp, auth, ...) pass through to claude.”* — easy to miss.

This is **by design for commander** (subcommands reject c-thru’s `--append-system-prompt` / `--settings` / `--agents` inject), but it **breaks the user mental model** that `cthru …` always means “routed through c-thru.”

## Desired outcomes (product — pick when fixing)

A. **Document-only:** make the passthrough loud (banner/stderr: “agents is native Claude; no proxy; --model is Claude’s agent-view model, not c-thru routing”).  
B. **Proxy for agent-view:** spawn proxy + set env before `exec claude agents …`, still without injecting invalid subcommand flags — so dispatched sessions hit the proxy if Claude inherits env.  
C. **Model remap:** translate `cthru agents --model grok` → Claude’s `--model` with a concrete ID Claude understands *and* ensure proxy routes that ID (harder: agent view may not send through BASE_URL the same way).  
D. **UX alias:** recommend `cthru --model grok` (main session) or “ask agent grok” inside a normal `cthru` chat instead of `cthru agents`.

### Argv rule (agreed direction 2026-07-14)

**If `--model <name>` is a c-thru model** (route key, brand pin, Ollama tag in map, `claude-via-*`, etc.), **strip `--model` / `--model=…` from the argv forwarded to native `claude agents`** — do not pass c-thru names through as Claude’s agent-view `--model`.

- Stripping alone fixes “Claude sees garbage model id”; it does **not** by itself make Grok route (still need B and/or C for real proxy routing).
- Claude-native model ids may still be forwarded as agent-view defaults.
- Handle both orders: `cthru agents --model grok` **and** `cthru --model grok agents` consistently (today only the first hits the early `exec` path).

## Investigation remaining

- [ ] Confirm live: `C_THRU_DEBUG=1 cthru agents --model grok` never prints proxy port / BASE_URL (expect silent `exec`)
- [ ] Confirm agent-view dispatched sessions inherit env or not (does B even work?)
- [ ] What model IDs does agent view accept for `--model`? Does `grok` 400 or fall back?
- [ ] Decide A/B/C/D product choice

## Acceptance criteria

- [ ] User-visible behavior matches docs (either loud passthrough or real routing)
- [ ] c-thru model names in `--model` are **not** forwarded to `claude agents` (strip or remap)
- [ ] If routing is promised: proxy log shows traffic; `x-c-thru-served-by` / xAI path for grok
- [ ] Hermetic test: first-arg `agents` either (a) documents+warns, or (b) sets proxy env before exec; plus argv pin that `grok` never appears as Claude’s `--model` after strip
- [ ] README / help one-liner: `cthru agents` ≠ brand agent `grok` / ≠ main `--model` routing

## Related

- Brand leaf: `agents/grok.md` + runtime `--agents` inject (normal `cthru` chat only)
- Agent tool routing: `c-thru-agent-router-hook.sh` (Agent tool inside a session, not `claude agents` UI)
- Supersedes draft filename typo “clod” — this file is the canonical task

## Out of scope until product choice

- Changing xAI sanitize / brand pin semantics for normal chat sessions  
- Full Claude apps gateway parity
