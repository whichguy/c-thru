#!/usr/bin/env bash
# PostCompact hook: reinject c-thru routing context after compaction.
# Exits 0 silently if proxy not running.
HOOKS_PORT="${CLAUDE_PROXY_HOOKS_PORT:-9998}"
curl --silent --max-time 3 --fail \
  -X POST "http://127.0.0.1:${HOOKS_PORT}/hooks/context" \
  -H "Content-Type: application/json" \
  -d '{"event":"PostCompact"}' 2>/dev/null || exit 0
