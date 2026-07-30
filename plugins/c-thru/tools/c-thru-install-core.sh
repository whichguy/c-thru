#!/usr/bin/env bash
# Shared installer core for Shape C (install.sh + plugin bootstrap).
# Source with REPO_DIR and CLAUDE_DIR set. Safe under set -euo pipefail when
# callers handle return codes.
#
# Exports / expects:
#   REPO_DIR     — full c-thru source tree (must contain tools/c-thru, agents/, config/)
#   CLAUDE_DIR   — profile root (default ~/.claude)
#   C_THRU_INSTALL_NO_PATH — if 1, skip shell rc PATH edit

: "${CLAUDE_DIR:=${CLAUDE_PROFILE_DIR:-$HOME/.claude}}"

CTHRU_CLI_STAMP_NAME=".c-thru-cli-installed"
CTHRU_SRC_DIR_NAME="c-thru-src"
CTHRU_DEFAULT_REMOTE="${C_THRU_GIT_REMOTE:-https://github.com/whichguy/c-thru.git}"

cthru_core_colors() {
  if [[ -z "${RED:-}" ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    GRAY='\033[0;90m'
    NC='\033[0m'
  fi
}

cthru_tools_dest() {
  printf '%s' "${CLAUDE_DIR}/tools"
}

cthru_stamp_path() {
  printf '%s' "${CLAUDE_DIR}/${CTHRU_CLI_STAMP_NAME}"
}

cthru_src_path() {
  printf '%s' "${CLAUDE_DIR}/${CTHRU_SRC_DIR_NAME}"
}

# Return 0 if REPO_DIR looks like a full c-thru tree suitable for CTHRU_REPO_ROOT.
cthru_repo_is_complete() {
  local root="${1:-$REPO_DIR}"
  [[ -x "$root/tools/c-thru" ]] && [[ -d "$root/agents" ]] && [[ -f "$root/config/model-map.json" ]]
}

cthru_plugin_version() {
  local pj="${1:-}/plugins/c-thru/.claude-plugin/plugin.json"
  [[ -f "$pj" ]] || pj="${1:-}/.claude-plugin/plugin.json"
  if [[ -f "$pj" ]] && command -v node >/dev/null 2>&1; then
    node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version||'')}catch(e){}" "$pj" 2>/dev/null || true
  fi
}

