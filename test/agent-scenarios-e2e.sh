#!/usr/bin/env bash
# B3 — scenario e2e: prompt → agent → proxy → journal (opt-in, Ollama-backed).
#
# Drives a REAL c-thru session (best-local-oss, journaling on) with a prompt
# crafted to elicit a specific subagent, then greps the journal for an entry
# whose `capability` matches the expected agent. This exercises the full
# prompt→agent-selection→proxy→log path that the hermetic suites can't.
#
# ADVISORY / BEST-EFFORT — NOT an authoritative gate:
#   LLM agent selection is non-deterministic; a model may answer inline instead
#   of dispatching the Task/Agent tool, or pick a neighbouring agent. So a
#   scenario "miss" is logged as ADVISORY and does NOT fail the suite. The
#   authoritative gates are B1 (test/agent-invocation-headers.test.js) and
#   B2 (test/agent-router-hook.test.js), which are deterministic and hermetic.
#   This script NEVER fails the suite: scenario misses are advisory, and even a
#   "no journal produced at all" condition is surfaced as a loud WARNING (it can
#   mean the session couldn't run in this environment, not a code defect). It
#   always exits 0 — treat the output as a signal, not a gate.
#
# Gates (all must pass or the script SKIPs cleanly with exit 0):
#   - C_THRU_E2E=1            must be set (opt-in)
#   - Ollama reachable        (tools/c-thru-ollama-probe.sh → OK)
#   - a usable `claude` binary (for the real session)
#
# Run: C_THRU_E2E=1 bash test/agent-scenarios-e2e.sh

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
has_active_test_supervisor() {
  node "$REPO_DIR/tools/test-supervisor-capability.js" --verify-shell-child
}

if ! has_active_test_supervisor; then
  exec node "$REPO_DIR/tools/run-with-hard-timeout.js" \
    --timeout-seconds "${C_THRU_TEST_TIMEOUT_SECONDS:-3600}" \
    -- bash "${BASH_SOURCE[0]}" "$@"
fi

skip() { echo "SKIP  agent-scenarios-e2e: $1"; exit 0; }

# ── Gate 1: opt-in ────────────────────────────────────────────────────────────
[ "${C_THRU_E2E:-0}" = "1" ] || skip "set C_THRU_E2E=1 to enable (advisory Ollama-backed layer)"

# ── Gate 2: Ollama reachable ──────────────────────────────────────────────────
probe="$(bash "$REPO_DIR/tools/c-thru-ollama-probe.sh" 2>/dev/null || echo 'DOWN')"
case "$probe" in
  OK\ *) echo "Ollama: $probe" ;;
  *)     skip "Ollama not reachable ($probe) — start it to run scenarios" ;;
esac

