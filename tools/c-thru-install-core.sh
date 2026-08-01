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

# Resolve plugin version string from a package or monorepo root.
# Roots tried (first wins): explicit arg, C_THRU_PACKAGE_ROOT, REPO_DIR.
# Layouts: <root>/.claude-plugin/plugin.json (plugin package)
#          <root>/plugins/c-thru/.claude-plugin/plugin.json (monorepo)
cthru_plugin_version() {
  local root="${1:-${C_THRU_PACKAGE_ROOT:-${REPO_DIR:-}}}"
  local pj
  [[ -n "$root" ]] || return 1
  for pj in \
    "${root}/.claude-plugin/plugin.json" \
    "${root}/plugins/c-thru/.claude-plugin/plugin.json"
  do
    if [[ -f "$pj" ]] && command -v node >/dev/null 2>&1; then
      local v
      v="$(node -e "try{const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version;if(v)process.stdout.write(String(v))}catch(e){}" "$pj" 2>/dev/null || true)"
      if [[ -n "$v" ]]; then
        printf '%s' "$v"
        return 0
      fi
    fi
  done
  return 1
}

# Remove durable loopback ANTHROPIC_BASE_URL (plugin fixed-port residue).
# Never touches non-loopback URLs. Uses node (always available if proxy is).
cthru_scrub_loopback_base_url() {
  local settings="${CLAUDE_DIR}/settings.json"
  [[ -f "$settings" ]] || return 0
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs=require("fs");
      const f=process.argv[1];
      let s;
      try { s=JSON.parse(fs.readFileSync(f,"utf8")); } catch(e) { process.exit(0); }
      const u=s&&s.env&&s.env.ANTHROPIC_BASE_URL;
      if(!u||typeof u!=="string") process.exit(0);
      if(!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(u)) process.exit(0);
      delete s.env.ANTHROPIC_BASE_URL;
      if(s.env&&Object.keys(s.env).length===0) delete s.env;
      fs.writeFileSync(f, JSON.stringify(s,null,2)+"\n");
    ' "$settings" 2>/dev/null || true
  elif command -v jq >/dev/null 2>&1; then
    local base_url tmp
    base_url=$(jq -r '.env.ANTHROPIC_BASE_URL // empty' "$settings" 2>/dev/null || true)
    case "$base_url" in
      http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*)
        tmp="${settings}.tmp.$$"
        jq 'if .env and .env.ANTHROPIC_BASE_URL then
              del(.env.ANTHROPIC_BASE_URL)
              | (if (.env|length)==0 then del(.env) else . end)
            else . end' "$settings" >"$tmp" && mv "$tmp" "$settings"
        ;;
    esac
  fi
  rm -f "${CLAUDE_DIR}/.c-thru-plugin-setup-pending" 2>/dev/null || true
}

# Actual checkout identity for a git root (never invents a missed pin tag).
cthru_git_actual_sha() {
  local root="${1:-}"
  # Worktrees use a .git *file* (gitdir: …), not a directory — test -e, not -d.
  [[ -n "$root" && -e "$root/.git" ]] || return 1
  command -v git >/dev/null 2>&1 || return 1
  git -C "$root" rev-parse HEAD 2>/dev/null
}

cthru_git_actual_ref() {
  local root="${1:-}" abr
  [[ -n "$root" && -e "$root/.git" ]] || return 1
  command -v git >/dev/null 2>&1 || return 1
  abr="$(git -C "$root" describe --tags --exact-match 2>/dev/null || true)"
  if [[ -n "$abr" ]]; then
    printf '%s' "$abr"
    return 0
  fi
  abr="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -n "$abr" && "$abr" != "HEAD" ]]; then
    printf '%s' "$abr"
    return 0
  fi
  # Detached without tag: short SHA as ref label
  git -C "$root" rev-parse --short HEAD 2>/dev/null
}

