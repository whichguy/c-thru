#!/usr/bin/env bash
# Part-2 contract: tools/c-thru-session-start.sh is the SINGLE canonical injector
# of the proxy's control-plane block. It curls POST /hooks/context and prepends
# the returned additionalContext to its emitted SessionStart context — in BOTH
# launch modes (this is the gap plugin mode never had).
#
# Recipe mirrors session-start-seeding.test.sh: a scratch repo holding ONLY the
# hook (so the first-run seeding / pollution / git-divergence checks are all inert
# — no config dir, no model-map-config.js, not a git checkout), plus a tiny node
# stub HTTP server standing in for the proxy. The stub answers /ping (so no
# "proxy down" advisory) and POST /hooks/context (the canonical block, built from
# the stub's own port). We then assert the merged additionalContext carries the
# proxy base URL + all three endpoints, AND that the block appears exactly once
# (the local tier/mode line was dropped — no double injection).
#
# JSON asserts use node -e (no jq) so run-all registers this unconditionally.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-injection.XXXXXX")"
STUB_PID=""
SLOW_PID=""
cleanup() {
  [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null
  [[ -n "$SLOW_PID" ]] && kill "$SLOW_PID" 2>/dev/null
  rm -rf "$BASE"
}
trap cleanup EXIT

# ── Scratch repo: ONLY the hook (seeding/pollution/git checks all skip) ───────
SCRATCH="$BASE/scratch"
mkdir -p "$SCRATCH/tools"
cp "$REPO_DIR/tools/c-thru-session-start.sh" "$SCRATCH/tools/"
PROFILE="$BASE/profile"; mkdir -p "$PROFILE"

# ── Stub proxy: /ping + POST /hooks/context (canonical block on its own port) ──
cat > "$BASE/stub.js" <<'JS'
const http = require('http');
const srv = http.createServer((req, res) => {
  const p = srv.address().port;
  if (req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, active_tier: 'stub-tier', active_mode: 'connected' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/hooks/context') {
    const block = [
      `(c-thru) proxy control plane: http://127.0.0.1:${p} — query with curl:`,
      `  GET /c-thru/status (routes, per-model usage, cooldowns)`,
      `  GET /c-thru/recent?n=N (recent requests: served model, tokens, latency, errors)`,
      `  GET /c-thru/dashboard (live HTML stats — open in a browser)`,
      `Profile: stub-tier, Mode: connected. Dashboard: http://127.0.0.1:${p}/c-thru/dashboard`,
    ].join('\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: block } }));
    return;
  }
  res.writeHead(404); res.end('{}');
});
srv.listen(0, '127.0.0.1', () => { process.stdout.write(String(srv.address().port) + '\n'); });
JS

node "$BASE/stub.js" > "$BASE/port" 2>"$BASE/stub.err" &
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true  # silence the job-control "Terminated" notice at cleanup
for _ in $(seq 1 50); do [ -s "$BASE/port" ] && break; sleep 0.1; done
PORT="$(sed -n '1p' "$BASE/port" 2>/dev/null)"
if [[ -z "$PORT" ]]; then
  fail "stub proxy started and printed a port"
  cat "$BASE/stub.err" 2>/dev/null | sed 's/^/        /'
  echo ""; echo "0/1 passed — 1 FAILED"; exit 1
fi
pass "stub proxy listening on :$PORT"

# ── Run the hook against the stub (plugin-mode shape: only ANTHROPIC_BASE_URL) ─
extract_addl() {  # stdin = hook JSON → additionalContext
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.hookSpecificOutput&&j.hookSpecificOutput.additionalContext)||'')}catch(e){process.exit(2)}})"
}

OUT="$(env -u OLLAMA_URL -u OLLAMA_BASE_URL -u CLAUDE_PROXY_PORT \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
  CLAUDE_PROFILE_DIR="$PROFILE" \
  bash "$SCRATCH/tools/c-thru-session-start.sh" 2>/dev/null)"; HOOK_EC=$?
[[ $HOOK_EC -eq 0 ]] && pass "hook exits 0" || fail "hook exits 0 (got $HOOK_EC)"

ADDL="$(printf '%s' "$OUT" | extract_addl)"

