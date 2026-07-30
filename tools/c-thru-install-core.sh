#!/usr/bin/env bash
# Shared installer core for Shape C (install.sh + plugin bootstrap).
# Source with REPO_DIR set (or set via cthru_ensure_source_root_s1).
# Callers may use set -euo pipefail; functions return non-zero on hard failure.
#
# Expects:
#   REPO_DIR     — full c-thru tree (tools/c-thru, agents/, config/) after ensure/install
#   CLAUDE_DIR   — profile root (default ~/.claude via CLAUDE_PROFILE_DIR)
#
# Env:
#   C_THRU_GIT_REMOTE       — clone URL (default github.com/whichguy/c-thru.git)
#   C_THRU_BOOTSTRAP_PULL   — 0 to skip git pull on existing c-thru-src (default 1)
#   C_THRU_FORCE_BOOTSTRAP  — used by bootstrap wrapper, not this file

: "${CLAUDE_DIR:=${CLAUDE_PROFILE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}}"

CTHRU_CLI_STAMP_NAME=".c-thru-cli-installed"
CTHRU_SRC_DIR_NAME="c-thru-src"
CTHRU_DEFAULT_REMOTE="https://github.com/whichguy/c-thru.git"

# Tools linked into $CLAUDE_DIR/tools (src name relative to REPO_DIR/tools).
# Format: "source_basename dest_name" — dest defaults to source if one field.
CTHRU_LINK_TOOLS=(
  "c-thru c-thru"
  "c-thru cthru"
  "c-thru claude-router"
  "claude-proxy claude-proxy"
  "verify-llm-capabilities-mcp.sh verify-llm-capabilities-mcp"
  "c-thru-proxy-health.sh c-thru-proxy-health"
  "c-thru-session-start.sh c-thru-session-start"
  "c-thru-map-changed.sh c-thru-map-changed"
  "c-thru-classify.sh c-thru-classify"
  "c-thru-stop-hook.sh c-thru-stop-hook"
  "c-thru-stop-failure-hook.sh c-thru-stop-failure-hook"
  "c-thru-ensure-proxy-on-port.sh c-thru-ensure-proxy-on-port"
  "c-thru-revive-agent-sessions.sh c-thru-revive-agent-sessions"
  "c-thru-gateway-auth-helper.sh c-thru-gateway-auth-helper"
  "c-thru-statusline.sh c-thru-statusline"
  "c-thru-statusline-overlay.sh c-thru-statusline-overlay"
  "c-thru-ollama-gc.sh c-thru-ollama-gc"
  "c-thru-contract-check.sh c-thru-contract-check"
  "c-thru-hygiene-check.sh c-thru-hygiene-check"
  "c-thru-self-update.sh c-thru-self-update"
  "c-thru-marketplace-update.sh c-thru-marketplace-update"
  "verify-lmstudio-ollama-compat.sh verify-lmstudio-ollama-compat"
  "c-thru-ollama-probe.sh c-thru-ollama-probe"
  "c-thru-enter-plan-hook.sh c-thru-enter-plan-hook"
  "c-thru-agent-router-hook.sh c-thru-agent-router-hook"
  "c-thru-postcompact-context.sh c-thru-postcompact-context"
  "c-thru-install-core.sh c-thru-install-core"
  "c-thru-plugin-bootstrap.sh c-thru-plugin-bootstrap"
  "c-thru-setup-messages.sh c-thru-setup-messages"
)

CTHRU_LINK_TOOLS_NODE=(
  "llm-capabilities-mcp.js llm-capabilities-mcp"
  "model-map-validate.js model-map-validate"
  "model-map-sync.js model-map-sync"
  "model-map-edit.js model-map-edit"
  "model-map-resolve.js model-map-resolve.js"
  "c-thru-resolve c-thru-resolve"
)

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

cthru_chmod_tree_bins() {
  local root="${1:-$REPO_DIR}"
  [[ -d "$root/tools" ]] || return 0
  chmod +x "$root/tools/c-thru" "$root/tools/claude-proxy" 2>/dev/null || true
  chmod +x "$root/tools/"*.sh "$root/tools/c-thru-resolve" 2>/dev/null || true
  chmod +x "$root/tools/"*.js 2>/dev/null || true
}

# Full tree check for CTHRU_REPO_ROOT (file presence; chmod separately).
cthru_repo_is_complete() {
  local root="${1:-${REPO_DIR:-}}"
  [[ -n "$root" ]] || return 1
  [[ -f "$root/tools/c-thru" ]] && [[ -d "$root/agents" ]] && [[ -f "$root/config/model-map.json" ]]
}

cthru_plugin_version() {
  local root="${1:-}"
  local pj
  for pj in \
    "${root}/plugins/c-thru/.claude-plugin/plugin.json" \
    "${root}/.claude-plugin/plugin.json"
  do
    if [[ -f "$pj" ]] && command -v node >/dev/null 2>&1; then
      node -e "try{const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version;if(v)process.stdout.write(String(v))}catch(e){}" "$pj" 2>/dev/null && return 0
    fi
  done
  return 0
}

