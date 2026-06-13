#!/usr/bin/env bash
# Regression test for the first-run seeding block in tools/c-thru-session-start.sh
# (lines ~18-56): the highest-side-effect shell block in the repo — it seeds 3
# model-map files, spawns a proxy via nohup, and writes ANTHROPIC_BASE_URL into
# settings.json — and had zero coverage (install-smoke checks executability only).
#
# Recipe per self-update-divergence.test.sh: mktemp -d BASE, fixture per scenario.
#   - session-start derives ROUTER_REPO_ROOT from its own location, so it IS
#     copied into <scratch>/tools/. <scratch>/config/model-map.json is a tiny
#     sentinel so seeded copies are cmp-distinguishable from the real config.
#   - NO tools/claude-proxy in the scratch → the nohup spawn is skipped by its
#     own [ -f ] gate (proxy.plugin.log absent is the proof). No process leaks.
#   - Isolation is by REMOVAL, not blanking: env -u strips the proxy/Ollama vars
#     so the hook exits at its port gate right after the seeding block — Checks
#     1-4, ollama-gc, and `ollama list` are never reached, and the real ~/.claude
#     is provably untouched (fresh CLAUDE_PROFILE_DIR tmp per scenario).
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

# ── Fixture: scratch repo with ONLY the hook + a sentinel bundled config ──────
SCRATCH="$BASE/scratch"
mkdir -p "$SCRATCH/tools" "$SCRATCH/config"
cp "$REPO_DIR/tools/c-thru-session-start.sh" "$SCRATCH/tools/"
# The hook sources $ROUTER_REPO_ROOT/tools/c-thru-lib.sh for its port ladder —
# co-locate it so the hook exercises its real path to the port gate.
cp "$REPO_DIR/tools/c-thru-lib.sh" "$SCRATCH/tools/"
printf '{"sentinel":"seeding-test"}\n' > "$SCRATCH/config/model-map.json"
SENTINEL="$SCRATCH/config/model-map.json"

run_hook() {  # $1 = profile dir → sets HOOK_EC, HOOK_STDERR
  HOOK_EC=0
  HOOK_STDERR="$(env -u ANTHROPIC_BASE_URL -u CLAUDE_PROXY_PORT \
    -u OLLAMA_URL -u OLLAMA_BASE_URL -u CLAUDE_CONFIG_DIR -u CLAUDE_DIR \
    CLAUDE_PROFILE_DIR="$1" C_THRU_PLUGIN_PORT=10017 \
    bash "$SCRATCH/tools/c-thru-session-start.sh" 2>&1 >/dev/null)" || HOOK_EC=$?
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

# ── a: first run, settings.json {} → seed maps + register base URL ───────────
echo "a. first run + empty settings.json: seeds 3 maps, registers ANTHROPIC_BASE_URL"
{
  P="$BASE/profile-a"; mkdir -p "$P"
  printf '{}\n' > "$P/settings.json"
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
  [[ "$(json_get "$P/settings.json" env.ANTHROPIC_BASE_URL)" == "http://127.0.0.1:10017" ]] \
    && pass "settings.json env.ANTHROPIC_BASE_URL = http://127.0.0.1:10017" \
    || fail "settings.json env.ANTHROPIC_BASE_URL = http://127.0.0.1:10017 (got: $(json_get "$P/settings.json" env.ANTHROPIC_BASE_URL))"
  check_contains "stderr carries the registration notice" \
    "routing registered on port 10017" "$HOOK_STDERR"
  [[ ! -f "$P/proxy.plugin.log" ]] \
    && pass "no proxy spawned (no tools/claude-proxy in scratch)" \
    || fail "no proxy spawned (proxy.plugin.log exists)"
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
  run_hook "$P"
  [[ $HOOK_EC -eq 0 ]] && pass "exits 0" || fail "exits 0 (got $HOOK_EC)"
  [[ "$(cat "$P/model-map.overrides.json")" == "$ovr_before" ]] \
    && pass "mutated overrides survive byte-identical" \
    || fail "mutated overrides survive byte-identical"
  [[ "$(cat "$P/model-map.json")" == "$eff_before" ]] \
    && pass "mutated effective map survives byte-identical" \
    || fail "mutated effective map survives byte-identical"
  check_absent "no re-registration notice" "routing registered" "$HOOK_STDERR"
}

# ── c: no settings.json → maps seeded, settings NOT created ──────────────────
echo ""
echo "c. first run, no settings.json: maps seeded, settings stays absent"
{
  P="$BASE/profile-c"; mkdir -p "$P"
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
}

# ── d: ANTHROPIC_BASE_URL already in settings.json → preserved verbatim ──────
echo ""
echo "d. first run, settings.json already routes elsewhere: preserved verbatim"
{
  P="$BASE/profile-d"; mkdir -p "$P"
  printf '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://sentinel.example:9999"\n  }\n}\n' > "$P/settings.json"
  settings_before="$(cat "$P/settings.json")"
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
}

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[[ "$FAIL" -eq 0 ]]