cthru_write_stamp() {
  local root="${1:-$REPO_DIR}"
  local ver ref sha
  ver="$(cthru_plugin_version "$root")"
  [[ -n "$ver" ]] || ver="unknown"
  # Prefer actual git identity; never stamp a desired pin that is not checked out.
  sha=""
  ref=""
  if sha="$(cthru_git_actual_sha "$root" 2>/dev/null)"; then
    ref="$(cthru_git_actual_ref "$root" 2>/dev/null || true)"
    if [[ -n "${C_THRU_SOURCE_REF:-}" ]] && cthru_git_at_ref "$root" "${C_THRU_SOURCE_REF}"; then
      ref="${C_THRU_SOURCE_REF}"
    fi
  else
    ref="${C_THRU_SOURCE_REF:-}"
  fi
  [[ -n "$ref" ]] || ref="unknown"
  mkdir -p "$CLAUDE_DIR"
  local tmp
  tmp="$(cthru_stamp_path).tmp.$$"
  cat >"$tmp" <<EOF
version=${ver}
source_root=${root}
source_ref=${ref}
source_sha=${sha}
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  mv -f "$tmp" "$(cthru_stamp_path)"
  # Shape C: do not leave plugin fixed-port routing fighting cthru process env
  cthru_scrub_loopback_base_url
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

# Desired git ref for S1 pin (tag vX.Y.Z matching plugin version when possible).
#
# Input override: C_THRU_SOURCE_REF_DESIRED (preferred) or C_THRU_SOURCE_REF when
# C_THRU_SOURCE_REF_IS_ACTUAL is not 1 (actual exports must not re-enter as pin).
# Package root: arg → C_THRU_PACKAGE_ROOT → REPO_DIR.
# Fail-closed: if version undiscoverable and C_THRU_ALLOW_UNPINNED!=1, return 1.
cthru_desired_source_ref() {
  local ver root="${1:-${C_THRU_PACKAGE_ROOT:-${REPO_DIR:-}}}"
  local override="${C_THRU_SOURCE_REF_DESIRED:-}"
  if [[ -z "$override" && "${C_THRU_SOURCE_REF_IS_ACTUAL:-0}" != "1" && -n "${C_THRU_SOURCE_REF:-}" ]]; then
    override="${C_THRU_SOURCE_REF}"
  fi
  if [[ -n "$override" ]]; then
    printf '%s' "$override"
    return 0
  fi
  if ver="$(cthru_plugin_version "$root" 2>/dev/null)"; then
    if [[ -n "$ver" && "$ver" != "unknown" ]]; then
      printf 'v%s' "$ver"
      return 0
    fi
  fi
  if [[ "${C_THRU_ALLOW_UNPINNED:-0}" == "1" ]]; then
    printf 'main'
    return 0
  fi
  return 1
}

# True if root HEAD equals the commit named by want (tag/branch/sha).
cthru_git_at_ref() {
  local root="$1" want="$2" head tip
  [[ -n "$root" && -n "$want" ]] || return 1
  head="$(git -C "$root" rev-parse HEAD 2>/dev/null)" || return 1
  tip="$(git -C "$root" rev-parse --verify --quiet "${want}^{commit}" 2>/dev/null)" || return 1
  [[ -n "$head" && -n "$tip" && "$head" == "$tip" ]]
}

cthru_try_pin_checkout() {
  local root="$1" want="$2"
  git -C "$root" fetch --depth 1 origin "refs/tags/${want}:refs/tags/${want}" >/dev/null 2>&1 \
    || git -C "$root" fetch --depth 1 origin "$want" >/dev/null 2>&1 || true
  git -C "$root" checkout --detach "tags/${want}" >/dev/null 2>&1 \
    || git -C "$root" checkout --detach "$want" >/dev/null 2>&1 \
    || return 1
  cthru_git_at_ref "$root" "$want"
}

# After pin attempt: record **actual** checkout only (never the desired pin).
# Sets C_THRU_SOURCE_REF_IS_ACTUAL=1 so desired_source_ref will not treat actual
# as a user pin override on a later call in the same shell.
cthru_export_actual_source_ref() {
  local root="$1"
  local actual sha
  actual="$(cthru_git_actual_ref "$root" 2>/dev/null || true)"
  sha="$(cthru_git_actual_sha "$root" 2>/dev/null || true)"
  export C_THRU_SOURCE_ACTUAL_REF="${actual:-}"
  export C_THRU_SOURCE_ACTUAL_SHA="${sha:-}"
  if [[ -n "$actual" ]]; then
    export C_THRU_SOURCE_REF="$actual"
    export C_THRU_SOURCE_REF_IS_ACTUAL=1
  else
    unset C_THRU_SOURCE_REF || true
    unset C_THRU_SOURCE_REF_IS_ACTUAL || true
  fi
}

# S1: durable full tree at $CLAUDE_DIR/c-thru-src → sets REPO_DIR
# Fail-closed: pin to v<plugin-version> (or C_THRU_SOURCE_REF). If pin cannot
# be checked out, return non-zero unless C_THRU_ALLOW_UNPINNED=1 (then clone
# default branch and stamp **actual** identity only).
cthru_ensure_source_root_s1() {
  cthru_core_colors
  local src remote desired pin_ok=0 pkg
  src="$(cthru_src_path)"
  remote="${C_THRU_GIT_REMOTE:-$CTHRU_DEFAULT_REMOTE}"
  # Package root: optional arg $1, else C_THRU_PACKAGE_ROOT, else REPO_DIR
  pkg="${1:-${C_THRU_PACKAGE_ROOT:-${REPO_DIR:-}}}"
  if [[ -n "$pkg" ]]; then
    export C_THRU_PACKAGE_ROOT="$pkg"
  fi
  # Capture user pin override before any actual-export mutates C_THRU_SOURCE_REF
  if [[ -n "${C_THRU_SOURCE_REF:-}" && "${C_THRU_SOURCE_REF_IS_ACTUAL:-0}" != "1" ]]; then
    export C_THRU_SOURCE_REF_DESIRED="${C_THRU_SOURCE_REF_DESIRED:-$C_THRU_SOURCE_REF}"
  fi
  if ! desired="$(cthru_desired_source_ref "$pkg")"; then
    echo -e "${RED}c-thru bootstrap: cannot resolve pin ref (set C_THRU_PACKAGE_ROOT to plugin package, or C_THRU_SOURCE_REF / C_THRU_ALLOW_UNPINNED=1)${NC}" >&2
    return 1
  fi

  if cthru_repo_is_complete "$src"; then
    cthru_chmod_tree_bins "$src"
    if [[ -d "$src/.git" ]] && command -v git >/dev/null 2>&1; then
      if cthru_try_pin_checkout "$src" "$desired"; then
        pin_ok=1
      elif [[ "${C_THRU_ALLOW_UNPINNED:-0}" == "1" ]]; then
        echo -e "${YELLOW}c-thru bootstrap: pin ${desired} unavailable; C_THRU_ALLOW_UNPINNED=1 — using current tree${NC}" >&2
        [[ "${C_THRU_BOOTSTRAP_PULL:-1}" == "1" ]] && git -C "$src" pull --ff-only >/dev/null 2>&1 || true
        pin_ok=1
      else
        echo -e "${RED}c-thru bootstrap: cannot pin ${desired} at ${src} (set C_THRU_ALLOW_UNPINNED=1 to override)${NC}" >&2
        return 1
      fi
    else
      # Complete tree without .git (copied product tree) — accept as-is
      pin_ok=1
    fi
    cthru_export_actual_source_ref "$src"
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
    :
  elif [[ -e "$src" ]]; then
    echo -e "${RED}c-thru bootstrap: ${src} exists but is not a complete c-thru tree${NC}" >&2
    return 1
  else
    echo -e "${YELLOW}c-thru bootstrap: cloning ${remote} (${desired}) → ${src}${NC}" >&2
    if git clone --depth 1 --branch "$desired" "$remote" "$src" >&2; then
      pin_ok=1
    elif [[ "${C_THRU_ALLOW_UNPINNED:-0}" == "1" ]]; then
      echo -e "${YELLOW}c-thru bootstrap: pin ${desired} missing on remote; C_THRU_ALLOW_UNPINNED=1 — cloning default branch${NC}" >&2
      rm -rf "$src"
      if ! git clone --depth 1 "$remote" "$src" >&2; then
        echo -e "${RED}c-thru bootstrap: git clone failed${NC}" >&2
        return 1
      fi
      pin_ok=1
    else
      echo -e "${RED}c-thru bootstrap: pin ${desired} not on remote (set C_THRU_ALLOW_UNPINNED=1 to clone default branch)${NC}" >&2
      return 1
    fi
    # Prefer detached tag when clone used branch name that is a tag
    git -C "$src" checkout --detach "tags/${desired}" >/dev/null 2>&1 \
      || git -C "$src" checkout --detach "$desired" >/dev/null 2>&1 || true
  fi

  cthru_chmod_tree_bins "$src"
  if ! cthru_repo_is_complete "$src"; then
    echo -e "${RED}c-thru bootstrap: clone incomplete (need tools/c-thru, agents/, config/model-map.json)${NC}" >&2
    return 1
  fi

  # Fail-closed: if we claimed a pin, HEAD must resolve to desired when not unpinned.
  if [[ "${C_THRU_ALLOW_UNPINNED:-0}" != "1" ]]; then
    if [[ -d "$src/.git" ]] && ! cthru_git_at_ref "$src" "$desired"; then
      if ! cthru_try_pin_checkout "$src" "$desired"; then
        echo -e "${RED}c-thru bootstrap: HEAD is not pin ${desired} (set C_THRU_ALLOW_UNPINNED=1 to accept)${NC}" >&2
        return 1
      fi
    fi
  fi

  cthru_export_actual_source_ref "$src"
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
