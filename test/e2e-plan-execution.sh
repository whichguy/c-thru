#!/usr/bin/env bash
# test/e2e-plan-execution.sh
# End-to-end verification of the /c-thru-plan hierarchy using deterministic stubs.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d -t c-thru-e2e-plan-XXXXXX)"
STUBS_PATH="$REPO_ROOT/test/stubs/plan-stubs.json"
C_THRU="$REPO_ROOT/tools/c-thru"

echo "Setting up dummy repository in $TEST_DIR"
cd "$TEST_DIR"
git init -q
git config user.email "test@example.com"
git config user.name "Test User"
echo "# Dummy App" > README.md
git add README.md
git commit -m "initial commit" -q

# Set environment for test mode
export C_THRU_PLAN_TEST_MODE=1
export C_THRU_PLAN_STUBS_PATH="$STUBS_PATH"
export CLAUDE_ROUTER_DEBUG=1
# Ensure the proxy port doesn't collide if another is running
export CLAUDE_PROXY_PORT=9997

echo "Executing plan-orchestrator simulation via harness subcommands"
# Simulate the environment the orchestrator expects
export PLAN_DIR="$TEST_DIR/.c-thru/plan"
mkdir -p "$PLAN_DIR/waves/001/digests" "$PLAN_DIR/waves/001/outputs" "$PLAN_DIR/waves/001/findings"

cat <<EOF > "$PLAN_DIR/current.md"
## Items
- [ ] item-1: create main.js
  agent: scaffolder
  target_resources: [src/main.js]
EOF

# 1. Batching
node "$REPO_ROOT/tools/c-thru-plan-harness.js" batch \
  --current-md "$PLAN_DIR/current.md" \
  --items "item-1" \
  --wave-id "001" \
  --commit-msg "Scaffold main.js" \
  --output "$PLAN_DIR/waves/001/wave.md"

if [ -f "$PLAN_DIR/waves/001/wave.md" ]; then
  echo "  PASS: wave.md created via batch"
else
  echo "  FAIL: batch failed"
  exit 1
fi

# 2. Calibrate (simulating worker completion)
node "$REPO_ROOT/tools/c-thru-plan-harness.js" calibrate \
  --item "item-1" \
  --agent "scaffolder" \
  --confidence "high" \
  --verify-pass "true" \
  --wave-dir "$PLAN_DIR/waves/001"

# 3. Update marker (simulating Phase 4 marker update)
node "$REPO_ROOT/tools/c-thru-plan-harness.js" update-marker \
  --wave-md "$PLAN_DIR/waves/001/wave.md" \
  --item "item-1" \
  --status "x" \
  --produced "src/main.js"

echo "Verifying results..."
grep -q "\- \[x\] item-1" "$PLAN_DIR/waves/001/wave.md"
if [ $? -eq 0 ]; then
  echo "  PASS: item-1 marked as done in wave.md"
else
  echo "  FAIL: update-marker failed"
  exit 1
fi

echo "E2E Plan Execution Test Complete"
rm -rf "$TEST_DIR"
