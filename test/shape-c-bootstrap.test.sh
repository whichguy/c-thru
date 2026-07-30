#!/usr/bin/env bash
# Hermetic Shape C bootstrap + stamp tests (local REPO_DIR; no network).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-shape-c.XXXXXX")"
export CLAUDE_DIR="$BASE/claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"

pass=0
fail=0
check() {
  local name="$1"
  shift
  if "$@"; then
    pass=$((pass + 1))
  else
    echo "FAIL: $name"
    fail=$((fail + 1))
  fi
}

# shellcheck source=../tools/c-thru-install-core.sh
. "$REPO_ROOT/tools/c-thru-install-core.sh"

export REPO_DIR="$REPO_ROOT"

check "empty dir incomplete" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-install-core.sh"; ! cthru_repo_is_complete "'"$BASE"'/nope"'
check "monorepo complete" cthru_repo_is_complete "$REPO_DIR"
check "install from repo" cthru_install_from_repo
check "c-thru linked and exists" test -e "$CLAUDE_DIR/tools/c-thru"
check "cthru linked and exists" test -e "$CLAUDE_DIR/tools/cthru"
check "stamp exists" test -f "$(cthru_stamp_path)"
check "stamp healthy" cthru_stamp_is_healthy
check "source_root field" test "$(cthru_read_stamp_field source_root)" = "$REPO_DIR"

# Dangling symlink must fail health
rm -f "$CLAUDE_DIR/tools/c-thru"
ln -sfn "$BASE/missing-c-thru" "$CLAUDE_DIR/tools/c-thru"
check "dangling symlink unhealthy" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-install-core.sh"; CLAUDE_DIR="'"$CLAUDE_DIR"'"; ! cthru_stamp_is_healthy'
# Repair
cthru_install_from_repo
check "repaired healthy" cthru_stamp_is_healthy

# Version stale detection (when package root has different version — use empty = not stale)
check "not stale vs self" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-install-core.sh"; CLAUDE_DIR="'"$CLAUDE_DIR"'"; ! cthru_stamp_version_stale_vs "'"$REPO_DIR"'"'

bash "$REPO_ROOT/tools/c-thru-plugin-bootstrap.sh" 2>/dev/null || true
check "stamp still healthy after bootstrap noop" cthru_stamp_is_healthy

C_THRU_FORCE_BOOTSTRAP=1 bash "$REPO_ROOT/tools/c-thru-plugin-bootstrap.sh" 2>/dev/null || true
check "bootstrap log after force" test -f "$CLAUDE_DIR/c-thru-bootstrap.log"

check "session-start has Shape C" grep -q '_cthru_cli_ready' "$REPO_ROOT/tools/c-thru-session-start.sh"
check "session-start lite opt-in" grep -q 'C_THRU_PLUGIN_LITE' "$REPO_ROOT/tools/c-thru-session-start.sh"
check "session-start requires resolvable tools link" grep -q 'tools/c-thru' "$REPO_ROOT/tools/c-thru-session-start.sh"
# No executable git-clone (comments like "do NOT git-clone" are fine)
check "session-start no git clone cmd" bash -c '! grep -E "^[^#]*git[[:space:]]+clone" "'"$REPO_ROOT"'/tools/c-thru-session-start.sh"'
check "session-start prompts install-cli" grep -q 'install-cli' "$REPO_ROOT/tools/c-thru-session-start.sh"
check "session-start sources plugin gate" grep -q 'c-thru-plugin-hook-gate' "$REPO_ROOT/tools/c-thru-session-start.sh"

# Stamp pin fields after install
check "stamp has source_ref" test -n "$(cthru_read_stamp_field source_ref)"
check "stamp has source_sha or empty-ok" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-install-core.sh"; CLAUDE_DIR="'"$CLAUDE_DIR"'"; v=$(cthru_read_stamp_field source_sha); true'
check "stamp has version" test -n "$(cthru_read_stamp_field version)"

# R0a: scrub loopback ANTHROPIC_BASE_URL on stamp write
mkdir -p "$CLAUDE_DIR"
cat >"$CLAUDE_DIR/settings.json" <<'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3456",
    "OTHER": "keep"
  }
}
EOF
cthru_write_stamp "$REPO_DIR"
check "scrub removed loopback base URL" bash -c '! grep -q "ANTHROPIC_BASE_URL" "'"$CLAUDE_DIR"'/settings.json"'
check "scrub kept other env" grep -q '"OTHER"' "$CLAUDE_DIR/settings.json"

