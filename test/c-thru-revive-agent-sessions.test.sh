#!/usr/bin/env bash
# Session revive: stage gateway CLAUDE_CONFIG_DIR + patch jobs + respawn.
# H2: only active (working|blocked) jobs; skip done. M1: no real auth on disk.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/tools/c-thru-revive-agent-sessions.sh"
PASS=0; FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-revive.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

export HOME="$BASE/home"
export CLAUDE_DIR="$HOME/.claude"
export CLAUDE_JOBS_DIR="$HOME/.claude/jobs"
export C_THRU_AGENT_GATEWAY_DIR="$CLAUDE_DIR/c-thru-agent-gateway"
mkdir -p "$CLAUDE_DIR" "$CLAUDE_JOBS_DIR/aabbcc11" "$CLAUDE_JOBS_DIR/deadbeef" "$CLAUDE_DIR/projects"
printf '%s\n' '{"permissions":{"defaultMode":"default"}}' > "$CLAUDE_DIR/settings.json"

# Active brand job that needs rehydrate.
cat > "$CLAUDE_JOBS_DIR/aabbcc11/state.json" <<'JSON'
{
  "state": "blocked",
  "template": "claude",
  "respawnFlags": ["--agent", "claude", "--model", "grok", "--permission-mode", "auto"],
  "providerEnv": {
    "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.DEADBEEF"
  },
  "daemonShort": "aabbcc11",
  "sessionId": "aabbcc11-0000-0000-0000-000000000001"
}
JSON

# Done brand job — must NOT thrash on open.
cat > "$CLAUDE_JOBS_DIR/deadbeef/state.json" <<'JSON'
{
  "state": "done",
  "template": "claude",
  "respawnFlags": ["--agent", "claude", "--model", "grok"],
  "providerEnv": {
    "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.OLD"
  },
  "daemonShort": "deadbeef"
}
JSON

mkdir -p "$BASE/bin"
cat > "$BASE/bin/claude" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_CLAUDE_LOG}"
if [[ "$1" == "respawn" ]]; then
  exit 0
fi
exit 0
SH
chmod +x "$BASE/bin/claude"
export PATH="$BASE/bin:$PATH"
export FAKE_CLAUDE_LOG="$BASE/claude.log"
: > "$FAKE_CLAUDE_LOG"

export ANTHROPIC_BASE_URL="http://127.0.0.1:55555/s/testsession"
export ANTHROPIC_AUTH_TOKEN="sk-ant-oat01-REAL-LOOKING-SECRET-TOKEN-VALUE"
export CLAUDE_BIN="$BASE/bin/claude"

echo "1. revive active job; stage gateway; do not thrash done; no real token on disk"
bash "$SCRIPT"
ec=$?
[[ $ec -eq 0 ]] && pass "exit 0" || fail "exit $ec"

[[ -f "$C_THRU_AGENT_GATEWAY_DIR/settings.json" ]] && pass "gateway settings.json created" || fail "gateway settings missing"

BASE_IN="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.env&&s.env.ANTHROPIC_BASE_URL||"")' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
[[ "$BASE_IN" == "$ANTHROPIC_BASE_URL" ]] && pass "settings.env has current BASE_URL" || fail "BASE_URL got $BASE_IN"

TOK_IN="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.env&&s.env.ANTHROPIC_AUTH_TOKEN||"")' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
[[ -z "$TOK_IN" ]] && pass "does not persist real OAuth/API token" || fail "token leaked to disk: ${TOK_IN:0:20}"

CFG="$(node -e 'const s=require(process.argv[1]);process.stdout.write((s.providerEnv&&s.providerEnv.CLAUDE_CONFIG_DIR)||"")' "$CLAUDE_JOBS_DIR/aabbcc11/state.json")"
[[ "$CFG" == "$C_THRU_AGENT_GATEWAY_DIR" ]] && pass "active job providerEnv → gateway" || fail "providerEnv got $CFG"

CFG_DONE="$(node -e 'const s=require(process.argv[1]);process.stdout.write((s.providerEnv&&s.providerEnv.CLAUDE_CONFIG_DIR)||"")' "$CLAUDE_JOBS_DIR/deadbeef/state.json")"
[[ "$CFG_DONE" == "/tmp/c-thru-session.OLD" ]] && pass "done job not patched" || fail "done job was patched: $CFG_DONE"

if grep -q 'respawn aabbcc11' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  pass "claude respawn invoked for active job"
else
  fail "respawn not called for active job (log=$(cat "$FAKE_CLAUDE_LOG" 2>/dev/null))"
fi
if grep -q 'respawn deadbeef' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  fail "should not respawn done job"
else
  pass "done job not respawned"
fi

