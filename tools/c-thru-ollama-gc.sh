#!/usr/bin/env bash
# ARCH: GC tool for tracking and cleaning c-thru-pulled Ollama model tags.
# Subcommands: init | record <model> <source> [<backend_url>] | sweep [--dry-run] | purge
#
# State file: $PROFILE_DIR/c-thru-ollama-models.json
# {"version":1,"installed":{"qwen3:1.7b":{"pulled_at":1712345678,"source":"proxy","backend_url":"http://localhost:11434"}}}
#
# Locking: flock(1) when available, mkdir-based advisory lock as macOS fallback.
# All JSON I/O via inline node (stdlib-only, no external deps).
set -uo pipefail

PROFILE_DIR="${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
STATE_FILE="${C_THRU_OLLAMA_STATE_FILE:-$PROFILE_DIR/c-thru-ollama-models.json}"
MODEL_MAP_FILE="$PROFILE_DIR/model-map.json"

# --- _with_lock: run a function under exclusive advisory lock ---
# Uses flock(1) when available; falls back to atomic mkdir on macOS without util-linux.
_with_lock() {
  if command -v flock >/dev/null 2>&1; then
    (flock -x 9; "$@") 9>"$STATE_FILE.lock"
  else
    local _ldir="$STATE_FILE.lock.d" _i=0 _age _rc=0
    until mkdir "$_ldir" 2>/dev/null; do
      _age=$(( $(date +%s) - $(stat -f %m "$_ldir" 2>/dev/null || stat -c %Y "$_ldir" 2>/dev/null || echo 0) ))
      [ "$_age" -gt 30 ] && rmdir "$_ldir" 2>/dev/null || true
      sleep 0.05; _i=$((_i+1)); [ $_i -gt 100 ] && break
    done
    "$@" || _rc=$?
    rmdir "$_ldir" 2>/dev/null || true
    return $_rc
  fi
}

# --- init: create state file with empty schema if absent ---
subcmd_init() {
  [ -f "$STATE_FILE" ] && return 0
  mkdir -p "$(dirname "$STATE_FILE")"
  printf '{"version":1,"installed":{}}\n' > "$STATE_FILE"
  echo "c-thru-ollama-gc: initialized $STATE_FILE" >&2
}

# --- record: record a c-thru-pulled model in state file ---
# Idempotent: only inserts if absent (preserves original pulled_at on re-pull).
_record_write() {
  local model="$1" source="$2" backend_url="$3"
  node - "$STATE_FILE" "$model" "$source" "$backend_url" <<'RECEOF'
'use strict';
const fs = require('fs'), path = require('path');
const [,, sf, model, source, backendUrl] = process.argv;
let s = { version: 1, installed: {} };
try {
  const p = JSON.parse(fs.readFileSync(sf, 'utf8'));
  if (p && typeof p === 'object') { s = p; if (!s.installed) s.installed = {}; }
} catch {}
if (!s.installed[model]) {
  s.installed[model] = { pulled_at: Math.floor(Date.now() / 1000), source, backend_url: backendUrl };
  try { fs.mkdirSync(path.dirname(sf), { recursive: true }); } catch {}
  fs.writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
}
RECEOF
}

subcmd_record() {
  local model="${1:-}" source="${2:-}" backend_url="${3:-http://localhost:11434}"
  [ -n "$model" ]  || { echo "c-thru-ollama-gc: record: missing <model>" >&2; exit 1; }
  [ -n "$source" ] || { echo "c-thru-ollama-gc: record: missing <source>" >&2; exit 1; }
  _with_lock _record_write "$model" "$source" "$backend_url"
}

# --- sweep: GC unreferenced c-thru-pulled models ---
# Referenced set = union of connected_model + disconnect_model across ALL llm_profiles tiers.
# Defensive guard: if llm_profiles non-empty but referenced set is empty → abort (parse regression).
# Skipped entirely when C_THRU_GC_DISABLE=1.
_sweep_state_update() {
  # $@: model names to remove from state.installed
  node - "$STATE_FILE" "$@" <<'SWEEPEOF'
'use strict';
const fs = require('fs');
const [,, sf, ...toRemove] = process.argv;
const rm = new Set(toRemove);
let s = { version: 1, installed: {} };
try {
  const p = JSON.parse(fs.readFileSync(sf, 'utf8'));
  if (p && typeof p === 'object') { s = p; if (!s.installed) s.installed = {}; }
} catch {}
for (const m of rm) delete s.installed[m];
fs.writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
SWEEPEOF
}

