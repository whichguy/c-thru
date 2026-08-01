#!/bin/bash
# c-thru Smoke Check
# Verifies the core "Great Simplification" and Control Channel logic.
set -e

# Use a clean environment (a set-but-"0" CLAUDE_ROUTER_DEBUG still trips the
# deprecation alias check in tools/c-thru, which tests with -n, not value)
unset CLAUDE_ROUTER_DEBUG
unset ANTHROPIC_BASE_URL CLAUDE_PROXY_PORT CLAUDE_PROXY_BIND_ADDR CLAUDE_PROXY_BYPASS
export C_THRU_DEBUG=0
export CLAUDE_PROXY_DEBUG=0
export C_THRU_NO_OAUTH_INJECT=1
export C_THRU_NO_UPDATE=1
export C_THRU_SKIP_PREPULL=1

# Ensure we are in the repo root
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# A checkout-only CI job deliberately does not run install.sh, so it has no
# ~/.claude/model-map.json. Keep every smoke artifact under a disposable HOME
# and point both the launcher and proxy at the shipped repository config.
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-smoke.XXXXXX")"
SMOKE_HOME="$SMOKE_ROOT/home"
SMOKE_PROFILE="$SMOKE_HOME/.claude"
SMOKE_PROXY_PID=""
mkdir -p "$SMOKE_PROFILE"

smoke_cleanup() {
  if [[ -n "${SMOKE_PROXY_PID:-}" ]]; then
    kill "$SMOKE_PROXY_PID" 2>/dev/null || true
    wait "$SMOKE_PROXY_PID" 2>/dev/null || true
  fi
  rm -rf "$SMOKE_ROOT"
}
trap smoke_cleanup EXIT

export HOME="$SMOKE_HOME"
export CLAUDE_DIR="$SMOKE_PROFILE"
export CLAUDE_CONFIG_DIR="$SMOKE_PROFILE"
export CLAUDE_PROFILE_DIR="$SMOKE_PROFILE"
export CLAUDE_MODEL_MAP_DEFAULTS_PATH="$REPO_DIR/config/model-map.json"
export CLAUDE_MODEL_MAP_OVERRIDES_PATH="$SMOKE_PROFILE/model-map.overrides.json"
export CLAUDE_MODEL_MAP_SYNC_STATE_FILE="$SMOKE_PROFILE/model-map-defaults-sync.json"
export CLAUDE_MODEL_MAP_PATH="$REPO_DIR/config/model-map.json"
export C_THRU_OLLAMA_PREP_STATE_FILE="$SMOKE_PROFILE/ollama-prep-state.json"
export CLAUDE_PROXY_LOG_FILE="$SMOKE_ROOT/proxy.log"
export CLAUDE_PROXY_USAGE_STATS_FILE="$SMOKE_ROOT/usage-stats.json"
export CLAUDE_PROXY_PID_FILE="$SMOKE_ROOT/proxy.pid"
export CLAUDE_PROXY_CONTROL_TOKEN_FILE="$SMOKE_ROOT/proxy.control-token"
export C_THRU_AGENT_SENTINEL_SECRET_FILE="$SMOKE_PROFILE/proxy.agent-token"
export CLAUDE_PROXY_JOURNAL_DIR="$SMOKE_ROOT/journal"
printf '%s\n' 'c-thru-smoke-control-token' > "$CLAUDE_PROXY_CONTROL_TOKEN_FILE"
printf '%s\n' '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
  > "$C_THRU_AGENT_SENTINEL_SECRET_FILE"
chmod 0600 "$C_THRU_AGENT_SENTINEL_SECRET_FILE"

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
SMOKE_PIPE="$SMOKE_ROOT/proxy.ready.pipe"
mkfifo "$SMOKE_PIPE"
node tools/claude-proxy >"$SMOKE_PIPE" 2>/dev/null &
SMOKE_PROXY_PID=$!
SMOKE_PORT=""
if IFS= read -r -t 10 ready_line <"$SMOKE_PIPE"; then
  SMOKE_PORT="${ready_line#READY }"
fi
rm -f "$SMOKE_PIPE"

if [[ -z "$SMOKE_PORT" ]] || ! curl -sf --max-time 2.0 "http://127.0.0.1:$SMOKE_PORT/ping" >/dev/null 2>&1; then
  echo "❌ FAILED (Proxy did not start or READY not received)"
  exit 1
fi
export ANTHROPIC_BASE_URL="http://127.0.0.1:$SMOKE_PORT"
export CLAUDE_PROXY_PORT="$SMOKE_PORT"
echo "✅ OK (port $SMOKE_PORT)"

# Steps 1–3 above are true prerequisites and abort the run. Steps 4–7 are
# mutually independent given a running proxy, so they record-and-continue:
# an early failure must not hide staleness in the later steps (step 7's grep
# was stale for an unknown period because step 5 always exited first).
# The script runs under `set -e`, so every step command below is wrapped
# (`|| true` on captures, `if !` on bare commands) — only 1–3 keep abort
# semantics.
STEP_FAILED=0

# 4. Control Channel: Status (via / interceptor)
echo -n "4. Testing /c-thru-control status interceptor... "
status_out=$(tools/c-thru /c-thru-control status 2>&1) || true
if echo "$status_out" | grep -q "C-thru Status"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$status_out"
  STEP_FAILED=1
fi

# 4b. Control Channel: Status (via direct tool)
echo -n "4b. Testing tools/c-thru-control status... "
status_direct=$(tools/c-thru-control status 2>&1) || true
if echo "$status_direct" | grep -q "C-thru Status"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$status_direct"
  STEP_FAILED=1
fi

# 5. Control Channel: Mode Switch
echo -n "5. Testing mode switch (legacy 'offline' -> best-local-oss)... "
if ! tools/c-thru /c-thru-control go offline > /dev/null; then
  STEP_FAILED=1
fi
status_after=$(tools/c-thru /c-thru-control status 2>&1) || true
if echo "$status_after" | grep -q "\[best-local-oss\]"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$status_after"
  STEP_FAILED=1
fi

# 6. Control Channel: Mode Restore (sequential after 5 — restores connected mode)
echo -n "6. Testing mode switch (legacy 'connected' -> best-cloud-oss)... "
if ! tools/c-thru /c-thru-control back online > /dev/null; then
  STEP_FAILED=1
fi
status_final=$(tools/c-thru /c-thru-control status 2>&1) || true
if echo "$status_final" | grep -q "\[best-cloud-oss\]"; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$status_final"
  STEP_FAILED=1
fi

# 7. Basic Routing Smoke
echo -n "7. Testing model resolution logic... "
res_out=$(C_THRU_DEBUG=1 tools/c-thru --route default --help 2>&1 > /dev/null) || true
if echo "$res_out" | grep -q "EFFECTIVE_MODEL="; then
  echo "✅ OK"
else
  echo "❌ FAILED"
  echo "$res_out"
  STEP_FAILED=1
fi

if [[ "${STEP_FAILED:-0}" -ne 0 ]]; then
  echo -e "\033[1;31m--- Smoke FAILED ---\033[0m"
  exit 1
fi
echo -e "\033[1;32m--- All Smoke Tests Passed ---\033[0m"
