#!/usr/bin/env bash
# Gate for marketplace-plugin-invoked hooks (C_THRU_PLUGIN_HOOK=1).
# Source at the top of hook scripts after path resolve.
#
# Returns 0 from cthru_plugin_hook_should_skip if the hook body must not run.
# Canonical tools/* hooks (CLI inject) leave C_THRU_PLUGIN_HOOK unset → never skip.
#
# Do NOT treat Claude Code's hook-payload session_id as a cthru launch signal.
# Hooks often re-export stdin session_id into C_THRU_SESSION_ID; that is not
# "launched by cthru". Use C_THRU_FROM_CLI=1 (set by tools/c-thru) or a pure
# digit C_THRU_SESSION_ID (legacy: cthru exports $$).

cthru_plugin_hook_should_skip() {
  # Only applies to plugin-manifest invocations
  [[ "${C_THRU_PLUGIN_HOOK:-0}" == "1" ]] || return 1

  local cdir
  cdir="${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-${CLAUDE_DIR:-$HOME/.claude}}}"

  # Launched by cthru CLI: plugin hooks must not double-work with inject.
  if [[ "${C_THRU_FROM_CLI:-0}" == "1" ]]; then
    return 0
  fi
  # Legacy: cthru exports C_THRU_SESSION_ID="$$" (decimal pid only).
  if [[ -n "${C_THRU_SESSION_ID:-}" && "${C_THRU_SESSION_ID}" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  # Shape C CLI installed: skip plugin hook work (except install-cli path
  # which is a command, not these lifecycle hooks). Lite keeps plugin routing.
  if [[ -f "${cdir}/.c-thru-cli-installed" && "${C_THRU_PLUGIN_LITE:-0}" != "1" ]]; then
    return 0
  fi

  return 1
}
