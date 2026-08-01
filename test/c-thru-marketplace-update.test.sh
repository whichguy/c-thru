#!/usr/bin/env bash
# Hermetic behavior tests for tools/c-thru-marketplace-update.sh.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_DIR/tools/c-thru-marketplace-update.sh"
NODE_DIR="$(dirname "$(command -v node)")"
PASS=0; FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL+1)); }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-marketplace-update.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }

make_case() {  # $1 = directory; remaining args = stub names
  local d="$1"; shift
  mkdir -p "$d/bin" "$d/home/.claude/plugins" "$d/durable" "$d/shadow" \
    "$d/scan-claude/plugins/marketplaces" "$d/scan-grok/marketplace-cache"
  printf '{"plugins":{}}\n' > "$d/home/.claude/plugins/installed_plugins.json"
  local name
  for name in "$@"; do
    cat > "$d/bin/$name" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$CLI_LOG"
if [[ "$(basename "$0")" == "claude" && "${CLI_STARTED_FILE:-}" != "" ]]; then
  date +%s > "$CLI_STARTED_FILE"
fi
if [[ "$(basename "$0")" == "claude" && "${CLI_SLEEP_SECONDS:-0}" != "0" ]]; then
  sleep "$CLI_SLEEP_SECONDS"
  [[ "${CLI_FINISHED_FILE:-}" != "" ]] && : > "$CLI_FINISHED_FILE"
fi
STUB
    chmod +x "$d/bin/$name"
  done
}

run_update() {  # $1 = case directory; remaining args = env VAR=value pairs
  local d="$1"; shift
  (
    export HOME="$d/home" CLAUDE_DIR="$d/durable" CLAUDE_CONFIG_DIR="" CLAUDE_PROFILE_DIR="$d/shadow"
    export C_THRU_MARKETPLACE_CLAUDE_DIR="$d/scan-claude" C_THRU_MARKETPLACE_GROK_DIR="$d/scan-grok"
    export PATH="$d/bin:$NODE_DIR:/usr/bin:/bin" CLI_LOG="$d/cli.log"
    env "$@" bash "$SCRIPT" >/dev/null 2>&1
  )
}

echo "1. Opt-out skips entirely"
{
  D="$BASE/opt-out"; make_case "$D" claude grok codex
  run_update "$D" C_THRU_NO_MARKETPLACE_UPDATE=1
  [[ ! -e "$D/cli.log" && ! -e "$D/durable/.c-thru-marketplace-update-stamp" ]] \
    && pass "opt-out invokes no CLI and creates no stamp" \
    || fail "opt-out invokes no CLI and creates no stamp"
}

echo "2. Debounce skips fresh stamps and runs without one"
{
  D="$BASE/debounce"; make_case "$D" claude grok codex
  touch "$D/durable/.c-thru-marketplace-update-stamp"
  run_update "$D"
  fresh_skipped="$(test ! -e "$D/cli.log" && echo yes || echo no)"
  rm -f "$D/durable/.c-thru-marketplace-update-stamp"
  run_update "$D"
  absent_ran="$(grep -c '^claude plugin marketplace update$' "$D/cli.log" 2>/dev/null || true)"
  [[ "$fresh_skipped" == yes && "$absent_ran" -eq 1 ]] \
    && pass "fresh stamp debounces; absent stamp refreshes" \
    || fail "fresh stamp debounces; absent stamp refreshes"
}

echo "3. Stamp is touched after command execution"
{
  D="$BASE/stamp-order"; make_case "$D" claude
  run_update "$D" CLI_STARTED_FILE="$D/started"
  started="$(cat "$D/started" 2>/dev/null || echo 0)"
  stamped="$(mtime "$D/durable/.c-thru-marketplace-update-stamp" 2>/dev/null || echo 0)"
  [[ "$started" -gt 0 && "$stamped" -ge "$started" ]] \
    && pass "stamp postdates the stub's start" \
    || fail "stamp postdates the stub's start"
}

echo "4. Single-flight lock permits only one concurrent refresh"
{
  D="$BASE/single-flight"; make_case "$D" claude
  run_update "$D" C_THRU_MARKETPLACE_UPDATE_FORCE_MKDIR_LOCK=1 CLI_STARTED_FILE="$D/started" CLI_SLEEP_SECONDS=2 &
  FIRST_PID=$!
  for _i in 1 2 3 4 5 6 7 8 9 10; do [[ -e "$D/started" ]] && break; sleep 0.1; done
  run_update "$D" C_THRU_MARKETPLACE_UPDATE_FORCE_MKDIR_LOCK=1
  second_ec=$?
  wait "$FIRST_PID"; first_ec=$?
  count="$(grep -c '^claude plugin marketplace update$' "$D/cli.log" 2>/dev/null || true)"
  [[ "$first_ec" -eq 0 && "$second_ec" -eq 0 && "$count" -eq 1 ]] \
    && pass "second live-lock contender exits without CLI work" \
    || fail "second live-lock contender exits without CLI work"
}

