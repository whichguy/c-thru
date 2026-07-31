#!/usr/bin/env bash
# c-thru-ensure-proxy-on-port.sh — bring claude-proxy up on a known loopback port.
#
# Used by SessionStart (and optionally UserPromptSubmit) when ANTHROPIC_BASE_URL
# still points at a port whose listener died (agent-view reenter / rehydrate).
# Does NOT rewrite ANTHROPIC_BASE_URL — the session keeps its env; we resurrect
# the listener so the existing URL works again.
#
# Safe to source (defines cthru_ensure_proxy_on_port) or execute:
#   bash tools/c-thru-ensure-proxy-on-port.sh <port>
#
# Exit codes (when executed):
#   0  proxy answers /ping on that port (already up or after spawn)
#   1  could not bring proxy up (fail-open for hooks: callers ignore)
#   2  bad args / refused (non-integer port, out of range)
#
# Constraints: 127.0.0.1 only; short wait; single-flight per port via mkdir lock.
# shellcheck shell=bash

# Resolve this script's directory even when sourced.
_cthru_ensure_self="${BASH_SOURCE[0]:-$0}"
while [ -L "$_cthru_ensure_self" ]; do
  _cthru_ensure_dir=$(cd -P "$(dirname "$_cthru_ensure_self")" && pwd)
  _cthru_ensure_self=$(readlink "$_cthru_ensure_self")
  case "$_cthru_ensure_self" in /*) ;; *) _cthru_ensure_self="$_cthru_ensure_dir/$_cthru_ensure_self" ;; esac
done
_CTHRU_ENSURE_TOOLS_DIR=$(cd -P "$(dirname "$_cthru_ensure_self")" && pwd)
unset _cthru_ensure_self _cthru_ensure_dir

# Shared fingerprint helpers (no side effects at source).
if [[ -r "$_CTHRU_ENSURE_TOOLS_DIR/c-thru-lib.sh" ]]; then
  # shellcheck source=c-thru-lib.sh
  . "$_CTHRU_ENSURE_TOOLS_DIR/c-thru-lib.sh"
fi

# True if /ping on 127.0.0.1:$1 answers within ~1s.
cthru_proxy_ping_ok() {
  local port="${1:-}"
  [[ -n "$port" ]] || return 1
  curl -sf --max-time 1 "http://127.0.0.1:${port}/ping" >/dev/null 2>&1
}

# Desired fingerprint: prefer shared lib helper (explicit export or hash URL).
cthru_ensure_desired_upstream_fingerprint() {
  if type cthru_desired_anthropic_upstream_fingerprint >/dev/null 2>&1; then
    cthru_desired_anthropic_upstream_fingerprint
    return $?
  fi
  # Fallback if lib not sourced (should not happen in-repo).
  if [[ -n "${C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT:-}" ]]; then
    printf '%s' "$C_THRU_ANTHROPIC_UPSTREAM_FINGERPRINT"
    return 0
  fi
  local url="${CLAUDE_PROXY_ANTHROPIC_UPSTREAM:-}"
  [[ -n "$url" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e '
const crypto = require("crypto");
let s = process.argv[1] || "";
try { s = new URL(s).toString(); } catch {}
process.stdout.write(crypto.createHash("sha256").update(s).digest("hex").slice(0, 16));
' "$url" 2>/dev/null || true
}

# True when live /ping anthropic_upstream_fingerprint matches desired.
# Symmetric via cthru_upstream_fingerprints_equal (lib) when available.
cthru_ensure_upstream_fingerprint_ok() {
  local port="${1:-}"
  local desired live="" body
  desired="$(cthru_ensure_desired_upstream_fingerprint)"
  body="$(curl -sf --max-time 1 "http://127.0.0.1:${port}/ping" 2>/dev/null)" || return 1
  if type cthru_upstream_fingerprint_from_ping_json >/dev/null 2>&1; then
    live="$(cthru_upstream_fingerprint_from_ping_json "$body")"
  elif command -v node >/dev/null 2>&1; then
    live="$(node -e 'try{const j=JSON.parse(process.argv[1]||"{}");process.stdout.write(j.anthropic_upstream_fingerprint||"")}catch{}' "$body" 2>/dev/null || true)"
  elif command -v jq >/dev/null 2>&1; then
    live="$(printf '%s' "$body" | jq -r '.anthropic_upstream_fingerprint // empty' 2>/dev/null || true)"
  else
    return 1
  fi
  if type cthru_upstream_fingerprints_equal >/dev/null 2>&1; then
    cthru_upstream_fingerprints_equal "$desired" "$live"
    return $?
  fi
  if [[ -z "$desired" && -z "$live" ]]; then
    return 0
  fi
  if [[ -z "$desired" || -z "$live" ]]; then
    return 1
  fi
  [[ "$desired" == "$live" ]]
}

# On fingerprint mismatch: kill only when *this session requires* an override
# (desired non-empty). Empty desired + live override → refuse without killing
# so a co-tenant gateway-pinned proxy is not hijacked by a no-override hook.
# Returns 0 if caller may proceed to spawn, 1 if must abort without kill.
cthru_ensure_handle_fingerprint_mismatch() {
  local port="${1:-}"
  local desired
  desired="$(cthru_ensure_desired_upstream_fingerprint)"
  if [[ -z "$desired" ]]; then
    echo "c-thru: ensure-on-port :${port} has Anthropic upstream override; this session has none — not reusing, not killing (set CLAUDE_PROXY_ANTHROPIC_UPSTREAM or use another port)" >&2
    return 1
  fi
  cthru_ensure_kill_proxy_on_port "$port" || true
  return 0
}

# Best-effort kill of a live mismatched proxy so we can respawn with the
# correct CLAUDE_PROXY_ANTHROPIC_UPSTREAM (port must be free).
cthru_ensure_kill_proxy_on_port() {
  local port="${1:-}"
  local body pid=""
  body="$(curl -sf --max-time 1 "http://127.0.0.1:${port}/ping" 2>/dev/null)" || return 1
  if command -v node >/dev/null 2>&1; then
    pid="$(node -e 'try{const j=JSON.parse(process.argv[1]||"{}");if(j.pid)process.stdout.write(String(j.pid))}catch{}' "$body" 2>/dev/null || true)"
  elif command -v jq >/dev/null 2>&1; then
    pid="$(printf '%s' "$body" | jq -r '.pid // empty' 2>/dev/null || true)"
  fi
  if [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]]; then
    kill "$pid" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      cthru_proxy_ping_ok "$port" || return 0
      sleep 0.15
    done
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.1
  fi
  cthru_proxy_ping_ok "$port" && return 1
  return 0
}

# Pick a model-map path for a resurrected proxy (prefer durable profile).
cthru_ensure_proxy_config_path() {
  if [[ -n "${CLAUDE_MODEL_MAP_PATH:-}" && -f "${CLAUDE_MODEL_MAP_PATH}" ]]; then
    printf '%s' "$CLAUDE_MODEL_MAP_PATH"
    return 0
  fi
  local profile="${CLAUDE_DIR:-${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}}"
  # Prefer durable originals over ephemeral session shadows when possible.
  if [[ -n "${HOME:-}" && -f "$HOME/.claude/model-map.json" ]]; then
    # If CLAUDE_CONFIG_DIR is a temp c-thru-session shadow, still prefer ~/.claude.
    case "${CLAUDE_CONFIG_DIR:-}" in
      */c-thru-session.*)
        printf '%s' "$HOME/.claude/model-map.json"
        return 0
        ;;
    esac
  fi
  if [[ -f "$profile/model-map.json" ]]; then
    printf '%s' "$profile/model-map.json"
    return 0
  fi
  # Repo or plugin-bundle layout: tools/ sibling of config/
  if [[ -f "$_CTHRU_ENSURE_TOOLS_DIR/../config/model-map.json" ]]; then
    printf '%s' "$_CTHRU_ENSURE_TOOLS_DIR/../config/model-map.json"
    return 0
  fi
  return 1
}

