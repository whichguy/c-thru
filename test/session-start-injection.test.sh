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
cleanup() { [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null; rm -rf "$BASE"; }
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

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[[ "$FAIL" -eq 0 ]]