echo "5. PID-aware fallback reclaims dead locks but respects live ones"
{
  D="$BASE/pid-lock"; make_case "$D" claude
  LOCK="$D/durable/.c-thru-marketplace-update.lock.d"
  sleep 0.01 & DEAD_PID=$!; wait "$DEAD_PID"
  mkdir -p "$LOCK"; printf '%s\n' "$DEAD_PID" > "$LOCK/pid"
  run_update "$D" C_THRU_MARKETPLACE_UPDATE_FORCE_MKDIR_LOCK=1
  reclaimed_count="$(grep -c '^claude plugin marketplace update$' "$D/cli.log" 2>/dev/null || true)"
  rm -f "$D/durable/.c-thru-marketplace-update-stamp" "$D/cli.log"
  sleep 5 & LIVE_PID=$!
  mkdir -p "$LOCK"; printf '%s\n' "$LIVE_PID" > "$LOCK/pid"
  run_update "$D" C_THRU_MARKETPLACE_UPDATE_FORCE_MKDIR_LOCK=1
  live_skipped="$(test ! -e "$D/cli.log" && echo yes || echo no)"
  kill "$LIVE_PID" 2>/dev/null || true; wait "$LIVE_PID" 2>/dev/null || true
  rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || true
  [[ "$reclaimed_count" -eq 1 && "$live_skipped" == yes ]] \
    && pass "dead PID is reclaimed; old live PID is respected" \
    || fail "dead PID is reclaimed; old live PID is respected"
}

echo "6. Ahead marketplace preflight skips every CLI and stamps the run"
{
  D="$BASE/preflight"; make_case "$D" claude grok codex
  ORIGIN="$D/origin.git"; SEED="$D/seed"; CLONE="$D/scan-claude/plugins/marketplaces/ahead"
  git init --bare -q -b main "$ORIGIN"
  git clone -q "$ORIGIN" "$SEED" 2>/dev/null
  git -C "$SEED" config user.email test@example.com; git -C "$SEED" config user.name "Marketplace Test"
  echo seed > "$SEED/README"; git -C "$SEED" add README; git -C "$SEED" commit -qm seed; git -C "$SEED" push -q -u origin main
  git clone -q "$ORIGIN" "$CLONE"; git -C "$CLONE" config user.email test@example.com; git -C "$CLONE" config user.name "Marketplace Test"
  echo local > "$CLONE/local"; git -C "$CLONE" add local; git -C "$CLONE" commit -qm local
  run_update "$D"
  advisory="$(grep -c 'marketplace update skipped: unsafe marketplace clone state' "$D/durable/.c-thru-marketplace-update.log" 2>/dev/null || true)"
  [[ ! -e "$D/cli.log" && "$advisory" -eq 1 && -f "$D/durable/.c-thru-marketplace-update-stamp" ]] \
    && pass "ahead clone skips all CLIs, logs advisory, and stamps" \
    || fail "ahead clone skips all CLIs, logs advisory, and stamps"
}

echo "6b. Detached-HEAD clone with an unreachable local commit is also treated as unsafe"
{
  D="$BASE/preflight-detached"; make_case "$D" claude grok codex
  ORIGIN="$D/origin2.git"; SEED="$D/seed2"; CLONE="$D/scan-grok/marketplace-cache/ahead-detached"
  git init --bare -q -b main "$ORIGIN"
  git clone -q "$ORIGIN" "$SEED" 2>/dev/null
  git -C "$SEED" config user.email test@example.com; git -C "$SEED" config user.name "Marketplace Test"
  echo seed > "$SEED/README"; git -C "$SEED" add README; git -C "$SEED" commit -qm seed; git -C "$SEED" push -q -u origin main
  git clone -q "$ORIGIN" "$CLONE"; git -C "$CLONE" config user.email test@example.com; git -C "$CLONE" config user.name "Marketplace Test"
  git -C "$CLONE" checkout -q --detach main
  echo local > "$CLONE/local"; git -C "$CLONE" add local; git -C "$CLONE" commit -qm local
  run_update "$D"
  advisory="$(grep -c 'detached HEAD not reachable from any remote branch' "$D/durable/.c-thru-marketplace-update.log" 2>/dev/null || true)"
  [[ ! -e "$D/cli.log" && "$advisory" -eq 1 ]] \
    && pass "detached-HEAD local-only commit is caught and skips all CLIs" \
    || fail "detached-HEAD local-only commit is caught and skips all CLIs"
}