echo ""
echo "Merged additionalContext carries the proxy block:"
check_contains "proxy base URL present"  "http://127.0.0.1:$PORT" "$ADDL"
check_contains "lists /c-thru/status"    "/c-thru/status"          "$ADDL"
check_contains "lists /c-thru/recent"    "/c-thru/recent"          "$ADDL"
check_contains "lists /c-thru/dashboard" "/c-thru/dashboard"       "$ADDL"
check_contains "carries the dashboard_url" "http://127.0.0.1:$PORT/c-thru/dashboard" "$ADDL"

# No double-injection: the block's signature line appears exactly once.
n_block="$(printf '%s\n' "$ADDL" | grep -cF 'proxy control plane')"
[[ "$n_block" -eq 1 ]] \
  && pass "proxy block injected exactly once (no double-injection)" \
  || fail "proxy block injected exactly once (got $n_block occurrences)"

# ── B2: proxy DOWN (ANTHROPIC_BASE_URL → a closed port) ───────────────────────
# No block, a "proxy down" advisory, hook still exits 0. A just-released port is
# definitively closed (nothing in this test re-binds it), so the curls to /ping +
# /hooks/context both refuse instantly — proving resilience without a kill race.
echo ""
echo "B2: proxy down → no block, proxy-down advisory, hook exits 0"
CLOSED_PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))})")"
OUT_DOWN="$(env -u OLLAMA_URL -u OLLAMA_BASE_URL -u CLAUDE_PROXY_PORT \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$CLOSED_PORT" \
  CLAUDE_PROFILE_DIR="$PROFILE" \
  bash "$SCRATCH/tools/c-thru-session-start.sh" 2>/dev/null)"; DOWN_EC=$?
[[ $DOWN_EC -eq 0 ]] && pass "hook exits 0 when proxy is down" || fail "hook exits 0 when proxy is down (got $DOWN_EC)"
ADDL_DOWN="$(printf '%s' "$OUT_DOWN" | extract_addl)"
if printf '%s' "$ADDL_DOWN" | grep -qF 'proxy control plane'; then
  fail "no proxy block when proxy is down"
  printf '%s\n' "$ADDL_DOWN" | sed 's/^/        /'
else
  pass "no proxy block when proxy is down"
fi
check_contains "proxy-down advisory present" "proxy down on :$CLOSED_PORT" "$ADDL_DOWN"

# ── B3: proxy UP + a local advisory (Ollama down) — block AND advisory, block first ──
# OLLAMA_URL points at the same closed port → Check-2 adds an "Ollama unreachable"
# advisory while the (real stub) proxy is up. The proxy block must come first.
echo ""
echo "B3: proxy up + advisory coexist — block present, advisory present, block first"
OUT_B3="$(env -u CLAUDE_PROXY_PORT \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
  OLLAMA_URL="http://127.0.0.1:$CLOSED_PORT" \
  CLAUDE_PROFILE_DIR="$PROFILE" \
  bash "$SCRATCH/tools/c-thru-session-start.sh" 2>/dev/null)"; B3_EC=$?
[[ $B3_EC -eq 0 ]] && pass "hook exits 0 (proxy up + advisory)" || fail "hook exits 0 (proxy up + advisory) (got $B3_EC)"
ADDL_B3="$(printf '%s' "$OUT_B3" | extract_addl)"
check_contains "B3: proxy block present"        "proxy control plane" "$ADDL_B3"
check_contains "B3: Ollama-down advisory present" "Ollama unreachable"  "$ADDL_B3"
b3_block_line="$(printf '%s\n' "$ADDL_B3" | grep -nF 'proxy control plane' | head -1 | cut -d: -f1)"
b3_adv_line="$(printf '%s\n' "$ADDL_B3" | grep -nF 'Ollama unreachable' | head -1 | cut -d: -f1)"
if [[ -n "$b3_block_line" && -n "$b3_adv_line" && "$b3_block_line" -lt "$b3_adv_line" ]]; then
  pass "B3: proxy block appears before the advisory (block first)"
else
  fail "B3: proxy block before advisory (block@${b3_block_line:-none} advisory@${b3_adv_line:-none})"
fi

# ── B4: node-fallback extraction (jq forced absent) yields the SAME block ─────
# Prepending an empty dir does NOT hide jq — `command -v jq` walks the whole
# PATH. We must run with a MINIMAL PATH that symlinks only the tools the hook
# uses (NOT jq), so `command -v jq` fails and the hook takes its node fallback.
echo ""
echo "B4: jq forced absent → node fallback extracts the same block"
NOJQ="$BASE/nojq-bin"; mkdir -p "$NOJQ"
for t in bash sh env curl node sed awk grep tr paste cut dirname readlink find git head ollama; do
  p="$(command -v "$t" 2>/dev/null || true)"
  [[ -n "$p" ]] && ln -sf "$p" "$NOJQ/$t"
