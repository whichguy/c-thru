#!/usr/bin/env bash
# Shell-level e2e: real Gemini through real c-thru CLI.
# Gated by C_THRU_LIVE_GEMINI=1 AND GOOGLE_API_KEY set; otherwise skip.
#
# This is the highest-leverage test in the suite — it exercises the full stack
# (c-thru → claude-proxy → real Gemini API → real Claude Code tool loop) and
# would have caught five bugs that pure-mock tests passed through during
# the Gemini integration. Run on demand before tagging Gemini work as ready.
#
# Run:
#   C_THRU_LIVE_GEMINI=1 GOOGLE_API_KEY=$KEY bash test/proxy-gemini-live-e2e.test.sh

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

LIVE_PROVIDER="gemini"
LIVE_SUITE="proxy-gemini-live-e2e"
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
if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
  echo "SKIP: GOOGLE_API_KEY not set"
  emit_live_outcome skipped missing_GOOGLE_API_KEY
  exit 0
fi

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
opportunistic_skip() { echo "  SKIP  OPPORTUNISTIC: $1"; SKIP=$((SKIP+1)); }

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
ARTIFACT_DIR="$(mktemp -d "$ARTIFACT_PARENT/c-thru-e2e.XXXXXX")"
RUN_TS="$$"
# Successful invocations ask their own launcher to reap only the proxy PID it
# started. Keep failed-call artifacts; remove the unique directory when empty.
trap 'rmdir "$ARTIFACT_DIR" 2>/dev/null || true' EXIT

