#!/usr/bin/env bash
# Shell-level e2e tests for the _explain_all_json bash integration.
# Tests the jq projection contracts and cache behaviour that JS unit tests
# cannot reach. Does not source the full c-thru script — exercises the JS
# tool directly with a fixture config, then validates the same jq pipelines
# used by collect_active_profile_capability_assignments and
# collect_active_profile_local_ollama_models.
#
# Run: bash test/c-thru-explain-bash.test.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_DIR="$SCRIPT_DIR/../tools"
EXPLAIN_JS="$TOOLS_DIR/c-thru-explain.js"

PASS=0; FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1" >&2; FAIL=$((FAIL+1)); }

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass "$label"
  else fail "$label (expected '$expected', got '$actual')"; fi
}

check_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$label"
  else fail "$label (expected to contain '$needle', got '$haystack')"; fi
}

# ── Fixture config ──────────────────────────────────────────────────────────
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

FIXTURE_CONFIG="$TMPDIR_TEST/model-map.json"
cat > "$FIXTURE_CONFIG" <<'EOF'
{
  "endpoints": {
    "ollama_local": { "format": "anthropic", "url": "http://localhost:11434", "auth": "none" },
    "cloud_ep":     { "format": "anthropic", "url": "https://api.anthropic.com" }
  },
  "model_routes": {
    "local-model-a":  "ollama_local",
    "cloud-model-b":  "cloud_ep"
  },
  "llm_profiles": {
    "worker": {
      "best-cloud":     { "64gb": "cloud-model-b" },
      "best-local-oss": { "64gb": "local-model-a" }
    },
    "scout": {
      "best-cloud":     { "64gb": "local-model-a" },
      "best-local-oss": { "64gb": "local-model-a" }
    },
    "default": {
      "best-cloud":     { "64gb": "cloud-model-b" },
      "best-local-oss": { "64gb": "local-model-a" }
    }
  }
}
EOF

echo "c-thru-explain bash integration tests"
echo ""

# ── Helper: run c-thru-explain.js --all --format json with fixture ──────────
explain_all() {
  local profile="$1" mode="$2"
  CLAUDE_LLM_PROFILE="$profile" CLAUDE_LLM_MODE="$mode" \
    CLAUDE_MODEL_MAP_PATH="$FIXTURE_CONFIG" \
    node "$EXPLAIN_JS" --all --format json 2>/dev/null
}

# ── 1: JSON output is valid and contains expected capabilities ──────────────
echo "1. --all --format json with fixture emits valid JSON"
{
  json="$(explain_all 64gb best-cloud)"
  if ! echo "$json" | python3 -m json.tool >/dev/null 2>&1; then
    fail "output is valid JSON (got: ${json:0:200})"
  else
    pass "output is valid JSON"
  fi
  count="$(echo "$json" | jq 'length')"
  check "entry count equals llm_profiles count (3)" "3" "$count"
  caps="$(echo "$json" | jq -r '.[].capability' | sort | tr '\n' ',')"
  check_contains "worker capability present" "worker" "$caps"
  check_contains "scout capability present" "scout" "$caps"
  check_contains "default capability present" "default" "$caps"
}

# ── 2: local vs cloud flags ──────────────────────────────────────────────────
echo ""
echo "2. local flag and endpoint_cli_host correctness"
{
  json="$(explain_all 64gb best-cloud)"
  # scout/best-cloud/64gb = local-model-a → ollama_local (localhost) → local:true
  scout_local="$(echo "$json" | jq -r '.[] | select(.capability=="scout") | .local')"
  check "scout is local:true in best-cloud" "true" "$scout_local"
  scout_host="$(echo "$json" | jq -r '.[] | select(.capability=="scout") | .endpoint_cli_host')"
  check "scout endpoint_cli_host is localhost" "http://localhost:11434" "$scout_host"

  # worker/best-cloud/64gb = cloud-model-b → cloud_ep (api.anthropic.com) → local:false
  worker_local="$(echo "$json" | jq -r '.[] | select(.capability=="worker") | .local')"
  check "worker is local:false in best-cloud" "false" "$worker_local"
  worker_host="$(echo "$json" | jq -r '.[] | select(.capability=="worker") | .endpoint_cli_host')"
  check "worker endpoint_cli_host is null for cloud" "null" "$worker_host"
}

