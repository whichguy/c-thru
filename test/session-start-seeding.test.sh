#!/usr/bin/env bash
# Regression test for the first-run seeding block in tools/c-thru-session-start.sh
# (lines ~18-56): the highest-side-effect shell block in the repo — it seeds 3
# model-map files, conditionally spawns a proxy via nohup, and conditionally
# writes ANTHROPIC_BASE_URL into settings.json.
#
# Recipe per self-update-divergence.test.sh: mktemp -d BASE, fixture per scenario.
#   - session-start derives ROUTER_REPO_ROOT from its own location, so it IS
#     copied into <scratch>/tools/. <scratch>/config/model-map.json is a tiny
#     sentinel so seeded copies are cmp-distinguishable from the real config.
#   - A fake node wrapper records plugin-proxy spawn attempts and exits
#     immediately. Real node still handles hook JSON work. No process leaks.
#   - Isolation is by REMOVAL, not blanking: env -u strips the proxy/Ollama vars
#     so the hook exits at its port gate right after the seeding block — Checks
#     1-4, ollama-gc, and `ollama list` are never reached, and the real ~/.claude
#     is provably untouched (fresh CLAUDE_PROFILE_DIR tmp per scenario).
#   - Selector scenarios add exactly one active launcher selector after that
#     cleanup. Maps must seed, but fixed-port spawn/settings writes must not run.
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
check_absent() {  # label, needle, haystack
  if printf '%s' "$3" | grep -qF "$2"; then
    fail "$1 (unexpectedly present: $2)"
    printf '%s\n' "$3" | sed 's/^/        /'
  else pass "$1"; fi
}

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-seeding.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

# ── Fixture: scratch repo, sentinel config, and recorded fake proxy spawn ─────
SCRATCH="$BASE/scratch"
FAKE_BIN="$BASE/fake-bin"
SPAWN_MARKER="$BASE/plugin-proxy-spawns"
REAL_NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$REAL_NODE_BIN" ]]; then
  echo "FAIL  session-start-seeding requires node"
  exit 1
fi
mkdir -p "$SCRATCH/tools" "$SCRATCH/config" "$FAKE_BIN"
cp "$REPO_DIR/tools/c-thru-session-start.sh" "$SCRATCH/tools/"
# The hook sources $ROUTER_REPO_ROOT/tools/c-thru-lib.sh for its port ladder —
# co-locate it so the hook exercises its real path to the port gate.
cp "$REPO_DIR/tools/c-thru-lib.sh" "$SCRATCH/tools/"
printf '{"sentinel":"seeding-test"}\n' > "$SCRATCH/config/model-map.json"
# Presence passes the hook's production [ -f "$_proxy_bin" ] gate. The fake
# node wrapper records this exact argv and exits before any server can start.
printf '// intercepted by test/fake-bin/node\n' > "$SCRATCH/tools/claude-proxy"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -u' \
  'if [[ "${1:-}" == */tools/claude-proxy ]]; then' \
  '  printf "%s\n" "$*" >> "$C_THRU_TEST_SPAWN_MARKER"' \
  '  exit 0' \
  'fi' \
  'exec "$C_THRU_TEST_REAL_NODE" "$@"' \
  > "$FAKE_BIN/node"
chmod +x "$FAKE_BIN/node"
SENTINEL="$SCRATCH/config/model-map.json"

spawn_attempt_count() {
  if [[ -f "$SPAWN_MARKER" ]]; then
    wc -l < "$SPAWN_MARKER" | tr -d ' '
  else
    printf '0'
  fi
}

wait_for_spawn_count() {  # $1 = expected count
  local expected="$1" i
  for ((i=0; i<50; i++)); do
    [[ "$(spawn_attempt_count)" == "$expected" ]] && return 0
    sleep 0.02
  done
  return 1
}