subcmd_sweep() {
  local dry_run=0
  [ "${1:-}" = "--dry-run" ] && dry_run=1
  [ "${C_THRU_GC_DISABLE:-0}" = "1" ] && return 0
  [ -f "$STATE_FILE" ] || return 0
  [ -f "$MODEL_MAP_FILE" ] || {
    echo "c-thru-ollama-gc: model-map not found at $MODEL_MAP_FILE — skipping sweep" >&2
    return 0
  }

  # Step 1: compute referenced set from model-map (strips JSON5 // comments before parse)
  local ref_json rc=0
  ref_json=$(node - "$MODEL_MAP_FILE" <<'REFEOF'
'use strict';
const fs = require('fs');
let raw;
try { raw = fs.readFileSync(process.argv[2], 'utf8'); } catch (e) {
  process.stderr.write('c-thru-ollama-gc: cannot read model-map: ' + e.message + '\n');
  process.exit(1);
}
// String-aware JSON5 comment stripper — avoids clobbering // inside string literals
function stripJsonComments(s) {
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      out += s[i++];
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i++]; if (i < s.length) out += s[i++]; }
        else if (s[i] === '"') { out += s[i++]; break; }
        else out += s[i++];
      }
    } else if (s[i] === '/' && s[i+1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (s[i] === '/' && s[i+1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i+1] === '/')) i++;
      i += 2;
    } else {
      out += s[i++];
    }
  }
  return out;
}
raw = stripJsonComments(raw);
let map;
try { map = JSON.parse(raw); } catch (e) {
  process.stderr.write('c-thru-ollama-gc: failed to parse model-map: ' + e.message + '\n');
  process.exit(1);
}
const profiles = map.llm_profiles || {};
const hasProfiles = Object.keys(profiles).length > 0;
const ref = new Set();
for (const tier of Object.values(profiles))
  for (const p of Object.values(tier || {}))
    if (p && typeof p === 'object') {
      if (p.connected_model) ref.add(p.connected_model);
      if (p.disconnect_model) ref.add(p.disconnect_model);
    }
