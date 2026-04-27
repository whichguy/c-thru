#!/bin/bash
# c-thru Smoke Check
# Verifies the core "Great Simplification" and Control Channel logic.
set -e

# Use a clean environment
export CLAUDE_ROUTER_DEBUG=0
export CLAUDE_PROXY_DEBUG=0

# Ensure we are in the repo root
cd "$(dirname "$0")/.."

echo -e "\033[1;34m--- C-thru Smoke Check ---\033[0m"

# 1. Dependency & Path Check
echo -n "1. Checking environment... "
node tools/model-map-config.js --print-paths > /dev/null
echo "✅ OK"

# 2. Dependency Check
echo -n "2. Checking dependencies... "
tools/c-thru check-deps > /dev/null
echo "✅ OK"

# 3. Start a proxy on a free port (READY <port> on stdout)
echo -n "3. Starting proxy... "
SMOKE_PIPE=$(mktemp -t c-thru-smoke-ready.XXXXXX)
rm -f "$SMOKE_PIPE"; mkfifo "$SMOKE_PIPE"
CLAUDE_PROFILE_DIR=$HOME/.claude CLAUDE_MODEL_MAP_PATH=$HOME/.claude/model-map.json \
  node tools/claude-proxy >"$SMOKE_PIPE" 2>/dev/null &
SMOKE_PROXY_PID=$!
SMOKE_PORT=""
if IFS= read -r -t 10 ready_line <"$SMOKE_PIPE"; then
  SMOKE_PORT="${ready_line#READY }"
fi
rm -f "$SMOKE_PIPE"
trap 'kill "$SMOKE_PROXY_PID" 2>/dev/null; wait "$SMOKE_PROXY_PID" 2>/dev/null' EXIT

if [[ -z "$SMOKE_PORT" ]] || ! curl -sf --max-time 2.0 "http://127.0.0.1:$SMOKE_PORT/ping" >/dev/null 2>&1; then
  echo "❌ FAILED (Proxy did not start or READY not received)"
  exit 1
fi
export ANTHROPIC_BASE_URL="http://127.0.0.1:$SMOKE_PORT"
export CLAUDE_PROXY_PORT="$SMOKE_PORT"
echo "✅ OK (port $SMOKE_PORT)"

# 4. Control Channel: Status (via / interceptor)
echo -n "4. Testing /c-thru-control status interceptor... "
status_out=$(tools/c-thru /c-thru-control status 2>&1)
if echo "$status_out" | grep -q "C-thru Status"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$status_out"
  exit 1
fi

# 4b. Control Channel: Status (via direct tool)
echo -n "4b. Testing tools/c-thru-control status... "
status_direct=$(tools/c-thru-control status 2>&1)
if echo "$status_direct" | grep -q "C-thru Status"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$status_direct"
  exit 1
fi

# 5. Control Channel: Mode Switch
echo -n "5. Testing mode switch (connected -> offline)... "
tools/c-thru /c-thru-control go offline > /dev/null
status_after=$(tools/c-thru /c-thru-control status 2>&1)
if echo "$status_after" | grep -q "\[offline\]"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$status_after"
  exit 1
fi

# 6. Control Channel: Mode Restore
echo -n "6. Testing mode switch (offline -> connected)... "
tools/c-thru /c-thru-control back online > /dev/null
status_final=$(tools/c-thru /c-thru-control status 2>&1)
if echo "$status_final" | grep -q "\[connected\]"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$status_final"
  exit 1
fi

# 7. Basic Routing Smoke
echo -n "7. Testing model resolution logic... "
res_out=$(CLAUDE_ROUTER_DEBUG=1 tools/c-thru --route default --help 2>&1 > /dev/null)
if echo "$res_out" | grep -q "• model"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$res_out"
  exit 1
fi

echo -e "\033[1;32m--- All Smoke Tests Passed ---\033[0m"