echo "2. placeholder token may be written"
: > "$FAKE_CLAUDE_LOG"
# reset active job
node -e '
  const fs=require("fs");
  const p=process.argv[1];
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.state="working";
  s.providerEnv={CLAUDE_CONFIG_DIR:"/tmp/c-thru-session.OTHER"};
  fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
' "$CLAUDE_JOBS_DIR/aabbcc11/state.json"
export ANTHROPIC_AUTH_TOKEN="ollama"
bash "$SCRIPT"
TOK2="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.env&&s.env.ANTHROPIC_AUTH_TOKEN||"")' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
[[ "$TOK2" == "ollama" ]] && pass "placeholder ollama token allowed" || fail "expected ollama token, got '$TOK2'"

echo "3. opt-out C_THRU_NO_SESSION_REVIVE"
: > "$FAKE_CLAUDE_LOG"
node -e '
  const fs=require("fs");
  const p=process.argv[1];
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.providerEnv={CLAUDE_CONFIG_DIR:"/tmp/c-thru-session.OTHER2"};
  fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
' "$CLAUDE_JOBS_DIR/aabbcc11/state.json"
C_THRU_NO_SESSION_REVIVE=1 bash "$SCRIPT"
CFG2="$(node -e 'const s=require(process.argv[1]);process.stdout.write((s.providerEnv&&s.providerEnv.CLAUDE_CONFIG_DIR)||"")' "$CLAUDE_JOBS_DIR/aabbcc11/state.json")"
[[ "$CFG2" == "/tmp/c-thru-session.OTHER2" ]] && pass "opt-out leaves job unchanged" || fail "opt-out still patched ($CFG2)"
[[ ! -s "$FAKE_CLAUDE_LOG" ]] && pass "opt-out no respawn" || fail "opt-out still respawned"

echo "4. no ANTHROPIC_BASE_URL → no-op"
unset ANTHROPIC_BASE_URL
: > "$FAKE_CLAUDE_LOG"
bash "$SCRIPT"
[[ ! -s "$FAKE_CLAUDE_LOG" ]] && pass "no base → no respawn" || fail "respawn without base"

echo "5. revive cap (C_THRU_REVIVE_MAX)"
export ANTHROPIC_BASE_URL="http://127.0.0.1:55555/s/testsession"
export ANTHROPIC_AUTH_TOKEN="ollama"
: > "$FAKE_CLAUDE_LOG"
# Two active brand jobs; cap=1 → only one respawn
mkdir -p "$CLAUDE_JOBS_DIR/ccccdd22" "$CLAUDE_JOBS_DIR/eeeeff33"
for jid in ccccdd22 eeeeff33; do
  cat > "$CLAUDE_JOBS_DIR/$jid/state.json" <<JSON
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.$jid" },
  "daemonShort": "$jid"
}
JSON
done
C_THRU_REVIVE_MAX=1 bash "$SCRIPT"
RESPAWN_N="$(grep -c '^respawn ' "$FAKE_CLAUDE_LOG" 2>/dev/null || echo 0)"
# Only jobs from this section should be candidates; prior aabbcc11 may still need revive if reset
# Count unique respawn lines — with cap 1 and 2+ candidates, must be exactly 1.
if [[ "$RESPAWN_N" -eq 1 ]]; then
  pass "revive cap limits to 1 respawn"
else
  fail "expected 1 respawn under cap, got $RESPAWN_N (log=$(cat "$FAKE_CLAUDE_LOG"))"
fi

echo "6. gateway symlinks profile entries without following ls word-split"
# projects/ should be linked into gateway (safe symlink of a real dir)
[[ -L "$C_THRU_AGENT_GATEWAY_DIR/projects" || -e "$C_THRU_AGENT_GATEWAY_DIR/projects" ]] \
  && pass "gateway linked profile entry (projects)" \
  || fail "gateway missing projects symlink"
# Must not nest gateway into itself
[[ ! -e "$C_THRU_AGENT_GATEWAY_DIR/c-thru-agent-gateway" ]] \
  && pass "gateway does not self-nest" \
  || fail "gateway nested itself"

echo "7. already on gateway + dead daemon still respawns (active)"
: > "$FAKE_CLAUDE_LOG"
mkdir -p "$CLAUDE_JOBS_DIR/a1b2c3d4"
cat > "$CLAUDE_JOBS_DIR/a1b2c3d4/state.json" <<JSON
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "$C_THRU_AGENT_GATEWAY_DIR" },
  "daemonShort": "a1b2c3d4"
}
JSON
# Cap high enough for this one job; empty PS snapshot → no live env.
C_THRU_REVIVE_MAX=5 C_THRU_REVIVE_PS_SNAPSHOT="" bash "$SCRIPT"
if grep -q 'respawn a1b2c3d4' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  pass "alreadyGateway active job still respawned"
else
  fail "alreadyGateway job not respawned (log=$(cat "$FAKE_CLAUDE_LOG"))"
