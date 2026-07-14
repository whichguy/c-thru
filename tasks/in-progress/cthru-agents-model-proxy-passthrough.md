# `cthru agents --model grok` — proxy + model passthrough

**Status:** **landed** (argv strip + proxy for brand models) — residual agent-view limits remain  
**Priority residual:** P2 (product clarity / agent-view may still prefer Anthropic picker semantics)  
**Added:** 2026-07-14  
**Landed:** 2026-07-14 in `feat(c-thru): native agents proxy, event-split hooks, drop agent colors` (+ follow-ups)

## Exact user command

```sh
cthru agents --model grok
```

## What was wrong (historical)

Early `tools/c-thru` path did `exec claude agents …` **before** proxy spawn / model-map resolution. Result:

| User ran | What ran |
|---|---|
| `cthru agents --model grok` | bare `claude agents --model grok` → Anthropic weekly limit / wrong backend |

## What landed

1. **Allowlist strip** (`strip_cthru_cli_args native_subcmd`): c-thru-private flags never forwarded; non-Claude-native `--model` values (grok, claude-via-*, map routes) are stripped and recorded in `STRIPPED_MODEL`.
2. **Claude-native models kept** on argv: sonnet / opus / fable / haiku / `claude-*` (except `claude-via-*`).
3. **`run_native_claude_subcommand`** (after config load): if brand/route model and not `CLAUDE_PROXY_BYPASS`, spawn proxy, set `ANTHROPIC_BASE_URL`, re-insert `--model <brand>` after the subcommand, foreground-launch Claude (EXIT trap kills proxy).
4. **Stderr** notes proxy routing (and that fleet inject is absent).
5. **Tests:** `test/c-thru-strip-args.test.sh`, `test/c-thru-target-launch.test.js` (3b grok+proxy, 3c sonnet).

## Still true (by design / residual)

| Surface | Behavior |
|---|---|
| Fleet `--agents` / `--append-system-prompt` | **Not** injected on native subcommands (commander rejects) |
| Brand Agent tool in main `cthru` chat | Separate path (sentinel + agent-router) — preferred for “ask grok” |
| Agent-view default model | Claude may still treat `--model` as agent-view vocabulary; proxy only helps if sessions inherit `ANTHROPIC_BASE_URL` and send that model string |
| Main chat | Prefer `cthru --model grok` for a full routed session with fleet |

## Verify (operator)

```sh
C_THRU_DEBUG=1 cthru agents --model grok
# Expect stderr: "c-thru: agents via proxy — model=grok ANTHROPIC_BASE_URL=http://127.0.0.1:…"
# Expect no bare Anthropic weekly-limit if traffic hits proxy

node test/c-thru-target-launch.test.js   # 3b/3c
bash test/c-thru-strip-args.test.sh
```

## Residual acceptance (optional follow-ups)

- [ ] Live interactive agent-view session: confirm proxy log shows traffic when a session runs
- [ ] If agent-view ignores brand model: document or pin `ANTHROPIC_DEFAULT_*` / concrete id
- [ ] README entry-points matrix (Wave 1) so users pick main chat vs agents view correctly

## Close criteria for this file

Move to done / delete when residual agent-view live check is green or explicitly waived, and docs matrix exists.
