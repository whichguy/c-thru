#!/usr/bin/env bash
# Regression test for the divergence/stale-WIP observability behaviors
# (tools/c-thru-self-update.sh + tools/c-thru-session-start.sh Check 4).
# These were hand-verified in a throwaway scratch clone when shipped; this
# encodes that scratch recipe so the behaviors can't silently regress.
#
# Recipe: bare origin + fresh clone per scenario under mktemp -d.
#   - self-update runs IN PLACE from the repo with ROUTER_REPO_ROOT=<scratch>
#     (its documented contract). It is NOT copied into the scratch: its dirty
#     check (`git status --porcelain`) counts untracked files, so a copied
#     script would make every scenario silently skip.
#   - session-start derives ROUTER_REPO_ROOT from its own location, so it IS
#     copied into <scratch>/tools/. Check 4 filters untracked (^??) lines,
#     so the copy doesn't pollute its tracked-dirty detection.
#
# Requires jq (run-all.sh registers this suite behind a jq check — SKIP, not
# FAIL, when absent); standalone runs without jq exit 0 with a SKIP notice.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not installed (needed to parse hook JSON output)"
  exit 0
fi

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check_contains() {  # label, needle, haystack
  if printf '%s' "$3" | grep -qF "$2"; then pass "$1"; else
    fail "$1 (missing: $2)"
    printf '%s\n' "$3" | sed 's/^/        /'
  fi
}
check_absent() {  # label, needle, haystack
  if printf '%s' "$3" | grep -qF "$2"; then
    fail "$1 (unexpectedly present: $2)"
    printf '%s\n' "$3" | sed 's/^/        /'
  else pass "$1"; fi
}

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-divergence.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

# ── Fixture: bare origin with one seed commit ────────────────────────────────
ORIGIN="$BASE/origin.git"
git init --bare -q -b main "$ORIGIN"
SEED="$BASE/seed"
git clone -q "$ORIGIN" "$SEED" 2>/dev/null
git -C "$SEED" config user.email test@example.com
git -C "$SEED" config user.name "Divergence Test"
echo "seed" > "$SEED/README.md"
git -C "$SEED" add README.md
git -C "$SEED" commit -qm "seed"
git -C "$SEED" push -q -u origin main 2>/dev/null
rm -rf "$SEED"

make_scratch() {  # $1 = name → prints clone path
  local d="$BASE/$1"
  git clone -q "$ORIGIN" "$d"
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name "Divergence Test"
  printf '%s' "$d"
}

advance_origin() {  # $1 = label — push one commit to origin via a side clone
  local p="$BASE/pusher-$1"
  git clone -q "$ORIGIN" "$p"
  git -C "$p" config user.email test@example.com
  git -C "$p" config user.name "Divergence Test"
  echo "upstream $1" >> "$p/upstream.txt"
  git -C "$p" add upstream.txt
  git -C "$p" commit -qm "upstream $1"
  git -C "$p" push -q origin main
  rm -rf "$p"
}

local_commit() {  # $1 = scratch
  echo "local" >> "$1/local.txt"
  git -C "$1" add local.txt
  git -C "$1" commit -qm "local"
}

run_self_update() {  # $1 = scratch → sets SU_EC, SU_STDERR
  local profile
  profile="$(mktemp -d "$BASE/profile.XXXXXX")"
  SU_EC=0
  SU_STDERR="$(ROUTER_REPO_ROOT="$1" CLAUDE_ROUTER_UPDATE_INTERVAL=0 \
    CLAUDE_ROUTER_NO_UPDATE="" CLAUDE_PROFILE_DIR="$profile" \
    CLAUDE_ROUTER_UPDATE_GRACE=10 \
    bash "$REPO_DIR/tools/c-thru-self-update.sh" 2>&1 >/dev/null)" || SU_EC=$?
  sleep 1.2  # backgrounded fetch subshell may write the log after main exits
}

