#!/usr/bin/env bash
# Regression test for tools/c-thru-ollama-gc.sh's sweep/purge state-tracking
# invariants. This script had zero test coverage before 4 real bugs were found
# and fixed in it in one review pass:
#   - sweep untracked a model from state even when it was only PREVIEWED
#     (C_THRU_OLLAMA_ALLOW_RM unset), not actually removed.
#   - purge unconditionally wiped the whole state.installed map regardless of
#     whether C_THRU_OLLAMA_ALLOW_RM was set (uninstall.sh's real --purge-models
#     path never sets it, so this fired on every real purge).
#   - the referenced-set extraction still walked the OLD tier-outer
#     connected_model/disconnect_model schema; against the current
#     capability-outer llm_profiles[capability][mode][tier] schema it always
#     computed an empty referenced set, which trips the "abort on parse
#     regression" guard — sweep could never actually run against a real config.
#   - sweep's referenced set ignored a project-scoped .claude/model-map.json.
# This test locks in the fixed behavior so none of the four can silently regress.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GC="$REPO_DIR/tools/c-thru-ollama-gc.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/c-thru-gc-test.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

# Fake `ollama` binary: `list` always succeeds (server "reachable"); `rm <model>`
# succeeds only for models named in $FAKE_OLLAMA_RM_OK (space-separated), fails
# for everything else — lets us simulate partial-success purge/sweep runs.
FAKE_BIN="$BASE/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/ollama" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  list) exit 0 ;;
  rm)
    for ok in ${FAKE_OLLAMA_RM_OK:-}; do
      [ "$ok" = "$2" ] && exit 0
    done
    exit 1
    ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/ollama"

run_gc() {  # profile_dir, subcommand, [args...] -- env: FAKE_OLLAMA_RM_OK, C_THRU_OLLAMA_ALLOW_RM
  local profile="$1"; shift
  PATH="$FAKE_BIN:$PATH" CLAUDE_DIR="$profile" bash "$GC" "$@" 2>&1
}

installed_json() {  # profile_dir -> prints state.installed keys, sorted, newline-joined
  node -e '
    const fs = require("fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(Object.keys(s.installed || {}).sort().join(","));
    } catch { console.log("<unreadable>"); }
  ' "$1/c-thru-ollama-models.json"
}

seed_state() {  # profile_dir, model1 [model2...]
  local profile="$1"; shift
  node -e '
    const fs = require("fs");
    const [, sf, ...models] = process.argv;
    const installed = {};
    for (const m of models) installed[m] = { pulled_at: 1700000000, source: "proxy", backend_url: "http://localhost:11434" };
    fs.writeFileSync(sf, JSON.stringify({ version: 1, installed }, null, 2) + "\n");
  ' "$profile/c-thru-ollama-models.json" "$@"
}

# A realistic capability-outer model-map (current schema) with two capabilities:
# one referencing "kept-model" (flat string, all tiers) and one referencing
# "kept-model-2" only at 64gb (tier-keyed object). Neither references
# "orphan-model" anywhere.
write_model_map() {  # profile_dir
  cat > "$1/model-map.json" <<'MAPEOF'
{
  "llm_profiles": {
    "workhorse": {
      "best-cloud": "kept-model",
      "on_failure": "cascade"
    },
    "judge": {
      "best-cloud-oss": { "64gb": "kept-model-2", "128gb": "kept-model-2" },
      "fallback_to": "workhorse"
    }
  }
}
MAPEOF
}

# ── 1. sweep referenced-set: correctly computed against the CURRENT schema ──
echo "1. sweep computes a non-empty referenced set against the current capability-outer schema"
{
  P="$BASE/p1"; mkdir -p "$P"
  write_model_map "$P"
  seed_state "$P" "orphan-model"
  out="$(run_gc "$P" sweep --dry-run)"
  if echo "$out" | grep -q "ABORT"; then
    fail "sweep did not abort with 'parse regression' on a real capability-outer config (got: $out)"
  else
    pass "sweep ran without the parse-regression abort"
  fi
  if echo "$out" | grep -q "would remove: orphan-model"; then
    pass "orphan-model (unreferenced) correctly flagged as a dry-run candidate"
  else
    fail "orphan-model should have been flagged as unreferenced (got: $out)"
  fi
}

