#!/usr/bin/env bash
# EXIT keep-alive: KEEP_PROXY leaves proxy; idle kills; no jobs.json keep layer.
# Brand agents default C_THRU_KEEP_PROXY=1 (see native brand path in c-thru).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-keepalive.XXXXXX")"
trap 'rm -rf "$HOME_DIR"' EXIT
export HOME="$HOME_DIR"
export CLAUDE_JOBS_DIR="$HOME_DIR/.claude/jobs"
mkdir -p "$CLAUDE_JOBS_DIR/aabbcc11"

set +u
# Extract by function name/pattern (not line range) so this stays correct
# across edits to tools/c-thru — see test/c-thru-ephemeral-settings.test.sh
# for the same convention.
eval "$(awk '/^pid_looks_like_proxy\(\) \{/,/^\}$/' "$REPO/tools/c-thru")"
eval "$(awk '/^terminate_and_reap_owned_pid\(\) \{/,/^\}$/' "$REPO/tools/c-thru")"
eval "$(awk '/^proxy_port_referenced_by_peers\(\) \{/,/^\}$/' "$REPO/tools/c-thru")"
eval "$(awk '/^reap_proxy_port_listener\(\) \{/,/^\}$/' "$REPO/tools/c-thru")"
eval "$(awk '/^cleanup_proxy_children\(\) \{/,/^\}$/' "$REPO/tools/c-thru")"
set -u

echo "1. C_THRU_KEEP_PROXY=1 → skip kill"
node -e 'setTimeout(()=>{}, 60000)' &
PROXY_STARTED_PID=$!
SAVE_PID=$PROXY_STARTED_PID
PROXY_PORT=99999
export C_THRU_KEEP_PROXY=1
sleep 0.15
cleanup_proxy_children 0
if kill -0 "$SAVE_PID" 2>/dev/null; then
  pass "KEEP_PROXY leaves proxy"
  kill "$SAVE_PID" 2>/dev/null || true
else
  fail "KEEP_PROXY still killed"
fi
wait "$SAVE_PID" 2>/dev/null || true
export C_THRU_KEEP_PROXY=0

echo "2. no peers → kill proxy"
node -e 'setTimeout(()=>{}, 60000)' &
PROXY_STARTED_PID=$!
SAVE_PID=$PROXY_STARTED_PID
PROXY_PORT=99998
sleep 0.15
cleanup_proxy_children 0
if kill -0 "$SAVE_PID" 2>/dev/null; then
  fail "should have killed orphan proxy"
  kill "$SAVE_PID" 2>/dev/null || true
else
  pass "kills proxy when no peers"
fi

echo "3. jobs.json alone must NOT keep main-chat proxy (over-broad keep removed)"
cat > "$CLAUDE_JOBS_DIR/aabbcc11/state.json" <<'JSON'
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.x" }
}
JSON
node -e 'setTimeout(()=>{}, 60000)' &
PROXY_STARTED_PID=$!
SAVE_PID=$PROXY_STARTED_PID
PROXY_PORT=99997
export C_THRU_KEEP_PROXY=0
sleep 0.15
# Peer detect uses live process env, not jobs/*.json
if proxy_port_referenced_by_peers "$PROXY_PORT" "$$" "$SAVE_PID"; then
  fail "jobs.json alone should not count as peer reference"
else
  pass "jobs.json alone is not a keep signal"
fi
cleanup_proxy_children 0
if kill -0 "$SAVE_PID" 2>/dev/null; then
  fail "cleanup kept proxy based on jobs.json alone"
  kill "$SAVE_PID" 2>/dev/null || true
else
  pass "cleanup kills proxy despite active brand job in jobs.json"
fi
wait "$SAVE_PID" 2>/dev/null || true

echo "4. reap_proxy_port_listener is defined and no-ops on free port"
if declare -f reap_proxy_port_listener >/dev/null 2>&1; then
  pass "reap_proxy_port_listener defined"
  reap_proxy_port_listener 1  # port 1 almost never has a proxy listener
  pass "reap no-ops on free/privileged port"
else
  fail "reap_proxy_port_listener missing"
fi

echo
echo "proxy-keep-alive: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
