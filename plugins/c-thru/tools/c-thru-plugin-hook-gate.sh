#!/usr/bin/env bash
# Gate for marketplace-plugin-invoked hooks (C_THRU_PLUGIN_HOOK=1).
# Source at the top of hook scripts after path resolve.
#
# Returns 0 from cthru_plugin_hook_should_skip if the hook body must not run.
# Canonical tools/* hooks (CLI inject) leave C_THRU_PLUGIN_HOOK unset → never skip.

cthru_plugin_hook_should_skip() {
  # Only applies to plugin-manifest invocations
  [[ "${C_THRU_PLUGIN_HOOK:-0}" == "1" ]] || return 1

  local cdir
  cdir="${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-${CLAUDE_DIR:-$HOME/.claude}}}"

  # Launched by cthru CLI: plugin hooks must not double-work
  if [[ -n "${C_THRU_SESSION_ID:-}" ]]; then
    return 0
  fi

  # Shape C CLI installed: skip plugin hook work (except install-cli path
  # which is a command, not these lifecycle hooks). Lite keeps plugin routing.
  if [[ -f "${cdir}/.c-thru-cli-installed" && "${C_THRU_PLUGIN_LITE:-0}" != "1" ]]; then
    return 0
  fi

  return 1
}
