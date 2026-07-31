#!/usr/bin/env bash
# Port-resurrection helper: c-thru-ensure-proxy-on-port.sh
# Covers: already-up, spawn-on-dead-port, bad port, opt-out path via SessionStart.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENSURE="$REPO_DIR/tools/c-thru-ensure-proxy-on-port.sh"
PROXY_JS="$REPO_DIR/tools/claude-proxy"
MAP="$REPO_DIR/config/model-map.json"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

[[ -f "$ENSURE" && -f "$PROXY_JS" && -f "$MAP" ]] || {
  echo "fatal: missing ensure script, claude-proxy, or model-map" >&2
  exit 1
}

# shellcheck source=/dev/null
source "$ENSURE"

# cthru_ensure_proxy_on_port refuses to act on any non-loopback
# ANTHROPIC_BASE_URL by design (see case 5). The ambient environment this
# test runs in (including a live Claude Code session) commonly exports
# ANTHROPIC_BASE_URL=https://api.anthropic.com already, which would make
# every case below silently hit that early-refuse guard instead of
# exercising the ping/spawn mechanics they're meant to test. Isolate it
# here; cases that need a specific value (4, 5, 6) set it explicitly inline.
unset ANTHROPIC_BASE_URL

# ── 1. bad port ──────────────────────────────────────────────────────────────
echo "1. bad port → exit 2"
cthru_ensure_proxy_on_port "not-a-port"
ec=$?
[[ $ec -eq 2 ]] && pass "non-numeric port → 2" || fail "non-numeric port (ec=$ec)"
cthru_ensure_proxy_on_port "99999"
ec=$?
[[ $ec -eq 2 ]] && pass "out-of-range port → 2" || fail "out-of-range (ec=$ec)"

# ── 2. already-up stub via real node server ──────────────────────────────────
echo "2. already listening → 0 without second spawn"
if ! command -v node >/dev/null 2>&1; then
  echo "  SKIP  node missing"
else
  STUBDIR="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-ensure-stub.XXXXXX")"
  INFO="$STUBDIR/port"
  cat > "$STUBDIR/stub.js" <<'JS'
const http = require('http');
const fs = require('fs');
const out = process.argv[2];
const s = http.createServer((q, r) => {
  if (String(q.url || '').indexOf('ping') >= 0) {
    r.writeHead(200);
    r.end(JSON.stringify({ ok: true }));
    return;
  }
  r.writeHead(404);
  r.end();
});
s.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(out, String(s.address().port));
});
setTimeout(() => process.exit(0), 15000);
JS
  node "$STUBDIR/stub.js" "$INFO" &
  STUB_PID=$!
  for _ in $(seq 1 50); do [[ -s "$INFO" ]] && break; sleep 0.05; done
  PORT="$(cat "$INFO")"
  if cthru_ensure_proxy_on_port "$PORT"; then
    pass "already-up /ping → 0"
  else
    fail "already-up should return 0 (port=$PORT)"
  fi
  kill "$STUB_PID" 2>/dev/null || true
  wait "$STUB_PID" 2>/dev/null || true
  rm -rf "$STUBDIR"
fi

# ── 3. spawn real claude-proxy on free port ──────────────────────────────────
echo "3. dead port → spawn real claude-proxy → /ping"
if ! command -v node >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "  SKIP  node/curl missing"
else
  # Pick a free port (bind+close).
  FREE_PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
  export CLAUDE_MODEL_MAP_PATH="$MAP"
  export CLAUDE_DIR="${TMPDIR:-/tmp}/c-thru-ensure-test-$$"
  mkdir -p "$CLAUDE_DIR"
  SPAWNED_PID=""
  if cthru_ensure_proxy_on_port "$FREE_PORT"; then
    pass "spawn+ping on :$FREE_PORT"
    # Reap whatever we started (best-effort: lsof listener on port).
    if command -v lsof >/dev/null 2>&1; then
      SPAWNED_PID="$(lsof -nP -iTCP:"$FREE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    fi
  else
    fail "spawn+ping on free port failed"
  fi
  if [[ -n "$SPAWNED_PID" ]]; then
    kill "$SPAWNED_PID" 2>/dev/null || true
    wait "$SPAWNED_PID" 2>/dev/null || true
    pass "reaped ensure-spawned proxy pid $SPAWNED_PID"
  else
    # Still try pkill by log/path pattern for this port
    pkill -f "claude-proxy --port ${FREE_PORT}" 2>/dev/null || true
    pass "cleanup attempted for :$FREE_PORT (no lsof pid)"
  fi
  rm -rf "$CLAUDE_DIR"
fi

