# Proxy journaling — record, replay, A/B (Phase A: record-only)

The `claude-proxy` can capture every LLM interaction to structured JSONL for later
audit, replay, and A/B testing. **Off by default**; opt in via env var.

## Phase A — record-only (current)

### Enabling

```sh
export CLAUDE_PROXY_JOURNAL=1
c-thru                       # next session captures all routed traffic
```

### Storage layout

```
~/.claude/journal/
├── 2026-04-26/
│   ├── workhorse.jsonl
│   ├── judge.jsonl
│   ├── deep-coder.jsonl
│   └── ...
└── 2026-04-27/
    └── ...
```

One file per **day × capability**. Append-only JSONL (one entry per line).

### Schema (v1)

Each line is a self-contained JSON object:

```jsonc
{
  "schema_version": 1,
  "id": "j_<unix-ms>_<random6>",        // stable identifier for replay
  "ts_iso": "2026-04-26T12:34:56.789Z",
  "capability": "workhorse",
  "tier": "128gb",                       // active hardware tier
  "mode": "connected",                   // active LLM mode
  "served_by": "claude-sonnet-4-6",      // post-resolution + post-filter model
  "backend_id": "anthropic",
  "backend_kind": "anthropic",
  "endpoint": "/v1/messages",
  "stream": false,
  "request": {                           // full client request body
    "model": "workhorse",
    "messages": [...],
    "system": "...",
    "tools": [...],
    "max_tokens": 1024
  },
  "response": {                          // full upstream response body
    "id": "msg_...",
    "content": [...],
    "stop_reason": "end_turn",
    "usage": { "input_tokens": 234, "output_tokens": 567 }
  },
  "stream_events": null,                 // OR raw SSE chunks if stream=true
  "stream_events_truncated": false,      // true if stream exceeded 1000 events
  "latency_ms": 1234,
  "status_code": 200,
  "input_tokens": 234,
  "output_tokens": 567,
  "stop_reason": "end_turn"
}
```

### What gets captured

- `/v1/messages` and capability-aliased model requests **only**
- Excluded automatically: `/ping`, `/v1/active-models`, `/debug/stats`, `/v1/models`,
  hook endpoints (port 9998)

### What gets scrubbed

Authorization headers stripped before write:
- `Authorization`, `x-api-key`, `cookie`, anything `x-api-*`

**Request bodies are journaled in full.** They contain user prompts — that's the
point of journaling. Document this loudly to anyone enabling it.

## Privacy implications

⚠️ **Read carefully before enabling.**

The journal captures:
- Full text of every prompt sent to a model (including pasted code, file contents, secrets in context)
- Full text of every response (including generated code, summaries, verdicts)
- Routing metadata (which model handled each request, latency)

This is the right behavior for audit/replay/A/B use cases, but means:
- Don't enable on a machine where user prompts contain secrets you don't want at rest
- Journal files have the same permissions as `~/.claude/` (typically 0700)
- No automatic rotation by age — files accumulate until manually cleaned (`find ~/.claude/journal -mtime +30 -delete`)
- The `id` field is suitable for cross-referencing in commit messages or chat logs without exposing content

## Configuration

| Env var | Effect |
|---|---|
| `CLAUDE_PROXY_JOURNAL=1` | Enable journaling. Off by default. |
| `CLAUDE_PROXY_JOURNAL_DIR=<path>` | Override storage directory (default `~/.claude/journal`) |
| `CLAUDE_PROXY_JOURNAL_INCLUDE=cap1,cap2` | Capture only listed capabilities |
| `CLAUDE_PROXY_JOURNAL_EXCLUDE=cap` | Skip capabilities even when journaling is on |
| `CLAUDE_PROXY_JOURNAL_MAX_BYTES=104857600` | Per-file size cap; on overflow file is renamed to `.1.jsonl` and a new one starts (default 100MB) |

## Querying

Standard Unix tooling. Examples:

```sh
# What did workhorse handle today?
jq -c 'select(.endpoint=="/v1/messages") | {id, served_by, latency_ms}' \
  ~/.claude/journal/$(date +%F)/workhorse.jsonl

# All requests over 5 seconds latency
jq -c 'select(.latency_ms > 5000) | {capability, served_by, latency_ms}' \
  ~/.claude/journal/$(date +%F)/*.jsonl

# Who served deep-coder requests yesterday?
jq -c '.served_by' ~/.claude/journal/$(date -v-1d +%F)/deep-coder.jsonl | sort | uniq -c

# Find a specific id (for cross-reference from a commit)
grep '"id":"j_1700000000000_abc123"' ~/.claude/journal/*/*.jsonl
```

## Failure isolation

Journal write errors **never** break the user's request. If the directory isn't
writable, disk is full, or any other I/O fails, the proxy logs `journal.write_error`
to its own log file and continues serving. The user request always completes.

## Future phases (not yet implemented)

| Phase | Description |
|---|---|
| **B** — Replay | `c-thru journal replay <id>` re-issues a captured request against the current proxy and diffs the response |
| **C** — A/B harness | `c-thru journal ab <id> --against <model>` runs the same request through a different model for quality comparison |
| **D** — Benchmark feedback | Real production traffic feeds back into `docs/benchmark.json` quality data |

These are tracked under task #11.

## Implementation notes

- Capture happens at `finalizeTrackedUsage` time — already a non-hot-path finalization point
- One JSON.stringify + one async `fs.appendFile` per request (fire-and-forget)
- File rotation at 100MB by default; one backup file (`.1.jsonl`)
- Stream events capped at 1000 per response with `stream_events_truncated: true` flag
- See `tools/claude-proxy` near `proxyLog` for the helper functions and schema construction

## See also

- [`docs/connectivity-modes.md`](./connectivity-modes.md) — modes that affect what `served_by` shows up in journal entries
- [`docs/benchmark.json`](./benchmark.json) — quality data; future Phase D will feed journal back into this
