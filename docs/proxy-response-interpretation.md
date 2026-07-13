# Proxy response interpretation audit

How `claude-proxy` turns upstream HTTP/SSE into client-visible bytes and internal
stats. Last updated with the error-body sanitize + compressed-tee fail-open work.

## Session injection vs response decode

**Ephemeral session isolation does not rewrite response bodies.** It affects:

- Claude’s config view (`CLAUDE_CONFIG_DIR` shadow, `--settings` / `--agents`)
- Which proxy process is spawned (`$CLAUDE_PROFILE_DIR/tools/claude-proxy`)
- Optional URL prefix `/s/<session-id>` for **mode** isolation on a shared proxy

Response decode is always **per-request** on that process. Cross-session body mix-up
does not occur. Stale long-lived proxy processes *can* keep old decode bugs until
restart (see [Restart after proxy code changes](#restart-after-proxy-code-changes)).

## Path matrix

| Path | Body to client | Proxy parses body? | Compression handling | User-visible risk | Verdict |
|---|---|---|---|---|---|
| `forwardAnthropic` success | `upRes.pipe(res)` + upstream headers | Usage/journal **tee only** | Tee **skips** when `Content-Encoding` is gzip/deflate/br; client still gets full pipe | None if tee fail-open | OK |
| `forwardAnthropic` error (fallback miss) | `sendAnthropicError` JSON | Yes — full buffer | `formatUpstreamErrorMessage` (gunzip/br + extract + sanitize) | Was mojibake; fixed | OK |
| `handleOllamaError` | `sendAnthropicError` | Yes | Same helper | Fixed | OK |
| `forwardGemini` error | Anthropic error JSON | Yes | Same helper | Fixed | OK |
| Gemini Files API errors | `sendAnthropicError` | Yes | Same helper | Fixed | OK |
| Gemini / Ollama-legacy success SSE | Rebuilt Anthropic SSE | Yes — stream state machine | Expects uncompressed upstream text frames | Stats/TUI only if upstream wrongly compresses translated streams | OK for current backends |
| `forwardToAnthropicCatchAll` | `upRes.pipe(res)` | No | Pass-through | None | OK |
| Debug `traceLog` body_snippet | N/A (logs) | Snippet only | Sanitized | Debug logs only | OK |
| Journal stream events | N/A | Tee buffer | Same as usage tee (skip if compressed) | Operators only | OK |

## Request-side notes (not response offsets)

- **Content-Length** is deleted on outbound rewrite (`scrubCthruHeaders`) — Node recomputes length. Correct.
- **Agent sentinel** is prepended by the PreToolUse hook into the task prompt. The proxy:
  1. Finds the marker with **`lastIndexOf`** (newest wins when multi-turn history still carries older markers).
  2. Extracts an **opaque name** (arbitrary agent, capability, or model id until `]]`; optional trailing `:<16-hex>` HMAC). When trusted, sets `body.model = name` and runs normal **`resolveBackend`** mapping (not limited to `agent_to_capability`).
  3. **`stripAgentSentinelFromBody`** removes all `[[c-thru-agent:…]]` strings before forwarding so the upstream LLM never sees routing metadata.
  Client SQLite history still retains markers for the next turn. HTTP headers `x-c-thru-*` are already scrubbed outbound; the header `x-c-thru-agent` is optional and unused by stock Claude Code.
- **Model rewrite** changes request JSON size; response is not a slice of the request.
- **Default mode** is `best-cloud-oss` (cloud OSS). Enum aliases `sonnet`/`opus`/`haiku`/`fable` are mode-conditional so they do not force Anthropic under OSS mode.

## Module resolution (session / install)

`install.sh` symlinks `claude-proxy` into `~/.claude/tools/`. Ephemeral sessions usually
symlink `tools` → `~/.claude/tools`. Node resolves `require('./upstream-error-body.js')`
from the **realpath** of `claude-proxy` (repo `tools/`), not the ephemeral directory.

Invariant: keep `claude-proxy` as a symlink into the repo (or ship sibling modules
next to any real-file install). The plugin bundle copies `upstream-error-body.js`
via `sync-plugin-bundle.sh`.

## Restart after proxy code changes

Node loads `claude-proxy` once per process. After editing proxy JS:

```sh
pkill -f claude-proxy
# next c-thru launch starts a new process with the new code
```

Until restart, sessions keep the old interpretation behavior even though disk is updated.

## Related tests

- `test/upstream-error-body.test.js` — unit decode/sanitize
- `test/proxy-upstream-error-sanitize.test.js` — gzip/binary 429 through proxy
- `test/proxy-session-mode-isolation.test.js` — `/s/<id>` mode isolation
- `test/proxy-response-pipe.test.js` — compressed success body reaches client intact