run_session_start() {  # $1 = scratch → prints additionalContext (jq = JSON assert)
  mkdir -p "$1/tools"
  cp "$REPO_DIR/tools/c-thru-session-start.sh" "$1/tools/"
  # The hook sources $ROUTER_REPO_ROOT/tools/c-thru-lib.sh — co-locate it.
  cp "$REPO_DIR/tools/c-thru-lib.sh" "$1/tools/"
  local out profile
  profile="$(mktemp -d "$BASE/profile.XXXXXX")"
  out="$(CLAUDE_PROXY_PORT=1 OLLAMA_URL="" OLLAMA_BASE_URL="" \
    ANTHROPIC_BASE_URL="" CLAUDE_PROFILE_DIR="$profile" \
    bash "$1/tools/c-thru-session-start.sh")"
  printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext'
}

# ── 1: self-update, diverged + clean tree ────────────────────────────────────
echo "1. self-update: diverged (ahead 1, behind 1), clean tree"
{
  S="$(make_scratch s1)"
  advance_origin s1
  local_commit "$S"
  run_self_update "$S"
  [[ $SU_EC -eq 0 ]] && pass "exits 0 (never blocks launch)" \
                     || fail "exits 0 (got $SU_EC)"
  check_contains "stderr carries the diverged advisory" \
    "diverged from origin (ahead 1, behind 1)" "$SU_STDERR"
  log_content="$(cat "$S/.c-thru-update.log" 2>/dev/null || true)"
  check_contains "update log gains the skip line" "self-update skipped" "$log_content"
}

# ── 2: self-update, ahead-only (the no-nag contract) ─────────────────────────
echo ""
echo "2. self-update: ahead-only stays silent"
{
  S="$(make_scratch s2)"
  local_commit "$S"
  run_self_update "$S"
  [[ $SU_EC -eq 0 ]] && pass "exits 0" || fail "exits 0 (got $SU_EC)"
  check_absent "no stderr advisory for unpushed work" "diverged" "$SU_STDERR"
  log_content="$(cat "$S/.c-thru-update.log" 2>/dev/null || true)"
  check_absent "no skip line in update log" "self-update skipped" "$log_content"
}

# ── 3: session-start Check 4 matrix ──────────────────────────────────────────
echo ""
echo "3. session-start Check 4: diverged + clean"
{
  S="$(make_scratch s3a)"
  advance_origin s3a
  local_commit "$S"
  git -C "$S" fetch -q origin   # Check 4 reads last-fetched state only
  ctx="$(run_session_start "$S")"
  check_contains "diverged advisory present" \
    "(c-thru) repo diverged from origin (ahead 1, behind 1)" "$ctx"
}

echo ""
echo "3b. session-start Check 4: behind-only + dirty tracked file"
{
  S="$(make_scratch s3b)"
  advance_origin s3b
  echo "wip" >> "$S/README.md"
  git -C "$S" fetch -q origin
  ctx="$(run_session_start "$S")"
  check_contains "behind+dirty advisory present" \
    "behind origin but has uncommitted changes" "$ctx"
  check_absent "no diverged advisory (not ahead)" "diverged from origin" "$ctx"
}

echo ""
echo "3c. session-start Check 4: stale WIP (tracked mod, untouched >24h)"
{
  S="$(make_scratch s3c)"
  echo "wip" >> "$S/README.md"
  two_days_ago="$(date -v-2d +%Y%m%d%H%M 2>/dev/null || date -d '2 days ago' +%Y%m%d%H%M)"
  touch -t "$two_days_ago" "$S/README.md"
  ctx="$(run_session_start "$S")"
  check_contains "stale-WIP advisory present" "untouched for >24h" "$ctx"
}

echo ""
echo "3d. session-start Check 4: fresh WIP — no stale advisory"
{
  S="$(make_scratch s3d)"
  echo "wip" >> "$S/README.md"
  touch "$S/README.md"
  ctx="$(run_session_start "$S")"
  check_absent "no stale-WIP advisory for fresh changes" "untouched for >24h" "$ctx"
}

echo ""
echo "3e. session-start Check 4: clean + synced — zero repo advisories"
{
  S="$(make_scratch s3e)"
  ctx="$(run_session_start "$S")"
  check_absent "no (c-thru) repo lines" "(c-thru) repo" "$ctx"
  check_absent "no stale-WIP line" "untouched for >24h" "$ctx"
}

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[[ "$FAIL" -eq 0 ]]
