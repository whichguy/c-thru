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

if [[ "${C_THRU_LIVE_GEMINI:-0}" != "1" ]]; then
  echo "SKIP: C_THRU_LIVE_GEMINI not set"
  exit 0
fi
if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
  echo "SKIP: GOOGLE_API_KEY not set"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTHRU="$ROOT/tools/c-thru"
if [[ ! -x "$CTHRU" ]]; then
  echo "FAIL: $CTHRU not executable"
  exit 1
fi

PASS=0
FAIL=0
SKIP=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
skip_test() { echo "  SKIP  $1"; SKIP=$((SKIP+1)); }

# Pick a timeout binary if one exists; otherwise run without bounded timeout.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
fi
if [[ -z "$TIMEOUT_BIN" ]]; then
  echo "WARN: no timeout binary; install via: brew install coreutils"
fi

ARTIFACT_DIR="${TMPDIR:-/tmp}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"

# O1 (per-process proxy cleanup): snapshot pre-existing claude-proxy PIDs so a
# parallel test invocation isn't killed by ours. cleanup_proxies kills only
# proxies whose PID was NOT in the original snapshot.
#
# pgrep portability: -f matches against the full command line. Output is
# whitespace-separated PIDs; an empty result is OK (returns 1).
PRE_PIDS_FILE="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-pre-pids.txt"
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

# Final cleanup on any exit path so leaked proxies from this run don't linger.
trap 'cleanup_proxies; rm -f "$PRE_PIDS_FILE"' EXIT

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
  local -i to="${TIMEOUT:-90}"
  # O2: mirror stdout to a file so live progress can be observed with
  # `tail -f /tmp/c-thru-e2e-*-<label>.out` while the test is running.
  local _rc_buf _err_file _out_file
  _err_file="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-${label}.err"
  _out_file="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-${label}.out"
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

# ── L1. PONG smoke ────────────────────────────────────────────────────────
echo
echo "L1. gemini-latest single-turn 'PONG' check"
cleanup_proxies
out=""
run_cthru out L1 --model gemini-latest -p "Reply with the literal word PONG and nothing else."
rc=$?
[[ $rc -eq 0 ]] && pass "L1 exit 0" || fail "L1 exit $rc — output: ${out:0:300}"
[[ "$out" == *PONG* || "$out" == *pong* || "$out" == *Pong* ]] && pass "L1 stdout contains PONG" || fail "L1 missing PONG — output: ${out:0:300}"

# ── L2. gemini-flash basic completion ─────────────────────────────────────
echo
echo "L2. gemini-flash 3-word hello"
cleanup_proxies
out=""
run_cthru out L2 --model gemini-flash -p "Say hello in 3 words."
rc=$?
[[ $rc -eq 0 ]] && pass "L2 exit 0" || fail "L2 exit $rc"
[[ -n "$out" ]] && pass "L2 non-empty output" || fail "L2 empty output"

# ── L3. THE TEST — list files in folder (full tool_use loop) ──────────────
echo
echo "L3. gemini-latest 'list files' (full tool_use roundtrip — the headline test)"
cleanup_proxies
TMPDIR_L3="$(mktemp -d 2>/dev/null || mktemp -d -t gemini-l3)"
touch "$TMPDIR_L3/alpha.txt" "$TMPDIR_L3/beta.md" "$TMPDIR_L3/gamma.json"
L3_ERR="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-L3.err"
out=""
if [[ -n "$TIMEOUT_BIN" ]]; then
  out="$(cd "$TMPDIR_L3" && $TIMEOUT_BIN 120 "$CTHRU" --model gemini-latest -p "list the files in the current folder" 2>"$L3_ERR")"
else
  out="$(cd "$TMPDIR_L3" && "$CTHRU" --model gemini-latest -p "list the files in the current folder" 2>"$L3_ERR")"
fi
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
cleanup_proxies
out=""
run_cthru out L4 --model gemini-latest -p "What is 2 + 2? Answer with just the number."
rc=$?
[[ $rc -eq 0 ]] && pass "L4 exit 0" || fail "L4 exit $rc"
[[ "$out" == *4* ]] && pass "L4 output contains 4" || fail "L4 missing 4 — output: ${out:0:200}"

# ── L5. gemini-pro reasoning ──────────────────────────────────────────────
echo
echo "L5. gemini-pro 1+1 reasoning"
cleanup_proxies
out=""
run_cthru out L5 --model gemini-pro -p "What is 1+1? Show your reasoning briefly."
rc=$?
[[ $rc -eq 0 ]] && pass "L5 exit 0" || fail "L5 exit $rc"
[[ "$out" == *2* ]] && pass "L5 output contains 2" || fail "L5 missing 2 — output: ${out:0:200}"

# ── L6. Vertex (only if env present) ──────────────────────────────────────
echo
echo "L6. Vertex AI smoke (requires GOOGLE_CLOUD_TOKEN + project + region)"
if [[ -z "${GOOGLE_CLOUD_TOKEN:-}" || -z "${GOOGLE_CLOUD_PROJECT:-}" || -z "${GOOGLE_CLOUD_REGION:-}" ]]; then
  echo "  SKIP  L6 — set GOOGLE_CLOUD_TOKEN, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_REGION to run"
else
  cleanup_proxies
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
cleanup_proxies
TMPDIR_L7="$(mktemp -d 2>/dev/null || mktemp -d -t gemini-l7)"
ALPHA_TOKEN="QUOKKA_BANANA_42"
printf '%s\n' "$ALPHA_TOKEN" > "$TMPDIR_L7/alpha.txt"
: > "$TMPDIR_L7/beta.md"
: > "$TMPDIR_L7/gamma.json"
L7_ERR="$ARTIFACT_DIR/c-thru-e2e-${RUN_TS}-L7.err"
out=""
if [[ -n "$TIMEOUT_BIN" ]]; then
  out="$(cd "$TMPDIR_L7" && $TIMEOUT_BIN 120 "$CTHRU" --model gemini-latest -p "List the files in the current folder AND read the contents of alpha.txt. Do both in parallel." 2>"$L7_ERR")"
else
  out="$(cd "$TMPDIR_L7" && "$CTHRU" --model gemini-latest -p "List the files in the current folder AND read the contents of alpha.txt. Do both in parallel." 2>"$L7_ERR")"
fi
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
  cleanup_proxies
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
  cleanup_proxies
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
cleanup_proxies
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
if [[ -n "$TIMEOUT_BIN" ]]; then
  out="$(cd "$TMPDIR_L13" && $TIMEOUT_BIN 180 "$CTHRU" --model gemini-latest -p "Read the README.md in this folder, then write a one-line summary to $SUMMARY_PATH" 2>"$L13_ERR")"
else
  out="$(cd "$TMPDIR_L13" && "$CTHRU" --model gemini-latest -p "Read the README.md in this folder, then write a one-line summary to $SUMMARY_PATH" 2>"$L13_ERR")"
fi
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
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