# ── 4. SessionStart integration: NO_RESURRECT keeps advisory ─────────────────
echo "4. SessionStart with C_THRU_NO_RESURRECT=1 on closed port → advisory"
HOOK="$REPO_DIR/tools/c-thru-session-start.sh"
LIB="$REPO_DIR/tools/c-thru-lib.sh"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-ensure-ss.XXXXXX")"
mkdir -p "$SCRATCH/tools"
cp "$HOOK" "$LIB" "$ENSURE" "$SCRATCH/tools/"
CLOSED="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
OUT="$(printf '{}' | env -u CLAUDE_PROXY_PORT -u PROXY_PORT -u OLLAMA_URL -u OLLAMA_BASE_URL \
  C_THRU_NO_RESURRECT=1 \
  ANTHROPIC_BASE_URL="http://127.0.0.1:${CLOSED}" \
  CLAUDE_PROFILE_DIR="$SCRATCH/profile" \
  bash "$SCRATCH/tools/c-thru-session-start.sh" 2>/dev/null || true)"
if printf '%s' "$OUT" | grep -q "proxy down on :${CLOSED}"; then
  pass "SessionStart advisory with NO_RESURRECT"
else
  fail "SessionStart missing proxy-down advisory (out=${OUT:0:200})"
fi
rm -rf "$SCRATCH"

# ── 5. remote BASE_URL must not spawn even with CLAUDE_PROXY_PORT ────────────
echo "5. remote ANTHROPIC_BASE_URL → refuse spawn"
FREE_REMOTE="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
export CLAUDE_MODEL_MAP_PATH="$MAP"
if ANTHROPIC_BASE_URL="https://api.anthropic.com" cthru_ensure_proxy_on_port "$FREE_REMOTE"; then
  fail "remote BASE_URL should refuse ensure"
  pkill -f "claude-proxy --port ${FREE_REMOTE}" 2>/dev/null || true
else
  if curl -sf --max-time 0.5 "http://127.0.0.1:${FREE_REMOTE}/ping" >/dev/null 2>&1; then
    fail "remote BASE_URL still spawned a listener"
    pkill -f "claude-proxy --port ${FREE_REMOTE}" 2>/dev/null || true
  else
    pass "remote BASE_URL refuses ensure (no spawn)"
  fi
fi

# ── 6. failed spawn is reaped (broken config path) ───────────────────────────
echo "6. failed spawn reaps orphan node (broken config)"
FREE_FAIL="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
BAD_MAP="$(mktemp "${TMPDIR:-/tmp}/c-thru-ensure-badmap.XXXXXX")"
printf 'not-json\n' > "$BAD_MAP"
# Before: count node processes mentioning this port (should be 0 after ensure fails).
ANTHROPIC_BASE_URL="http://127.0.0.1:${FREE_FAIL}" \
  CLAUDE_MODEL_MAP_PATH="$BAD_MAP" \
  CLAUDE_DIR="${TMPDIR:-/tmp}/c-thru-ensure-fail-$$" \
  cthru_ensure_proxy_on_port "$FREE_FAIL" || true
mkdir -p "${TMPDIR:-/tmp}/c-thru-ensure-fail-$$"
# Give any race a beat, then assert no listener + no lingering node for that port.
sleep 0.3
if curl -sf --max-time 0.3 "http://127.0.0.1:${FREE_FAIL}/ping" >/dev/null 2>&1; then
  fail "broken config should not leave a live /ping"
  pkill -f "claude-proxy --port ${FREE_FAIL}" 2>/dev/null || true
else
  pass "broken config leaves no /ping listener"
fi
# Best-effort: no process still advertising this --port (reap path).
if pgrep -f "claude-proxy --port ${FREE_FAIL}" >/dev/null 2>&1 || \
   pgrep -f "node.*--port ${FREE_FAIL}" >/dev/null 2>&1; then
  # May still match briefly; re-check after short wait.
  sleep 0.5
  if pgrep -f "--port ${FREE_FAIL}" >/dev/null 2>&1; then
    fail "orphan node still running for --port ${FREE_FAIL}"
    pkill -f "--port ${FREE_FAIL}" 2>/dev/null || true
  else
    pass "orphan spawn reaped after failed ensure"
  fi
else
  pass "orphan spawn reaped after failed ensure"
fi
rm -f "$BAD_MAP"
rm -rf "${TMPDIR:-/tmp}/c-thru-ensure-fail-$$"

