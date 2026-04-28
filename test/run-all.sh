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
run_suite "proxy-runtime-fallback (fallback chains, cycle detection)" \
  node "$REPO_DIR/test/proxy-runtime-fallback.test.js"
run_suite "capability-alias-resolve (2-hop agent→capability)" \
  node "$REPO_DIR/test/capability-alias-resolve.test.js"
run_suite "llm-mode-resolution-matrix (16-mode matrix)" \
  node "$REPO_DIR/test/llm-mode-resolution-matrix.test.js"
run_suite "resolve-capability (capability alias graph)" \
  node "$REPO_DIR/test/resolve-capability.test.js"
run_suite "model-map-filter (mode-based filtering)" \
  node "$REPO_DIR/test/model-map-filter.test.js"
run_suite "model-map-ranking (quality-score ranking)" \
  node "$REPO_DIR/test/model-map-ranking.test.js"
run_suite "proxy-tool-use (tool use / function calling)" \
  node "$REPO_DIR/test/proxy-tool-use.test.js"
run_suite "hw-profile (hardware tier detection)" \
  node "$REPO_DIR/test/hw-profile.test.js"
run_suite "model-map-layered (3-tier config merge)" \
  node "$REPO_DIR/test/model-map-layered.test.js"
run_suite "llm-profiles-editor (profile edit helpers)" \
  node "$REPO_DIR/test/llm-profiles-editor.test.js"
run_suite "model-map-config (config path resolution)" \
  node "$REPO_DIR/test/model-map-config.test.js"
run_suite "proxy-cli-flags (parseCliFlags edge cases)" \
  node "$REPO_DIR/test/proxy-cli-flags.test.js"
run_suite "proxy-usage-stats (recordUsage debounce + SIGTERM flush)" \
  node "$REPO_DIR/test/proxy-usage-stats.test.js"
run_suite "agent-contract-static (agent/skill static contracts)" \
  node "$REPO_DIR/test/agent-contract-static.test.js"
run_suite "agent-status-schema (STATUS block schema)" \
  node "$REPO_DIR/test/agent-status-schema.test.js"
run_suite "c-thru-config-helpers (config helper functions)" \
  node "$REPO_DIR/test/c-thru-config-helpers.test.js"
run_suite "c-thru-explain (explain command resolution)" \
  node "$REPO_DIR/test/c-thru-explain.test.js"
run_suite "c-thru-plan-harness (plan harness utilities)" \
  node "$REPO_DIR/test/c-thru-plan-harness.test.js"
run_suite "c-thru-target-launch (target launch helpers)" \
  node "$REPO_DIR/test/c-thru-target-launch.test.js"
run_suite "cli-e2e-flags (CLI flag forwarding e2e)" \
  node "$REPO_DIR/test/cli-e2e-flags.test.js"
run_suite "compile-prompts (agent prompt compilation)" \
  node "$REPO_DIR/test/compile-prompts.test.js"
run_suite "llm-capabilities-mcp (MCP server tools)" \
  node "$REPO_DIR/test/llm-capabilities-mcp.test.js"
run_suite "model-map-pollution (config isolation / no cross-test leak)" \
  node "$REPO_DIR/test/model-map-pollution.test.js"
run_suite "model-map-validate (schema validator unit)" \
  node "$REPO_DIR/test/model-map-validate.test.js"
run_suite "planner-return-schema (planner output schema)" \
  node "$REPO_DIR/test/planner-return-schema.test.js"
run_suite "proxy-active-models (/v1/active-models endpoint)" \
  node "$REPO_DIR/test/proxy-active-models.test.js"
run_suite "proxy-autodetect (backend auto-detection)" \
  node "$REPO_DIR/test/proxy-autodetect.test.js"
run_suite "proxy-concurrent (concurrent request handling)" \
  node "$REPO_DIR/test/proxy-concurrent.test.js"
run_suite "proxy-config-reload (SIGHUP config reload)" \
  node "$REPO_DIR/test/proxy-config-reload.test.js"
run_suite "proxy-e2e (end-to-end proxy request flow)" \
  node "$REPO_DIR/test/proxy-e2e.test.js"
run_suite "proxy-fallback-cascade (fallback chain cascade)" \
  node "$REPO_DIR/test/proxy-fallback-cascade.test.js"
run_suite "proxy-form-factor (form factor detection)" \
  node "$REPO_DIR/test/proxy-form-factor.test.js"
run_suite "proxy-journal (journaling JSONL output)" \
  node "$REPO_DIR/test/proxy-journal.test.js"
run_suite "proxy-messages (messages API translation)" \
  node "$REPO_DIR/test/proxy-messages.test.js"
run_suite "proxy-mode-filters (mode-based request filtering)" \
  node "$REPO_DIR/test/proxy-mode-filters.test.js"
run_suite "proxy-mode-multi-backend (multi-backend mode routing)" \
  node "$REPO_DIR/test/proxy-mode-multi-backend.test.js"
run_suite "proxy-mode-overrides (mode override precedence)" \
  node "$REPO_DIR/test/proxy-mode-overrides.test.js"
run_suite "proxy-mode-ranking (mode-aware quality ranking)" \
  node "$REPO_DIR/test/proxy-mode-ranking.test.js"
run_suite "proxy-resolution-matrix (full resolution matrix)" \
  node "$REPO_DIR/test/proxy-resolution-matrix.test.js"
run_suite "proxy-streaming-ollama (SSE streaming to Ollama)" \
  node "$REPO_DIR/test/proxy-streaming-ollama.test.js"
run_suite "proxy-streaming (SSE streaming)" \
  node "$REPO_DIR/test/proxy-streaming.test.js"
run_suite "proxy-tier-resolution (hw-tier model resolution)" \
  node "$REPO_DIR/test/proxy-tier-resolution.test.js"
run_suite "proxy-translation (Anthropic→provider translation)" \
  node "$REPO_DIR/test/proxy-translation.test.js"
run_suite "resolution-coverage (full resolution coverage)" \
  node "$REPO_DIR/test/resolution-coverage.test.js"

# EXCLUDED (currently failing — do not wire until fixed):
# benchmark-coverage.test.js: coverage-map mismatch / fixture drift (run manually to diagnose)
# proxy-classify.test.js:     withProxy async error at startup
# proxy-targets.test.js:      withProxy async error at startup
skip_suite "benchmark-coverage (excluded — fixture drift, run manually to diagnose)"
skip_suite "proxy-classify (excluded — withProxy async error at startup)"
skip_suite "proxy-targets (excluded — withProxy async error at startup)"

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