fi

echo "8. scrub secret-shaped keys from profile settings.env into gateway"
printf '%s\n' '{"env":{"ANTHROPIC_API_KEY":"sk-ant-secret","OPENAI_API_KEY":"sk-open","SAFE_FLAG":"1","permissions":"keep-me-not-env"}}' > "$CLAUDE_DIR/settings.json"
# Force re-stage
rm -f "$C_THRU_AGENT_GATEWAY_DIR/settings.json"
: > "$FAKE_CLAUDE_LOG"
export ANTHROPIC_AUTH_TOKEN="ollama"
C_THRU_REVIVE_MAX=1 C_THRU_REVIVE_PS_SNAPSHOT=" " bash "$SCRIPT"
HAS_KEY="$(node -e '
  const s=require(process.argv[1]);
  const e=s.env||{};
  process.stdout.write([e.ANTHROPIC_API_KEY||"",e.OPENAI_API_KEY||"",e.ANTHROPIC_AUTH_TOKEN||"",e.SAFE_FLAG||""].join("|"));
' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
# Expect empty secrets, placeholder ollama token, SAFE_FLAG preserved
case "$HAS_KEY" in
  "||ollama|1") pass "gateway scrubs API keys; keeps placeholder + non-secret" ;;
  *) fail "gateway env scrub failed: $HAS_KEY" ;;
esac

echo "9. healthy live worker → patch-only (no respawn thrash)"
: > "$FAKE_CLAUDE_LOG"
mkdir -p "$CLAUDE_JOBS_DIR/b2c3d4e5"
cat > "$CLAUDE_JOBS_DIR/b2c3d4e5/state.json" <<JSON
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.OLDSHADOW" },
  "daemonShort": "b2c3d4e5"
}
JSON
# Simulate a live claude daemon already on the current gateway port.
export ANTHROPIC_BASE_URL="http://127.0.0.1:55555/s/testsession"
FAKE_PS="12345 claude daemonShort=b2c3d4e5 ANTHROPIC_BASE_URL=http://127.0.0.1:55555/s/old"
# Only this job should be considered: force empty other activity via isolated jobs dir.
ISO_JOBS="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-revive-iso.XXXXXX")"
mkdir -p "$ISO_JOBS/b2c3d4e5"
cp "$CLAUDE_JOBS_DIR/b2c3d4e5/state.json" "$ISO_JOBS/b2c3d4e5/state.json"
CLAUDE_JOBS_DIR="$ISO_JOBS" \
  C_THRU_REVIVE_PS_SNAPSHOT="$FAKE_PS" \
  C_THRU_REVIVE_CURRENT_PORT_OK=1 \
  C_THRU_REVIVE_MAX=5 \
  bash "$SCRIPT"
CFG_PATCH="$(node -e 'const s=require(process.argv[1]);process.stdout.write((s.providerEnv&&s.providerEnv.CLAUDE_CONFIG_DIR)||"")' "$ISO_JOBS/b2c3d4e5/state.json")"
if [[ "$CFG_PATCH" == "$C_THRU_AGENT_GATEWAY_DIR" ]]; then
  pass "healthy live job state patched to gateway"
else
  fail "healthy live job not patched (got $CFG_PATCH)"
fi
if grep -q 'respawn b2c3d4e5' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  fail "healthy live job was respawned (should be patch-only)"
else
  pass "healthy live job not respawned"
fi
rm -rf "$ISO_JOBS"

echo "10. IPv6 loopback BASE_URL port parse"
: > "$FAKE_CLAUDE_LOG"
ISO2="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-revive-v6.XXXXXX")"
mkdir -p "$ISO2/c3d4e5f6"
cat > "$ISO2/c3d4e5f6/state.json" <<'JSON'
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.v6" },
  "daemonShort": "c3d4e5f6"
}
JSON
CLAUDE_JOBS_DIR="$ISO2" \
  ANTHROPIC_BASE_URL="http://[::1]:55555/s/v6" \
  C_THRU_REVIVE_PS_SNAPSHOT="" \
  C_THRU_REVIVE_CURRENT_PORT_OK=0 \
  C_THRU_REVIVE_MAX=5 \
  bash "$SCRIPT"
if grep -q 'respawn c3d4e5f6' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  pass "IPv6 [::1] BASE_URL revived job"
else
  fail "IPv6 BASE_URL no-op (log=$(cat "$FAKE_CLAUDE_LOG"))"
fi
rm -rf "$ISO2"

echo
echo "revive-agent-sessions: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
