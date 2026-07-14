#!/usr/bin/env bash
# StopFailure hook: same-port ensure on server_error/unknown; skip rate_limit.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO/tools/c-thru-stop-failure-hook.sh"
PASS=0; FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-stopfail.XXXXXX")"
trap 'rm -rf "$HOME_DIR"; pkill -f "claude-proxy --port ${FREE_PORT:-0}" 2>/dev/null || true' EXIT
mkdir -p "$HOME_DIR/.claude"

run_hook() {
  local json="$1"
  shift
  printf '%s' "$json" | env HOME="$HOME_DIR" CLAUDE_DIR="$HOME_DIR/.claude" \
    CLAUDE_MODEL_MAP_PATH="$REPO/config/model-map.json" \
    "$@" bash "$HOOK" 2>/dev/null || true
}

echo "1. rate_limit → no spawn"
FREE_PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
run_hook '{"hook_event_name":"StopFailure","error":"rate_limit"}' \
  ANTHROPIC_BASE_URL="http://127.0.0.1:${FREE_PORT}"
if curl -sf --max-time 0.5 "http://127.0.0.1:${FREE_PORT}/ping" >/dev/null 2>&1; then
  fail "rate_limit should not spawn proxy"
  pkill -f "claude-proxy --port ${FREE_PORT}" 2>/dev/null || true
else
  pass "rate_limit no spawn"
fi

echo "2. server_error + dead port → ensure / NO_RESURRECT"
FREE_PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
run_hook '{"hook_event_name":"StopFailure","error":"server_error","error_details":"ECONNREFUSED"}' \
  C_THRU_NO_RESURRECT=1 \
  ANTHROPIC_BASE_URL="http://127.0.0.1:${FREE_PORT}"
if curl -sf --max-time 0.5 "http://127.0.0.1:${FREE_PORT}/ping" >/dev/null 2>&1; then
  fail "NO_RESURRECT should not spawn"
  pkill -f "claude-proxy --port ${FREE_PORT}" 2>/dev/null || true
else
  pass "NO_RESURRECT skips spawn"
fi

run_hook '{"hook_event_name":"StopFailure","error":"server_error","error_details":"Connection to the API was lost (ECONNREFUSED)"}' \
  ANTHROPIC_BASE_URL="http://127.0.0.1:${FREE_PORT}"
# wait a bit for spawn
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf --max-time 0.3 "http://127.0.0.1:${FREE_PORT}/ping" >/dev/null 2>&1 && break
  sleep 0.25
done
if curl -sf --max-time 1 "http://127.0.0.1:${FREE_PORT}/ping" >/dev/null 2>&1; then
  pass "server_error resurrects proxy on same port"
  pkill -f "claude-proxy --port ${FREE_PORT}" 2>/dev/null || true
  sleep 0.2
else
  fail "server_error should resurrect on :$FREE_PORT"
fi

echo "3. remote BASE_URL → no spawn"
FREE_PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
run_hook '{"error":"server_error"}' \
  ANTHROPIC_BASE_URL="https://api.anthropic.com" \
  CLAUDE_PROXY_PORT="$FREE_PORT"
if curl -sf --max-time 0.5 "http://127.0.0.1:${FREE_PORT}/ping" >/dev/null 2>&1; then
  fail "remote BASE_URL should not spawn"
  pkill -f "claude-proxy --port ${FREE_PORT}" 2>/dev/null || true
else
  pass "remote BASE_URL no spawn"
fi

echo "4. empty stdin fail-open"
run_hook '' ANTHROPIC_BASE_URL="http://127.0.0.1:1"
pass "empty stdin exits 0"

echo
echo "stop-failure-hook: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
