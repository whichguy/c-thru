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

# ── Exclusive lock for full runs ───────────────────────────────────────────────
# Two concurrent full runs cross-fail: proxy-e2e talks to the live Ollama backend
# (timeouts under contention — observed empirically) and smoke-check exercises the
# shared proxy lifecycle. Most unit suites bind random free ports and are safe,
# so --fast runs skip the lock; full runs hold it for the whole run.
# mkdir-lock with a stale-pid check — NOT flock(1), which is absent on stock
# macOS (this repo's primary dev machine); flock may be added as a parenthetical
# fast-path for Linux CI only.
LOCK_DIR="${TMPDIR:-/tmp}/c-thru-run-all.lock"
LOCK_HELD=""

release_lock() {
  [[ -n "$LOCK_HELD" ]] && rm -rf "$LOCK_DIR"
}

acquire_lock() {
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    local owner=""
    owner=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then
      echo "  removing stale lock (pid $owner no longer running)"
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [[ -z "$owner" ]]; then
      # mkdir→pid-write window is microseconds; a pid-less lock older than 60s
      # means the holder crashed before writing its pid — reclaim it.
      local now mtime age
      now=$(date +%s)
      mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo "$now")
      age=$(( now - mtime ))
      if (( age > 60 )); then
        echo "  removing stale pid-less lock (age ${age}s)"
        rm -rf "$LOCK_DIR"
        continue
      fi
    fi
    echo "  waiting for concurrent run-all.sh (pid ${owner:-unknown}) to release the full-run lock..."
    sleep 5
  done
  echo "$$" > "$LOCK_DIR/pid"
  LOCK_HELD=1
  trap release_lock EXIT
}

# Full runs are exclusive; --fast runs are concurrency-safe and skip the lock.
if [[ $FAST -eq 0 ]]; then
  acquire_lock
fi

# Failing-suite output is also persisted here (lazily created on first failure)
# so a flake in a long full run stays diagnosable after the terminal scrolls.
# Green runs create nothing.
FAIL_LOG_DIR="${TMPDIR:-/tmp}/c-thru-runall-$$"
# Failed runs leave their dir behind by design (that's the point) — prune only
# week-old leftovers so they don't accumulate forever. Prefix can't collide with
# the c-thru-run-all.lock dir; -mtime +7 never touches a live run's dir.
find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'c-thru-runall-*' -mtime +7 -exec rm -rf {} + 2>/dev/null || true

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
    mkdir -p "$FAIL_LOG_DIR"
    local slug
    slug=$(printf '%s' "$label" | tr -c 'a-zA-Z0-9._-' '-' | sed 's/--*/-/g; s/^-//; s/-$//')
    printf '%s\n' "$out" > "$FAIL_LOG_DIR/$slug.log"
    echo "    output saved: $FAIL_LOG_DIR/$slug.log" >&2
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
run_suite "c-thru-explain-bash (bash integration: _explain_all_json cache + TSV contracts)" \
  bash "$REPO_DIR/test/c-thru-explain-bash.test.sh"
run_suite "c-thru-bootstrap-auth-env (bootstrap auth env helper)" \
  bash "$REPO_DIR/test/c-thru-bootstrap-auth-env.test.sh"
run_suite "hook-payload-extraction (hook payload extraction)" \
  bash "$REPO_DIR/test/hook-payload-extraction.test.sh"
run_suite "agent-router-hook (subagent_type → capability model rewrite)" \
  bash "$REPO_DIR/test/agent-router-hook.test.js"
run_suite "strict-models (C_THRU_STRICT_MODELS=1 enforcement)" \
  bash "$REPO_DIR/test/strict-models.test.sh"
if command -v jq >/dev/null 2>&1; then
  run_suite "self-update-divergence (diverged/stale-WIP advisories)" \
    bash "$REPO_DIR/test/self-update-divergence.test.sh"
else
  skip_suite "self-update-divergence (jq not installed)"
fi
run_suite "session-start-seeding (first-run seed + settings registration)" \
  bash "$REPO_DIR/test/session-start-seeding.test.sh"

echo ""
echo "Node tests:"
run_suite "model-map-v12-adapter (regression)" \
  node "$REPO_DIR/test/model-map-v12-adapter.test.js"
run_suite "proxy-lifecycle (startup, /ping, loopback bind)" \
  node "$REPO_DIR/test/proxy-lifecycle.test.js"
run_suite "proxy-unhandled-rejection (unhandledRejection handler + log)" \
  node "$REPO_DIR/test/proxy-unhandled-rejection.test.js"
run_suite "proxy-body-size-cap (MAX_BODY_BYTES 413 guard)" \
  node "$REPO_DIR/test/proxy-body-size-cap.test.js"
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
run_suite "agent-mapping-complete (every agent → live endpoint, all modes×tiers)" \
  node "$REPO_DIR/test/agent-mapping-complete.test.js"
run_suite "agent-invocation-headers (per-agent resolved-via/served-by/journal)" \
  node "$REPO_DIR/test/agent-invocation-headers.test.js"
run_suite "agent-dispatch-graph (subagent_type targets resolve agent→capability→model)" \
  node "$REPO_DIR/test/agent-dispatch-graph.test.js"
run_suite "agent-description-quality (description discoverability lint)" \
  node "$REPO_DIR/test/agent-description-quality.test.js"
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
run_suite "proxy-config-watcher (watcher failure logs warning, no crash)" \
  node "$REPO_DIR/test/proxy-config-watcher.test.js"
run_suite "proxy-observability-headers (backend latency, auth-missing, tier headers)" \
  node "$REPO_DIR/test/proxy-observability-headers.test.js"
