#!/usr/bin/env bash
# Regression/behavioral test for tools/c-thru-stop-hook.sh — a Stop hook that
# runs automatically after every response and does an mv -f on a tracker file.
# Had zero behavioral coverage before this file (only referenced by
# install-smoke.test.sh's symlink-presence check).
#
# NOTE: separately discovered (not fixed here — see task tracker) that the
# literal event tags this script greps for ([fallback.candidate_success],
# [fallback.chain_start]) are no longer emitted anywhere in the current
# tools/claude-proxy — they're from an older, since-rewritten fallback
# architecture. This test still validates the hook's own mechanical logic
# (parsing, dedup, staleness, tracker writes) against fixture log lines built
# in the format the hook currently expects — real, executable behavior worth
# locking in regardless of whether production traffic currently feeds it.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_DIR/tools/c-thru-stop-hook.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-stop-hook-test.XXXXXX")"
trap 'chmod -R u+w "$BASE" 2>/dev/null; rm -rf "$BASE"' EXIT

log_line() {  # ts_iso, event, json_fields
  echo "$1 c-thru [$2] $3"
}

now_iso() { node -e 'process.stdout.write(new Date().toISOString())'; }
minutes_ago_iso() { node -e "process.stdout.write(new Date(Date.now() - Number(process.argv[1]) * 60000).toISOString())" "$1"; }

run_hook() {  # profile_dir -> prints stdout
  HOME="$1" bash "$HOOK"
}

fresh_ts="$(now_iso)"
stale_ts="$(minutes_ago_iso 5)"  # >120s old

# ── 1. No log file → silent, exit 0 ─────────────────────────────────────────
echo "1. no proxy.log file"
{
  P="$BASE/p1"; mkdir -p "$P/.claude"
  out="$(run_hook "$P")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "exits 0 with empty stdout when proxy.log is absent" || fail "expected exit 0 + empty stdout (got ec=$ec, out=$out)"
}

# ── 2. Log file with no fallback lines → silent ─────────────────────────────
echo ""
echo "2. proxy.log has no [fallback.candidate_success] line"
{
  P="$BASE/p2"; mkdir -p "$P/.claude"
  { log_line "$fresh_ts" "some.other_event" '{"pid":1}'; } > "$P/.claude/proxy.log"
  out="$(run_hook "$P")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "exits 0 with empty stdout when no matching event exists" || fail "expected exit 0 + empty stdout (got ec=$ec, out=$out)"
}

# ── 3. Fresh event → correct systemMessage + tracker written ────────────────
echo ""
echo "3. fresh fallback.candidate_success event"
{
  P="$BASE/p3"; mkdir -p "$P/.claude"
  log_line "$fresh_ts" "fallback.chain_start" '{"pid":1,"terminal_model":"claude-sonnet-4-6"}' > "$P/.claude/proxy.log"
  log_line "$fresh_ts" "fallback.candidate_success" '{"pid":1,"candidate":"qwen3.6:35b","terminal_model":"claude-sonnet-4-6"}' >> "$P/.claude/proxy.log"
  out="$(run_hook "$P")"; ec=$?
  if [ "$ec" -eq 0 ] && command -v jq >/dev/null 2>&1; then
    msg="$(printf '%s' "$out" | jq -r '.systemMessage // empty' 2>/dev/null)"
    if [[ "$msg" == *"claude-sonnet-4-6"*"qwen3.6:35b"* ]]; then
      pass "systemMessage names both primary and served-by candidate"
    else
      fail "systemMessage missing expected model names (got: $out)"
    fi
  else
    fail "expected exit 0 + valid JSON (got ec=$ec, out=$out)"
  fi
  tracker="$P/.claude/.c-thru-stop-hook-last-ts"
  [ -s "$tracker" ] && pass "tracker file written after a fresh event" || fail "tracker file should have been written"
}

# ── 4. Same event replayed → silent (dedupe via tracker) ────────────────────
echo ""
echo "4. replaying the same event a second time"
{
  P="$BASE/p3"  # reuse state from test 3 — tracker already has this event's ts
  out="$(run_hook "$P")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "replayed event is silently deduped (no repeat systemMessage)" || fail "expected silent dedupe (got ec=$ec, out=$out)"
}