# Run a c-thru invocation with a hard timeout when available. Captures combined
# stdout+stderr into the caller's variable named by $1. On non-zero exit, also
# saves stderr to an artifact file for diagnostic in the FAIL message.
#
# Usage: run_cthru <out_var> [<label>] -- <c-thru args...>
#
# Note: the local var name is `_rc_buf` not `out` — `local out` would shadow the
# caller's `out` so `printf -v "$out_var"` writes to the local and discards it.
run_cthru() {
  local out_var="$1"; shift
  local label="adhoc"
  if [[ "${1:-}" != -* && "${1:-}" != "" ]]; then
    label="$1"; shift
  fi
  local -i to="$CLI_TIMEOUT_SECONDS"
  # O2: mirror stdout to a file so live progress can be observed with
  # `tail -f /tmp/c-thru-e2e-*-<label>.out` while the test is running.
  local _rc_buf _err_file _out_file
  _err_file="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-${label}.err"
  _out_file="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-${label}.out"
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

# ── L1. PONG smoke ────────────────────────────────────────────────────────
echo
echo "L1. gemini-latest single-turn 'PONG' check"
out=""
run_cthru out L1 --model gemini-latest -p "Reply with the literal word PONG and nothing else."
rc=$?
[[ $rc -eq 0 ]] && pass "L1 exit 0" || fail "L1 exit $rc — output: ${out:0:300}"
[[ "$out" == *PONG* || "$out" == *pong* || "$out" == *Pong* ]] && pass "L1 stdout contains PONG" || fail "L1 missing PONG — output: ${out:0:300}"

# ── L2. gemini-flash basic completion ─────────────────────────────────────
echo
echo "L2. gemini-flash 3-word hello"
out=""
run_cthru out L2 --model gemini-flash -p "Say hello in 3 words."
rc=$?
[[ $rc -eq 0 ]] && pass "L2 exit 0" || fail "L2 exit $rc"
[[ -n "$out" ]] && pass "L2 non-empty output" || fail "L2 empty output"

# ── L3. THE TEST — list files in folder (full tool_use loop) ──────────────
echo
echo "L3. gemini-latest 'list files' (full tool_use roundtrip — the headline test)"
TMPDIR_L3="$(mktemp -d 2>/dev/null || mktemp -d -t gemini-l3)"
touch "$TMPDIR_L3/alpha.txt" "$TMPDIR_L3/beta.md" "$TMPDIR_L3/gamma.json"
L3_ERR="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-L3.err"
out=""
out="$(cd "$TMPDIR_L3" && run_bounded "$CLI_TIMEOUT_SECONDS" "$CTHRU" --model gemini-latest -p "list the files in the current folder" 2>"$L3_ERR")"
rc=$?
[[ $rc -eq 0 ]] && rm -f "$L3_ERR" || out+=$'\n[stderr saved to: '"$L3_ERR"$']'
[[ $rc -eq 0 ]] && pass "L3 exit 0" || fail "L3 exit $rc — output: ${out:0:300}"
hits=0
[[ "$out" == *alpha.txt* ]] && hits=$((hits+1))
[[ "$out" == *beta.md* ]]   && hits=$((hits+1))
[[ "$out" == *gamma.json* ]] && hits=$((hits+1))
if [[ $hits -ge 2 ]]; then
  pass "L3 mentions ≥2 actual filenames (got $hits/3)"
else
  fail "L3 only mentions $hits/3 filenames — tool_use loop likely broken. Output: ${out:0:500}"
fi
rm -rf "$TMPDIR_L3"

# ── L4. tool_use with arithmetic ──────────────────────────────────────────
echo
echo "L4. gemini-latest arithmetic (lets Claude Code inject default tools)"
out=""
run_cthru out L4 --model gemini-latest -p "What is 2 + 2? Answer with just the number."
rc=$?
[[ $rc -eq 0 ]] && pass "L4 exit 0" || fail "L4 exit $rc"
[[ "$out" == *4* ]] && pass "L4 output contains 4" || fail "L4 missing 4 — output: ${out:0:200}"

# ── L5. gemini-pro reasoning ──────────────────────────────────────────────
echo
echo "L5. gemini-pro 1+1 reasoning"
out=""
run_cthru out L5 --model gemini-pro -p "What is 1+1? Show your reasoning briefly."
rc=$?
[[ $rc -eq 0 ]] && pass "L5 exit 0" || fail "L5 exit $rc"
[[ "$out" == *2* ]] && pass "L5 output contains 2" || fail "L5 missing 2 — output: ${out:0:200}"

# ── L6. Vertex (only if env present) ──────────────────────────────────────
echo
echo "L6. Vertex AI smoke (requires GOOGLE_CLOUD_TOKEN + project + region)"
if [[ -z "${GOOGLE_CLOUD_TOKEN:-}" || -z "${GOOGLE_CLOUD_PROJECT:-}" || -z "${GOOGLE_CLOUD_REGION:-}" ]]; then
  opportunistic_skip "L6 — dedicated Vertex credentials not present"
else
  out=""
  run_cthru out L6 --model gemini-vertex -p "Reply with the literal word VERTEX_OK."
  rc=$?
  [[ $rc -eq 0 ]] && pass "L6 exit 0" || fail "L6 exit $rc — output: ${out:0:300}"
  [[ "$out" == *VERTEX_OK* ]] && pass "L6 Vertex roundtrip" || fail "L6 missing VERTEX_OK — output: ${out:0:300}"
fi

# ── L7. parallel tool calls in one assistant turn ─────────────────────────
# Catches: thoughtSignature cache keying when a single assistant turn returns
# 2 functionCalls — both must be remembered and re-attached individually on
# the follow-up turn.
echo
echo "L7. gemini-latest parallel tool calls (list + read in one turn)"
TMPDIR_L7="$(mktemp -d 2>/dev/null || mktemp -d -t gemini-l7)"
ALPHA_TOKEN="QUOKKA_BANANA_42"
printf '%s\n' "$ALPHA_TOKEN" > "$TMPDIR_L7/alpha.txt"
: > "$TMPDIR_L7/beta.md"
: > "$TMPDIR_L7/gamma.json"
L7_ERR="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-L7.err"
out=""
out="$(cd "$TMPDIR_L7" && run_bounded "$CLI_TIMEOUT_SECONDS" "$CTHRU" --model gemini-latest -p "List the files in the current folder AND read the contents of alpha.txt. Do both in parallel." 2>"$L7_ERR")"
rc=$?
[[ $rc -eq 0 ]] && rm -f "$L7_ERR" || out+=$'\n[stderr saved to: '"$L7_ERR"$']'
[[ $rc -eq 0 ]] && pass "L7 exit 0" || fail "L7 exit $rc — output: ${out:0:300}"
[[ "$out" == *alpha.txt* ]] && pass "L7 mentions alpha.txt" || fail "L7 missing alpha.txt — output: ${out:0:300}"
# Proof the read happened — the unique token from alpha.txt must surface.
[[ "$out" == *"$ALPHA_TOKEN"* ]] && pass "L7 contains alpha.txt token (read tool was called)" || fail "L7 missing token '$ALPHA_TOKEN' — read tool likely not invoked. Output: ${out:0:500}"
rm -rf "$TMPDIR_L7"

# ── L8–L11. each model alias through full wrapper ─────────────────────────
# Catches: route/alias regressions like the bug this session where the wrapper
# renamed gemini-pro → gemini-pro-latest but the proxy didn't have a route.
for alias_name in gemini-pro gemini-flash gemini-fast gemini-2.5-flash; do
  echo
  echo "L8/9/10/11. alias=$alias_name PONG"
  out=""
  run_cthru out "L-${alias_name}" --model "$alias_name" -p "Reply with the literal word PONG and nothing else."
  rc=$?
  [[ $rc -eq 0 ]] && pass "L-${alias_name} exit 0" || fail "L-${alias_name} exit $rc — output: ${out:0:300}"
  shopt -s nocasematch
  [[ "$out" == *pong* ]] && pass "L-${alias_name} stdout contains PONG" || fail "L-${alias_name} missing PONG — output: ${out:0:300}"
  shopt -u nocasematch
done

# ── L12. cross-mode invariance ────────────────────────────────────────────
# Gemini routing should be mode-orthogonal — both best-cloud and best-cloud-oss
# should successfully route gemini-latest.
for mode in best-cloud best-cloud-oss; do
  echo
  echo "L12. mode=$mode + gemini-latest"
  out=""
  run_cthru out "L12-${mode}" --mode "$mode" --model gemini-latest -p "Reply with the literal word PONG and nothing else."
  rc=$?
  [[ $rc -eq 0 ]] && pass "L12-${mode} exit 0" || fail "L12-${mode} exit $rc — output: ${out:0:300}"
done

# ── L13. realistic Claude Code session ────────────────────────────────────
# Catches the whole stack: auth + tool injection + multi-turn + thoughtSignature
# + file I/O + claude-CLI's `-p` mode end-of-turn detection.
echo
echo "L13. realistic CC session — read README + write summary"
TMPDIR_L13="$(mktemp -d 2>/dev/null || mktemp -d -t gemini-l13)"
SUMMARY_PATH="$TMPDIR_L13/summary.txt"
# P2 tightening: place a unique token ONLY in the body (not also derivable from
# the title/literal "project"). A summary that hits this token proves the read
# tool actually returned the file body — mock evasion is impossible.
README_BODY_TOKEN="GLISTENING_QUOKKA_47B"
cat > "$TMPDIR_L13/README.md" <<EOF
# Sample Repo

This codebase orchestrates $README_BODY_TOKEN across X, Y, and Z subsystems.
EOF
L13_ERR="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-L13.err"
out="$(cd "$TMPDIR_L13" && run_bounded "$CLI_TIMEOUT_SECONDS" "$CTHRU" --model gemini-latest -p "Read the README.md in this folder, then write a one-line summary to $SUMMARY_PATH" 2>"$L13_ERR")"
rc=$?
[[ $rc -eq 0 ]] && rm -f "$L13_ERR" || out+=$'\n[stderr saved to: '"$L13_ERR"$']'
[[ $rc -eq 0 ]] && pass "L13 exit 0" || fail "L13 exit $rc — output: ${out:0:300}"
if [[ -s "$SUMMARY_PATH" ]]; then
  pass "L13 summary.txt written and non-empty"
  summary_text="$(cat "$SUMMARY_PATH")"
  # Token-strict: only a true read of README.md body can produce this token.
  if [[ "$summary_text" == *"$README_BODY_TOKEN"* ]]; then
    pass "L13 summary contains README body token (read tool round-tripped real content)"
  else
    fail "L13 summary missing body token '$README_BODY_TOKEN' — got: ${summary_text:0:200}"
  fi
else
  fail "L13 summary.txt missing or empty — output: ${out:0:300}"
fi
rm -rf "$TMPDIR_L13"

echo
if [[ $SKIP -gt 0 ]]; then
  echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed ($SKIP skipped)"
else
  echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
fi
if [[ $FAIL -eq 0 ]]; then
  emit_live_outcome passed "all_mandatory_contracts_exercised_${SKIP}_opportunistic_skips"
  exit 0
fi
emit_live_outcome failed "${FAIL}_assertions_failed"
exit 1