# ── 3: collect_active_profile_capability_assignments jq projection ──────────
echo ""
echo "3. capability-assignments jq projection: correct TSV fields"
{
  json="$(explain_all 64gb best-cloud)"
  # Same jq used in collect_active_profile_capability_assignments (default_override="")
  tsv="$(echo "$json" | jq -r --arg do "" '
    .[] |
    .capability as $cap |
    (if $cap == "default" and $do != "" then $do else .model end) as $model |
    if $model == null or $model == "" then empty
    else [$cap, $model, (if .is_recommended then "(rec)" else "" end)] | @tsv
    end
  ')"
  field_counts="$(echo "$tsv" | awk -F'\t' '{print NF}' | sort -u)"
  check "all TSV rows have exactly 3 fields" "3" "$field_counts"

  # Worker row: capability=worker, model=cloud-model-b
  worker_row="$(echo "$tsv" | awk -F'\t' '$1=="worker"')"
  worker_model="$(echo "$worker_row" | cut -f2)"
  check "worker model field is cloud-model-b" "cloud-model-b" "$worker_model"
  worker_rec="$(echo "$worker_row" | cut -f3)"
  check "worker rec field is empty string" "" "$worker_rec"
}

# ── 4: default_override replaces model for the default capability slot ───────
echo ""
echo "4. default_override substitutes model for default capability"
{
  json="$(explain_all 64gb best-cloud)"
  # With override "my-override-model"
  tsv="$(echo "$json" | jq -r --arg do "my-override-model" '
    .[] |
    .capability as $cap |
    (if $cap == "default" and $do != "" then $do else .model end) as $model |
    if $model == null or $model == "" then empty
    else [$cap, $model, (if .is_recommended then "(rec)" else "" end)] | @tsv
    end
  ')"
  default_model="$(echo "$tsv" | awk -F'\t' '$1=="default"' | cut -f2)"
  check "default slot uses override model" "my-override-model" "$default_model"

  # Without override, default resolves to its configured model
  tsv_no_override="$(echo "$json" | jq -r --arg do "" '
    .[] |
    .capability as $cap |
    (if $cap == "default" and $do != "" then $do else .model end) as $model |
    if $model == null or $model == "" then empty
    else [$cap, $model, (if .is_recommended then "(rec)" else "" end)] | @tsv
    end
  ')"
  default_model_raw="$(echo "$tsv_no_override" | awk -F'\t' '$1=="default"' | cut -f2)"
  check "default slot without override uses configured model (cloud-model-b)" "cloud-model-b" "$default_model_raw"
}

