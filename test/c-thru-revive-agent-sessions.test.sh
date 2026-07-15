#!/usr/bin/env bash
# Session revive: stage gateway + patch jobs + selective respawn.
# Live detection must NOT require ANTHROPIC_BASE_URL (bg workers often omit it).
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
# Isolate live-detect from the host machine's real daemons / agents.
export C_THRU_CC_DAEMON_DIR="$BASE/cc-daemon-empty"
export C_THRU_REVIVE_SKIP_AGENTS_JSON=1
export C_THRU_REVIVE_PS_SNAPSHOT=" "
mkdir -p "$CLAUDE_DIR" "$CLAUDE_JOBS_DIR/aabbcc11" "$CLAUDE_JOBS_DIR/deadbeef" "$CLAUDE_DIR/projects" "$C_THRU_CC_DAEMON_DIR"
printf '%s\n' '{"permissions":{"defaultMode":"default"}}' > "$CLAUDE_DIR/settings.json"

# Active brand job that needs rehydrate (dead → respawn).
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

# Done brand job — patch-only (durable gateway for next resume), never respawn.
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
if [[ "$1" == "stop" ]]; then
  exit 0
fi
if [[ "$1" == "respawn" ]]; then
  if [[ "${FAKE_CLAUDE_RESPAWN_FAIL:-}" == "bg" ]]; then
    echo "Session $2 is currently running as a background agent (bg). Use \`claude agents\` to find and attach to it" >&2
    exit 1
  fi
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

echo "1. revive active job; stage gateway; patch done (no respawn); no real token on disk"
bash "$SCRIPT"
ec=$?
[[ $ec -eq 0 ]] && pass "exit 0" || fail "exit $ec"

[[ -f "$C_THRU_AGENT_GATEWAY_DIR/settings.json" ]] && pass "gateway settings.json created" || fail "gateway settings missing"

BASE_IN="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.env&&s.env.ANTHROPIC_BASE_URL||"")' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
# Shared gateway must be UNSCOPED (no /s/<session-id>) even if caller had a scope.
[[ "$BASE_IN" == "http://127.0.0.1:55555" ]] && pass "settings.env has unscoped BASE_URL" || fail "BASE_URL got $BASE_IN (want unscoped host:port)"
[[ "$BASE_IN" != *"/s/"* ]] && pass "gateway BASE_URL has no /s/ session scope" || fail "gateway BASE_URL is session-scoped: $BASE_IN"
TOK_IN="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.env&&s.env.ANTHROPIC_AUTH_TOKEN||"")' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
# Custom BASE_URL requires a real-shaped token for Claude's login gate; oauth may be staged.
[[ "$TOK_IN" == "sk-ant-oat01-REAL-LOOKING-SECRET-TOKEN-VALUE" ]] \
  && pass "oauth-shaped token staged (login gate)" \
  || fail "expected oauth-shaped token staged, got '${TOK_IN:0:24}'"
CFG="$(node -e 'const s=require(process.argv[1]);process.stdout.write((s.providerEnv&&s.providerEnv.CLAUDE_CONFIG_DIR)||"")' "$CLAUDE_JOBS_DIR/aabbcc11/state.json")"
[[ "$CFG" == "$C_THRU_AGENT_GATEWAY_DIR" ]] && pass "active job providerEnv → gateway" || fail "providerEnv got $CFG"

CFG_DONE="$(node -e 'const s=require(process.argv[1]);process.stdout.write((s.providerEnv&&s.providerEnv.CLAUDE_CONFIG_DIR)||"")' "$CLAUDE_JOBS_DIR/deadbeef/state.json")"
[[ "$CFG_DONE" == "$C_THRU_AGENT_GATEWAY_DIR" ]] && pass "done job patched to gateway" || fail "done job not patched: $CFG_DONE"

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