run_suite "proxy-init-race (READY_FAILED sentinel on EADDRINUSE)" \
  node "$REPO_DIR/test/proxy-init-race.test.js"
run_suite "proxy-fallback-reload (fallback chain stable across SIGHUP reload)" \
  node "$REPO_DIR/test/proxy-fallback-reload.test.js"
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
run_suite "proxy-probe-llm (/v1/probe-llm endpoint)" \
  node "$REPO_DIR/test/proxy-probe-llm.test.js"
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
run_suite "anthropic-api-coverage (501 gating + translation-gap header)" \
  node "$REPO_DIR/test/anthropic-api-coverage.test.js"
run_suite "resolution-coverage (full resolution coverage)" \
  node "$REPO_DIR/test/resolution-coverage.test.js"
run_suite "proxy-model-pin-routing (model pin + routing)" \
  node "$REPO_DIR/test/proxy-model-pin-routing.test.js"
run_suite "proxy-cross-provider-parity (live parity — skipped unless C_THRU_LIVE_PARITY=1)" \
  node "$REPO_DIR/test/proxy-cross-provider-parity.test.js"
run_suite "proxy-gemini-routing (Gemini routing + picker aliases)" \
  node "$REPO_DIR/test/proxy-gemini-routing.test.js"
run_suite "proxy-gemini-translation (Anthropic→Gemini translation)" \
  node "$REPO_DIR/test/proxy-gemini-translation.test.js"

run_suite "proxy-ollama-passthrough (Ollama /v1/messages passthrough + tool block preservation)" \
  node "$REPO_DIR/test/proxy-ollama-passthrough.test.js"
run_suite "model-map-lineage (full resolution matrix snapshot)" \
  node "$REPO_DIR/test/model-map-lineage.test.js"
run_suite "lineage-update-roundtrip (--update no-op/update/corrupt behaviors)" \
  node "$REPO_DIR/test/lineage-update-roundtrip.test.js"
run_suite "proxy-quality (mapping, fallback cascade, v1 passthrough)" \
  node "$REPO_DIR/test/proxy-quality.test.js"

# EXCLUDED (tests for features not yet implemented in the proxy):
# proxy-classify.test.js:  CLAUDE_PROXY_CLASSIFY dynamic in-proxy classifier not implemented
# proxy-targets.test.js:   targets{} config section (request_defaults per model) not implemented
# benchmark-coverage.test.js: passes now, but low value (0 cells checked since modes not in fixture)
skip_suite "benchmark-coverage (excluded — 0 cells checked, mode fixture not populated)"
skip_suite "proxy-classify (excluded — CLAUDE_PROXY_CLASSIFY feature not implemented in proxy)"
skip_suite "proxy-targets (excluded — targets{} config feature not implemented in proxy)"

if [[ "${C_THRU_LIVE_ANTHROPIC:-0}" == "1" ]]; then
  echo ""
  echo "Live API tests (C_THRU_LIVE_ANTHROPIC=1):"
  run_suite "anthropic-api-coverage-live (real api.anthropic.com via proxy)" \
    node "$REPO_DIR/test/anthropic-api-coverage-live.test.js"
else
  skip_suite "anthropic-api-coverage-live (set C_THRU_LIVE_ANTHROPIC=1 + ANTHROPIC_API_KEY to enable)"
fi

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
# Drift checks duplicated from .githooks/pre-commit: the hook only runs when
# core.hooksPath is armed (per-clone, manual, silently lost), so a green full
# run must prove bundle/README sync regardless of hook activation.
run_suite "sync-plugin-bundle --check (bundle drift)" \
  bash "$REPO_DIR/tools/sync-plugin-bundle.sh" --check
run_suite "gen-routing-doc --check (README routing table drift)" \
  node "$REPO_DIR/tools/gen-routing-doc.js" --check
run_suite "hooks-armed (core.hooksPath → .githooks, fail-closed)" \
  bash "$REPO_DIR/test/hooks-armed.test.sh"

if [[ $FAST -eq 0 ]]; then
  echo ""
  echo "Smoke tests (slow — skip with --fast):"
  if [[ -f "$REPO_DIR/test/smoke-check.sh" ]]; then
    run_suite "smoke-check (proxy start, control channel)" \
      bash "$REPO_DIR/test/smoke-check.sh"
  else
    skip_suite "smoke-check (not found)"
  fi
  # Advisory, opt-in: a real Ollama-backed session whose prompt elicits a
  # subagent, verified via the journal. Self-skips (exit 0) unless C_THRU_E2E=1
  # and Ollama + a claude binary are present; never fails the suite.
  if [[ "${C_THRU_E2E:-0}" == "1" ]]; then
    run_suite "agent-scenarios-e2e (prompt→agent→journal, advisory)" \
      bash "$REPO_DIR/test/agent-scenarios-e2e.sh"
  else
    skip_suite "agent-scenarios-e2e (set C_THRU_E2E=1 + Ollama to enable)"
  fi
else
  skip_suite "smoke-check (--fast mode)"
  skip_suite "agent-scenarios-e2e (--fast mode)"
fi

echo ""
echo "-----------------"
TOTAL=$(( PASS + FAIL ))
if [[ $FAIL -eq 0 ]]; then
  # ${SKIP:+...} alone always expands (SKIP=0 is non-empty) — guard on count
  if [[ $SKIP -gt 0 ]]; then
    echo "✓ $TOTAL/$TOTAL suites passed ($SKIP skipped)"
  else
    echo "✓ $TOTAL/$TOTAL suites passed"
  fi
else
  echo "✗ $FAIL/$TOTAL suites failed (failing output saved under $FAIL_LOG_DIR)"
  exit 1
fi
