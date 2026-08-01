#!/bin/bash
# End-to-end execution of the agent hierarchy test.
# Runs the test through the real c-thru router using CLAUDE_BIN override.

set -e

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
has_active_test_supervisor() {
  node "$REPO_ROOT/tools/test-supervisor-capability.js" --verify-shell-child
}

if ! has_active_test_supervisor; then
  exec node "$REPO_ROOT/tools/run-with-hard-timeout.js" \
    --timeout-seconds "${C_THRU_TEST_TIMEOUT_SECONDS:-3600}" \
    -- bash "${BASH_SOURCE[0]}" "$@"
fi

echo "--- c-thru E2E Hierarchy Test (Actual Call-through) ---"
echo "Repo root: $REPO_ROOT"

# 1. Configure the environment
export C_THRU_HIERARCHY_TESTS=1
export CLAUDE_LLM_MEMORY_GB=16
export C_THRU_KEEP_PROXY=0

MODEL_TEST_TIMEOUT_MS="${C_THRU_MODEL_TEST_TIMEOUT_MS:-3600000}"
if [[ ! "$MODEL_TEST_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] \
  || (( ${#MODEL_TEST_TIMEOUT_MS} > 10 )) \
  || (( MODEL_TEST_TIMEOUT_MS > 3600000 )); then
  echo "ERROR: C_THRU_MODEL_TEST_TIMEOUT_MS must be an integer from 1 to 3600000" >&2
  exit 2
fi
export C_THRU_MODEL_TEST_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS"
export CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS"
export CLAUDE_PROXY_GEMINI_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS"
export CLAUDE_PROXY_RESPONSES_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS"
export CLAUDE_PROXY_OLLAMA_TIMEOUT_MS="$MODEL_TEST_TIMEOUT_MS"
export CLAUDE_PROXY_OLLAMA_TTFT_MS="$MODEL_TEST_TIMEOUT_MS"
export CLAUDE_PROXY_STREAM_STALL_MS="$MODEL_TEST_TIMEOUT_MS"
export CLAUDE_PROXY_STREAM_WALL_MS="$MODEL_TEST_TIMEOUT_MS"
# Point CLAUDE_BIN directly to our test script.
# c-thru will exec it with any forwarded args (like --model).
export CLAUDE_BIN="$REPO_ROOT/test/agent-prompt-hierarchy.test.js"

# 2. Invoke c-thru
echo "Invoking tools/c-thru..."
"$REPO_ROOT/tools/c-thru" --model qwen3:1.7b
