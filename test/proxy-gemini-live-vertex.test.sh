#!/usr/bin/env bash
# Vertex AI live coverage — replicates a few AI-Studio cases against the
# gemini_vertex endpoint to verify the auth-path divergence (Bearer vs
# x-goog-api-key) and the URL-templating round-trip.
#
# Gated separately from the AI-Studio suite. Requires:
#   GOOGLE_CLOUD_TOKEN   — `gcloud auth print-access-token`
#   GOOGLE_CLOUD_PROJECT — GCP project id
#   GOOGLE_CLOUD_REGION  — e.g. us-central1
#   C_THRU_LIVE_GEMINI=1
#
# Run:
#   GOOGLE_CLOUD_TOKEN=$(gcloud auth print-access-token) \
#     GOOGLE_CLOUD_PROJECT=my-proj GOOGLE_CLOUD_REGION=us-central1 \
#     C_THRU_LIVE_GEMINI=1 bash test/proxy-gemini-live-vertex.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
has_active_test_supervisor() {
  node "$ROOT/tools/test-supervisor-capability.js" --verify-shell-child
}

if ! has_active_test_supervisor; then
  exec node "$ROOT/tools/run-with-hard-timeout.js" \
    --timeout-seconds "${C_THRU_TEST_TIMEOUT_SECONDS:-3600}" \
    -- bash "${BASH_SOURCE[0]}" "$@"
fi

LIVE_PROVIDER="vertex"
LIVE_SUITE="proxy-gemini-live-vertex"
emit_live_outcome() {
  local status="$1" reason="$2"
  reason=$(printf '%s' "$reason" | tr -c 'A-Za-z0-9_.:/+-' '_')
  printf 'C_THRU_LIVE_OUTCOME|provider=%s|suite=%s|status=%s|reason=%s\n' \
    "$LIVE_PROVIDER" "$LIVE_SUITE" "$status" "$reason"
}

if [[ "${C_THRU_LIVE_GEMINI:-0}" != "1" ]]; then
  echo "SKIP: C_THRU_LIVE_GEMINI not set"
  emit_live_outcome skipped gate_not_enabled
  exit 0
fi
for v in GOOGLE_CLOUD_TOKEN GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_REGION; do
  if [[ -z "${!v:-}" ]]; then
    echo "SKIP: $v not set"
    emit_live_outcome skipped "missing_${v}"
    exit 0
  fi
done