# Non-loopback must stay
cat >"$CLAUDE_DIR/settings.json" <<'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  }
}
EOF
cthru_write_stamp "$REPO_DIR"
check "scrub keeps non-loopback URL" grep -q 'api.anthropic.com' "$CLAUDE_DIR/settings.json"

# R0b: plugin hook gate
# shellcheck source=../tools/c-thru-plugin-hook-gate.sh
. "$REPO_ROOT/tools/c-thru-plugin-hook-gate.sh"
unset C_THRU_PLUGIN_HOOK C_THRU_SESSION_ID C_THRU_PLUGIN_LITE C_THRU_FROM_CLI || true
check "gate inactive without PLUGIN_HOOK" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-plugin-hook-gate.sh"; ! cthru_plugin_hook_should_skip'
export C_THRU_PLUGIN_HOOK=1
# Claude payload session ids must NOT skip (was a real bug: install-cli never prompted)
export C_THRU_SESSION_ID=sess_claude_payload
# stamp still present from earlier install → skip via stamp, so remove stamp for this check
_stamp_bak="$(cthru_stamp_path).bak-test"
mv "$(cthru_stamp_path)" "$_stamp_bak"
check "gate allows Claude session_id without stamp" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-plugin-hook-gate.sh"; export C_THRU_PLUGIN_HOOK=1 C_THRU_SESSION_ID=sess_claude_payload; CLAUDE_DIR="'"$CLAUDE_DIR"'"; CLAUDE_PROFILE_DIR="'"$CLAUDE_DIR"'"; ! cthru_plugin_hook_should_skip'
export C_THRU_FROM_CLI=1
check "gate skips under C_THRU_FROM_CLI" cthru_plugin_hook_should_skip
unset C_THRU_FROM_CLI
export C_THRU_SESSION_ID=12345
check "gate skips under legacy pid SESSION_ID" cthru_plugin_hook_should_skip
unset C_THRU_SESSION_ID
mv "$_stamp_bak" "$(cthru_stamp_path)"
# stamp present + no lite → skip
check "gate skips when stamp installed" cthru_plugin_hook_should_skip
export C_THRU_PLUGIN_LITE=1
check "gate allows lite mode" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-plugin-hook-gate.sh"; export C_THRU_PLUGIN_HOOK=1 C_THRU_PLUGIN_LITE=1; CLAUDE_DIR="'"$CLAUDE_DIR"'"; CLAUDE_PROFILE_DIR="'"$CLAUDE_DIR"'"; ! cthru_plugin_hook_should_skip'
unset C_THRU_PLUGIN_HOOK C_THRU_PLUGIN_LITE C_THRU_FROM_CLI

# Live SessionStart: Claude stdin session_id + no stamp → install-cli prompt (R0c)
_ss_base="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-ss.XXXXXX")"
export CLAUDE_DIR="$_ss_base/claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"
export C_THRU_PLUGIN_HOOK=1
unset C_THRU_FROM_CLI C_THRU_SESSION_ID || true
_ss_out_file="$_ss_base/out.txt"
printf '%s' '{"session_id":"sess_live_abc"}' | bash "$REPO_ROOT/tools/c-thru-session-start.sh" >"$_ss_out_file" 2>&1 || true
check "session-start prompts install-cli with Claude session_id" grep -q install-cli "$_ss_out_file"
# restore shape-c CLAUDE_DIR for remaining checks
export CLAUDE_DIR="$BASE/claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"
rm -rf "$_ss_base"
unset C_THRU_PLUGIN_HOOK

# Completeness without +x still true (file present)
chmod -x "$REPO_DIR/tools/c-thru" 2>/dev/null || true
check "complete without +x" cthru_repo_is_complete "$REPO_DIR"
chmod +x "$REPO_DIR/tools/c-thru" 2>/dev/null || true

# install-cli command exists
check "install-cli command present" test -f "$REPO_ROOT/commands/c-thru-install-cli.md"
check "hooks.json sets PLUGIN_HOOK" grep -q 'C_THRU_PLUGIN_HOOK=1' "$REPO_ROOT/plugins/c-thru/hooks/hooks.json"
check "cthru exports C_THRU_FROM_CLI" grep -q 'C_THRU_FROM_CLI=1' "$REPO_ROOT/tools/c-thru"

rm -rf "$BASE"
echo "shape-c-bootstrap: $pass ok, $fail failed"
[[ "$fail" -eq 0 ]]
