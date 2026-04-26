#!/usr/bin/env bash
# c-thru installer: symlinks router/proxy + helpers into ~/.claude/tools/
# and seeds a user-level model-map on first run.
# Safe to re-run: each step checks current state before acting.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
NC='\033[0m'

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
TOOLS_SRC="$REPO_DIR/tools"
TOOLS_DEST="$CLAUDE_DIR/tools"

JQ_AVAILABLE=0
if command -v jq >/dev/null 2>&1; then
    JQ_AVAILABLE=1
fi

DEPS_WARN=0

echo -e "${YELLOW}🔧 c-thru installer — ${REPO_DIR}${NC}"

if [ ! -d "$TOOLS_SRC" ]; then
    echo -e "${RED}❌ Missing ${TOOLS_SRC}${NC}" >&2
    exit 1
fi

chmod +x "$TOOLS_SRC/c-thru" "$TOOLS_SRC/claude-proxy" "$TOOLS_SRC/llm-capabilities-mcp.js" "$TOOLS_SRC/model-map-sync.js" "$TOOLS_SRC/model-map-validate.js" "$TOOLS_SRC/model-map-edit.js" "$TOOLS_SRC/model-map-layered.js" 2>/dev/null || true
# llm-capabilities-shared.js is a library, not executable
chmod +x "$TOOLS_SRC/verify-llm-capabilities-mcp.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-proxy-health.sh" "$TOOLS_SRC/c-thru-session-start.sh" "$TOOLS_SRC/c-thru-map-changed.sh" "$TOOLS_SRC/c-thru-classify.sh" "$TOOLS_SRC/c-thru-ollama-probe.sh" "$TOOLS_SRC/c-thru-postcompact-context.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-stop-hook.sh" "$TOOLS_SRC/c-thru-statusline.sh" "$TOOLS_SRC/c-thru-statusline-overlay.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-contract-check.sh" "$TOOLS_SRC/c-thru-self-update.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/model-map-apply-recommendations.js" "$TOOLS_SRC/verify-lmstudio-ollama-compat.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/model-map-resolve.js" "$TOOLS_SRC/c-thru-resolve" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-enter-plan-hook.sh" 2>/dev/null || true

mkdir -p "$TOOLS_DEST"

# --- Idempotent symlink helper ---
link_tool() {
    local src="$1" dest_name="$2"
    local dest="$TOOLS_DEST/$dest_name"
    local want="$TOOLS_SRC/$src"
    [ -x "$want" ] || return 0

    if [ -L "$dest" ]; then
        local current
        current="$(readlink "$dest")"
        if [ "$current" = "$want" ]; then
            echo -e "  ${GRAY}✓  ${dest_name}${NC}"
            return 0
        fi
        ln -sfn "$want" "$dest"
        echo -e "  ${GREEN}✅ ${dest_name} — updated (was: ${current})${NC}"
    elif [ -e "$dest" ]; then
        echo -e "  ${YELLOW}⚠️  ${dest_name} — exists as a real file, not a symlink; skipping${NC}"
    else
        ln -sfn "$want" "$dest"
        echo -e "  ${GREEN}✅ ${dest_name} — installed${NC}"
    fi
}

echo ""
echo "Tools:"
link_tool c-thru c-thru
link_tool c-thru claude-router
link_tool claude-proxy claude-proxy
if [ "$JQ_AVAILABLE" -eq 0 ]; then
    DEPS_WARN=1
    echo -e "  ${YELLOW}⚠️  jq not found — some install steps will be skipped${NC}"
fi
if command -v node >/dev/null 2>&1; then
    link_tool llm-capabilities-mcp.js llm-capabilities-mcp
    link_tool model-map-validate.js model-map-validate
    link_tool model-map-sync.js model-map-sync
    link_tool model-map-edit.js model-map-edit
    link_tool model-map-resolve.js model-map-resolve.js
    link_tool c-thru-resolve c-thru-resolve
else
    DEPS_WARN=1
    echo -e "  ${YELLOW}⚠️  node not found — claude-proxy requires Node.js ≥ 15${NC}"