# ── Gate 3: a claude binary to drive ──────────────────────────────────────────
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
[ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || skip "no usable 'claude' binary on PATH (set CLAUDE_BIN=...)"

C_THRU="$REPO_DIR/tools/c-thru"
[ -x "$C_THRU" ] || [ -f "$C_THRU" ] || skip "tools/c-thru entrypoint not found"

MODEL_TEST_TIMEOUT_MS="${C_THRU_MODEL_TEST_TIMEOUT_MS:-3600000}"
if [[ ! "$MODEL_TEST_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] \
  || (( ${#MODEL_TEST_TIMEOUT_MS} > 7 )) \
  || { (( ${#MODEL_TEST_TIMEOUT_MS} == 7 )) && [[ "$MODEL_TEST_TIMEOUT_MS" > "3600000" ]]; }; then
  echo "ERROR: C_THRU_MODEL_TEST_TIMEOUT_MS must be an integer from 1 to 3600000" >&2
  exit 2
fi
MODEL_TEST_TIMEOUT_SECONDS=$(( (MODEL_TEST_TIMEOUT_MS + 999) / 1000 ))
E2E_TIMEOUT_SECONDS="${C_THRU_E2E_TIMEOUT:-$MODEL_TEST_TIMEOUT_SECONDS}"
if [[ ! "$E2E_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || (( ${#E2E_TIMEOUT_SECONDS} > 4 )) \
  || { (( ${#E2E_TIMEOUT_SECONDS} == 4 )) && [[ "$E2E_TIMEOUT_SECONDS" > "3600" ]]; }; then
  echo "ERROR: C_THRU_E2E_TIMEOUT must be an integer from 1 to 3600" >&2
  exit 2
fi

WORK="$(mktemp -d -t c-thru-agent-e2e-XXXXXX)"
JOURNAL_DIR="$WORK/journal"
TARGET_FILE="$WORK/target.py"
cat > "$TARGET_FILE" <<'PY'
def add(a, b):
    return a + b
PY
trap 'rm -rf "$WORK"' EXIT

# Portable timeout wrapper (macOS has no `timeout` by default): run "$@" in the
# background, kill after $1 seconds. Returns the command's own exit status.
run_with_timeout() {
  local secs="$1"; shift
  local term_after="$secs"
  local kill_grace=0
  if (( secs > 3 )); then
    term_after=$(( secs - 3 ))
    kill_grace=2
  fi
  "$@" &
  local pid=$!
  (
    sleep "$term_after" &
    local sleeper=$!
    trap 'kill "$sleeper" 2>/dev/null || true; exit 0' TERM INT
    wait "$sleeper" 2>/dev/null || exit 0
    kill -TERM "$pid" 2>/dev/null || exit 0
    if (( kill_grace > 0 )); then sleep "$kill_grace"; fi
    kill -KILL "$pid" 2>/dev/null || true
  ) &
  local watcher=$!
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill -TERM "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return $rc
}

# Drive one scenario: run a real session with a subagent-eliciting prompt, then
# check the journal for the expected capability.
PASS=0; ADVISORY=0; SESSIONS_WITH_JOURNAL=0
scenario() {
  local label="$1" expected_cap="$2" prompt="$3"
  echo ""
  echo "Scenario: $label  (expect capability='$expected_cap')"

  run_with_timeout "$E2E_TIMEOUT_SECONDS" \
    env CLAUDE_LLM_MODE=best-local-oss \
        CLAUDE_PROXY_JOURNAL=1 \
        CLAUDE_PROXY_JOURNAL_DIR="$JOURNAL_DIR" \
        CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS" \
        CLAUDE_PROXY_GEMINI_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS" \
        CLAUDE_PROXY_RESPONSES_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS" \
        CLAUDE_PROXY_OLLAMA_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS" \
        CLAUDE_PROXY_OLLAMA_TTFT_MS="$MODEL_TEST_TIMEOUT_MS" \
        CLAUDE_PROXY_STREAM_STALL_MS="$MODEL_TEST_TIMEOUT_MS" \
        CLAUDE_PROXY_STREAM_WALL_MS="$MODEL_TEST_TIMEOUT_MS" \
        C_THRU_MODEL_TEST_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS" \
        C_THRU_NO_UPDATE=1 \
        C_THRU_NO_MARKETPLACE_UPDATE=1 \
        CLAUDE_BIN="$CLAUDE_BIN" \
        bash "$C_THRU" -p "$prompt" >/dev/null 2>&1 || true

  # Did this session produce ANY journal output? (infra liveness signal)
  if find "$JOURNAL_DIR" -name '*.jsonl' 2>/dev/null | grep -q .; then
    SESSIONS_WITH_JOURNAL=$((SESSIONS_WITH_JOURNAL+1))
  fi

  # Grep the journal for an entry whose capability matches the expected agent.
  local hit=""
  if [ -d "$JOURNAL_DIR" ]; then
    hit=$(grep -rhl "\"capability\"[[:space:]]*:[[:space:]]*\"$expected_cap\"" "$JOURNAL_DIR" 2>/dev/null | head -1 || true)
  fi
  if [ -n "$hit" ]; then
    echo "  PASS  journal records capability='$expected_cap' ($hit)"
    PASS=$((PASS+1))
  else
    echo "  ADVISORY  no journal entry for capability='$expected_cap' (LLM chose differently or answered inline)"
    ADVISORY=$((ADVISORY+1))
  fi
}

scenario "security review"  "reviewer-security" \
  "Use the reviewer-security subagent (via the Task tool) to do a security review of the file $TARGET_FILE. Dispatch the subagent now."
scenario "plan a refactor"  "planner" \
  "Use the planner subagent (via the Task tool) to plan a refactor of $TARGET_FILE into a typed module. Dispatch the subagent now."
scenario "write unit tests" "tester" \
  "Use the tester subagent (via the Task tool) to write unit tests for the add() function in $TARGET_FILE. Dispatch the subagent now."

echo ""
echo "-----------------"
echo "scenarios: $PASS matched, $ADVISORY advisory (best-effort, non-deterministic)"

# No journal output from ANY scenario usually means the session couldn't run in
# this environment (auth, nested CLI, missing --agents injection) rather than a
# code defect — surface it loudly but do NOT fail (B1/B2 are the gates).
if [ "$SESSIONS_WITH_JOURNAL" -eq 0 ]; then
  echo "WARNING  no journal output from ANY scenario — the real session likely could not run here;" >&2
  echo "         this layer is advisory, so not failing. Verify via B1/B2 (the authoritative gates)." >&2
fi

exit 0