// Defensive guard: non-empty profiles but empty result means parse failure
if (hasProfiles && ref.size === 0) {
  process.stderr.write('c-thru-ollama-gc: ABORT — llm_profiles is non-empty but referenced set is empty (parse regression?)\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify([...ref]) + '\n');
REFEOF
  ) || rc=$?

  if [ "$rc" -eq 2 ]; then
    exit 1
  elif [ "$rc" -ne 0 ]; then
    echo "c-thru-ollama-gc: sweep: failed to compute referenced set — skipping" >&2
    return 0
  fi

  # Step 2: compute GC candidates (state.installed keys not in referenced set)
  local candidates
  candidates=$(node - "$STATE_FILE" "$ref_json" <<'CANDEOF'
'use strict';
const fs = require('fs');
const [,, sf, refJson] = process.argv;
const ref = new Set(JSON.parse(refJson));
let s = { installed: {} };
try {
  const p = JSON.parse(fs.readFileSync(sf, 'utf8'));
  if (p && typeof p === 'object') { s = p; if (!s.installed) s.installed = {}; }
} catch { process.exit(0); }
const cands = Object.keys(s.installed).filter(m => !ref.has(m));
if (cands.length > 0) process.stdout.write(cands.join('\n') + '\n');
CANDEOF
  ) || return 0

  [ -z "$candidates" ] && return 0

  if [ "$dry_run" -eq 1 ]; then
    while IFS= read -r m; do
      [ -n "$m" ] && echo "c-thru-ollama-gc: [dry-run] would remove: $m" >&2
    done <<< "$candidates"
    return 0
  fi

  # Step 3: verify ollama is reachable before issuing rm commands.
  # `ollama rm` exits 1 for BOTH "model not found" AND "server unreachable" — we
  # cannot distinguish them at the per-model level.  Probing with `ollama list`
  # first lets us bail early rather than treating every rm failure as an orphan
  # and silently purging state entries for models that are still installed.
  if ! ollama list >/dev/null 2>&1; then
    echo "c-thru-ollama-gc: sweep: ollama server unreachable — skipping GC to avoid purging state for live models" >&2
    return 0
  fi

  # Step 4: ollama rm each candidate; collect all attempted (success or orphan) for state cleanup
  local -a processed=()
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    if [ "${C_THRU_OLLAMA_ALLOW_RM:-0}" = "1" ]; then
      if ollama rm "$m" >/dev/null 2>&1; then
        echo "c-thru-ollama-gc: removed $m" >&2
      else
        # Tag already gone — remove orphan from state file regardless
        echo "c-thru-ollama-gc: $m not found in ollama (removing orphan from state)" >&2
      fi
    else
      echo "c-thru-ollama-gc: [skipped] would remove $m (set C_THRU_OLLAMA_ALLOW_RM=1 to enable)" >&2
    fi
    processed+=("$m")
  done <<< "$candidates"

  # Step 5: batch-remove processed models from state file under lock
  if [ ${#processed[@]} -gt 0 ]; then
    _with_lock _sweep_state_update "${processed[@]}"
    echo "c-thru-ollama-gc: swept ${#processed[@]} model(s)" >&2
  fi
}

# --- purge: ollama rm ALL c-thru-managed models and clear state ---
# Used by uninstall.sh. Skipped when C_THRU_GC_DISABLE=1.
subcmd_purge() {
  [ "${C_THRU_GC_DISABLE:-0}" = "1" ] && return 0
  [ -f "$STATE_FILE" ] || {
    echo "c-thru-ollama-gc: state file not found — nothing to purge" >&2
    return 0
  }

  local models
  models=$(node - "$STATE_FILE" <<'LISTEOF'
'use strict';
const fs = require('fs');
let s = { installed: {} };
try {
  const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (p && typeof p === 'object') { s = p; if (!s.installed) s.installed = {}; }
} catch { process.exit(0); }
const ms = Object.keys(s.installed);
if (ms.length > 0) process.stdout.write(ms.join('\n') + '\n');
LISTEOF
  ) || return 0

  if [ -z "$models" ]; then
    echo "c-thru-ollama-gc: no c-thru-managed models to purge" >&2
    return 0
  fi

  local removed=0
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    if [ "${C_THRU_OLLAMA_ALLOW_RM:-0}" = "1" ]; then
      if ollama rm "$m" >/dev/null 2>&1; then
        echo "c-thru-ollama-gc: purged $m" >&2
        removed=$((removed+1))
      else
        echo "c-thru-ollama-gc: warning — failed to purge $m (may not exist locally)" >&2
      fi
    else
      echo "c-thru-ollama-gc: [skipped] would purge $m (set C_THRU_OLLAMA_ALLOW_RM=1 to enable)" >&2
    fi
  done <<< "$models"

  # Clear installed map
  node - "$STATE_FILE" <<'CLEAREOF' || true
'use strict';
const fs = require('fs');
let s = { version: 1, installed: {} };
try {
  const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (p && typeof p === 'object') s = p;
} catch {}
s.installed = {};
fs.writeFileSync(process.argv[2], JSON.stringify(s, null, 2) + '\n');
CLEAREOF

  echo "c-thru-ollama-gc: purge complete ($removed model(s) removed)" >&2
}

# --- main ---
subcmd="${1:-}"
shift || true
case "$subcmd" in
  init)   subcmd_init   "$@" ;;
  record) subcmd_record "$@" ;;
  sweep)  subcmd_sweep  "$@" ;;
  purge)  subcmd_purge  "$@" ;;
  *)
    echo "Usage: $(basename "$0") <init|record|sweep|purge> [args...]" >&2
    echo "  init                         create state file if absent" >&2
    echo "  record <model> <source> [url] record a c-thru-pulled model" >&2
    echo "  sweep [--dry-run]            GC unreferenced tracked models" >&2
    echo "  purge                        remove all tracked models (uninstall)" >&2
    exit 1
    ;;
esac