echo "2. placeholder ollama token must NOT be written (causes Not logged in)"
: > "$FAKE_CLAUDE_LOG"
# Poison gateway first, then re-stage with ollama env — must clear, not keep.
node -e '
  const fs=require("fs");
  const p=process.argv[1];
  fs.writeFileSync(p, JSON.stringify({env:{ANTHROPIC_BASE_URL:"http://127.0.0.1:1",ANTHROPIC_AUTH_TOKEN:"ollama"}},null,2)+"\n");
' "$C_THRU_AGENT_GATEWAY_DIR/settings.json"
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
[[ -z "$TOK2" ]] && pass "placeholder ollama stripped from gateway" || fail "ollama must not persist (got '$TOK2')"

echo "2b. real oauth-shaped token may be staged for custom BASE_URL login gate"
: > "$FAKE_CLAUDE_LOG"
export ANTHROPIC_AUTH_TOKEN="sk-ant-oat01-TESTONLY-NOT-A-REAL-SECRET-VALUE-XXXX"
bash "$SCRIPT"
TOK3="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.env&&s.env.ANTHROPIC_AUTH_TOKEN||"")' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
[[ "$TOK3" == "sk-ant-oat01-TESTONLY-NOT-A-REAL-SECRET-VALUE-XXXX" ]] \
  && pass "real-shaped token staged for client login gate" \
  || fail "expected real-shaped token in gateway, got '${TOK3:0:30}'"

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
if [[ "$RESPAWN_N" -eq 1 ]]; then
  pass "revive cap limits to 1 respawn"
else
  fail "expected 1 respawn under cap, got $RESPAWN_N (log=$(cat "$FAKE_CLAUDE_LOG"))"
fi

echo "6. gateway symlinks profile entries without following ls word-split"
[[ -L "$C_THRU_AGENT_GATEWAY_DIR/projects" || -e "$C_THRU_AGENT_GATEWAY_DIR/projects" ]] \
  && pass "gateway linked profile entry (projects)" \
  || fail "gateway missing projects symlink"
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
C_THRU_REVIVE_MAX=5 C_THRU_REVIVE_PS_SNAPSHOT=" " C_THRU_REVIVE_LIVE_IDS="" bash "$SCRIPT"
if grep -q 'respawn a1b2c3d4' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  pass "alreadyGateway active job still respawned"
else
  fail "alreadyGateway job not respawned (log=$(cat "$FAKE_CLAUDE_LOG"))"
fi

echo "8. scrub secret-shaped keys from profile settings.env into gateway"
printf '%s\n' '{"env":{"ANTHROPIC_API_KEY":"sk-ant-secret","OPENAI_API_KEY":"sk-open","SAFE_FLAG":"1","permissions":"keep-me-not-env"}}' > "$CLAUDE_DIR/settings.json"
rm -f "$C_THRU_AGENT_GATEWAY_DIR/settings.json"
: > "$FAKE_CLAUDE_LOG"
export ANTHROPIC_AUTH_TOKEN="ollama"
C_THRU_REVIVE_MAX=1 C_THRU_REVIVE_PS_SNAPSHOT=" " bash "$SCRIPT"
HAS_KEY="$(node -e '
  const s=require(process.argv[1]);
  const e=s.env||{};
  process.stdout.write([e.ANTHROPIC_API_KEY||"",e.OPENAI_API_KEY||"",e.ANTHROPIC_AUTH_TOKEN||"",e.SAFE_FLAG||""].join("|"));
' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
# API keys scrubbed; ollama placeholder not written; SAFE_FLAG kept.
case "$HAS_KEY" in
  "|||1") pass "gateway scrubs API keys; no ollama placeholder; keeps non-secret" ;;
  *) fail "gateway env scrub failed: $HAS_KEY" ;;