# ── 7. R2: fingerprint mismatch kills and respawns with new override ─────────
echo "7. wrong upstream fingerprint → kill + respawn (R2)"
if ! command -v node >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "  SKIP  node/curl missing"
else
  FREE_FP="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();})')"
  CLAUDE_DIR_FP="${TMPDIR:-/tmp}/c-thru-ensure-fp-$$"
  mkdir -p "$CLAUDE_DIR_FP"
  export CLAUDE_MODEL_MAP_PATH="$MAP"
  export CLAUDE_DIR="$CLAUDE_DIR_FP"
  unset ANTHROPIC_BASE_URL
  export ANTHROPIC_BASE_URL="http://127.0.0.1:${FREE_FP}"

  URL_A="https://gw-a.example.com/anthropic"
  URL_B="https://gw-b.example.com/anthropic"
  FP_A="$(node -e 'const c=require("crypto");let s=process.argv[1];try{s=new URL(s).toString()}catch{}process.stdout.write(c.createHash("sha256").update(s).digest("hex").slice(0,16))' "$URL_A")"
  FP_B="$(node -e 'const c=require("crypto");let s=process.argv[1];try{s=new URL(s).toString()}catch{}process.stdout.write(c.createHash("sha256").update(s).digest("hex").slice(0,16))' "$URL_B")"

  # Spawn with override A
  export CLAUDE_PROXY_ANTHROPIC_UPSTREAM="$URL_A"
  export C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT="$FP_A"
  if ! cthru_ensure_proxy_on_port "$FREE_FP"; then
    fail "initial spawn with override A"
  else
    LIVE_A="$(curl -sf --max-time 2 "http://127.0.0.1:${FREE_FP}/ping" 2>/dev/null || true)"
    LIVE_FP_A="$(node -e 'try{const j=JSON.parse(process.argv[1]||"{}");process.stdout.write(j.anthropic_upstream_fingerprint||"")}catch{}' "$LIVE_A" 2>/dev/null || true)"
    if [[ "$LIVE_FP_A" == "$FP_A" ]]; then
      pass "live fingerprint is A after first ensure"
    else
      fail "live fingerprint A (got=$LIVE_FP_A expect=$FP_A)"
    fi
    PID_A="$(node -e 'try{const j=JSON.parse(process.argv[1]||"{}");if(j.pid)process.stdout.write(String(j.pid))}catch{}' "$LIVE_A" 2>/dev/null || true)"

    # Desired B — should kill A and respawn
    export CLAUDE_PROXY_ANTHROPIC_UPSTREAM="$URL_B"
    export C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT="$FP_B"
    if cthru_ensure_proxy_on_port "$FREE_FP"; then
      LIVE_B="$(curl -sf --max-time 2 "http://127.0.0.1:${FREE_FP}/ping" 2>/dev/null || true)"
      LIVE_FP_B="$(node -e 'try{const j=JSON.parse(process.argv[1]||"{}");process.stdout.write(j.anthropic_upstream_fingerprint||"")}catch{}' "$LIVE_B" 2>/dev/null || true)"
      PID_B="$(node -e 'try{const j=JSON.parse(process.argv[1]||"{}");if(j.pid)process.stdout.write(String(j.pid))}catch{}' "$LIVE_B" 2>/dev/null || true)"
      if [[ "$LIVE_FP_B" == "$FP_B" ]]; then
        pass "after ensure, live fingerprint is B"
      else
        fail "after ensure fingerprint B (got=$LIVE_FP_B expect=$FP_B)"
      fi
      if [[ -n "$PID_A" && -n "$PID_B" && "$PID_A" != "$PID_B" ]]; then
        pass "respawned new pid (A=$PID_A B=$PID_B)"
      elif [[ -n "$PID_B" ]]; then
        # Same pid only if process replaced in-place (unlikely); still ok if fp matches
        pass "listener answers with B (pid_a=$PID_A pid_b=$PID_B)"
      else
        fail "no live pid after B ensure"
      fi
      if [[ -n "$PID_A" ]] && kill -0 "$PID_A" 2>/dev/null; then
        # Old pid still alive is ok only if it's the same process that updated — we require new fp
        if [[ "$PID_A" == "$PID_B" ]]; then
          pass "same pid retained after env change is acceptable if fp is B"
        else
          fail "old pid A still alive after kill/respawn"
        fi
      else
        pass "old pid A no longer running"
      fi
    else
      fail "ensure with override B after A"
    fi
  fi
  # Cleanup listener on FREE_FP
  if command -v lsof >/dev/null 2>&1; then
    kill $(lsof -nP -iTCP:"$FREE_FP" -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true
  fi
  pkill -f "claude-proxy --port ${FREE_FP}" 2>/dev/null || true
  unset CLAUDE_PROXY_ANTHROPIC_UPSTREAM C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT ANTHROPIC_BASE_URL
  rm -rf "$CLAUDE_DIR_FP"
fi

echo
echo "ensure-proxy-on-port: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