cthru_write_stamp() {
  local root="${1:-$REPO_DIR}"
  local ver
  ver="$(cthru_plugin_version "$root")"
  [[ -n "$ver" ]] || ver="unknown"
  mkdir -p "$CLAUDE_DIR"
  cat >"$(cthru_stamp_path)" <<EOF
version=${ver}
source_root=${root}
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

cthru_read_stamp_field() {
  local key="$1"
  local f
  f="$(cthru_stamp_path)"
  [[ -f "$f" ]] || return 1
  grep -E "^${key}=" "$f" 2>/dev/null | head -1 | cut -d= -f2-
}

# 0 = stamp present and source_root still has tools/c-thru symlink target healthy
cthru_stamp_is_healthy() {
  local root dest
  root="$(cthru_read_stamp_field source_root 2>/dev/null || true)"
  [[ -n "$root" ]] || return 1
  cthru_repo_is_complete "$root" || return 1
  dest="$(cthru_tools_dest)/c-thru"
  [[ -L "$dest" || -x "$dest" ]] || return 1
  return 0
}

cthru_link_tool() {
  local src="$1" dest_name="$2"
  local tools_src="${REPO_DIR}/tools"
  local tools_dest
  tools_dest="$(cthru_tools_dest)"
  local dest="$tools_dest/$dest_name"
  local want="$tools_src/$src"
  cthru_core_colors
  if [[ ! -e "$want" ]]; then return 0; fi
  if [[ ! -x "$want" ]]; then
    echo -e "  ${YELLOW}⚠️  ${dest_name} — source ${src} exists but is not executable; skipping${NC}"
    return 0
  fi
  mkdir -p "$tools_dest"
  if [[ -L "$dest" ]]; then
    local current
    current="$(readlink "$dest")"
    if [[ "$current" == "$want" ]]; then
      echo -e "  ${GRAY}✓  ${dest_name}${NC}"
      return 0
    fi
    ln -sfn "$want" "$dest"
    echo -e "  ${GREEN}✅ ${dest_name} — updated (was: ${current})${NC}"
  elif [[ -e "$dest" ]]; then
    echo -e "  ${YELLOW}⚠️  ${dest_name} — exists as a real file, not a symlink; skipping${NC}"
  else
    ln -sfn "$want" "$dest"
    echo -e "  ${GREEN}✅ ${dest_name} — installed${NC}"
  fi
}

cthru_link_all_tools() {
  cthru_core_colors
  echo ""
  echo "Tools:"
  cthru_link_tool c-thru c-thru
  cthru_link_tool c-thru cthru
  cthru_link_tool c-thru claude-router
  cthru_link_tool claude-proxy claude-proxy
  if command -v node >/dev/null 2>&1; then
    cthru_link_tool llm-capabilities-mcp.js llm-capabilities-mcp
    cthru_link_tool model-map-validate.js model-map-validate
    cthru_link_tool model-map-sync.js model-map-sync
    cthru_link_tool model-map-edit.js model-map-edit
    cthru_link_tool model-map-resolve.js model-map-resolve.js
    cthru_link_tool c-thru-resolve c-thru-resolve
  fi
  cthru_link_tool verify-llm-capabilities-mcp.sh verify-llm-capabilities-mcp
  cthru_link_tool c-thru-proxy-health.sh c-thru-proxy-health
  cthru_link_tool c-thru-session-start.sh c-thru-session-start
  cthru_link_tool c-thru-map-changed.sh c-thru-map-changed
  cthru_link_tool c-thru-classify.sh c-thru-classify
  cthru_link_tool c-thru-stop-hook.sh c-thru-stop-hook
  cthru_link_tool c-thru-stop-failure-hook.sh c-thru-stop-failure-hook
  cthru_link_tool c-thru-ensure-proxy-on-port.sh c-thru-ensure-proxy-on-port
  cthru_link_tool c-thru-revive-agent-sessions.sh c-thru-revive-agent-sessions
  cthru_link_tool c-thru-gateway-auth-helper.sh c-thru-gateway-auth-helper
  cthru_link_tool c-thru-statusline.sh c-thru-statusline
  cthru_link_tool c-thru-statusline-overlay.sh c-thru-statusline-overlay
  cthru_link_tool c-thru-ollama-gc.sh c-thru-ollama-gc
  cthru_link_tool c-thru-contract-check.sh c-thru-contract-check
  cthru_link_tool c-thru-hygiene-check.sh c-thru-hygiene-check
  cthru_link_tool c-thru-self-update.sh c-thru-self-update
  cthru_link_tool c-thru-marketplace-update.sh c-thru-marketplace-update
  cthru_link_tool verify-lmstudio-ollama-compat.sh verify-lmstudio-ollama-compat
  cthru_link_tool c-thru-ollama-probe.sh c-thru-ollama-probe
  cthru_link_tool c-thru-enter-plan-hook.sh c-thru-enter-plan-hook
  cthru_link_tool c-thru-agent-router-hook.sh c-thru-agent-router-hook
  cthru_link_tool c-thru-postcompact-context.sh c-thru-postcompact-context
  cthru_link_tool c-thru-install-core.sh c-thru-install-core
  cthru_link_tool c-thru-plugin-bootstrap.sh c-thru-plugin-bootstrap
  cthru_link_tool c-thru-setup-messages.sh c-thru-setup-messages
}

cthru_seed_model_map() {
  cthru_core_colors
  local shipped="${REPO_DIR}/config/model-map.json"
  local sys_map="${CLAUDE_DIR}/model-map.system.json"
  local ovr_map="${CLAUDE_DIR}/model-map.overrides.json"
  local user_map="${CLAUDE_DIR}/model-map.json"
  local tools_src="${REPO_DIR}/tools"
  echo ""
  echo "Model-map:"
  mkdir -p "$CLAUDE_DIR"
  if [[ ! -f "$ovr_map" ]]; then echo '{}' >"$ovr_map"; fi
  if [[ -f "$shipped" ]] && command -v node >/dev/null 2>&1; then
    if [[ -f "$tools_src/model-map-sync.js" ]]; then
      node "$tools_src/model-map-sync.js" "$shipped" "$ovr_map" "" "$user_map" 2>/dev/null || true
    fi
    cp "$shipped" "$sys_map"
    echo -e "  ${GREEN}✅ model-map.json updated${NC}"
  elif [[ -f "$shipped" ]]; then
    cp "$shipped" "$sys_map"
    [[ -f "$user_map" ]] || cp "$shipped" "$user_map"
    echo -e "  ${GREEN}✅ model-map system seeded (no node — skip layered sync)${NC}"
  fi
}

# S1: ensure durable full tree at $CLAUDE_DIR/c-thru-src
# Sets REPO_DIR to that path on success.
cthru_ensure_source_root_s1() {
  cthru_core_colors
  local src remote
  src="$(cthru_src_path)"
  remote="${C_THRU_GIT_REMOTE:-$CTHRU_DEFAULT_REMOTE}"

  if cthru_repo_is_complete "$src"; then
    if [[ "${C_THRU_BOOTSTRAP_PULL:-1}" == "1" ]] && [[ -d "$src/.git" ]]; then
      git -C "$src" pull --ff-only 2>/dev/null || true
    fi
    REPO_DIR="$src"
    export REPO_DIR
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo -e "${RED}c-thru bootstrap: git not found — cannot clone source root${NC}" >&2
    return 1
  fi

  mkdir -p "$(dirname "$src")"
  if [[ -d "$src/.git" ]]; then
    git -C "$src" pull --ff-only 2>/dev/null || true
  elif [[ -e "$src" ]]; then
    echo -e "${RED}c-thru bootstrap: ${src} exists but is not a complete c-thru tree${NC}" >&2
    return 1
  else
    echo -e "${YELLOW}c-thru bootstrap: cloning ${remote} → ${src}${NC}"
    if ! git clone --depth 1 "$remote" "$src" 2>&1; then
      echo -e "${RED}c-thru bootstrap: git clone failed${NC}" >&2
      return 1
    fi
  fi

  if ! cthru_repo_is_complete "$src"; then
    echo -e "${RED}c-thru bootstrap: clone incomplete (missing tools/c-thru, agents/, or config/)${NC}" >&2
    return 1
  fi
  chmod +x "$src/tools/c-thru" "$src/tools/claude-proxy" 2>/dev/null || true
  REPO_DIR="$src"
  export REPO_DIR
  return 0
}

# Install tools + map + stamp for a complete REPO_DIR.
cthru_install_from_repo() {
  if ! cthru_repo_is_complete "${REPO_DIR:-}"; then
    echo "c-thru-install-core: REPO_DIR incomplete: ${REPO_DIR:-unset}" >&2
    return 1
  fi
  chmod +x "$REPO_DIR/tools/c-thru" "$REPO_DIR/tools/claude-proxy" 2>/dev/null || true
  cthru_link_all_tools
  cthru_seed_model_map
  cthru_write_stamp "$REPO_DIR"
  return 0
}