esac
echo "9. live via CLAUDE_JOB_DIR (no BASE_URL) → patch-only, no respawn"
: > "$FAKE_CLAUDE_LOG"
ISO_JOBS="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-revive-iso.XXXXXX")"
mkdir -p "$ISO_JOBS/b2c3d4e5"
cat > "$ISO_JOBS/b2c3d4e5/state.json" <<'JSON'
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.OLDSHADOW" },
  "daemonShort": "b2c3d4e5"
}
JSON
# Live signal: CLAUDE_JOB_DIR only — no ANTHROPIC_BASE_URL (real bg workers).
FAKE_PS="12345 claude CLAUDE_JOB_DIR=/tmp/x/jobs/b2c3d4e5 CLAUDE_CODE_SESSION_KIND=bg"
CLAUDE_JOBS_DIR="$ISO_JOBS" \
  C_THRU_REVIVE_PS_SNAPSHOT="$FAKE_PS" \
  C_THRU_CC_DAEMON_DIR="$BASE/cc-daemon-empty" \
  C_THRU_REVIVE_SKIP_AGENTS_JSON=1 \
  C_THRU_REVIVE_MAX=5 \
  bash "$SCRIPT"
CFG_PATCH="$(node -e 'const s=require(process.argv[1]);process.stdout.write((s.providerEnv&&s.providerEnv.CLAUDE_CONFIG_DIR)||"")' "$ISO_JOBS/b2c3d4e5/state.json")"
if [[ "$CFG_PATCH" == "$C_THRU_AGENT_GATEWAY_DIR" ]]; then
  pass "live-without-BASE_URL job patched to gateway"
else
  fail "live-without-BASE_URL not patched (got $CFG_PATCH)"
fi
if grep -q 'respawn b2c3d4e5' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  fail "live-without-BASE_URL was respawned (should be patch-only)"
else
  pass "live-without-BASE_URL not respawned"
fi
rm -rf "$ISO_JOBS"

echo "10. live via rv sock → no respawn"
: > "$FAKE_CLAUDE_LOG"
ISO3="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-revive-sock.XXXXXX")"
DAEMON="$BASE/cc-daemon-sock"
mkdir -p "$DAEMON/rv" "$ISO3/d4e5f6a7"
: > "$DAEMON/rv/d4e5f6a7.sock"
cat > "$ISO3/d4e5f6a7/state.json" <<'JSON'
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.sock" },
  "daemonShort": "d4e5f6a7"
}
JSON
CLAUDE_JOBS_DIR="$ISO3" \
  C_THRU_REVIVE_PS_SNAPSHOT=" " \
  C_THRU_CC_DAEMON_DIR="$DAEMON" \
  C_THRU_REVIVE_SKIP_AGENTS_JSON=1 \
  C_THRU_REVIVE_MAX=5 \
  bash "$SCRIPT"
if grep -q 'respawn d4e5f6a7' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  fail "rv-sock live job was respawned"
else
  pass "rv-sock live job not respawned"
fi
CFG_SOCK="$(node -e 'const s=require(process.argv[1]);process.stdout.write((s.providerEnv&&s.providerEnv.CLAUDE_CONFIG_DIR)||"")' "$ISO3/d4e5f6a7/state.json")"
[[ "$CFG_SOCK" == "$C_THRU_AGENT_GATEWAY_DIR" ]] && pass "rv-sock live job still patched" || fail "rv-sock not patched ($CFG_SOCK)"
rm -rf "$ISO3"

echo "11. respawn error 'already running as background agent' → stop+respawn recycle, bounded"
: > "$FAKE_CLAUDE_LOG"
ISO4="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-revive-bgerr.XXXXXX")"
mkdir -p "$ISO4/e5f6a7b8"
cat > "$ISO4/e5f6a7b8/state.json" <<'JSON'
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "/tmp/c-thru-session.bgerr" },
  "daemonShort": "e5f6a7b8"
}
JSON
CLAUDE_JOBS_DIR="$ISO4" \
  C_THRU_REVIVE_PS_SNAPSHOT=" " \
  C_THRU_CC_DAEMON_DIR="$BASE/cc-daemon-empty" \
  C_THRU_REVIVE_SKIP_AGENTS_JSON=1 \
  C_THRU_REVIVE_LIVE_IDS="" \
  FAKE_CLAUDE_RESPAWN_FAIL=bg \
  C_THRU_REVIVE_MAX=5 \
  bash "$SCRIPT"