# ── 5. Event older than 120s → silent, tracker untouched ────────────────────
echo ""
echo "5. stale fallback event (>120s old)"
{
  P="$BASE/p5"; mkdir -p "$P/.claude"
  log_line "$stale_ts" "fallback.chain_start" '{"pid":1,"terminal_model":"claude-sonnet-4-6"}' > "$P/.claude/proxy.log"
  log_line "$stale_ts" "fallback.candidate_success" '{"pid":1,"candidate":"qwen3.6:35b"}' >> "$P/.claude/proxy.log"
  out="$(run_hook "$P")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "stale (>120s) event is silently ignored" || fail "expected silent no-op for stale event (got ec=$ec, out=$out)"
  tracker="$P/.claude/.c-thru-stop-hook-last-ts"
  [ ! -e "$tracker" ] && pass "tracker file NOT written for a stale event" || fail "tracker file should not have been created"
}

# ── 6. terminal_model sourced from chain_start when absent on the success line ─
echo ""
echo "6. terminal_model falls back to the chain_start line when absent on candidate_success"
{
  P="$BASE/p6"; mkdir -p "$P/.claude"
  log_line "$fresh_ts" "fallback.chain_start" '{"pid":1,"terminal_model":"claude-opus-4-8"}' > "$P/.claude/proxy.log"
  # No terminal_model on this line — hook must fall back to the chain_start scan above.
  log_line "$fresh_ts" "fallback.candidate_success" '{"pid":1,"candidate":"gpt-oss:20b"}' >> "$P/.claude/proxy.log"
  out="$(run_hook "$P")"; ec=$?
  if [ "$ec" -eq 0 ] && command -v jq >/dev/null 2>&1; then
    msg="$(printf '%s' "$out" | jq -r '.systemMessage // empty' 2>/dev/null)"
    if [[ "$msg" == *"claude-opus-4-8"*"gpt-oss:20b"* ]]; then
      pass "terminal_model correctly recovered from the chain_start line"
    else
      fail "expected terminal_model fallback to work (got: $out)"
    fi
  else
    fail "expected exit 0 + valid JSON (got ec=$ec, out=$out)"
  fi
}

# ── 7. jq missing → fail-open, silent ────────────────────────────────────────
echo ""
echo "7. jq not installed"
{
  P="$BASE/p7"; mkdir -p "$P/.claude"
  log_line "$fresh_ts" "fallback.candidate_success" '{"pid":1,"candidate":"x","terminal_model":"y"}' > "$P/.claude/proxy.log"
  FAKE_BIN="$BASE/fakebin-no-jq"; mkdir -p "$FAKE_BIN"
  # PATH with every real dir except one that would provide jq — simplest
  # portable way is to filter jq out of the current PATH.
  no_jq_path="$(printf '%s' "$PATH" | tr ':' '\n' | while read -r d; do [ -x "$d/jq" ] || printf '%s:' "$d"; done)"
  out="$(HOME="$P" PATH="$no_jq_path" bash "$HOOK")"; ec=$?
  [ "$ec" -eq 0 ] && [ -z "$out" ] && pass "fail-open silent exit 0 when jq is unavailable" || fail "expected fail-open (got ec=$ec, out=$out)"
}

# ── 8. Tracker write failure (unwritable dir) → still exits 0 ───────────────
echo ""
echo "8. tracker file directory is unwritable"
{
  P="$BASE/p8"; mkdir -p "$P/.claude"
  log_line "$fresh_ts" "fallback.candidate_success" '{"pid":1,"candidate":"x","terminal_model":"y"}' > "$P/.claude/proxy.log"
  chmod 555 "$P/.claude"
  out="$(run_hook "$P")"; ec=$?
  chmod 755 "$P/.claude"
  [ "$ec" -eq 0 ] && pass "still exits 0 when the tracker file can't be written (never crashes)" || fail "expected exit 0 even on write failure (got ec=$ec)"
}

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[ "$FAIL" -eq 0 ]
