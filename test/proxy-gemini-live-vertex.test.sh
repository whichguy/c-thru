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

if [[ "${C_THRU_LIVE_GEMINI:-0}" != "1" ]]; then
  echo "SKIP: C_THRU_LIVE_GEMINI not set"
  exit 0
fi
for v in GOOGLE_CLOUD_TOKEN GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_REGION; do
  if [[ -z "${!v:-}" ]]; then
    echo "SKIP: $v not set"
    exit 0
  fi
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTHRU="$ROOT/tools/c-thru"
[[ -x "$CTHRU" ]] || { echo "FAIL: $CTHRU not executable"; exit 1; }

PASS=0
FAIL=0
SKIP=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
skip_test() { echo "  SKIP  $1"; SKIP=$((SKIP+1)); }

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
fi
[[ -z "$TIMEOUT_BIN" ]] && echo "WARN: no timeout binary; install via: brew install coreutils"

ARTIFACT_DIR="${TMPDIR:-/tmp}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"

# O1: per-process proxy cleanup — snapshot pre-existing PIDs so a parallel
# test invocation isn't killed by ours.
PRE_PIDS_FILE="$ARTIFACT_DIR/c-thru-vertex-${RUN_TS}-pre-pids.txt"
pgrep -f claude-proxy > "$PRE_PIDS_FILE" 2>/dev/null || : > "$PRE_PIDS_FILE"
cleanup_proxies() {
  local cur
  cur="$(pgrep -f claude-proxy 2>/dev/null || true)"
  [[ -z "$cur" ]] && return 0
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if ! grep -qx "$pid" "$PRE_PIDS_FILE"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done <<< "$cur"
}
trap 'cleanup_proxies; rm -f "$PRE_PIDS_FILE"' EXIT

run_cthru() {
  local out_var="$1"; shift
  local label="$1"; shift
  local -i to="${TIMEOUT:-90}"
  local _rc_buf _err_file _out_file
  _err_file="$ARTIFACT_DIR/c-thru-vertex-${RUN_TS}-${label}.err"
  _out_file="$ARTIFACT_DIR/c-thru-vertex-${RUN_TS}-${label}.out"
  if [[ -n "$TIMEOUT_BIN" ]]; then
    _rc_buf="$($TIMEOUT_BIN "${to}" "$CTHRU" "$@" 2>"$_err_file" | tee "$_out_file")"
  else
    _rc_buf="$("$CTHRU" "$@" 2>"$_err_file" | tee "$_out_file")"
  fi
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
cleanup_proxies
out=""
run_cthru out V1 --model gemini-vertex -p "Reply with the literal word VERTEX_OK."
rc=$?
[[ $rc -eq 0 ]] && pass "V1 exit 0" || fail "V1 exit $rc — output: ${out:0:300}"
[[ "$out" == *VERTEX_OK* ]] && pass "V1 stdout contains VERTEX_OK" || fail "V1 missing VERTEX_OK — output: ${out:0:300}"

# ── V2. Vertex tool_use smoke (replicates S3) ─────────────────────────────
echo
echo "V2. gemini-vertex arithmetic"
cleanup_proxies
out=""
run_cthru out V2 --model gemini-vertex -p "What is 7 + 5? Answer with just the number."
rc=$?
[[ $rc -eq 0 ]] && pass "V2 exit 0" || fail "V2 exit $rc"
[[ "$out" == *12* ]] && pass "V2 contains 12" || fail "V2 missing 12 — output: ${out:0:300}"

# ── V3. Vertex tool_use roundtrip (replicates L3) ─────────────────────────
echo
echo "V3. gemini-vertex list-files tool roundtrip"
cleanup_proxies
TMPDIR_V3="$(mktemp -d 2>/dev/null || mktemp -d -t gemini-v3)"
touch "$TMPDIR_V3/alpha.txt" "$TMPDIR_V3/beta.md" "$TMPDIR_V3/gamma.json"
V3_ERR="$ARTIFACT_DIR/c-thru-vertex-${RUN_TS}-V3.err"
if [[ -n "$TIMEOUT_BIN" ]]; then
  out="$(cd "$TMPDIR_V3" && $TIMEOUT_BIN 120 "$CTHRU" --model gemini-vertex -p "list the files in the current folder" 2>"$V3_ERR")"
else
  out="$(cd "$TMPDIR_V3" && "$CTHRU" --model gemini-vertex -p "list the files in the current folder" 2>"$V3_ERR")"
fi
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
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
