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

# Round-5 B2: full proxy base URL for hooks, carrying the /s/<session-id>
# suffix when available — same session identity tools/c-thru exports
# (C_THRU_SESSION_ID) and inherits down to hook child processes. Hooks that
# built "http://127.0.0.1:$PORT" directly (session-start, classify,
# postcompact) silently dropped this prefix, so their /hooks/context calls
# read the proxy's GLOBAL mode/config even when this session had switched its
# own session-scoped mode via POST /s/<id>/c-thru/mode. Prints nothing when
# cthru_hook_listen_port itself can't discover a port (fail-open, same as
# "c-thru not active"). Opt-out mirrors tools/c-thru's own:
# C_THRU_SESSION_SCOPED_MODE=0.
cthru_hook_base_url() {
  local port; port="$(cthru_hook_listen_port)"
  [[ -n "$port" ]] || return 0
  local base="http://127.0.0.1:${port}"
  if [[ -n "${C_THRU_SESSION_ID:-}" && "${C_THRU_SESSION_SCOPED_MODE:-1}" != "0" ]]; then
    base="${base}/s/${C_THRU_SESSION_ID}"
  fi
  printf '%s' "$base"
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

# Durable profile for child processes / skills that must survive the ephemeral
# session shadow. Prefer the launcher-exported C_THRU_ORIGINAL_PROFILE_DIR
# (set before CLAUDE_PROFILE_DIR is pointed at the mktemp shadow). Never consult
# CLAUDE_PROFILE_DIR or CLAUDE_CONFIG_DIR — those may be the disposable shadow.
cthru_durable_profile_dir() {
  printf '%s' "${C_THRU_ORIGINAL_PROFILE_DIR:-${CLAUDE_DIR:-$HOME/.claude}}"
}

# C23 — emit control-token curl header args for a mutating route, or nothing
# when the token is absent (proxy fails open for loopback). Prints args suitable
# for `curl ... $(...)` / array capture. Side effects only when *called*.
control_token_curl_args() {
  local tf="${CLAUDE_PROXY_CONTROL_TOKEN_FILE:-${CLAUDE_PROFILE_DIR:-${CLAUDE_DIR:-$HOME/.claude}}/proxy.control-token}"
  local tok=""
  [[ -n "${CLAUDE_PROXY_CONTROL_TOKEN:-}" ]] && tok="$CLAUDE_PROXY_CONTROL_TOKEN"
  [[ -z "$tok" && -s "$tf" ]] && tok="$(cat "$tf" 2>/dev/null)"
  [[ -n "$tok" ]] && printf -- '-H\nX-C-Thru-Control: %s\n' "$tok"
  return 0
}

# Opt-in: C_THRU_STATS_RESET=launch clears the lifetime usage ledger once after
# the proxy is known ready for this process tree. Default is never (forensics).
# Uses POST /c-thru/stats/clear so multi-proxy clear-wins applies. Once per shell.
maybe_reset_usage_stats_on_launch() {
  [[ "${C_THRU_STATS_RESET:-never}" == "launch" ]] || return 0
  [[ "${_C_THRU_STATS_RESET_DONE:-0}" == "1" ]] && return 0
  local port=""
  port="${PROXY_PORT:-${CLAUDE_PROXY_PORT:-}}"
  [[ -z "$port" ]] && port="$(claude_proxy_listen_port 2>/dev/null || true)"
  [[ -n "$port" ]] || return 0
  local _ct_args=()
  local _ct_line
  while IFS= read -r _ct_line; do _ct_args+=("$_ct_line"); done < <(control_token_curl_args)
  # bash 3.2 + set -u: empty "${_ct_args[@]}" is unbound — safe expansion.
  # Brief retries on 503 lock-busy (F4); do not set DONE unless clear succeeds.
  local _attempt=0 _code=""
  while [[ $_attempt -lt 5 ]]; do
    _attempt=$((_attempt + 1))
    _code="$(curl -sS --max-time 2.0 -o /dev/null -w '%{http_code}' -X POST \
      ${_ct_args[@]+"${_ct_args[@]}"} \
      "http://127.0.0.1:${port}/c-thru/stats/clear" 2>/dev/null || echo 000)"
    if [[ "$_code" == "200" ]]; then
      _C_THRU_STATS_RESET_DONE=1
      if [[ "${C_THRU_DEBUG:-0}" != "0" && -n "${C_THRU_DEBUG:-}" ]]; then
        echo "c-thru: C_THRU_STATS_RESET=launch cleared usage stats on :$port" >&2
      fi
      return 0
    fi
    [[ "$_code" == "503" ]] || break
    sleep 0.1 2>/dev/null || sleep 1
  done
  return 0
}