# ── 5: collect_active_profile_local_ollama_models jq projection ─────────────
echo ""
echo "5. local-ollama-models jq projection: 5 fields, __EMPTY__ in field 3"
{
  json="$(explain_all 64gb best-cloud)"
  # Same jq used in collect_active_profile_local_ollama_models
  tsv="$(echo "$json" | jq -r '
    .[] | select(.local == true and .endpoint_cli_host != null) |
    [.model, .endpoint_cli_host, "__EMPTY__", (.endpoint_id // ""), .capability] | @tsv
  ' | sort -u)"
  [[ -n "$tsv" ]] || { fail "local-ollama-models jq produced no output"; }
  field_counts="$(echo "$tsv" | awk -F'\t' '{print NF}' | sort -u)"
  check "all local-ollama rows have exactly 5 fields" "5" "$field_counts"

  # Field 2 = endpoint_cli_host = http://localhost:11434
  f2="$(echo "$tsv" | head -1 | cut -f2)"
  check "field 2 is http://localhost:11434" "http://localhost:11434" "$f2"

  # Field 3 = __EMPTY__ sentinel
  f3="$(echo "$tsv" | head -1 | cut -f3)"
  check "field 3 is __EMPTY__ sentinel" "__EMPTY__" "$f3"

  # Field 4 = endpoint_id = ollama_local
  f4="$(echo "$tsv" | head -1 | cut -f4)"
  check "field 4 is endpoint_id (ollama_local)" "ollama_local" "$f4"
}

# ── 6: best-local-oss — all caps resolve to local ───────────────────────────
echo ""
echo "6. best-local-oss: all capabilities resolve to local"
{
  json="$(explain_all 64gb best-local-oss)"
  non_local="$(echo "$json" | jq '[.[] | select(.local == false)] | length')"
  check "no non-local entries in best-local-oss for this fixture" "0" "$non_local"
}

# ── 7: _explain_all_json cache: node spawned only once per unique key ────────
echo ""
echo "7. _explain_all_json cache hit: node spawned only once for same key"
{
  # Must call function directly (not via $()) so global cache vars propagate
  # back to this shell. Use temp files to capture stdout instead.
  OUT1="$TMPDIR_TEST/cache_out1.json"
  OUT2="$TMPDIR_TEST/cache_out2.json"

  CONFIG="$FIXTURE_CONFIG"
  CTHRU_SELF_DIR="$TOOLS_DIR"
  _EXPLAIN_ALL_CACHE_KEY=""
  _EXPLAIN_ALL_CACHE_JSON=""

  _explain_all_json_test() {
    local profile="$1" llm_mode="$2"
    local mtime
    mtime="$(stat -c %Y "$CONFIG" 2>/dev/null || stat -f %m "$CONFIG" 2>/dev/null || echo 0)"
    local key="${mtime}:${profile}:${llm_mode}"
    if [[ "$key" == "$_EXPLAIN_ALL_CACHE_KEY" && -n "$_EXPLAIN_ALL_CACHE_JSON" ]]; then
      printf '%s' "$_EXPLAIN_ALL_CACHE_JSON"
      return 0
    fi
    local json
    json="$(CLAUDE_LLM_PROFILE="$profile" CLAUDE_LLM_MODE="$llm_mode" \
            CLAUDE_MODEL_MAP_PATH="$CONFIG" \
            node "$CTHRU_SELF_DIR/c-thru-explain.js" --all --format json 2>/dev/null)" || return 1
    _EXPLAIN_ALL_CACHE_KEY="$key"
    _EXPLAIN_ALL_CACHE_JSON="$json"
    printf '%s' "$json"
  }

  # First call — direct (no subshell), writes to temp file so globals persist
  _explain_all_json_test 64gb best-cloud > "$OUT1"

  if [[ -n "$_EXPLAIN_ALL_CACHE_KEY" ]]; then pass "cache key set after first call"
  else fail "cache key set after first call (key is empty)"; fi

  if [[ -n "$_EXPLAIN_ALL_CACHE_JSON" ]]; then pass "cache json set after first call"
  else fail "cache json set after first call (json is empty)"; fi

  # Second call: stub node to always exit 1 so we can prove it isn't invoked.
  # If the cache is hit, the stub never runs and we get identical output.
  # CONFIG stays the same so the mtime-based cache key matches.
  STUB_DIR="$TMPDIR_TEST/stub-node"
  mkdir -p "$STUB_DIR"
  printf '#!/usr/bin/env bash\nexit 1\n' > "$STUB_DIR/node"
  chmod +x "$STUB_DIR/node"

  PATH="$STUB_DIR:$PATH" _explain_all_json_test 64gb best-cloud > "$OUT2"
  rm -rf "$STUB_DIR"

  if diff -q "$OUT1" "$OUT2" >/dev/null 2>&1; then
    pass "second call returns identical output (cache hit — stub node not invoked)"
  else
    fail "second call returns identical output (cache missed — stub node was invoked)"
  fi
}

# ── 8: unknown mode exits non-zero ───────────────────────────────────────────
echo ""
echo "8. unknown --mode exits non-zero with clear error"
{
  stderr_out="$(CLAUDE_MODEL_MAP_PATH="$FIXTURE_CONFIG" \
    node "$EXPLAIN_JS" --all --format json --mode bogus-mode 2>&1 >/dev/null)"
  exit_code=$?
  check "exits non-zero" "1" "$exit_code"
  check_contains "error mentions the bad mode" "bogus-mode" "$stderr_out"
  check_contains "error lists valid modes" "best-cloud" "$stderr_out"
}

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "$PASS/$((PASS+FAIL)) passed${FAIL:+ — $FAIL FAILED}"
[[ "$FAIL" -eq 0 ]]