# ── 2. sweep (default, no ALLOW_RM): preview-only, state untouched ──────────
echo ""
echo "2. sweep without C_THRU_OLLAMA_ALLOW_RM only previews — state stays tracked"
{
  P="$BASE/p2"; mkdir -p "$P"
  write_model_map "$P"
  seed_state "$P" "orphan-model" "kept-model"
  run_gc "$P" sweep >/dev/null
  after="$(installed_json "$P")"
  if [ "$after" = "kept-model,orphan-model" ]; then
    pass "state.installed unchanged after a preview-only sweep (orphan-model NOT silently untracked)"
  else
    fail "state.installed should be unchanged (got: $after)"
  fi
}

# ── 3. sweep with ALLOW_RM=1: orphan actually removed AND untracked ─────────
echo ""
echo "3. sweep with C_THRU_OLLAMA_ALLOW_RM=1 removes and untracks only the orphan"
{
  P="$BASE/p3"; mkdir -p "$P"
  write_model_map "$P"
  seed_state "$P" "orphan-model" "kept-model"
  FAKE_OLLAMA_RM_OK="orphan-model" C_THRU_OLLAMA_ALLOW_RM=1 CLAUDE_DIR="$P" PATH="$FAKE_BIN:$PATH" bash "$GC" sweep >/dev/null 2>&1
  after="$(installed_json "$P")"
  if [ "$after" = "kept-model" ]; then
    pass "orphan-model removed + untracked; kept-model still tracked"
  else
    fail "expected only 'kept-model' left tracked (got: $after)"
  fi
}

# ── 4. purge (default, no ALLOW_RM): state left completely untouched ───────
echo ""
echo "4. purge without C_THRU_OLLAMA_ALLOW_RM leaves state.installed untouched"
{
  P="$BASE/p4"; mkdir -p "$P"
  seed_state "$P" "model-a" "model-b"
  run_gc "$P" purge >/dev/null
  after="$(installed_json "$P")"
  if [ "$after" = "model-a,model-b" ]; then
    pass "state.installed unchanged after a preview-only purge (not silently wiped)"
  else
    fail "state.installed should still list both models (got: $after)"
  fi
}

# ── 5. purge with ALLOW_RM=1: only successfully-removed models are untracked ─
echo ""
echo "5. purge with C_THRU_OLLAMA_ALLOW_RM=1 untracks only models actually removed"
{
  P="$BASE/p5"; mkdir -p "$P"
  seed_state "$P" "removable-model" "stuck-model"
  FAKE_OLLAMA_RM_OK="removable-model" C_THRU_OLLAMA_ALLOW_RM=1 CLAUDE_DIR="$P" PATH="$FAKE_BIN:$PATH" bash "$GC" purge >/dev/null 2>&1
  after="$(installed_json "$P")"
  if [ "$after" = "stuck-model" ]; then
    pass "removable-model untracked; stuck-model (rm failed) stays tracked"
  else
    fail "expected only 'stuck-model' left tracked (got: $after)"
  fi
}

# ── 6. sweep referenced-set is unioned with a project-scoped model-map ──────
echo ""
echo "6. sweep spares a model referenced only by a project-local .claude/model-map.json"
{
  P="$BASE/p6"; mkdir -p "$P"
  write_model_map "$P"   # profile map references kept-model / kept-model-2 only
  PROJECT="$BASE/p6-project"
  mkdir -p "$PROJECT/.claude"
  cat > "$PROJECT/.claude/model-map.json" <<'MAPEOF'
{ "llm_profiles": { "coder": { "best-cloud": "project-only-model" } } }
MAPEOF
  seed_state "$P" "project-only-model"
  out="$(cd "$PROJECT" && PATH="$FAKE_BIN:$PATH" CLAUDE_DIR="$P" bash "$GC" sweep --dry-run 2>&1)"
  if echo "$out" | grep -q "would remove: project-only-model"; then
    fail "project-only-model should be spared (referenced by the project-local config), but sweep flagged it"
  else
    pass "project-only-model correctly spared (not flagged as an orphan)"
  fi
}

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "$PASS/$((PASS+FAIL)) passed — $FAIL FAILED"
else
  echo "$PASS/$((PASS+FAIL)) passed"
fi
[ "$FAIL" -eq 0 ]