run_hook() {  # $1 profile, $2 optional stdin; remaining args are selector KEY=VALUE pairs
  local profile="$1" payload=""
  shift
  if [[ $# -gt 0 ]]; then
    payload="$1"
    shift
  fi
  HOOK_EC=0
  if [ -n "$payload" ]; then
    HOOK_STDERR="$(printf '%s' "$payload" | env -u ANTHROPIC_BASE_URL -u CLAUDE_PROXY_PORT \
      -u PROXY_PORT \
      -u OLLAMA_URL -u OLLAMA_BASE_URL -u CLAUDE_CONFIG_DIR -u CLAUDE_DIR \
      PATH="$FAKE_BIN:$PATH" \
      CLAUDE_PROFILE_DIR="$profile" C_THRU_PLUGIN_PORT=10017 C_THRU_NO_RESURRECT=1 \
      C_THRU_TEST_PROXY_BIN="$SCRATCH/tools/claude-proxy" \
      C_THRU_TEST_REAL_NODE="$REAL_NODE_BIN" C_THRU_TEST_SPAWN_MARKER="$SPAWN_MARKER" \
      "$@" \
      bash "$SCRATCH/tools/c-thru-session-start.sh" 2>&1 >/dev/null)" || HOOK_EC=$?
  else
    HOOK_STDERR="$(env -u ANTHROPIC_BASE_URL -u CLAUDE_PROXY_PORT \
      -u PROXY_PORT \
      -u OLLAMA_URL -u OLLAMA_BASE_URL -u CLAUDE_CONFIG_DIR -u CLAUDE_DIR \
      PATH="$FAKE_BIN:$PATH" \
      CLAUDE_PROFILE_DIR="$profile" C_THRU_PLUGIN_PORT=10017 C_THRU_NO_RESURRECT=1 \
      C_THRU_TEST_PROXY_BIN="$SCRATCH/tools/claude-proxy" \
      C_THRU_TEST_REAL_NODE="$REAL_NODE_BIN" C_THRU_TEST_SPAWN_MARKER="$SPAWN_MARKER" \
      "$@" \
      bash "$SCRATCH/tools/c-thru-session-start.sh" </dev/null 2>&1 >/dev/null)" || HOOK_EC=$?
  fi
}

json_get() {  # $1 = file, $2 = dotted path → prints value or ""
  node -e "
    try {
      let v = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      for (const k of process.argv[2].split('.')) v = v?.[k];
      process.stdout.write(v == null ? '' : String(v));
    } catch (e) {}
  " "$1" "$2"
}

echo "0. source/plugin parity"
cmp -s "$REPO_DIR/tools/c-thru-session-start.sh" \
       "$REPO_DIR/plugins/c-thru/hooks/c-thru-session-start.sh" \
  && pass "source and plugin SessionStart hooks are byte-identical" \
  || fail "source and plugin SessionStart hooks are byte-identical"

# Shape C default (no C_THRU_PLUGIN_LITE): seed maps only — never durable base URL.
# ── a: first run, settings.json {} → seed maps, no register ─────────────────
echo "a. first run + empty settings.json: seeds 3 maps, no durable ANTHROPIC_BASE_URL (Shape C)"
{
  P="$BASE/profile-a"; mkdir -p "$P"
  printf '{}\n' > "$P/settings.json"
  spawns_before="$(spawn_attempt_count)"
  run_hook "$P"
  [[ $HOOK_EC -eq 0 ]] && pass "exits 0" || fail "exits 0 (got $HOOK_EC)"
  cmp -s "$SENTINEL" "$P/model-map.system.json" \
    && pass "model-map.system.json seeded from bundled config" \
    || fail "model-map.system.json seeded from bundled config"
  cmp -s "$SENTINEL" "$P/model-map.json" \
    && pass "model-map.json (effective) seeded from bundled config" \
    || fail "model-map.json (effective) seeded from bundled config"
  [[ "$(cat "$P/model-map.overrides.json" 2>/dev/null)" == "{}" ]] \
    && pass "model-map.overrides.json seeded as {}" \
    || fail "model-map.overrides.json seeded as {}"
  [[ -z "$(json_get "$P/settings.json" env.ANTHROPIC_BASE_URL)" ]] \
    && pass "settings.json has no durable ANTHROPIC_BASE_URL without LITE" \
    || fail "settings.json has no durable ANTHROPIC_BASE_URL without LITE (got: $(json_get "$P/settings.json" env.ANTHROPIC_BASE_URL))"
  check_absent "no registration notice without LITE" \
    "routing registered" "$HOOK_STDERR"
  sleep 0.05
  [[ "$(spawn_attempt_count)" == "$spawns_before" ]] \
    && pass "ordinary first run does not spawn fixed-port proxy without LITE" \
    || fail "ordinary first run does not spawn fixed-port proxy without LITE (got $(spawn_attempt_count))"
  [[ ! -e "$P/proxy.plugin.log" ]] \
    && pass "ordinary first run does not open proxy.plugin.log without LITE" \
    || fail "ordinary first run does not open proxy.plugin.log without LITE"
  [[ ! -e "$P/.c-thru-plugin-setup-pending" ]] \
    && pass "no durable-setup pending marker without LITE" \
    || fail "no durable-setup pending marker without LITE"
}

# ── b: second run is a no-op — user-mutated maps survive byte-identical ──────
echo ""
echo "b. second run: seeding block skipped, mutated maps untouched"
{
  P="$BASE/profile-a"  # reuse scenario a's already-seeded profile
  printf '{"self_update":false}\n' > "$P/model-map.overrides.json"
  printf '{"sentinel":"user-edited"}\n' > "$P/model-map.json"
  ovr_before="$(cat "$P/model-map.overrides.json")"
  eff_before="$(cat "$P/model-map.json")"
  spawns_before="$(spawn_attempt_count)"
  run_hook "$P"
  [[ $HOOK_EC -eq 0 ]] && pass "exits 0" || fail "exits 0 (got $HOOK_EC)"
  [[ "$(cat "$P/model-map.overrides.json")" == "$ovr_before" ]] \
    && pass "mutated overrides survive byte-identical" \
    || fail "mutated overrides survive byte-identical"
  [[ "$(cat "$P/model-map.json")" == "$eff_before" ]] \
    && pass "mutated effective map survives byte-identical" \
    || fail "mutated effective map survives byte-identical"
  check_absent "no re-registration notice" "routing registered" "$HOOK_STDERR"
  [[ "$(spawn_attempt_count)" == "$spawns_before" ]] \
    && pass "second run makes no additional spawn attempt" \
    || fail "second run makes no additional spawn attempt"
}

# ── c: no settings.json → maps seeded, settings NOT created ──────────────────
echo ""
echo "c. first run, no settings.json: maps seeded, settings stays absent"
{
  P="$BASE/profile-c"; mkdir -p "$P"
  spawns_before="$(spawn_attempt_count)"
  run_hook "$P"
  [[ $HOOK_EC -eq 0 ]] && pass "exits 0" || fail "exits 0 (got $HOOK_EC)"
  cmp -s "$SENTINEL" "$P/model-map.system.json" \
    && pass "model-map.system.json seeded" \
    || fail "model-map.system.json seeded"
  [[ ! -f "$P/settings.json" ]] \
    && pass "settings.json not created" \
    || fail "settings.json not created"
  check_absent "no registration notice without settings.json" \
    "routing registered" "$HOOK_STDERR"
  sleep 0.05
  [[ "$(spawn_attempt_count)" == "$spawns_before" ]] \
    && pass "no spawn without settings.json and without LITE" \
    || fail "no spawn without settings.json and without LITE"
}

# ── d: ANTHROPIC_BASE_URL already in settings.json → preserved verbatim ──────
echo ""
echo "d. first run, settings.json already routes elsewhere: preserved verbatim"
{
  P="$BASE/profile-d"; mkdir -p "$P"
  printf '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://sentinel.example:9999"\n  }\n}\n' > "$P/settings.json"
  settings_before="$(cat "$P/settings.json")"
  spawns_before="$(spawn_attempt_count)"
  run_hook "$P"
  [[ $HOOK_EC -eq 0 ]] && pass "exits 0" || fail "exits 0 (got $HOOK_EC)"
  cmp -s "$SENTINEL" "$P/model-map.system.json" \
    && pass "model-map.system.json still seeded" \
    || fail "model-map.system.json still seeded"
  [[ "$(cat "$P/settings.json")" == "$settings_before" ]] \
    && pass "settings.json preserved verbatim" \
    || fail "settings.json preserved verbatim"
  check_absent "no registration notice when base URL pre-set" \
    "routing registered" "$HOOK_STDERR"
  sleep 0.05
  [[ "$(spawn_attempt_count)" == "$spawns_before" ]] \
    && pass "no spawn when settings already have base URL (no LITE)" \
    || fail "no spawn when settings already have base URL (no LITE)"
}

echo ""
echo "e. first run with session_id on stdin: still no durable URL without LITE"
{
  P="$BASE/profile-e"; mkdir -p "$P"
  printf '{}\n' > "$P/settings.json"
  spawns_before="$(spawn_attempt_count)"
  run_hook "$P" '{"session_id":"scenario-e-sess"}'
  [[ $HOOK_EC -eq 0 ]] && pass "exits 0" || fail "exits 0 (got $HOOK_EC)"
  [[ -z "$(json_get "$P/settings.json" env.ANTHROPIC_BASE_URL)" ]] \
    && pass "session_id path does not write durable ANTHROPIC_BASE_URL without LITE" \
    || fail "session_id path does not write durable ANTHROPIC_BASE_URL without LITE"
  sleep 0.05
  [[ "$(spawn_attempt_count)" == "$spawns_before" ]] \
    && pass "session_id path does not spawn without LITE" \
    || fail "session_id path does not spawn without LITE"
}

# ── f: launcher selectors + maps seed; no durable without LITE ───────────────
echo ""
echo "f. launcher selector: maps seed; no fixed spawn/settings (Shape C default)"
for selector_name in ANTHROPIC_BASE_URL CLAUDE_PROXY_PORT PROXY_PORT; do
  P="$BASE/profile-f-${selector_name}"; mkdir -p "$P"
  printf '{\n  "sentinel": "settings-must-stay-byte-identical"\n}\n' > "$P/settings.json"
  settings_before="$(cat "$P/settings.json")"
  spawns_before="$(spawn_attempt_count)"
  case "$selector_name" in
    ANTHROPIC_BASE_URL)
      selector_value="ANTHROPIC_BASE_URL=http://127.0.0.1:1/s/launcher-owned"
      ;;
    CLAUDE_PROXY_PORT)
      selector_value="CLAUDE_PROXY_PORT=1"
      ;;
    PROXY_PORT)
      selector_value="PROXY_PORT=1"
      ;;
  esac
  run_hook "$P" '' "$selector_value"
  [[ $HOOK_EC -eq 0 ]] \
    && pass "$selector_name: exits 0" \
    || fail "$selector_name: exits 0 (got $HOOK_EC)"
  cmp -s "$SENTINEL" "$P/model-map.system.json" \
    && pass "$selector_name: model-map.system.json still seeded" \
    || fail "$selector_name: model-map.system.json still seeded"
  [[ "$(cat "$P/settings.json")" == "$settings_before" ]] \
    && pass "$selector_name: settings.json remains byte-identical" \
    || fail "$selector_name: settings.json remains byte-identical"
  check_absent "$selector_name: no fixed-port registration notice" \
    "routing registered" "$HOOK_STDERR"
  sleep 0.05
  [[ "$(spawn_attempt_count)" == "$spawns_before" ]] \
    && pass "$selector_name: zero fixed-port proxy spawn attempts" \
    || fail "$selector_name: zero fixed-port proxy spawn attempts"
  [[ ! -e "$P/.c-thru-plugin-setup-pending" ]] \
    && pass "$selector_name: no durable pending without LITE" \
    || fail "$selector_name: no durable pending without LITE"
