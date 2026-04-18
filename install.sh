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
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
TOOLS_SRC="$REPO_DIR/tools"
TOOLS_DEST="$CLAUDE_DIR/tools"

JQ_AVAILABLE=0
if command -v jq >/dev/null 2>&1; then
    JQ_AVAILABLE=1
fi

echo -e "${YELLOW}🔧 c-thru installer — ${REPO_DIR}${NC}"

if [ ! -d "$TOOLS_SRC" ]; then
    echo -e "${RED}❌ Missing ${TOOLS_SRC}${NC}" >&2
    exit 1
fi

chmod +x "$TOOLS_SRC/claude-router" "$TOOLS_SRC/claude-proxy" 2>/dev/null || true
chmod +x "$TOOLS_SRC/claude-proxy" "$TOOLS_SRC/llm-capabilities-mcp.js" "$TOOLS_SRC/model-map-sync.js" "$TOOLS_SRC/model-map-validate.js" "$TOOLS_SRC/model-map-edit.js" "$TOOLS_SRC/model-map-layered.js" 2>/dev/null || true
# llm-capabilities-shared.js is a library, not executable
chmod +x "$TOOLS_SRC/verify-llm-capabilities-mcp.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-proxy-health.sh" "$TOOLS_SRC/c-thru-session-start.sh" "$TOOLS_SRC/c-thru-map-changed.sh" "$TOOLS_SRC/c-thru-classify.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-stop-hook.sh" "$TOOLS_SRC/c-thru-statusline.sh" "$TOOLS_SRC/c-thru-statusline-overlay.sh" 2>/dev/null || true

mkdir -p "$TOOLS_DEST"

# --- Idempotent symlink helper ---
# Prints:
#   ✓  name            — already correct, nothing to do
#   ✅ name            — created or updated (target changed)
#   ⚠️  name           — exists as a real file, not a symlink; skipped
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
link_tool claude-router claude-router
link_tool claude-router c-thru
link_tool claude-proxy claude-proxy
if command -v node >/dev/null 2>&1; then
    link_tool llm-capabilities-mcp.js llm-capabilities-mcp
    link_tool model-map-validate.js model-map-validate
    link_tool model-map-sync.js model-map-sync
    link_tool model-map-edit.js model-map-edit
else
    echo -e "  ${YELLOW}⚠️  node not found — skipping JS helper symlinks${NC}"
fi
link_tool verify-llm-capabilities-mcp.sh verify-llm-capabilities-mcp
link_tool c-thru-proxy-health.sh c-thru-proxy-health
link_tool c-thru-session-start.sh c-thru-session-start
link_tool c-thru-map-changed.sh c-thru-map-changed
link_tool c-thru-classify.sh c-thru-classify
link_tool c-thru-stop-hook.sh c-thru-stop-hook
link_tool c-thru-statusline.sh c-thru-statusline
link_tool c-thru-statusline-overlay.sh c-thru-statusline-overlay

# --- Migrate legacy providers schema ---
# Guard: jq -e '.providers' is a no-op if key is absent — idempotent by design.
migrate_providers_schema() {
    local file="$1"
    [ -f "$file" ] || return 0
    jq -e '.providers' "$file" >/dev/null 2>&1 || return 0

    local timestamp
    timestamp=$(date '+%Y%m%d_%H%M%S')
    local backup="${file}.bak.${timestamp}"
    cp "$file" "$backup"
    echo -e "  ${YELLOW}⚠️  Migrating legacy 'providers' schema${NC}"
    echo -e "  ${YELLOW}    Backup: ${backup}${NC}"

    local dropped
    dropped=$(jq -r '.providers | to_entries[] | select(.value | has("config_dir") or has("env") or (has("auth_token") and .auth_token != "ollama")) | .key' "$file" 2>/dev/null || true)
    if [ -n "$dropped" ]; then
        echo -e "  ${YELLOW}    Fields config_dir/env/auth_token cannot be auto-mapped; review these entries:${NC}"
        echo "$dropped" | while IFS= read -r k; do echo -e "  ${YELLOW}       - ${k}${NC}"; done
    fi

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

    local count
    count=$(printf '%s' "$migrated" | jq '.backends | length')
    echo -e "  ${GREEN}✅ Migrated ${count} provider(s) → backends + model_routes${NC}"
}