RESPAWN_BG="$(grep -c '^respawn e5f6a7b8' "$FAKE_CLAUDE_LOG" 2>/dev/null || echo 0)"
STOP_BG="$(grep -c '^stop e5f6a7b8' "$FAKE_CLAUDE_LOG" 2>/dev/null || echo 0)"
# First respawn hits bg-error → recycle does stop+respawn (and one more stop+respawn if still bg).
# Bounded: not a runaway loop.
if [[ "$STOP_BG" -ge 1 && "$RESPAWN_BG" -ge 2 && "$RESPAWN_BG" -le 4 ]]; then
  pass "already-running-as-bg: bounded stop+respawn recycle (stop=$STOP_BG respawn=$RESPAWN_BG)"
else
  fail "unexpected recycle shape stop=$STOP_BG respawn=$RESPAWN_BG (log=$(cat "$FAKE_CLAUDE_LOG"))"
fi
rm -rf "$ISO4"

echo "12. rewrite stale ephemeral SessionStart path in respawnFlags"
: > "$FAKE_CLAUDE_LOG"
ISO5="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-revive-stalehooks.XXXXXX")"
mkdir -p "$ISO5/f6a7b8c9"
# Durable hook targets for the rewrite (use real script if present).
DUR_SS="$REPO/tools/c-thru-session-start.sh"
DUR_SF="$REPO/tools/c-thru-stop-failure-hook.sh"
SETTINGS_JSON="$(node -e '
  const ss=process.argv[1], sf=process.argv[2];
  process.stdout.write(JSON.stringify({hooks:{
    SessionStart:[{matcher:"*",hooks:[{type:"command",command:ss,timeout:10}]}],
    StopFailure:[{matcher:"server_error|unknown",hooks:[{type:"command",command:sf,timeout:10}]}],
  }}));
' "/var/folders/xx/T//c-thru-session.DEADTMP/tools/c-thru-session-start" "$DUR_SF")"
cat > "$ISO5/f6a7b8c9/state.json" <<JSON
{
  "state": "done",
  "respawnFlags": ["--settings", $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$SETTINGS_JSON"), "--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "$C_THRU_AGENT_GATEWAY_DIR" },
  "daemonShort": "f6a7b8c9"
}
JSON
CLAUDE_JOBS_DIR="$ISO5" \
  CLAUDE_DIR="$CLAUDE_DIR" \
  C_THRU_REVIVE_PS_SNAPSHOT=" " \
  C_THRU_CC_DAEMON_DIR="$BASE/cc-daemon-empty" \
  C_THRU_REVIVE_SKIP_AGENTS_JSON=1 \
  C_THRU_REVIVE_MAX=5 \
  bash "$SCRIPT"
HOOK_CMD="$(node -e '
  const s=require(process.argv[1]);
  const f=s.respawnFlags||[];
  const i=f.indexOf("--settings");
  if(i<0){process.stdout.write("");process.exit(0)}
  const o=JSON.parse(f[i+1]);
  process.stdout.write(o.hooks.SessionStart[0].hooks[0].command||"");
' "$ISO5/f6a7b8c9/state.json")"
if [[ "$HOOK_CMD" == *c-thru-session.* ]]; then
  fail "stale ephemeral SessionStart path not rewritten (got $HOOK_CMD)"
elif [[ -n "$HOOK_CMD" && -f "$HOOK_CMD" ]]; then
  pass "stale SessionStart rewritten to durable path"
else
  # May be install symlink path
  if [[ "$HOOK_CMD" == *c-thru-session-start* && "$HOOK_CMD" != *c-thru-session.* ]]; then
    pass "stale SessionStart rewritten off ephemeral ($HOOK_CMD)"
  else
    fail "unexpected SessionStart path after patch: $HOOK_CMD"
  fi
fi
if grep -q 'respawn f6a7b8c9' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  fail "done job with stale hooks should not respawn"
else
  pass "done+stale-hooks not respawned"
