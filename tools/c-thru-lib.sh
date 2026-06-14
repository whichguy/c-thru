# c-thru-lib.sh — sourceable env / proxy-discovery resolvers.
#
# Single source of truth for the env-var precedence ladders that were
# hand-rolled and drifted across tools/c-thru and the hooks. SOURCE this file;
# do not execute it.
#
# Contract (so it is safe everywhere it is sourced):
#   - function definitions ONLY — zero side effects at source time, so it is
#     safe under a consumer's `set -e` (self-update) and changes no state.
#   - every variable reference is `${VAR:-}`-guarded, so it is safe under a
#     consumer's `set -u` (tools/c-thru, the hooks, the tests).
#   - no `set` commands, no `export`s, no I/O.
#
# shellcheck shell=bash

# Extract an explicit port from an http(s) base URL, else print nothing.
# grep -oE is portable to BusyBox/Alpine; `sed -nE` isn't.
proxy_port_from_base_url() {
  local url="${1:-}"
  echo "$url" | grep -oE '^https?://[^/:]+:[0-9]+' | grep -oE '[0-9]+$'
}

# Proxy listen-port ladder for HOOKS (the hot path: runs on every prompt /
# tool call). Identical precedence to claude_proxy_listen_port() MINUS the
# pid-file/lsof tail — hooks must not pay an lsof cost per prompt. Prints the
# port, or nothing when the proxy is not discoverable via env (the hook then
# no-ops, same as "c-thru not active").
cthru_hook_listen_port() {
  if [[ -n "${CLAUDE_PROXY_PORT:-}" ]]; then
    printf '%s' "$CLAUDE_PROXY_PORT"
  elif [[ -n "${PROXY_PORT:-}" ]]; then
    printf '%s' "$PROXY_PORT"
  elif [[ "${CLAUDE_PROXY_USE_OLLAMA_PORT:-0}" == "1" ]]; then
    printf '%s' "11434"
  elif [[ -n "${ANTHROPIC_BASE_URL:-}" ]] && \
       { [[ -n "$(proxy_port_from_base_url "${ANTHROPIC_BASE_URL:-}")" ]] || \
         [[ "${ANTHROPIC_BASE_URL:-}" =~ ^https?://127\.0\.0\.1 ]]; }; then
    # Plugin mode: no PROXY_PORT/pid file, but settings.json pre-wrote
    # ANTHROPIC_BASE_URL at the proxy's fixed port. Derive it here. A loopback
    # URL with no explicit port falls back to the plugin default.
    local _abu_port; _abu_port="$(proxy_port_from_base_url "${ANTHROPIC_BASE_URL:-}")"
    if [[ -n "$_abu_port" ]]; then
      printf '%s' "$_abu_port"
    else
      printf '%s' "${C_THRU_PLUGIN_PORT:-10017}"
    fi
  fi
}

# Full proxy listen-port ladder for tools/c-thru (NOT the hot path): the hook
# ladder above, then a pid-file/lsof tail. One precedence source — the tail is
# appended here so hooks and c-thru never disagree on the leading ladder.
claude_proxy_listen_port() {
  local port; port="$(cthru_hook_listen_port)"
  if [[ -n "$port" ]]; then
    printf '%s' "$port"
    return 0
  fi
  # Fall back to pid-file: find the proxy's listening port via lsof.
  local pid_file; pid_file="$(cthru_effective_profile_dir)/proxy.pid"
  if [[ -f "$pid_file" ]] && command -v lsof >/dev/null 2>&1; then
    local pid; pid="$(cat "$pid_file" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      lsof -a -iTCP -sTCP:LISTEN -n -P -p "$pid" 2>/dev/null \
        | awk 'NR>1{print $9}' | grep -oE '[0-9]+$' | head -1
    fi
  fi
}

# The session-SHADOWED profile dir: where the active c-thru session reads/writes.
# CLAUDE_PROFILE_DIR is the ephemeral inline override c-thru sets at launch — so
# this resolver intentionally consults it FIRST. (Not drift vs the resolver
# below: this one is the shadow, that one is the durable original.)
cthru_effective_profile_dir() {
  printf '%s' "${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
}

# The user's DURABLE profile dir: never the session shadow. For state that must
# survive an `rm -rf` of the ephemeral shadow (e.g. self-update / benchmarks
# debounce stamps). It does NOT consult CLAUDE_PROFILE_DIR — that omission is
# the whole point (shadow-isolation), not an oversight to "fix".
cthru_original_profile_dir() {
  printf '%s' "${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
}

# Inbound Ollama base URL. Precedence matches claude-proxy:87: OLLAMA_URL is the
# inline var c-thru injects at launch; OLLAMA_BASE_URL is the legacy fallback.
cthru_ollama_url() {
  printf '%s' "${OLLAMA_URL:-${OLLAMA_BASE_URL:-http://localhost:11434}}"
}
