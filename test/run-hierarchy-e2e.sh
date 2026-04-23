#!/bin/bash
# End-to-end execution of the agent hierarchy test.
# Runs the test through the real c-thru router using CLAUDE_BIN override.

set -e

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

echo "--- c-thru E2E Hierarchy Test (Actual Call-through) ---"
echo "Repo root: $REPO_ROOT"

# 1. Configure the environment
export C_THRU_HIERARCHY_TESTS=1
export CLAUDE_LLM_MEMORY_GB=16
export C_THRU_KEEP_PROXY=1
# Point CLAUDE_BIN directly to our test script.
# c-thru will exec it with any forwarded args (like --model).
export CLAUDE_BIN="$REPO_ROOT/test/agent-prompt-hierarchy.test.js"

# 2. Invoke c-thru
echo "Invoking tools/c-thru..."
"$REPO_ROOT/tools/c-thru" --model qwen3:1.7b