cthru_write_stamp() {
  local root="${1:-$REPO_DIR}"
  local ver
  ver="$(cthru_plugin_version "$root")"
  [[ -n "$ver" ]] || ver="unknown"
  mkdir -p "$CLAUDE_DIR"
  # Atomic-ish write
  local tmp
  tmp="$(cthru_stamp_path).tmp.$$"
  cat >"$tmp" <<EOF
version=${ver}
source_root=${root}
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  mv -f "$tmp" "$(cthru_stamp_path)"
}

cthru_read_stamp_field() {
  local key="$1"
  local f
  f="$(cthru_stamp_path)"
  [[ -f "$f" ]] || return 1
  # Values may contain = ; take everything after first =
  grep -E "^${key}=" "$f" 2>/dev/null | head -1 | sed "s/^${key}=//"
}

# True if tools/c-thru resolves to an existing file (not a dangling symlink).
cthru_tools_c_thru_ok() {
  local dest
  dest="$(cthru_tools_dest)/c-thru"
  [[ -e "$dest" ]] || return 1
  # Prefer executable; file present is enough for health (chmod may fix later)
  [[ -f "$dest" || -L "$dest" ]]
}

# 0 = stamp + source root + tools link all healthy
cthru_stamp_is_healthy() {
  local root
  root="$(cthru_read_stamp_field source_root 2>/dev/null || true)"
  [[ -n "$root" ]] || return 1
  cthru_repo_is_complete "$root" || return 1
  cthru_tools_c_thru_ok || return 1
  return 0
}

# True if stamp version differs from version in a package root (empty versions skip).
cthru_stamp_version_stale_vs() {
  local package_root="${1:-}"
  local stamped pkg
  stamped="$(cthru_read_stamp_field version 2>/dev/null || true)"
  pkg="$(cthru_plugin_version "$package_root")"
  [[ -n "$stamped" && -n "$pkg" && "$stamped" != "$pkg" ]]
}

cthru_link_tool() {
  local src="$1" dest_name="$2"
  local tools_src="${REPO_DIR}/tools"
  local tools_dest dest want current
  tools_dest="$(cthru_tools_dest)"
  dest="$tools_dest/$dest_name"
  want="$tools_src/$src"
  cthru_core_colors
  if [[ ! -e "$want" ]]; then return 0; fi
  # Ensure linkable bits for scripts/binaries we ship
  chmod +x "$want" 2>/dev/null || true
  mkdir -p "$tools_dest"
  if [[ -L "$dest" ]]; then
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
  local entry src dest
  cthru_core_colors
  echo ""
  echo "Tools:"
  for entry in "${CTHRU_LINK_TOOLS[@]}"; do
    src="${entry%% *}"
    dest="${entry#* }"
    [[ "$dest" == "$entry" ]] && dest="$src"
    cthru_link_tool "$src" "$dest"
  done
  if command -v node >/dev/null 2>&1; then
    for entry in "${CTHRU_LINK_TOOLS_NODE[@]}"; do
      src="${entry%% *}"
      dest="${entry#* }"
      [[ "$dest" == "$entry" ]] && dest="$src"
      cthru_link_tool "$src" "$dest"
    done
  fi
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

# S1: durable full tree at $CLAUDE_DIR/c-thru-src → sets REPO_DIR
cthru_ensure_source_root_s1() {
  cthru_core_colors
  local src remote
  src="$(cthru_src_path)"
  remote="${C_THRU_GIT_REMOTE:-$CTHRU_DEFAULT_REMOTE}"

  if cthru_repo_is_complete "$src"; then
    cthru_chmod_tree_bins "$src"
    if [[ "${C_THRU_BOOTSTRAP_PULL:-1}" == "1" ]] && [[ -d "$src/.git" ]]; then
      git -C "$src" pull --ff-only >/dev/null 2>&1 || true
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
    git -C "$src" pull --ff-only >/dev/null 2>&1 || true
  elif [[ -e "$src" ]]; then
    echo -e "${RED}c-thru bootstrap: ${src} exists but is not a complete c-thru tree${NC}" >&2
    return 1
  else
    echo -e "${YELLOW}c-thru bootstrap: cloning ${remote} → ${src}${NC}" >&2
    if ! git clone --depth 1 "$remote" "$src" >&2; then
      echo -e "${RED}c-thru bootstrap: git clone failed${NC}" >&2
      return 1
    fi
  fi

  cthru_chmod_tree_bins "$src"
  if ! cthru_repo_is_complete "$src"; then
    echo -e "${RED}c-thru bootstrap: clone incomplete (need tools/c-thru, agents/, config/model-map.json)${NC}" >&2
    return 1
  fi
  REPO_DIR="$src"
  export REPO_DIR
  return 0
}

cthru_install_from_repo() {
  if ! cthru_repo_is_complete "${REPO_DIR:-}"; then
    echo "c-thru-install-core: REPO_DIR incomplete: ${REPO_DIR:-unset}" >&2
    return 1
  fi
  cthru_chmod_tree_bins "$REPO_DIR"
  cthru_link_all_tools
  cthru_seed_model_map
  cthru_write_stamp "$REPO_DIR"
  return 0
}
