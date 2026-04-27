#!/usr/bin/env bash
# Run the full c-thru test suite.
# Exit 0 = all tests passed.  Exit 1 = one or more suites failed.
#
# Usage: bash test/run-all.sh [--fast]
#   --fast  skip slow/optional suites (e2e, smoke-check)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

PASS=0
FAIL=0
SKIP=0

run_suite() {
  local label="$1"
  shift
  printf "  %-55s" "$label"
  local out ec=0
  out=$("$@" 2>&1) || ec=$?
  if [[ $ec -eq 0 ]]; then
    echo "✓"
    PASS=$(( PASS + 1 ))
  else
    echo "✗"
    FAIL=$(( FAIL + 1 ))
    echo "$out" | sed 's/^/    /' >&2
  fi
}

skip_suite() {
  local label="$1"
  printf "  %-55s" "$label"
  echo "SKIP"
  SKIP=$(( SKIP + 1 ))
}

echo ""
echo "c-thru test suite"
echo "-----------------"
echo ""
echo "Shell tests:"
run_suite "install-smoke (idempotency, symlinks, ephemeral arch)" \
  bash "$REPO_DIR/test/install-smoke.test.sh"
run_suite "ollama-probe (health-check script)" \
  bash "$REPO_DIR/test/ollama-probe.test.sh"
run_suite "preflight-model-readiness (/v1/active-models)" \
  bash "$REPO_DIR/test/preflight-model-readiness.test.sh"
run_suite "c-thru-contract-check (agent/skill contracts)" \
  bash "$REPO_DIR/test/c-thru-contract-check.test.sh"

echo ""
echo "Node tests:"
run_suite "model-map-v12-adapter (regression)" \
  node "$REPO_DIR/test/model-map-v12-adapter.test.js"
run_suite "proxy-lifecycle (startup, /ping, loopback bind)" \
  node "$REPO_DIR/test/proxy-lifecycle.test.js"
run_suite "proxy-forward-ollama-midstream-error" \
  node "$REPO_DIR/test/proxy-forward-ollama-midstream-error.test.js"
run_suite "proxy-client-disconnect-cleanup" \
  node "$REPO_DIR/test/proxy-client-disconnect-cleanup.test.js"
run_suite "proxy-content-length-scrub" \
  node "$REPO_DIR/test/proxy-content-length-scrub.test.js"
run_suite "proxy-cooldown-ttl" \
  node "$REPO_DIR/test/proxy-cooldown-ttl.test.js"
run_suite "model-map-config-project-overlay" \
  node "$REPO_DIR/test/model-map-config-project-overlay.test.js"

echo ""
echo "Validators:"
run_suite "model-map-validate (config/model-map.json)" \
  node "$REPO_DIR/tools/model-map-validate.js" "$REPO_DIR/config/model-map.json"
run_suite "c-thru-contract-check (agent contracts)" \
  bash "$REPO_DIR/tools/c-thru-contract-check.sh"
run_suite "bash -n tools/c-thru" \
  bash -n "$REPO_DIR/tools/c-thru"
run_suite "node --check tools/claude-proxy" \
  node --check "$REPO_DIR/tools/claude-proxy"

if [[ $FAST -eq 0 ]]; then
  echo ""
  echo "Smoke tests (slow — skip with --fast):"
  if [[ -f "$REPO_DIR/test/smoke-check.sh" ]]; then
    run_suite "smoke-check (proxy start, control channel)" \
      bash "$REPO_DIR/test/smoke-check.sh"
  else
    skip_suite "smoke-check (not found)"
  fi
else
  skip_suite "smoke-check (--fast mode)"
fi

echo ""
echo "-----------------"
TOTAL=$(( PASS + FAIL ))
if [[ $FAIL -eq 0 ]]; then
  echo "✓ $TOTAL/$TOTAL suites passed${SKIP:+ ($SKIP skipped)}"
else
  echo "✗ $FAIL/$TOTAL suites failed"
  exit 1
fi