# Locate claude-proxy JS entry.
cthru_ensure_proxy_js_path() {
  local profile="${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
  if [[ -f "$profile/tools/claude-proxy" ]]; then
    printf '%s' "$profile/tools/claude-proxy"
    return 0
  fi
  if [[ -f "$_CTHRU_ENSURE_TOOLS_DIR/claude-proxy" ]]; then
    printf '%s' "$_CTHRU_ENSURE_TOOLS_DIR/claude-proxy"
    return 0
  fi
  if [[ -n "${CTHRU_REPO_ROOT:-}" && -f "${CTHRU_REPO_ROOT}/tools/claude-proxy" ]]; then
    printf '%s' "${CTHRU_REPO_ROOT}/tools/claude-proxy"
    return 0
  fi
  return 1
}

# Bring proxy up on port $1. Prints nothing on success; brief stderr on spawn.
# Returns 0 if /ping OK, 1 if still down, 2 if bad port.
cthru_ensure_proxy_on_port() {
  local port="${1:-}"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    return 2
  fi
  # Never spawn a local proxy when the session is dialing a non-loopback
  # Anthropic/cloud URL (e.g. leftover CLAUDE_PROXY_PORT + real BASE_URL).
  case "${ANTHROPIC_BASE_URL:-}" in
    ""|http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
    *) return 1 ;;
  esac
  # Already live — only reuse when Anthropic upstream fingerprint matches
  # (F6: stale override must not be silently kept).
  if cthru_proxy_ping_ok "$port"; then
    if cthru_ensure_upstream_fingerprint_ok "$port"; then
      return 0
    fi
    # Desired empty → do not kill co-tenant; desired set → kill+respawn below.
    cthru_ensure_handle_fingerprint_mismatch "$port" || return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi

  local proxy_js config log_file lock_dir lock_age
  proxy_js="$(cthru_ensure_proxy_js_path 2>/dev/null)" || return 1
  config="$(cthru_ensure_proxy_config_path 2>/dev/null)" || return 1

  # Single-flight: mkdir lock (portable; no flock required).
  lock_dir="${TMPDIR:-/tmp}/c-thru-ensure-port.${port}.lock.d"
  if [[ -d "$lock_dir" ]]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$lock_dir" 2>/dev/null || stat -c %Y "$lock_dir" 2>/dev/null || echo 0) ))
    if [[ "$lock_age" -gt 15 ]]; then
      rmdir "$lock_dir" 2>/dev/null || true
    fi
  fi
  if ! mkdir "$lock_dir" 2>/dev/null; then
    # Another ensure in progress — wait briefly for /ping.
    local i
    for i in 1 2 3 4 5 6 7 8; do
      if cthru_proxy_ping_ok "$port" && cthru_ensure_upstream_fingerprint_ok "$port"; then
        return 0
      fi
      sleep 0.25
    done
    return 1
  fi

  # Holding lock — recheck then spawn.
  if cthru_proxy_ping_ok "$port"; then
    if cthru_ensure_upstream_fingerprint_ok "$port"; then
      rmdir "$lock_dir" 2>/dev/null || true
      return 0
    fi
    if ! cthru_ensure_handle_fingerprint_mismatch "$port"; then
      rmdir "$lock_dir" 2>/dev/null || true
      return 1
    fi
  fi

  log_file="${CLAUDE_DIR:-${HOME:-/tmp}/.claude}/proxy.ensure-${port}.log"
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true

  # Fixed port + READY suppressed by --port (see claude-proxy CLI). Detach so
  # the hook can exit without reaping the proxy.
  # Inherit CLAUDE_PROXY_ANTHROPIC_UPSTREAM from Claude/hook env (F5/F6).
  local spawn_pid=""
  nohup env \
    ${CLAUDE_PROXY_ANTHROPIC_UPSTREAM:+CLAUDE_PROXY_ANTHROPIC_UPSTREAM="$CLAUDE_PROXY_ANTHROPIC_UPSTREAM"} \
    ${C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM:+C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM="$C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM"} \
    ${C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM:+C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM="$C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM"} \
    node "$proxy_js" --port "$port" --config "$config" \
    >>"$log_file" 2>&1 </dev/null &
  spawn_pid=$!
  disown "$spawn_pid" 2>/dev/null || true

  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if cthru_proxy_ping_ok "$port"; then
      if cthru_ensure_upstream_fingerprint_ok "$port"; then
        rmdir "$lock_dir" 2>/dev/null || true
        printf 'c-thru: resurrected proxy on :%s\n' "$port" >&2
        return 0
      fi
      # Spawned but fingerprint wrong (env not applied) — kill and fail closed.
      cthru_ensure_kill_proxy_on_port "$port" || true
      break
    fi
    # If the child already exited, stop waiting early.
    if [[ -n "$spawn_pid" ]] && ! kill -0 "$spawn_pid" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done

  # Spawn never answered /ping — reap the orphan so we don't leave a wedged
  # node process holding (or racing for) the port.
  if [[ -n "$spawn_pid" ]] && kill -0 "$spawn_pid" 2>/dev/null; then
    kill "$spawn_pid" 2>/dev/null || true
    wait "$spawn_pid" 2>/dev/null || true
  fi
  rmdir "$lock_dir" 2>/dev/null || true
  return 1
}

# Executed as a script (not sourced).
if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  set -uo pipefail
  cthru_ensure_proxy_on_port "${1:-}"
  exit $?
fi