MODEL_TEST_TIMEOUT_MS="${C_THRU_MODEL_TEST_TIMEOUT_MS:-3600000}"
if [[ ! "$MODEL_TEST_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] \
  || (( ${#MODEL_TEST_TIMEOUT_MS} > 7 )) \
  || { (( ${#MODEL_TEST_TIMEOUT_MS} == 7 )) && [[ "$MODEL_TEST_TIMEOUT_MS" > "3600000" ]]; }; then
  echo "ERROR: C_THRU_MODEL_TEST_TIMEOUT_MS must be an integer from 1 to 3600000" >&2
  emit_live_outcome failed invalid_C_THRU_MODEL_TEST_TIMEOUT_MS
  exit 2
fi
MODEL_TEST_TIMEOUT_SECONDS=$(( (MODEL_TEST_TIMEOUT_MS + 999) / 1000 ))
CLI_TIMEOUT_SECONDS="${TIMEOUT:-$MODEL_TEST_TIMEOUT_SECONDS}"
if [[ ! "$CLI_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || (( ${#CLI_TIMEOUT_SECONDS} > 4 )) \
  || { (( ${#CLI_TIMEOUT_SECONDS} == 4 )) && [[ "$CLI_TIMEOUT_SECONDS" > "3600" ]]; }; then
  echo "ERROR: TIMEOUT must be an integer from 1 to 3600" >&2
  emit_live_outcome failed invalid_TIMEOUT
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
export C_THRU_KEEP_PROXY=0

CTHRU="$ROOT/tools/c-thru"
if [[ ! -x "$CTHRU" ]]; then
  echo "FAIL: $CTHRU not executable"
  emit_live_outcome failed c_thru_not_executable
  exit 1
fi

PASS=0
FAIL=0
SKIP=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
skip_test() { echo "  SKIP  $1"; SKIP=$((SKIP+1)); }

run_bounded() {
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
  return "$rc"
}

ARTIFACT_PARENT="${TMPDIR:-/tmp}"
ARTIFACT_DIR="$(mktemp -d "$ARTIFACT_PARENT/c-thru-vertex.XXXXXX")"
RUN_TS="$$"
# Each launcher reaps only the proxy PID it started. Preserve failed-call
# artifacts and remove the unique run directory when it is empty.
trap 'rmdir "$ARTIFACT_DIR" 2>/dev/null || true' EXIT

run_cthru() {
  local out_var="$1"; shift
  local label="$1"; shift
  local -i to="$CLI_TIMEOUT_SECONDS"
  local _rc_buf _err_file _out_file
  _err_file="$ARTIFACT_DIR/c-thru-vertex-${RUN_TS}-${label}.err"
  _out_file="$ARTIFACT_DIR/c-thru-vertex-${RUN_TS}-${label}.out"
  _rc_buf="$(run_bounded "${to}" "$CTHRU" "$@" 2>"$_err_file" | tee "$_out_file")"
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    _rc_buf+=$'\n[stderr saved to: '"$_err_file"$']'
    _rc_buf+=$'\n[stdout saved to: '"$_out_file"$']'
  else
    rm -f "$_err_file" "$_out_file"
  fi
  printf -v "$out_var" '%s' "$_rc_buf"
  return $rc
}

# ── V1. Vertex PONG smoke ─────────────────────────────────────────────────
echo
echo "V1. gemini-vertex single-turn PONG"
out=""
run_cthru out V1 --model gemini-vertex -p "Reply with the literal word VERTEX_OK."
rc=$?
[[ $rc -eq 0 ]] && pass "V1 exit 0" || fail "V1 exit $rc — output: ${out:0:300}"
[[ "$out" == *VERTEX_OK* ]] && pass "V1 stdout contains VERTEX_OK" || fail "V1 missing VERTEX_OK — output: ${out:0:300}"

# ── V2. Vertex tool_use smoke (replicates S3) ─────────────────────────────
echo
echo "V2. gemini-vertex arithmetic"
out=""
run_cthru out V2 --model gemini-vertex -p "What is 7 + 5? Answer with just the number."
rc=$?
[[ $rc -eq 0 ]] && pass "V2 exit 0" || fail "V2 exit $rc"
[[ "$out" == *12* ]] && pass "V2 contains 12" || fail "V2 missing 12 — output: ${out:0:300}"

# ── V3. Vertex tool_use roundtrip (replicates L3) ─────────────────────────
echo
echo "V3. gemini-vertex list-files tool roundtrip"
TMPDIR_V3="$(mktemp -d 2>/dev/null || mktemp -d -t gemini-v3)"
touch "$TMPDIR_V3/alpha.txt" "$TMPDIR_V3/beta.md" "$TMPDIR_V3/gamma.json"
V3_ERR="$ARTIFACT_DIR/c-thru-vertex-${RUN_TS}-V3.err"
out="$(cd "$TMPDIR_V3" && run_bounded "$CLI_TIMEOUT_SECONDS" "$CTHRU" --model gemini-vertex -p "list the files in the current folder" 2>"$V3_ERR")"
rc=$?
[[ $rc -eq 0 ]] && rm -f "$V3_ERR" || out+=$'\n[stderr saved to: '"$V3_ERR"$']'
[[ $rc -eq 0 ]] && pass "V3 exit 0" || fail "V3 exit $rc — output: ${out:0:300}"
hits=0
[[ "$out" == *alpha.txt* ]] && hits=$((hits+1))
[[ "$out" == *beta.md* ]]   && hits=$((hits+1))
[[ "$out" == *gamma.json* ]] && hits=$((hits+1))
[[ $hits -ge 2 ]] && pass "V3 mentions ≥2 filenames ($hits/3)" || fail "V3 only $hits/3 — output: ${out:0:500}"
rm -rf "$TMPDIR_V3"

echo
if [[ $SKIP -gt 0 ]]; then
  echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed ($SKIP skipped)"
else
  echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
fi
if [[ $FAIL -eq 0 ]]; then
  emit_live_outcome passed all_mandatory_contracts_exercised
  exit 0
fi
emit_live_outcome failed "${FAIL}_assertions_failed"
exit 1