# --- MCP server registration in ~/.claude.json ---
register_mcp_server() {
    if [ "$JQ_AVAILABLE" -eq 0 ]; then
        echo -e "  ${YELLOW}⚠️  jq not found — skipping MCP registration${NC}"
        return 0
    fi

    local server_name="llm-capabilities"
    local mcp_js="$TOOLS_DEST/llm-capabilities-mcp"
    local claude_json="$HOME/.claude.json"

    if [ ! -f "$claude_json" ]; then
        echo '{}' > "$claude_json"
    fi

    local current_arg
    current_arg=$(jq -r --arg n "$server_name" '.mcpServers[$n].args[0] // empty' "$claude_json" 2>/dev/null || true)

    if [ "$current_arg" = "$mcp_js" ]; then
        echo -e "  ${GRAY}✓  llm-capabilities registered${NC}"
        return 0
    fi

    local tmp="${claude_json}.tmp.$$"
    jq --arg n "$server_name" --arg path "$mcp_js" \
        'if .mcpServers == null then .mcpServers = {} else . end |
         .mcpServers[$n] = {"type": "stdio", "command": "node", "args": [$path]}' \
        "$claude_json" > "$tmp"
    mv "$tmp" "$claude_json"

    if [ -n "$current_arg" ]; then
        echo -e "  ${GREEN}✅ updated (was: ${current_arg})${NC}"
    else
        echo -e "  ${GREEN}✅ registered llm-capabilities${NC}"
    fi
}

# --- Permission allow-list entry in ~/.claude/settings.json ---
add_permission() {
    if [ "$JQ_AVAILABLE" -eq 0 ]; then
        echo -e "  ${YELLOW}⚠️  jq not found — skipping permission${NC}"
        return 0
    fi

    local perm="mcp__llm-capabilities__*"
    local settings="$CLAUDE_DIR/settings.json"

    if [ ! -f "$settings" ]; then
        echo '{"permissions":{"allow":[]}}' > "$settings"
    fi

    local exists
    exists=$(jq -r --arg p "$perm" '(.permissions.allow // []) | map(select(. == $p)) | length' "$settings" 2>/dev/null || echo 0)

    if [ "${exists:-0}" -gt 0 ]; then
        echo -e "  ${GRAY}✓  ${perm} allowed${NC}"
        return 0
    fi

    local tmp="${settings}.tmp.$$"
    jq --arg p "$perm" '
        if .permissions == null then .permissions = {} else . end |
        if .permissions.allow == null then .permissions.allow = [] else . end |
        .permissions.allow += [$p]
    ' "$settings" > "$tmp"
    mv "$tmp" "$settings"
    echo -e "  ${GREEN}✅ added permission: ${perm}${NC}"
}

# --- Skill: /c-thru-status command file ---
install_skill() {
    local commands_dir="$CLAUDE_DIR/commands"
    local skill_file="$commands_dir/c-thru-status.md"
    local canonical_line='Run: ~/.claude/tools/claude-router --list $ARGUMENTS'

    mkdir -p "$commands_dir"

    if [ -f "$skill_file" ] && grep -qF "$canonical_line" "$skill_file" 2>/dev/null; then
        echo -e "  ${GRAY}✓  /c-thru-status${NC}"
        return 0
    fi

    cat > "$skill_file" << 'SKILL_EOF'
---
description: "Show c-thru routes, models, and backend health"
allowed-tools: "Bash"
---

# c-thru Status

Run: ~/.claude/tools/claude-router --list $ARGUMENTS
SKILL_EOF
    echo -e "  ${GREEN}✅ installed skill: /c-thru-status${NC}"
}