echo "6c. Detached-HEAD clone exactly matching a remote branch is safe"
{
  D="$BASE/preflight-detached-clean"; make_case "$D" claude grok codex
  ORIGIN="$D/origin3.git"; SEED="$D/seed3"; CLONE="$D/scan-grok/marketplace-cache/clean-detached"
  git init --bare -q -b main "$ORIGIN"
  git clone -q "$ORIGIN" "$SEED" 2>/dev/null
  git -C "$SEED" config user.email test@example.com; git -C "$SEED" config user.name "Marketplace Test"
  echo seed > "$SEED/README"; git -C "$SEED" add README; git -C "$SEED" commit -qm seed; git -C "$SEED" push -q -u origin main
  git clone -q "$ORIGIN" "$CLONE"; git -C "$CLONE" config user.email test@example.com; git -C "$CLONE" config user.name "Marketplace Test"
  git -C "$CLONE" checkout -q --detach main
  run_update "$D"
  count="$(grep -c '^claude plugin marketplace update$' "$D/cli.log" 2>/dev/null || true)"
  [[ "$count" -eq 1 ]] \
    && pass "clean detached HEAD matching remote is treated as safe" \
    || fail "clean detached HEAD matching remote is treated as safe"
}

echo "6d. Installed-plugin enumeration updates every configured plugin id"
{
  D="$BASE/plugin-enum"; make_case "$D" claude
  # _claude_root() resolves via C_THRU_MARKETPLACE_CLAUDE_DIR (set by run_update to
  # "$d/scan-claude"), the same root _scan_marketplaces() reads -- not $HOME/.claude.
  mkdir -p "$D/scan-claude/plugins"
  cat > "$D/scan-claude/plugins/installed_plugins.json" <<'JSON'
{"version":2,"plugins":{"async-suite@claude-craft":[{"scope":"user"}],"chrome-devtools-mcp@claude-plugins-official":[{"scope":"user"}]}}
JSON
  run_update "$D"
  a="$(grep -c '^claude plugin update -- async-suite@claude-craft$' "$D/cli.log" 2>/dev/null || true)"
  b="$(grep -c '^claude plugin update -- chrome-devtools-mcp@claude-plugins-official$' "$D/cli.log" 2>/dev/null || true)"
  [[ "$a" -eq 1 && "$b" -eq 1 ]] \
    && pass "each installed plugin id is passed to claude plugin update" \
    || fail "each installed plugin id is passed to claude plugin update"
}

echo "7. Missing CLIs are silently skipped"
{
  D="$BASE/missing"; make_case "$D" claude
  run_update "$D"; ec=$?
  claude_only="$(grep -c '^claude plugin marketplace update$' "$D/cli.log" 2>/dev/null || true)"
  total="$(wc -l < "$D/cli.log" 2>/dev/null || echo 0)"
  [[ "$ec" -eq 0 && "$claude_only" -eq 1 && "$total" -eq 1 ]] \
    && pass "only installed Claude CLI is called" \
    || fail "only installed Claude CLI is called"
}

echo "8. Long-running update warns but is never killed"
{
  D="$BASE/never-kill"; make_case "$D" claude
  run_update "$D" C_THRU_MARKETPLACE_UPDATE_WARN_AFTER=1 CLI_SLEEP_SECONDS=2 CLI_FINISHED_FILE="$D/finished"
  warning="$(grep -c 'diagnostic only; not terminating' "$D/durable/.c-thru-marketplace-update.log" 2>/dev/null || true)"
  [[ -f "$D/finished" && -f "$D/durable/.c-thru-marketplace-update-stamp" && "$warning" -eq 1 ]] \
    && pass "slow CLI finishes naturally and stamp follows it" \
    || fail "slow CLI finishes naturally and stamp follows it"
}

echo "9. plugin-fixups-check failure is logged but stays fail-open"
{
  D="$BASE/fixups-fail"; make_case "$D" claude
  cat > "$D/bin/plugin-fixups-check" <<'STUB'
#!/usr/bin/env bash
echo "plugin-fixups-check: simulated failure" >&2
exit 7
STUB
  chmod +x "$D/bin/plugin-fixups-check"
  # Capture stderr (warn line) + still expect exit 0
  (
    export HOME="$D/home" CLAUDE_DIR="$D/durable" CLAUDE_CONFIG_DIR="" CLAUDE_PROFILE_DIR="$D/shadow"
    export C_THRU_MARKETPLACE_CLAUDE_DIR="$D/scan-claude" C_THRU_MARKETPLACE_GROK_DIR="$D/scan-grok"
    export PATH="$D/bin:$NODE_DIR:/usr/bin:/bin" CLI_LOG="$D/cli.log"
    bash "$SCRIPT" >"$D/stdout.txt" 2>"$D/stderr.txt"
    echo $? > "$D/ec"
  )
  ec="$(cat "$D/ec" 2>/dev/null || echo 99)"
  logged="$(grep -c 'plugin-fixups-check --fix rc=7' "$D/durable/.c-thru-marketplace-update.log" 2>/dev/null || true)"
  warned="$(grep -c 'plugin-fixups-check failed rc=7' "$D/stderr.txt" 2>/dev/null || true)"
  [[ "$ec" -eq 0 && "$logged" -ge 1 && "$warned" -ge 1 ]] \
    && pass "failing plugin-fixups-check logs rc and exits 0" \
    || fail "failing plugin-fixups-check logs rc and exits 0 (ec=$ec logged=$logged warned=$warned)"
}

echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[[ "$FAIL" -eq 0 ]]
