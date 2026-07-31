#!/usr/bin/env bash
# Shape C executable spec contract — each check id maps to plan anchors R0*/W0*.
# Hermetic (no network). Exit 0 only if all pass.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0
fail=0
check() {
  local id="$1"
  shift
  if "$@"; then
    pass=$((pass + 1))
  else
    echo "FAIL: $id"
    fail=$((fail + 1))
  fi
}

# shellcheck source=../tools/c-thru-install-core.sh
. "$REPO_ROOT/tools/c-thru-install-core.sh"
# shellcheck source=../tools/c-thru-plugin-hook-gate.sh
. "$REPO_ROOT/tools/c-thru-plugin-hook-gate.sh"

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-spec.XXXXXX")"
export CLAUDE_DIR="$BASE/claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"
trap 'rm -rf "$BASE"' EXIT

export REPO_DIR="$REPO_ROOT"

# ── R0a scrub ──────────────────────────────────────────────────────────────
cat >"$CLAUDE_DIR/settings.json" <<'EOF'
{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:3456","KEEP":"yes"}}
EOF
cthru_write_stamp "$REPO_DIR"
check "R0a-scrub-loopback" bash -c '! grep -q ANTHROPIC_BASE_URL "'"$CLAUDE_DIR"'/settings.json" && grep -q KEEP "'"$CLAUDE_DIR"'/settings.json"'
cat >"$CLAUDE_DIR/settings.json" <<'EOF'
{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}
EOF
cthru_write_stamp "$REPO_DIR"
check "R0a-scrub-keeps-non-loopback" grep -q api.anthropic.com "$CLAUDE_DIR/settings.json"

# ── R0d stamp fields (monorepo install path) ────────────────────────────────
cthru_install_from_repo >/dev/null
check "R0d-stamp-fields" bash -c '
  source "'"$REPO_ROOT"'/tools/c-thru-install-core.sh"
  CLAUDE_DIR="'"$CLAUDE_DIR"'"
  test -n "$(cthru_read_stamp_field version)" &&
  test -n "$(cthru_read_stamp_field source_root)" &&
  test -n "$(cthru_read_stamp_field source_ref)" &&
  test -n "$(cthru_read_stamp_field source_sha)"
'
# Honest: source_sha must match monorepo HEAD when .git present
if [[ -d "$REPO_DIR/.git" ]]; then
  want="$(git -C "$REPO_DIR" rev-parse HEAD)"
  got="$(cthru_read_stamp_field source_sha)"
  check "R0d-stamp-sha-matches-head" test "$got" = "$want"
fi
# Stamp ref must match actual git identity (never free-pass)
ref_got="$(cthru_read_stamp_field source_ref)"
actual_ref="$(cthru_git_actual_ref "$REPO_DIR" 2>/dev/null || true)"
check "R0d-stamp-ref-matches-actual" test -n "$ref_got" -a "$ref_got" = "$actual_ref"

# G1: pin ref from package root, not empty REPO_DIR
check "R0d-pin-ref-from-bundle" bash -c '
  source "'"$REPO_ROOT"'/tools/c-thru-install-core.sh"
  unset C_THRU_SOURCE_REF C_THRU_SOURCE_REF_DESIRED C_THRU_SOURCE_REF_IS_ACTUAL C_THRU_ALLOW_UNPINNED REPO_DIR
  export C_THRU_PACKAGE_ROOT="'"$REPO_ROOT"'/plugins/c-thru"
  d=$(cthru_desired_source_ref) || exit 1
  test "$d" = "v0.2.4" || test "$d" = "v$(cthru_plugin_version "$C_THRU_PACKAGE_ROOT")"
'
check "R0d-pin-empty-root-fails" bash -c '
  source "'"$REPO_ROOT"'/tools/c-thru-install-core.sh"
  unset C_THRU_SOURCE_REF C_THRU_SOURCE_REF_DESIRED C_THRU_SOURCE_REF_IS_ACTUAL C_THRU_ALLOW_UNPINNED C_THRU_PACKAGE_ROOT REPO_DIR
  ! cthru_desired_source_ref ""
'

# ── R0b gate ───────────────────────────────────────────────────────────────
unset C_THRU_PLUGIN_HOOK C_THRU_SESSION_ID C_THRU_PLUGIN_LITE C_THRU_FROM_CLI || true
check "R0b-gate-inactive" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-plugin-hook-gate.sh"; ! cthru_plugin_hook_should_skip'
export C_THRU_PLUGIN_HOOK=1
export C_THRU_FROM_CLI=1
check "R0b-gate-from-cli" cthru_plugin_hook_should_skip
unset C_THRU_FROM_CLI
export C_THRU_SESSION_ID=12345
check "R0b-gate-legacy-pid" cthru_plugin_hook_should_skip
unset C_THRU_SESSION_ID
# stamp present → skip
check "R0b-gate-stamp" cthru_plugin_hook_should_skip
# remove stamp: Claude sid must not skip
rm -f "$(cthru_stamp_path)"
export C_THRU_SESSION_ID=sess_claude_uuid
check "R0b-gate-claude-sid" bash -c 'source "'"$REPO_ROOT"'/tools/c-thru-plugin-hook-gate.sh"; export C_THRU_PLUGIN_HOOK=1 C_THRU_SESSION_ID=sess_claude_uuid; CLAUDE_DIR="'"$CLAUDE_DIR"'"; CLAUDE_PROFILE_DIR="'"$CLAUDE_DIR"'"; ! cthru_plugin_hook_should_skip'
unset C_THRU_SESSION_ID C_THRU_PLUGIN_HOOK

check "R0b-hooks-json-env" bash -c '
  python3 -c "
import json,sys
h=json.load(open(\"'"$REPO_ROOT"'/plugins/c-thru/hooks/hooks.json\"))
cmds=[]
def w(o):
  if isinstance(o,dict):
    if \"command\" in o: cmds.append(o[\"command\"])
    for v in o.values(): w(v)
  elif isinstance(o,list):
    for i in o: w(i)
w(h)
assert cmds and all(\"C_THRU_PLUGIN_HOOK=1\" in c for c in cmds), cmds
"
'
check "R0b-hooks-source-gate" bash -c '
  ok=1
  for f in "'"$REPO_ROOT"'"/plugins/c-thru/hooks/c-thru-*.sh; do
    grep -q c-thru-plugin-hook-gate "$f" || ok=0
  done
  test "$ok" = 1
'

# ── R0c ─────────────────────────────────────────────────────────────────────
check "R0c-no-session-clone" bash -c '! grep -E "^[^#]*git[[:space:]]+clone" "'"$REPO_ROOT"'/tools/c-thru-session-start.sh"'
check "R0c-install-cli-cmd" test -f "$REPO_ROOT/commands/c-thru-install-cli.md" -a -f "$REPO_ROOT/plugins/c-thru/commands/c-thru-install-cli.md"
_ss="$BASE/ss-out.txt"
export C_THRU_PLUGIN_HOOK=1
unset C_THRU_FROM_CLI C_THRU_SESSION_ID || true
# fresh dir without stamp
export CLAUDE_DIR="$BASE/ss-claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"
printf '%s' '{"session_id":"sess_live"}' | bash "$REPO_ROOT/tools/c-thru-session-start.sh" >"$_ss" 2>&1 || true
check "R0c-prompt-with-sid" grep -q install-cli "$_ss"
# restore CLAUDE_DIR for later
export CLAUDE_DIR="$BASE/claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"
unset C_THRU_PLUGIN_HOOK

# ── W0 no durable without LITE ──────────────────────────────────────────────
_w0="$BASE/w0-claude"
export CLAUDE_DIR="$_w0"
export CLAUDE_PROFILE_DIR="$_w0"
mkdir -p "$_w0"
# Ensure no stamp, no PLUGIN_HOOK (CLI inject path), maps need seed
rm -f "$_w0"/.c-thru-cli-installed
printf '%s\n' '{"hooks":{}}' >"$_w0/settings.json"
# Point ROUTER via running session-start from monorepo tools (no PLUGIN_HOOK)
unset C_THRU_PLUGIN_HOOK C_THRU_PLUGIN_LITE || true
printf '%s' '{}' | bash "$REPO_ROOT/tools/c-thru-session-start.sh" >/dev/null 2>&1 || true
check "W0-no-durable-without-lite" bash -c '! grep -q ANTHROPIC_BASE_URL "'"$_w0"'/settings.json" && ! grep -q 127.0.0.1 "'"$_w0"'/settings.json"'
export CLAUDE_DIR="$BASE/claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"

# ── R0d pin fail-closed / unpinned escape (local git remote, no network) ───
_pin="$BASE/pin"
mkdir -p "$_pin/upstream"
# Minimal c-thru-shaped tree in a local git repo
_up="$_pin/upstream"
mkdir -p "$_up/tools" "$_up/agents" "$_up/config" "$_up/plugins/c-thru/.claude-plugin"
printf '#!/bin/sh\n' >"$_up/tools/c-thru"
printf 'ok\n' >"$_up/agents/.keep"
printf '{}\n' >"$_up/config/model-map.json"
printf '{"version":"9.9.9","name":"c-thru"}\n' >"$_up/plugins/c-thru/.claude-plugin/plugin.json"
(cd "$_up" && git init -q && git config user.email t@t && git config user.name t && git branch -M main && git add -A && git commit -qm init)
git clone --bare -q "$_up" "$_pin/remote.git"
export CLAUDE_DIR="$BASE/pin-claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"
export C_THRU_SOURCE_REF=v9.9.9
export C_THRU_GIT_REMOTE="file://${_pin}/remote.git"
unset C_THRU_ALLOW_UNPINNED || true
# empty src path under CLAUDE_DIR
rm -rf "$CLAUDE_DIR/c-thru-src"
rm -f "$(cthru_stamp_path)" 2>/dev/null || true
if cthru_ensure_source_root_s1 2>/dev/null; then
  check "R0d-pin-fail-closed" false
else
  check "R0d-pin-fail-closed" true
fi
check "R0d-pin-fail-no-stamp" test ! -f "$(cthru_stamp_path)"
# escape hatch — remove any partial tree from failed clone
export C_THRU_ALLOW_UNPINNED=1
rm -rf "$CLAUDE_DIR/c-thru-src"
if cthru_ensure_source_root_s1 2>/dev/null; then
  export REPO_DIR="$CLAUDE_DIR/c-thru-src"
  cthru_write_stamp "$REPO_DIR"
  sha_got="$(cthru_read_stamp_field source_sha)"
  sha_want="$(git -C "$CLAUDE_DIR/c-thru-src" rev-parse HEAD)"
  ref_got="$(cthru_read_stamp_field source_ref)"
  check "R0d-pin-unpinned-escape" test "$sha_got" = "$sha_want"
  check "R0d-pin-unpinned-not-fake-vtag" bash -c '[[ "'"$ref_got"'" != "v9.9.9" ]]'
else
  check "R0d-pin-unpinned-escape" false
  check "R0d-pin-unpinned-not-fake-vtag" false
fi
# Pin success: tag exists on local remote
unset C_THRU_ALLOW_UNPINNED
export C_THRU_SOURCE_REF=v9.9.9
export C_THRU_SOURCE_REF_DESIRED=v9.9.9
unset C_THRU_SOURCE_REF_IS_ACTUAL
(cd "$_up" && git tag -a v9.9.9 -m t && git push -q "$_pin/remote.git" v9.9.9 2>/dev/null || git -C "$_pin/remote.git" tag v9.9.9 "$(git -C "$_up" rev-parse HEAD)" 2>/dev/null || true)
# re-push tag into bare: easiest re-clone bare
rm -rf "$_pin/remote.git"
git clone --bare -q "$_up" "$_pin/remote.git"
export C_THRU_GIT_REMOTE="file://${_pin}/remote.git"
rm -rf "$CLAUDE_DIR/c-thru-src"
export CLAUDE_DIR="$BASE/pin-ok" CLAUDE_PROFILE_DIR="$BASE/pin-ok"
mkdir -p "$CLAUDE_DIR"
if cthru_ensure_source_root_s1 2>/dev/null; then
  check "R0d-pin-success" cthru_git_at_ref "$CLAUDE_DIR/c-thru-src" v9.9.9
  export REPO_DIR="$CLAUDE_DIR/c-thru-src"
  cthru_write_stamp "$REPO_DIR"
  check "R0d-pin-success-stamp-sha" test "$(cthru_read_stamp_field source_sha)" = "$(git -C "$CLAUDE_DIR/c-thru-src" rev-parse HEAD)"
else
  check "R0d-pin-success" false
  check "R0d-pin-success-stamp-sha" false
fi
unset C_THRU_ALLOW_UNPINNED C_THRU_SOURCE_REF C_THRU_SOURCE_REF_DESIRED C_THRU_SOURCE_REF_IS_ACTUAL C_THRU_GIT_REMOTE C_THRU_PACKAGE_ROOT
export REPO_DIR="$REPO_ROOT"
export CLAUDE_DIR="$BASE/claude"
export CLAUDE_PROFILE_DIR="$CLAUDE_DIR"

# ── Meta / lean / wiring ────────────────────────────────────────────────────
check "CLI-from-cli-export" grep -q 'C_THRU_FROM_CLI=1' "$REPO_ROOT/tools/c-thru"
check "LEAN-bundle-no-plan-skill" test ! -f "$REPO_ROOT/plugins/c-thru/skills/c-thru-plan/SKILL.md"
check "LEAN-bundle-commands" bash -c '
  ls "'"$REPO_ROOT"'/plugins/c-thru/commands" | sort | tr "\n" " " | grep -q "c-thru-install-cli.md" &&
  ls "'"$REPO_ROOT"'/plugins/c-thru/commands" | sort | tr "\n" " " | grep -q "c-thru-status.md" &&
  ! test -f "'"$REPO_ROOT"'/plugins/c-thru/commands/cplan.md"
'
check "R1-suite-wired" bash -c '
  grep -q shape-c-spec-contract "'"$REPO_ROOT"'/test/run-all.sh" &&
  grep -q shape-c-bootstrap "'"$REPO_ROOT"'/test/run-all.sh" &&
  grep -q uninstall-shape-c "'"$REPO_ROOT"'/test/run-all.sh" &&
  grep -q setup-docs-alignment "'"$REPO_ROOT"'/test/run-all.sh"
'
check "gate-file-exists" test -f "$REPO_ROOT/tools/c-thru-plugin-hook-gate.sh" -a -f "$REPO_ROOT/plugins/c-thru/tools/c-thru-plugin-hook-gate.sh"

echo "shape-c-spec-contract: $pass ok, $fail failed"
[[ "$fail" -eq 0 ]]