done

# ── g: LITE mode still durable-registers on first run ────────────────────────
echo ""
echo "g. C_THRU_PLUGIN_LITE=1: first run registers durable loopback + spawn"
{
  P="$BASE/profile-lite"; mkdir -p "$P"
  printf '{}\n' > "$P/settings.json"
  spawns_before="$(spawn_attempt_count)"
  run_hook "$P" '' C_THRU_PLUGIN_LITE=1
  [[ $HOOK_EC -eq 0 ]] && pass "LITE exits 0" || fail "LITE exits 0 (got $HOOK_EC)"
  [[ "$(json_get "$P/settings.json" env.ANTHROPIC_BASE_URL)" == "http://127.0.0.1:10017" ]] \
    && pass "LITE writes env.ANTHROPIC_BASE_URL = http://127.0.0.1:10017" \
    || fail "LITE writes env.ANTHROPIC_BASE_URL (got: $(json_get "$P/settings.json" env.ANTHROPIC_BASE_URL))"
  check_contains "LITE registration notice" "routing registered on port 10017" "$HOOK_STDERR"
  expected_spawns=$((spawns_before+1))
  wait_for_spawn_count "$expected_spawns" \
    && pass "LITE attempts one fixed-port plugin proxy spawn" \
    || fail "LITE spawn (got $(spawn_attempt_count), expected $expected_spawns)"
}

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[[ "$FAIL" -eq 0 ]]