fi
rm -rf "$ISO5"

echo "13. gateway auth upgrade + live job → stop+respawn recycle"
: > "$FAKE_CLAUDE_LOG"
ISO6="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-revive-recycle.XXXXXX")"
mkdir -p "$ISO6/a7b8c9d0"
# Poison gateway with ollama first
printf '%s\n' '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:55555/s/old","ANTHROPIC_AUTH_TOKEN":"ollama"}}' \
  > "$C_THRU_AGENT_GATEWAY_DIR/settings.json"
cat > "$ISO6/a7b8c9d0/state.json" <<JSON
{
  "state": "working",
  "respawnFlags": ["--model", "grok"],
  "providerEnv": { "CLAUDE_CONFIG_DIR": "$C_THRU_AGENT_GATEWAY_DIR" },
  "daemonShort": "a7b8c9d0"
}
JSON
# Live via JOB_DIR; gateway will upgrade ollama → real token → exit 3 recycle
FAKE_PS="999 claude CLAUDE_JOB_DIR=/tmp/x/jobs/a7b8c9d0"
CLAUDE_JOBS_DIR="$ISO6" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:55555/s/new" \
  ANTHROPIC_AUTH_TOKEN="sk-ant-oat01-RECYCLE-TEST-TOKEN-VALUE-YYYY" \
  C_THRU_REVIVE_PS_SNAPSHOT="$FAKE_PS" \
  C_THRU_CC_DAEMON_DIR="$BASE/cc-daemon-empty" \
  C_THRU_REVIVE_SKIP_AGENTS_JSON=1 \
  C_THRU_REVIVE_MAX=5 \
  bash "$SCRIPT"
if grep -q '^stop a7b8c9d0' "$FAKE_CLAUDE_LOG" && grep -q '^respawn a7b8c9d0' "$FAKE_CLAUDE_LOG"; then
  pass "live job recycled (stop+respawn) after gateway auth upgrade"
else
  fail "expected stop+respawn recycle (log=$(cat "$FAKE_CLAUDE_LOG"))"
fi
TOK_GW="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.env&&s.env.ANTHROPIC_AUTH_TOKEN||"")' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
[[ "$TOK_GW" == "sk-ant-oat01-RECYCLE-TEST-TOKEN-VALUE-YYYY" ]] \
  && pass "gateway upgraded off ollama to real token" \
  || fail "gateway token not upgraded (got ${TOK_GW:0:24})"
rm -rf "$ISO6"

echo "14. gateway stages apiKeyHelper for attach/resume auth"
: > "$FAKE_CLAUDE_LOG"
export ANTHROPIC_AUTH_TOKEN="sk-ant-oat01-HELPER-TEST-TOKEN-VALUE-ZZZZ"
# Force restage
rm -f "$C_THRU_AGENT_GATEWAY_DIR/settings.json"
C_THRU_REVIVE_MAX=1 C_THRU_REVIVE_PS_SNAPSHOT=" " bash "$SCRIPT"
HELPER="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.apiKeyHelper||"")' "$C_THRU_AGENT_GATEWAY_DIR/settings.json")"
if [[ -n "$HELPER" && -f "$HELPER" ]]; then
  pass "gateway has apiKeyHelper pointing at existing script"
else
  fail "apiKeyHelper missing or not a file (got '$HELPER')"
fi
# Helper must never print ollama when only ollama is ambient
OUT_H="$(ANTHROPIC_AUTH_TOKEN=ollama bash "$HELPER" 2>/dev/null || true)"
if [[ "$OUT_H" == "ollama" ]]; then
  fail "auth helper printed ollama placeholder"
else
  pass "auth helper does not emit ollama"
fi

echo "15. IPv6 loopback BASE_URL port parse"
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
  C_THRU_REVIVE_PS_SNAPSHOT=" " \
  C_THRU_CC_DAEMON_DIR="$BASE/cc-daemon-empty" \
  C_THRU_REVIVE_SKIP_AGENTS_JSON=1 \
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