# --- Hooks: SessionStart, PostCompact, UserPromptSubmit ---
register_hooks() {
    if [ "$JQ_AVAILABLE" -eq 0 ]; then
        echo -e "  ${YELLOW}⚠️  jq not found — skipping hooks${NC}"
        return 0
    fi

    local settings="$CLAUDE_DIR/settings.json"
    local session_cmd="$TOOLS_DEST/c-thru-session-start"
    local health_cmd="$TOOLS_DEST/c-thru-proxy-health"
    local classify_cmd="$TOOLS_DEST/c-thru-classify"

    if [ ! -f "$settings" ]; then
        echo '{}' > "$settings"
    fi

    local tmp

    local hooks_url="http://127.0.0.1:${CLAUDE_PROXY_HOOKS_PORT:-9998}/hooks/context"

    # --- SessionStart (HTTP hook + command fallback) ---
    # Each sub-hook is registered independently to avoid duplication on re-runs.
    local ss_http_exists ss_cmd_exists
    ss_http_exists=$(jq -r --arg url "$hooks_url" \
        '(.hooks.SessionStart // []) | [.[].hooks[]?.url // ""] | map(select(contains($url))) | length' \
        "$settings" 2>/dev/null || echo 0)
    ss_cmd_exists=$(jq -r --arg cmd "$session_cmd" \
        '(.hooks.SessionStart // []) | [.[].hooks[]?.command // ""] | map(select(contains($cmd))) | length' \
        "$settings" 2>/dev/null || echo 0)

    local ss_changed=0
    if [ "${ss_http_exists:-0}" -gt 0 ]; then
        echo -e "  ${GRAY}✓  SessionStart HTTP hook${NC}"
    else
        tmp="${settings}.tmp.$$"
        jq --arg url "$hooks_url" '
            if .hooks == null then .hooks = {} else . end |
            if .hooks.SessionStart == null then .hooks.SessionStart = [] else . end |
            .hooks.SessionStart += [{"hooks": [{"type": "http", "url": $url, "timeout": 3}]}]
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        ss_changed=1
    fi
    if [ "${ss_cmd_exists:-0}" -gt 0 ]; then
        echo -e "  ${GRAY}✓  SessionStart command hook${NC}"
    else
        tmp="${settings}.tmp.$$"
        jq --arg cmd "$session_cmd" '
            if .hooks == null then .hooks = {} else . end |
            if .hooks.SessionStart == null then .hooks.SessionStart = [] else . end |
            .hooks.SessionStart += [{"hooks": [{"type": "command", "command": $cmd, "timeout": 5}]}]
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        ss_changed=1
    fi
    [ "$ss_changed" -eq 1 ] && echo -e "  ${GREEN}✅ registered hook: SessionStart (HTTP + command)${NC}"

    # --- PostCompact (HTTP hook + command fallback) ---
    local pc_http_exists pc_cmd_exists
    pc_http_exists=$(jq -r --arg url "$hooks_url" \
        '(.hooks.PostCompact // []) | [.[].hooks[]?.url // ""] | map(select(contains($url))) | length' \
        "$settings" 2>/dev/null || echo 0)
    pc_cmd_exists=$(jq -r --arg cmd "$session_cmd" \
        '(.hooks.PostCompact // []) | [.[].hooks[]?.command // ""] | map(select(contains($cmd))) | length' \
        "$settings" 2>/dev/null || echo 0)

    local pc_changed=0
    if [ "${pc_http_exists:-0}" -gt 0 ]; then
        echo -e "  ${GRAY}✓  PostCompact HTTP hook${NC}"
    else
        tmp="${settings}.tmp.$$"
        jq --arg url "$hooks_url" '
            if .hooks == null then .hooks = {} else . end |
            if .hooks.PostCompact == null then .hooks.PostCompact = [] else . end |
            .hooks.PostCompact += [{"hooks": [{"type": "http", "url": $url, "timeout": 3}]}]
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        pc_changed=1
    fi
    if [ "${pc_cmd_exists:-0}" -gt 0 ]; then
        echo -e "  ${GRAY}✓  PostCompact command hook${NC}"
    else
        tmp="${settings}.tmp.$$"
        jq --arg cmd "$session_cmd" '
            if .hooks == null then .hooks = {} else . end |
            if .hooks.PostCompact == null then .hooks.PostCompact = [] else . end |
            .hooks.PostCompact += [{"hooks": [{"type": "command", "command": $cmd, "timeout": 5}]}]
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        pc_changed=1
    fi
    [ "$pc_changed" -eq 1 ] && echo -e "  ${GREEN}✅ registered hook: PostCompact (HTTP + command)${NC}"

    # --- UserPromptSubmit (asyncRewake upgrade) ---
    # Detect old format (entry present, .async absent) → patch in-place
    local old_entry
    old_entry=$(jq -r --arg cmd "$health_cmd" \
        '(.hooks.UserPromptSubmit // []) | [.[].hooks[]? | select((.command // "") | contains($cmd))] | .[0] // null' \
        "$settings" 2>/dev/null)
    local has_async
    has_async=$(printf '%s' "$old_entry" | jq -r '.async // false' 2>/dev/null || echo "false")

    if [ "$old_entry" != "null" ] && [ "$has_async" = "true" ]; then
        echo -e "  ${GRAY}✓  UserPromptSubmit c-thru-proxy-health (asyncRewake)${NC}"
    elif [ "$old_entry" != "null" ]; then
        # Old format present — remove and re-add with asyncRewake
        tmp="${settings}.tmp.$$"
        jq --arg cmd "$health_cmd" '
            (.hooks.UserPromptSubmit // []) |= map(
                .hooks |= map(select((.command // "") | contains($cmd) | not))
            ) | (.hooks.UserPromptSubmit // []) |= map(select(.hooks | length > 0))
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        tmp="${settings}.tmp.$$"
        jq --arg cmd "$health_cmd" '
            if .hooks == null then .hooks = {} else . end |
            if .hooks.UserPromptSubmit == null then .hooks.UserPromptSubmit = [] else . end |
            .hooks.UserPromptSubmit += [{
                "matcher": "*",
                "hooks": [{"type": "command", "command": $cmd, "timeout": 3, "async": true, "asyncRewake": true}]
            }]
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        echo -e "  ${GREEN}✅ upgraded hook: UserPromptSubmit c-thru-proxy-health → asyncRewake${NC}"
    else
        # No entry — fresh install
        tmp="${settings}.tmp.$$"
        jq --arg cmd "$health_cmd" '
            if .hooks == null then .hooks = {} else . end |
            if .hooks.UserPromptSubmit == null then .hooks.UserPromptSubmit = [] else . end |
            .hooks.UserPromptSubmit += [{
                "matcher": "*",
                "hooks": [{"type": "command", "command": $cmd, "timeout": 3, "async": true, "asyncRewake": true}]
            }]
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        echo -e "  ${GREEN}✅ registered hook: UserPromptSubmit c-thru-proxy-health (asyncRewake)${NC}"
    fi

    # --- UserPromptSubmit classify (async context injection via hooks listener) ---
    local cl_exists
    cl_exists=$(jq -r --arg cmd "$classify_cmd" \
        '(.hooks.UserPromptSubmit // []) | [.[].hooks[]?.command // ""] | map(select(contains($cmd))) | length' \
        "$settings" 2>/dev/null || echo 0)
    if [ "${cl_exists:-0}" -gt 0 ]; then
        echo -e "  ${GRAY}✓  UserPromptSubmit c-thru-classify${NC}"
    else
        tmp="${settings}.tmp.$$"
        jq --arg cmd "$classify_cmd" '
            if .hooks == null then .hooks = {} else . end |
            if .hooks.UserPromptSubmit == null then .hooks.UserPromptSubmit = [] else . end |
            .hooks.UserPromptSubmit += [{
                "matcher": "*",
                "hooks": [{"type": "command", "command": $cmd, "timeout": 5, "async": true}]
            }]
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        echo -e "  ${GREEN}✅ registered hook: UserPromptSubmit c-thru-classify${NC}"
    fi
}

# --- User model-map: seed or validate ---
echo ""
echo "Model-map (${CLAUDE_DIR}/model-map.json):"
USER_MAP="$CLAUDE_DIR/model-map.json"
if [ -f "$USER_MAP" ]; then
    migrate_providers_schema "$USER_MAP"
    # Validate the existing map if the validator is available
    local_validate="$TOOLS_SRC/model-map-validate.js"
    if command -v node >/dev/null 2>&1 && [ -f "$local_validate" ]; then
        if node "$local_validate" "$USER_MAP" 2>/dev/null; then
            echo -e "  ${GRAY}✓  present and valid${NC}"
        else
            echo -e "  ${YELLOW}⚠️  present but validation failed — run: node ${local_validate} ${USER_MAP}${NC}"
        fi
    else
        echo -e "  ${GRAY}✓  present (validator not available)${NC}"
    fi
elif [ -f "$REPO_DIR/config/model-map.json" ]; then
    cp "$REPO_DIR/config/model-map.json" "$USER_MAP"
    echo -e "  ${GREEN}✅ Seeded from config/model-map.json${NC}"
else
    echo -e "  ${YELLOW}⚠️  No config/model-map.json found; skipping seed. Copy manually if needed.${NC}"
fi

echo ""
echo "MCP server:"
register_mcp_server

echo ""
echo "Permissions:"
add_permission

echo ""
echo "Skills:"
install_skill

echo ""
echo "Hooks:"
register_hooks

# --- Non-clobbering detection for statusline + Stop hook ---
# Probes settings.json via stdlib-only node (no jq dep) and prints
# manual-integration hints. Never auto-writes these entries.
detect_user_config() {
    local settings="$CLAUDE_DIR/settings.json"
    if ! command -v node >/dev/null 2>&1; then
        echo -e "  ${YELLOW}⚠️  node not available — cannot detect statusLine / Stop hook state${NC}"
        echo -e "  ${YELLOW}   Manual integration: see wiki/entities/c-thru-statusline.md${NC}"
        return 0
    fi
    [ -f "$settings" ] || echo '{}' > "$settings"

    local sl_state stop_state
    # Pass settings path as argv[1] to avoid shell-quoting issues if the path
    # contains single quotes or backslashes (e.g. /home/o'brien/.claude).
    sl_state=$(node -e "try{const s=require(process.argv[1]);process.stdout.write(s.statusLine?'yes':'no')}catch(e){process.stdout.write('unknown')}" "$settings" 2>/dev/null)
    stop_state=$(node -e "try{const s=require(process.argv[1]);process.stdout.write(s.hooks&&s.hooks.Stop?'yes':'no')}catch(e){process.stdout.write('unknown')}" "$settings" 2>/dev/null)

    echo ""
    echo "Statusline (fallback badge):"
    case "$sl_state" in
        yes)
            echo -e "  ${GRAY}✓  existing statusLine detected — NOT modifying settings${NC}"
            echo -e "  ${YELLOW}   To add the fallback badge, append this to your statusline's output:${NC}"
            echo "       \$(sh ~/.claude/tools/c-thru-statusline-overlay 2>/dev/null)"
            ;;
        no)
            echo -e "  ${GRAY}✓  no statusLine configured — overlay installed${NC}"
            echo -e "  ${YELLOW}   To enable the default wrapper (model | cwd + fallback badge):${NC}"
            echo "       /statusline and point it at: ~/.claude/tools/c-thru-statusline"
            ;;
        *)
            echo -e "  ${YELLOW}⚠️  could not probe settings.json — leaving statusLine untouched${NC}"
            echo -e "  ${YELLOW}   Manual integration: ~/.claude/tools/c-thru-statusline-overlay${NC}"
            ;;
    esac

    echo ""
    echo "Stop hook (in-terminal fallback notice):"
    case "$stop_state" in
        yes)
            echo -e "  ${GRAY}✓  existing Stop hook detected — NOT modifying settings${NC}"
            echo -e "  ${YELLOW}   To include the c-thru notice, append this entry to hooks.Stop manually:${NC}"
            echo "       {\"hooks\":[{\"type\":\"command\",\"command\":\"$TOOLS_DEST/c-thru-stop-hook\",\"timeout\":3}]}"
            ;;
        no)
            echo -e "  ${YELLOW}   Stop hook not auto-registered (opt-in). To enable, add to settings.json:${NC}"
            echo "       hooks.Stop += [{\"hooks\":[{\"type\":\"command\",\"command\":\"$TOOLS_DEST/c-thru-stop-hook\",\"timeout\":3}]}]"
            ;;
        *)
            echo -e "  ${YELLOW}⚠️  could not probe settings.json — Stop hook left unregistered${NC}"
            ;;
    esac
}
detect_user_config

echo ""
echo -e "${YELLOW}Quick reference:${NC}"
echo "  ~/.claude/tools/claude-router --list   list routes / local models"
echo "  ~/.claude/tools/model-map-validate     validate profile/project model-map configs"
echo "  tail ~/.claude/proxy.*.log             troubleshoot proxy startup"
echo "  pkill -f claude-proxy                  restart proxy after config edits"
echo "  CLAUDE_PROXY_BYPASS=1 claude ...       bypass proxy for direct Anthropic access"
echo ""
echo -e "${GREEN}✅ Done.${NC}"
