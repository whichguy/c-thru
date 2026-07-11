#!/usr/bin/env bash
# Behavioral test for tools/c-thru-statusline-overlay.sh — a composable
# statusline badge, safe to append to any host statusline. Had zero
# behavioral coverage before this file (only symlink-checked).
#
# NOTE: same discovery as test/c-thru-stop-hook.test.sh (see task tracker) —
# the literal event tag this script greps for ([fallback.candidate_success])
# is no longer emitted anywhere in the current tools/claude-proxy. This test
# still validates the script's own mechanical logic (parsing, staleness,
# fail-open behavior) against fixture log lines in the format it currently
# expects.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERLAY="$REPO_DIR/tools/c-thru-statusline-overlay.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-overlay-test.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

now_iso() { node -e 'process.stdout.write(new Date().toISOString())'; }
minutes_ago_iso() { node -e "process.stdout.write(new Date(Date.now() - Number(process.argv[1]) * 60000).toISOString())" "$1"; }

run_overlay() { HOME="$1" bash "$OVERLAY"; }  # profile_dir -> prints stdout

fresh_ts="$(now_iso)"
stale_ts="$(minutes_ago_iso 5)"  # >120s old

# ── 1. No proxy.log → empty output, exit 0 ──────────────────────────────────
echo "1. no proxy.log file"
{
  P="$BASE/p1"; mkdir -p "$P/.claude"
  out="$(run_overlay "$P")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "empty output, exit 0 when proxy.log is absent" || fail "expected empty output + exit 0 (got ec=$ec, out=$out)"
}

# ── 2. Fresh event → exact fallback-arrow badge ─────────────────────────────
echo ""
echo "2. fresh fallback.candidate_success event"
{
  P="$BASE/p2"; mkdir -p "$P/.claude"
  echo "$fresh_ts c-thru [fallback.candidate_success] {\"pid\":1,\"candidate\":\"qwen3.6:35b\"}" > "$P/.claude/proxy.log"
  out="$(run_overlay "$P")"; ec=$?
  [ "$ec" -eq 0 ] && [ "$out" = " ⚠️  FALLBACK → qwen3.6:35b" ] && pass "exact badge string for a fresh event" || fail "expected exact badge (got ec=$ec, out='$out')"
}

# ── 3. Stale event (>120s old) → empty ──────────────────────────────────────
echo ""
echo "3. stale fallback event (>120s old)"
{
  P="$BASE/p3"; mkdir -p "$P/.claude"
  echo "$stale_ts c-thru [fallback.candidate_success] {\"pid\":1,\"candidate\":\"qwen3.6:35b\"}" > "$P/.claude/proxy.log"
  out="$(run_overlay "$P")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "empty output for a stale (>120s) event" || fail "expected empty output (got ec=$ec, out='$out')"
}

# ── 4. jq missing → empty (fail-open) ───────────────────────────────────────
echo ""
echo "4. jq not installed"
{
  P="$BASE/p4"; mkdir -p "$P/.claude"
  echo "$fresh_ts c-thru [fallback.candidate_success] {\"pid\":1,\"candidate\":\"qwen3.6:35b\"}" > "$P/.claude/proxy.log"
  no_jq_path="$(printf '%s' "$PATH" | tr ':' '\n' | while read -r d; do [ -x "$d/jq" ] || printf '%s:' "$d"; done)"
  out="$(HOME="$P" PATH="$no_jq_path" bash "$OVERLAY")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "fail-open empty output when jq is unavailable" || fail "expected fail-open (got ec=$ec, out='$out')"
}

# ── 5. Malformed JSON on the event line → empty, no crash ──────────────────
echo ""
echo "5. malformed JSON payload on the matching line"
{
  P="$BASE/p5"; mkdir -p "$P/.claude"
  echo "$fresh_ts c-thru [fallback.candidate_success] {not valid json" > "$P/.claude/proxy.log"
  out="$(run_overlay "$P")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "empty output, no crash, on malformed JSON" || fail "expected empty output + exit 0 (got ec=$ec, out='$out')"
}

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[ "$FAIL" -eq 0 ]
