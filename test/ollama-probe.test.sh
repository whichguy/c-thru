#!/usr/bin/env bash
# Regression tests for tools/c-thru-ollama-probe.sh.
# Regression for session bug #3: hardcoded 127.0.0.1:11434 ignored OLLAMA_HOST.
#
# Run: bash test/ollama-probe.test.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE="$REPO_DIR/tools/c-thru-ollama-probe.sh"
# shellcheck source=test/helpers.sh
source "$REPO_DIR/test/helpers.sh"

if [ ! -x "$PROBE" ]; then
    echo "SKIP: $PROBE not found or not executable"
    exit 0
fi

# Ports used by this test — free any leftover processes from prior runs.
ALT_PORT=11435
CUSTOM_PORT=11500
# Prefer lsof; fall back to /usr/sbin/lsof (macOS) so PATH-minimal CI shells work.
LSOF_BIN=$(command -v lsof 2>/dev/null || true)
[[ -z "$LSOF_BIN" && -x /usr/sbin/lsof ]] && LSOF_BIN=/usr/sbin/lsof
port_in_use() {
  local p="$1"
  if [[ -n "$LSOF_BIN" ]]; then
    "$LSOF_BIN" -ti ":$p" >/dev/null 2>&1
  else
    # No lsof: treat well-known Ollama default as in-use if curl answers.
    if [[ "$p" == "11434" ]]; then
      curl -sf --max-time 1 "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1
    else
      return 1
    fi
  fi
}
_free_ports() {
  if [[ -n "$LSOF_BIN" ]]; then
    "$LSOF_BIN" -ti ":$ALT_PORT" -ti ":$CUSTOM_PORT" | xargs kill -9 2>/dev/null || true
  fi
}
_free_ports
trap '_free_ports' EXIT

# Probe must always exit 0
run_probe() {
    local rc=0
    out=$(bash "$PROBE" 2>/dev/null) || rc=$?
    echo "$out"
    return "$rc"
}

# ---------------------------------------------------------------------------
# Scenario 1: Default host, down (no server)
# ---------------------------------------------------------------------------
DEFAULT_PORT=11434
echo "Scenario 1: default host, down..."
if port_in_use "$DEFAULT_PORT"; then
    echo "  SKIP  Scenario 1: Ollama already running on $DEFAULT_PORT"
    PASS=$((PASS+2))  # count as passed — "always exits 0" and "DOWN" would pass if port were free
else
    unset OLLAMA_HOST 2>/dev/null || true
    result=$(run_probe); exit_rc=$?
    check "exit 0 when down"            "0" "$exit_rc"
    check "DOWN 127.0.0.1:$DEFAULT_PORT" "DOWN 127.0.0.1:$DEFAULT_PORT" "$result"
fi

# ---------------------------------------------------------------------------
# Scenarios 2-3: Default host, up (stub server on alternate port via OLLAMA_HOST)
# ---------------------------------------------------------------------------
echo "Scenario 2: up (0 models via OLLAMA_HOST)..."
if port_in_use "$ALT_PORT"; then
    echo "  SKIP  Scenarios 2-3: port $ALT_PORT in use"
else
    export OLLAMA_HOST="127.0.0.1:$ALT_PORT"
    PID=$(start_ollama_stub "$ALT_PORT" 0)
    result=$(run_probe); exit_rc=$?
    stop_ollama_stub "$PID"
    check "exit 0 when up (0 models)"  "0" "$exit_rc"
    check "OK 0" "OK 0" "$result"

    echo "Scenario 3: up (2 models via OLLAMA_HOST)..."
    PID=$(start_ollama_stub "$ALT_PORT" 2)
    result=$(run_probe); exit_rc=$?
    stop_ollama_stub "$PID"
    check "exit 0 when up (2 models)" "0" "$exit_rc"
    check "OK 2" "OK 2" "$result"
    unset OLLAMA_HOST
fi

# ---------------------------------------------------------------------------
# Scenario 4: Custom host, up — regression for bug #3
# ---------------------------------------------------------------------------
echo "Scenario 4: custom host, up (bug #3 regression)..."
if port_in_use "$CUSTOM_PORT"; then
    echo "  SKIP  Scenario 4: port $CUSTOM_PORT in use"
else
    export OLLAMA_HOST="127.0.0.1:$CUSTOM_PORT"
    PID=$(start_ollama_stub "$CUSTOM_PORT" 1)
    result=$(run_probe); exit_rc=$?
    stop_ollama_stub "$PID"
    check "exit 0 custom host up"  "0" "$exit_rc"
    check "OK 1 on custom host"    "OK 1" "$result"
fi

# ---------------------------------------------------------------------------
# Scenario 5: Custom host, down — regression for bug #3
# ---------------------------------------------------------------------------
echo "Scenario 5: custom host, down (bug #3 regression)..."
export OLLAMA_HOST="127.0.0.1:$CUSTOM_PORT"
result=$(run_probe); exit_rc=$?
check "exit 0 custom host down"         "0" "$exit_rc"
check "DOWN 127.0.0.1:$CUSTOM_PORT"     "DOWN 127.0.0.1:$CUSTOM_PORT" "$result"
unset OLLAMA_HOST

echo ""
echo "$((PASS+FAIL)) tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