fi
link_tool verify-llm-capabilities-mcp.sh verify-llm-capabilities-mcp
link_tool c-thru-proxy-health.sh c-thru-proxy-health
link_tool c-thru-session-start.sh c-thru-session-start
link_tool c-thru-map-changed.sh c-thru-map-changed
link_tool c-thru-classify.sh c-thru-classify
link_tool c-thru-stop-hook.sh c-thru-stop-hook
link_tool c-thru-statusline.sh c-thru-statusline
link_tool c-thru-statusline-overlay.sh c-thru-statusline-overlay
link_tool c-thru-ollama-gc.sh c-thru-ollama-gc
link_tool c-thru-contract-check.sh c-thru-contract-check
link_tool c-thru-self-update.sh c-thru-self-update
link_tool verify-lmstudio-ollama-compat.sh verify-lmstudio-ollama-compat
link_tool c-thru-ollama-probe.sh c-thru-ollama-probe
link_tool c-thru-enter-plan-hook.sh c-thru-enter-plan-hook
link_tool c-thru-postcompact-context.sh c-thru-postcompact-context

# --- Migrate legacy providers schema ---
migrate_providers_schema() {
    local file="$1"
    [ -f "$file" ] || return 0
    jq -e '.providers' "$file" >/dev/null 2>&1 || return 0
    local timestamp
    timestamp=$(date '+%Y%m%d_%H%M%S')
    local backup="${file}.bak.${timestamp}"
    cp "$file" "$backup"
    local migrated tmp
    migrated=$(jq '
      .providers as $prov |
      . + {
        backends: (
          (.backends // {}) + (
            $prov | to_entries | map(
              .key as $k | .value as $v |
              if ($v.auth_token == "ollama")
              then {key: $k, value: {kind: "ollama", url: ($v.base_url // "")}}
              else {key: $k, value: {kind: "anthropic", url: ($v.base_url // ""), auth_env: "ANTHROPIC_API_KEY"}}
              end
            ) | from_entries
          )
        ),
        model_routes: (
          ($prov | keys | map({key: ., value: .}) | from_entries) + (.model_routes // {})
        )
      } | del(.providers)
    ' "$file")
    tmp="${file}.tmp.$$"
    printf '%s\n' "$migrated" > "$tmp"
    mv "$tmp" "$file"
    echo -e "  ${GREEN}✅ Migrated legacy provider schema${NC}"
}

# --- Skill: /c-thru-status command file ---
install_skill() {
    local commands_dir="$CLAUDE_DIR/commands"
    local skill_file="$commands_dir/c-thru-status.md"
    local canonical_line='~/.claude/tools/c-thru --list $ARGUMENTS'
    mkdir -p "$commands_dir"
    if [ -f "$skill_file" ] && grep -qF "$canonical_line" "$skill_file" 2>/dev/null; then
        echo -e "  ${GRAY}✓  /c-thru-status${NC}"
        return 0
    fi
    cat > "$skill_file" << 'SKILL_EOF'
---
description: "Show c-thru routes, models, and backend health. Use 'fix' to pull missing models and reload."
allowed-tools: "Bash"
---
# c-thru Status
If `$ARGUMENTS` is empty or `--verbose`, run:
```bash
~/.claude/tools/c-thru --list $ARGUMENTS
```
SKILL_EOF
    echo -e "  ${GREEN}✅ installed skill: /c-thru-status${NC}"
}

# --- /cplan command shortcut ---
install_cplan_command() {
    local commands_dir="$CLAUDE_DIR/commands"
    local cmd_file="$commands_dir/cplan.md"
    local canonical_line='skill="c-thru-plan"'
    mkdir -p "$commands_dir"
    if [ -f "$cmd_file" ] && grep -qF "$canonical_line" "$cmd_file" 2>/dev/null; then
        echo -e "  ${GRAY}✓  /cplan${NC}"
        return 0
    fi
    cat > "$cmd_file" << 'CPLAN_EOF'
---
description: "Shortcut for /c-thru-plan — wave-based agentic planner"
allowed-tools: "Skill"
---
Invoke Skill(skill="c-thru-plan")
CPLAN_EOF
    echo -e "  ${GREEN}✅ installed command: /cplan${NC}"
}

# --- Agentic plan/wave: skill symlinks ---
install_skills_cthru() {
    local skills_src="$REPO_DIR/skills"
    local skills_dest="$CLAUDE_DIR/skills/c-thru"
    mkdir -p "$skills_dest" || return 1
    local installed=0
    for src in "$skills_src"/*/; do
        [ -d "$src" ] || continue
        local name
        name="$(basename "$src")"
        local dest="$skills_dest/$name"
        if [ ! -L "$dest" ] || [ "$(readlink "$dest")" != "${src%/}" ]; then
            ln -sfn "${src%/}" "$dest"
            installed=$((installed + 1))
        fi
    done
    [ $installed -gt 0 ] && echo -e "  ${GREEN}✅ skills/c-thru/ symlinked${NC}"
}

# --- Agentic plan/wave: extend model-map.system.json ---
extend_model_map() {
    [ "$JQ_AVAILABLE" -eq 1 ] || return 0
    local system_map="$CLAUDE_DIR/model-map.system.json"
    local shipped_map="$REPO_DIR/config/model-map.json"
    [ -f "$system_map" ] || return 0
    local already
    already=$(jq -r '.llm_profiles["128gb"]["judge"] // empty' "$system_map" 2>/dev/null || true)
    [ -n "$already" ] && return 0
    local tmp="${system_map}.tmp.$$"
    jq --slurpfile shipped "$shipped_map" '
        .llm_profiles = (.llm_profiles // {} | to_entries | map(.value = (.value + $shipped[0].llm_profiles[.key]) | select(.value != null)) | from_entries) |
        .agent_to_capability = ($shipped[0].agent_to_capability // {})
    ' "$system_map" > "$tmp" && mv "$tmp" "$system_map"
    echo -e "  ${GREEN}✅ model-map.system.json extended${NC}"
}

cleanup_old_persistent_config() {
    echo ""
    echo "Cleanup (migrating to ephemeral config):"
    local settings="$CLAUDE_DIR/settings.json"
    local claude_json="$HOME/.claude.json"
    local agents_dest="$CLAUDE_DIR/agents/c-thru"

    if [ -d "$agents_dest" ]; then
        rm -rf "$agents_dest"
        echo -e "  ${GREEN}✅ removed persistent agents: $agents_dest${NC}"
    fi
    local skills_dest="$CLAUDE_DIR/skills/c-thru"
    if [ -d "$skills_dest" ]; then
        rm -rf "$skills_dest"
        echo -e "  ${GREEN}✅ removed persistent skills: $skills_dest${NC}"
    fi

    if [ "$JQ_AVAILABLE" -eq 1 ]; then
        if [ -f "$settings" ]; then
            local tmp="${settings}.tmp.$$"
            jq --arg tools "$TOOLS_DEST" '
                if .hooks then
                  .hooks |= with_entries(
                    .value |= map(
                      .hooks |= map(select((.command // "") | startswith($tools) | not))
                    ) | map(select(.hooks | length > 0))
                  ) | .hooks |= with_entries(select(.value | length > 0))
                else . end
            ' "$settings" > "$tmp" && mv "$tmp" "$settings"
            echo -e "  ${GREEN}✅ cleaned up persistent hooks from settings.json${NC}"
        fi
        if [ -f "$claude_json" ]; then
            local tmp="${claude_json}.tmp.$$"
            jq 'if .mcpServers then del(.mcpServers["llm-capabilities"]) else . end' "$claude_json" > "$tmp" && mv "$tmp" "$claude_json"
            echo -e "  ${GREEN}✅ cleaned up persistent MCP from .claude.json${NC}"
        fi
    fi
}

echo ""
echo "Model-map:"
SYS_MAP="$CLAUDE_DIR/model-map.system.json"
OVR_MAP="$CLAUDE_DIR/model-map.overrides.json"
USER_MAP="$CLAUDE_DIR/model-map.json"
SHIPPED_MAP="$REPO_DIR/config/model-map.json"

if [ ! -f "$OVR_MAP" ]; then echo '{}' > "$OVR_MAP"; fi
if [ -f "$SHIPPED_MAP" ] && command -v node >/dev/null 2>&1; then
    node "$TOOLS_SRC/model-map-sync.js" "$SHIPPED_MAP" "$OVR_MAP" "$USER_MAP.tmp" "$USER_MAP" 2>/dev/null || true
    cp "$SHIPPED_MAP" "$SYS_MAP"
    [ -f "$USER_MAP.tmp" ] && mv "$USER_MAP.tmp" "$USER_MAP"
    echo -e "  ${GREEN}✅ model-map.json updated${NC}"
fi

cleanup_old_persistent_config
install_skill
install_cplan_command
extend_model_map

echo ""
echo -e "${GREEN}✅ Done. c-thru is now using ephemeral session control.${NC}"