done
if PATH="$NOJQ" command -v jq >/dev/null 2>&1; then
  fail "B4 setup: minimal PATH still exposes jq — cannot exercise the node fallback"
else
  pass "B4 setup: jq hidden under minimal PATH (node fallback will be taken)"
  OUT_NOJQ="$(env -u OLLAMA_URL -u OLLAMA_BASE_URL -u CLAUDE_PROXY_PORT \
    PATH="$NOJQ" \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
    CLAUDE_PROFILE_DIR="$PROFILE" \
    bash "$SCRATCH/tools/c-thru-session-start.sh" 2>/dev/null)"; NOJQ_EC=$?
  [[ $NOJQ_EC -eq 0 ]] && pass "hook exits 0 (node fallback path)" || fail "hook exits 0 (node fallback path) (got $NOJQ_EC)"
  ADDL_NOJQ="$(printf '%s' "$OUT_NOJQ" | extract_addl)"
  check_contains "node fallback extracts the proxy block" "proxy control plane"  "$ADDL_NOJQ"
  check_contains "node fallback carries the base URL"      "http://127.0.0.1:$PORT" "$ADDL_NOJQ"
fi
# If jq is present on this host, the normal-PATH B1 run above already exercised
# the jq extraction path — assert it produced the same block. (Skipped when the
# host has no jq: only the node fallback exists to test.)
if command -v jq >/dev/null 2>&1; then
  check_contains "jq path (normal-PATH B1 run) yields the same block" "proxy control plane" "$ADDL"
else
  echo "  SKIP  jq path assertion (jq absent on host — node fallback covered above)"
fi

# ── B5: /hooks/context delayed > 2s → hook honors --max-time 2 (bounded, no hang) ──
# A slow stub answers /ping instantly but stalls /hooks/context ~10s. The hook's
# `curl --max-time 2` must abort, drop the block, and still exit 0 quickly —
# proving a wedged proxy can't blow the 5s CLI hook budget.
echo ""
echo "B5: slow /hooks/context → hook completes within a bounded wall-time"
cat > "$BASE/stub-slow.js" <<'JS'
const http = require('http');
const srv = http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && req.url === '/hooks/context') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '(c-thru) proxy control plane: SLOW' } }));
    }, 10000);
    return;
  }
  res.writeHead(404); res.end('{}');
});
srv.listen(0, '127.0.0.1', () => { process.stdout.write(String(srv.address().port) + '\n'); });
JS
node "$BASE/stub-slow.js" > "$BASE/port-slow" 2>"$BASE/stub-slow.err" &
SLOW_PID=$!
disown "$SLOW_PID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$BASE/port-slow" ] && break; sleep 0.1; done
SLOW_PORT="$(sed -n '1p' "$BASE/port-slow" 2>/dev/null)"
if [[ -z "$SLOW_PORT" ]]; then
  fail "slow stub started and printed a port"
  cat "$BASE/stub-slow.err" 2>/dev/null | sed 's/^/        /'
else
  pass "slow stub listening on :$SLOW_PORT"
  SECONDS=0
  env -u OLLAMA_URL -u OLLAMA_BASE_URL -u CLAUDE_PROXY_PORT \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$SLOW_PORT" \
    CLAUDE_PROFILE_DIR="$PROFILE" \
    bash "$SCRATCH/tools/c-thru-session-start.sh" >/dev/null 2>&1; SLOW_EC=$?
  ELAPSED=$SECONDS
  [[ $SLOW_EC -eq 0 ]] && pass "hook exits 0 despite slow /hooks/context" || fail "hook exits 0 despite slow /hooks/context (got $SLOW_EC)"
  [[ $ELAPSED -lt 5 ]] \
    && pass "hook completes within bounded wall-time (${ELAPSED}s < 5s — proves --max-time 2)" \
    || fail "hook wall-time bounded (took ${ELAPSED}s, expected < 5s — possible hang)"
fi
kill "$SLOW_PID" 2>/dev/null || true; SLOW_PID=""

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[[ "$FAIL" -eq 0 ]]
