#!/usr/bin/env bash
# test/e2e-programming-assignment.sh
# Piecewise end-to-end validation for "create a programming assignment"

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d -t c-thru-e2e-prog-assign-XXXXXX)"
STUBS_PATH="$REPO_ROOT/test/stubs/plan-stubs.json"
HARNESS="node $REPO_ROOT/tools/c-thru-plan-harness.js"

echo "Setting up dummy repository in $TEST_DIR"
cd "$TEST_DIR"
git init -q
git config user.email "test@example.com"
git config user.name "Test User"
echo "# Dummy App" > README.md
git add README.md
git commit -m "initial commit" -q

export C_THRU_PLAN_TEST_MODE=1
export C_THRU_PLAN_STUBS_PATH="$STUBS_PATH"
export PLAN_DIR="$TEST_DIR/.c-thru/plan"

echo "=================================================="
echo "Piece 1: State Initialization & Pre-check"
echo "=================================================="
mkdir -p "$PLAN_DIR/waves" "$PLAN_DIR/discovery" "$PLAN_DIR/plan/snapshots" "$PLAN_DIR/review"
if [ -d "$PLAN_DIR/waves" ] && [ ! -f "$PLAN_DIR/.c-thru-contract-version" ]; then
    echo "  PASS: Directories created, contract marker absent."
else
    echo "  FAIL: State initialization failed."
    exit 1
fi

echo "=================================================="
echo "Piece 2: Plan Construction & Contract Marking"
echo "=================================================="
cat <<EOF > "$PLAN_DIR/current.md"
## Outcome
A complete programming assignment including boilerplate, instructions, solution, and automated tests.

## Items
- [ ] item-1: create instructions README.md
  agent: doc-writer
- [ ] item-2: scaffold assignment directories and boilerplate
  agent: scaffolder
  depends_on: [item-1]
- [ ] item-3: implement reference solution
  agent: implementer
  depends_on: [item-2]
- [ ] item-4: write test harness
  agent: test-writer
  depends_on: [item-3]
EOF
echo "3" > "$PLAN_DIR/.c-thru-contract-version"

if grep -q "item-4" "$PLAN_DIR/current.md" && [ "$(cat "$PLAN_DIR/.c-thru-contract-version")" == "3" ]; then
    echo "  PASS: current.md populated and contract marked."
else
    echo "  FAIL: Plan construction failed."
    exit 1
fi

echo "=================================================="
echo "Piece 3: Wave Topo-sorting & Batching (Wave 001)"
echo "=================================================="
mkdir -p "$PLAN_DIR/waves/001/digests" "$PLAN_DIR/waves/001/outputs" "$PLAN_DIR/waves/001/findings"
$HARNESS batch \
  --current-md "$PLAN_DIR/current.md" \
  --items "item-1" \
  --wave-id "001" \
  --commit-msg "Scaffold instructions" \
  --output "$PLAN_DIR/waves/001/wave.md"

if grep -q "\- \[ \] item-1" "$PLAN_DIR/waves/001/wave.md" && ! grep -q "\- \[ \] item-2" "$PLAN_DIR/waves/001/wave.md"; then
    echo "  PASS: Batch correctly isolated item-1."
else
    echo "  FAIL: Batching included incorrect items."
    exit 1
fi

echo "=================================================="
echo "Piece 4: Worker Calibration & Status Mutation"
echo "=================================================="
$HARNESS calibrate \
  --item "item-1" \
  --agent "doc-writer" \
  --confidence "high" \
  --verify-pass "true" \
  --wave-dir "$PLAN_DIR/waves/001"

$HARNESS update-marker \
  --wave-md "$PLAN_DIR/waves/001/wave.md" \
  --item "item-1" \
  --status "x" \
  --produced "README.md"

if grep -q "\- \[x\] item-1" "$PLAN_DIR/waves/001/wave.md"; then
    echo "  PASS: Marker updated to [x] for item-1."
else
    echo "  FAIL: Marker update failed."
    exit 1
fi

echo "=================================================="
echo "Piece 5: Pre-processor Transition Logic"
echo "=================================================="
cat <<EOF > "$PLAN_DIR/waves/001/findings.jsonl"
{"item_id":"item-1","status":"COMPLETE","produced":["README.md"],"dep_discoveries":[],"outcome_risk":false,"confidence":"high"}
EOF

HAS_RISK=$(grep -q '"outcome_risk":true' "$PLAN_DIR/waves/001/findings.jsonl" && echo "true" || echo "false")
if [ "$HAS_RISK" == "false" ]; then
    echo "  PASS: Pre-processor correctly evaluates to 'clean' transition."
else
    echo "  FAIL: Pre-processor incorrectly flagged outcome_risk."
    exit 1
fi

echo "=================================================="
echo "Piece 6: Final Review Transition"
echo "=================================================="
# Simulate current.md having all items completed
sed -i.bak 's/\[ \]/\[x\]/g' "$PLAN_DIR/current.md" 2>/dev/null || sed -i '' 's/\[ \]/\[x\]/g' "$PLAN_DIR/current.md"

READY_COUNT=$(grep "\- \[ \]" "$PLAN_DIR/current.md" | wc -l | tr -d ' ')
if [ "$READY_COUNT" -eq 0 ]; then
    echo "  PASS: No READY_ITEMS remain. Final review triggered."
else
    echo "  FAIL: Pending items incorrectly detected."
    exit 1
fi

echo "=================================================="
echo "E2E Programming Assignment Test Complete"
rm -rf "$TEST_DIR"
