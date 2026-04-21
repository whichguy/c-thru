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

chmod +x "$TOOLS_SRC/c-thru" "$TOOLS_SRC/claude-proxy" "$TOOLS_SRC/llm-capabilities-mcp.js" "$TOOLS_SRC/model-map-sync.js" "$TOOLS_SRC/model-map-validate.js" "$TOOLS_SRC/model-map-edit.js" "$TOOLS_SRC/model-map-layered.js" 2>/dev/null || true
# llm-capabilities-shared.js is a library, not executable
chmod +x "$TOOLS_SRC/verify-llm-capabilities-mcp.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-proxy-health.sh" "$TOOLS_SRC/c-thru-session-start.sh" "$TOOLS_SRC/c-thru-map-changed.sh" "$TOOLS_SRC/c-thru-classify.sh" "$TOOLS_SRC/c-thru-ollama-probe.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-stop-hook.sh" "$TOOLS_SRC/c-thru-statusline.sh" "$TOOLS_SRC/c-thru-statusline-overlay.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-contract-check.sh" "$TOOLS_SRC/c-thru-self-update.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/model-map-apply-recommendations.js" "$TOOLS_SRC/verify-lmstudio-ollama-compat.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/model-map-resolve.js" "$TOOLS_SRC/c-thru-resolve" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-enter-plan-hook.sh" 2>/dev/null || true

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
link_tool c-thru c-thru
link_tool c-thru claude-router
link_tool claude-proxy claude-proxy
if command -v node >/dev/null 2>&1; then
    node_major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo 0)
    if [ "$node_major" -lt 15 ]; then
        echo -e "  ${YELLOW}⚠️  Node.js ${node_major} detected — claude-proxy requires ≥ 15 (AbortController). Upgrade recommended.${NC}"
    fi
    link_tool llm-capabilities-mcp.js llm-capabilities-mcp
    link_tool model-map-validate.js model-map-validate
    link_tool model-map-sync.js model-map-sync
    link_tool model-map-edit.js model-map-edit
    link_tool model-map-resolve.js model-map-resolve.js
    link_tool c-thru-resolve c-thru-resolve
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
link_tool c-thru-ollama-gc.sh c-thru-ollama-gc
link_tool c-thru-contract-check.sh c-thru-contract-check
link_tool c-thru-self-update.sh c-thru-self-update
link_tool verify-lmstudio-ollama-compat.sh verify-lmstudio-ollama-compat
link_tool c-thru-ollama-probe.sh c-thru-ollama-probe
link_tool c-thru-enter-plan-hook.sh c-thru-enter-plan-hook

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

If `$ARGUMENTS` is `fix`, run the following steps in order:

**Step 1 — Apply recommended mappings for the active tier:**

```bash
CLAUDE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"
node "$CLAUDE_DIR/tools/model-map-edit" \
  "$CLAUDE_DIR/model-map.system.json" \
  "$CLAUDE_DIR/model-map.overrides.json" \
  "$CLAUDE_DIR/model-map.json" \
  '{}' 2>/dev/null && echo "config: up to date" || echo "config: no changes needed"
```

**Step 2 — Reload the running proxy:**

```bash
~/.claude/tools/c-thru reload
```

If `c-thru reload` exits non-zero (proxy not running), print:
`proxy not running — will auto-spawn on next use`

**Step 3 — Show current status:**

```bash
~/.claude/tools/c-thru --list
```
SKILL_EOF
    echo -e "  ${GREEN}✅ installed skill: /c-thru-status${NC}"
}

# --- /cplan command shortcut ---
install_cplan_command() {
    local commands_dir="$CLAUDE_DIR/commands"
    local cmd_file="$commands_dir/cplan.md"
    local canonical_line='Skill(skill="c-thru-plan", args="$ARGUMENTS")'

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

Invoke the c-thru-plan skill with the user's arguments:

Skill(skill="c-thru-plan", args="$ARGUMENTS")
CPLAN_EOF
    echo -e "  ${GREEN}✅ installed command: /cplan${NC}"
}

# --- EnterPlanMode advisory hook ---
# Registers a PreToolUse hook on EnterPlanMode that emits a hint about /c-thru-plan.
# Idempotent: skips if already registered. Respects planner_hint:false opt-out.
install_planner_hint_hook() {
    if [ "$JQ_AVAILABLE" -eq 0 ]; then
        echo -e "  ${YELLOW}⚠️  jq not found — skipping planner hint hook${NC}"
        return 0
    fi

    local settings="$CLAUDE_DIR/settings.json"
    local hook_cmd="$TOOLS_DEST/c-thru-enter-plan-hook"

    if [ ! -f "$settings" ]; then
        echo '{}' > "$settings"
    fi

    local already
    already=$(jq -r --arg cmd "$hook_cmd" \
        '(.hooks.PreToolUse // []) | [.[].hooks[]?.command // ""] | map(select(. == $cmd)) | length' \
        "$settings" 2>/dev/null || echo 0)
    if [ "${already:-0}" -gt 0 ]; then
        echo -e "  ${GRAY}✓  PreToolUse EnterPlanMode hook${NC}"
        return 0
    fi

    # Respect existing opt-out.
    local ovr="$CLAUDE_DIR/model-map.overrides.json"
    if [ -f "$ovr" ]; then
        local hint_val
        hint_val=$(jq -r '.planner_hint // "unset"' "$ovr" 2>/dev/null || echo "unset")
        if [ "$hint_val" = "false" ]; then
            echo -e "  ${GRAY}✓  planner hint opted out — skipping hook${NC}"
            return 0
        fi
    fi

    local tmp="${settings}.tmp.$$"
    jq --arg cmd "$hook_cmd" '
        if .hooks == null then .hooks = {} else . end |
        if .hooks.PreToolUse == null then .hooks.PreToolUse = [] else . end |
        .hooks.PreToolUse += [{"matcher": "EnterPlanMode", "hooks": [{"type": "command", "command": $cmd, "timeout": 3}]}]
    ' "$settings" > "$tmp" && mv "$tmp" "$settings"

    echo -e "  ${GREEN}✅ registered hook: PreToolUse EnterPlanMode (planner hint)${NC}"
    echo -e "  ${YELLOW}   Note: this hook fires in all Claude Code sessions on this machine.${NC}"
    echo -e "  ${YELLOW}   Disable: /c-thru-config planning off${NC}"
}

# --- Hooks: SessionStart, PostCompact, UserPromptSubmit, PostToolUse ---
register_hooks() {
    if [ "$JQ_AVAILABLE" -eq 0 ]; then
        echo -e "  ${YELLOW}⚠️  jq not found — skipping hooks${NC}"
        return 0
    fi

    local settings="$CLAUDE_DIR/settings.json"
    local session_cmd="$TOOLS_DEST/c-thru-session-start"
    local health_cmd="$TOOLS_DEST/c-thru-proxy-health"
    local classify_cmd="$TOOLS_DEST/c-thru-classify"
    local map_changed_cmd="$TOOLS_DEST/c-thru-map-changed"

    if [ ! -f "$settings" ]; then
        echo '{}' > "$settings"
    fi

    local tmp

    local hooks_url="http://127.0.0.1:${CLAUDE_PROXY_HOOKS_PORT:-9998}/hooks/context"

    # --- SessionStart (HTTP hook + command fallback) ---
    # Each sub-hook is registered independently to avoid duplication on re-runs.
    local ss_http_exists ss_cmd_exists
    # A12: exact match, not substring. A substring check re-registers (or
    # silently keeps a stale sibling) whenever the install prefix changes.
    ss_http_exists=$(jq -r --arg url "$hooks_url" \
        '(.hooks.SessionStart // []) | [.[].hooks[]?.url // ""] | map(select(. == $url)) | length' \
        "$settings" 2>/dev/null || echo 0)
    ss_cmd_exists=$(jq -r --arg cmd "$session_cmd" \
        '(.hooks.SessionStart // []) | [.[].hooks[]?.command // ""] | map(select(. == $cmd)) | length' \
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
        '(.hooks.PostCompact // []) | [.[].hooks[]?.url // ""] | map(select(. == $url)) | length' \
        "$settings" 2>/dev/null || echo 0)
    pc_cmd_exists=$(jq -r --arg cmd "$session_cmd" \
        '(.hooks.PostCompact // []) | [.[].hooks[]?.command // ""] | map(select(. == $cmd)) | length' \
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
        '(.hooks.UserPromptSubmit // []) | [.[].hooks[]? | select((.command // "") == $cmd)] | .[0] // null' \
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
                .hooks |= map(select((.command // "") != $cmd))
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
        '(.hooks.UserPromptSubmit // []) | [.[].hooks[]?.command // ""] | map(select(. == $cmd)) | length' \
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

    # --- PostToolUse map-changed (validates model-map.json on every file write) ---
    local mc_exists
    mc_exists=$(jq -r --arg cmd "$map_changed_cmd" \
        '(.hooks.PostToolUse // []) | [.[].hooks[]?.command // ""] | map(select(. == $cmd)) | length' \
        "$settings" 2>/dev/null || echo 0)
    if [ "${mc_exists:-0}" -gt 0 ]; then
        echo -e "  ${GRAY}✓  PostToolUse c-thru-map-changed${NC}"
    else
        tmp="${settings}.tmp.$$"
        jq --arg cmd "$map_changed_cmd" '
            if .hooks == null then .hooks = {} else . end |
            if .hooks.PostToolUse == null then .hooks.PostToolUse = [] else . end |
            .hooks.PostToolUse += [{
                "matcher": "*",
                "hooks": [{"type": "command", "command": $cmd, "timeout": 5}]
            }]
        ' "$settings" > "$tmp" && mv "$tmp" "$settings"
        echo -e "  ${GREEN}✅ registered hook: PostToolUse c-thru-map-changed${NC}"
    fi
}

# --- Agentic plan/wave: agent symlinks ---
# Symlinks each agents/*.md into ~/.claude/agents/c-thru/ (namespaced to avoid
# collisions with user's own agents). Only touches symlinks pointing into this repo.
# Idempotent: skips symlinks already pointing at the correct source.
# Failure mode: prints a warning and continues if target dir can't be created.
install_agents() {
    local agents_src="$REPO_DIR/agents"
    local agents_dest="$CLAUDE_DIR/agents/c-thru"

    if [ ! -d "$agents_src" ]; then
        echo -e "  ${YELLOW}⚠️  agents/ directory not found — skipping agent install${NC}"
        return 0
    fi

    mkdir -p "$agents_dest" || { echo -e "  ${RED}❌ cannot create $agents_dest${NC}" >&2; return 1; }

    local installed=0 skipped=0
    for src in "$agents_src"/*.md; do
        [ -f "$src" ] || continue
        local name
        name="$(basename "$src")"
        local dest="$agents_dest/$name"
        if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
            echo -e "  ${GRAY}✓  agents/c-thru/${name}${NC}"
            skipped=$((skipped + 1))
        else
            ln -sfn "$src" "$dest"
            echo -e "  ${GREEN}✅ agents/c-thru/${name}${NC}"
            installed=$((installed + 1))
        fi
    done
    [ $installed -gt 0 ] || [ $skipped -gt 0 ] || echo -e "  ${YELLOW}⚠️  no .md files found in agents/${NC}"
}

# --- Agentic plan/wave: skill symlinks ---
# Symlinks each skills/<name>/ directory into ~/.claude/skills/c-thru/<name>/.
# Namespaced under c-thru to avoid collisions with existing user skills.
# Idempotent: skips symlinks already pointing at the correct source.
# Failure mode: prints a warning and continues if target dir can't be created.
install_skills_cthru() {
    local skills_src="$REPO_DIR/skills"
    local skills_dest="$CLAUDE_DIR/skills/c-thru"

    if [ ! -d "$skills_src" ]; then
        echo -e "  ${YELLOW}⚠️  skills/ directory not found — skipping skill install${NC}"
        return 0
    fi

    mkdir -p "$skills_dest" || { echo -e "  ${RED}❌ cannot create $skills_dest${NC}" >&2; return 1; }

    local installed=0 skipped=0
    for src in "$skills_src"/*/; do
        [ -d "$src" ] || continue
        local name
        name="$(basename "$src")"
        local dest="$skills_dest/$name"
        if [ -L "$dest" ] && [ "$(readlink "$dest")" = "${src%/}" ]; then
            echo -e "  ${GRAY}✓  skills/c-thru/${name}${NC}"
            skipped=$((skipped + 1))
        else
            ln -sfn "${src%/}" "$dest"
            echo -e "  ${GREEN}✅ skills/c-thru/${name}${NC}"
            installed=$((installed + 1))
        fi
    done
    [ $installed -gt 0 ] || [ $skipped -gt 0 ] || echo -e "  ${YELLOW}⚠️  no skill directories found in skills/${NC}"
}

# --- Agentic plan/wave: extend model-map.system.json ---
# Merges the 6 new capability alias rows + agent_to_capability into
# model-map.system.json (one per tier, only if absent). Validates before
# atomic rename (config-swap-invariant). User overrides in
# model-map.overrides.json are never touched.
# Idempotent: skips if all 6 aliases already present in every tier.
# Failure mode: aborts with descriptive message on validator failure.
extend_model_map() {
    if [ "$JQ_AVAILABLE" -eq 0 ]; then
        echo -e "  ${YELLOW}⚠️  jq not found — skipping model-map extension${NC}"
        return 0
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo -e "  ${YELLOW}⚠️  node not found — skipping model-map extension${NC}"
        return 0
    fi

    local system_map="$CLAUDE_DIR/model-map.system.json"
    local shipped_map="$REPO_DIR/config/model-map.json"

    # If system map doesn't exist yet, sync will create it — nothing to extend.
    if [ ! -f "$system_map" ]; then
        echo -e "  ${GRAY}✓  model-map.system.json not present yet (sync will seed it)${NC}"
        return 0
    fi

    # Pre-check: verify none of the 6 new aliases already exist in 128gb tier.
    local already
    already=$(jq -r '.llm_profiles["128gb"]["judge"] // empty' "$system_map" 2>/dev/null || true)
    if [ -n "$already" ]; then
        echo -e "  ${GRAY}✓  capability aliases already present in model-map.system.json${NC}"
        return 0
    fi

    # Merge the new aliases from shipped config into system map, alias-by-alias per tier.
    local tmp="${system_map}.tmp.$$"
    jq --slurpfile shipped "$shipped_map" '
        . as $sys |
        $shipped[0].llm_profiles as $shipped_profiles |
        ($sys.llm_profiles // {}) as $existing_profiles |
        .llm_profiles = (
            $existing_profiles | to_entries | map(
                .key as $tier |
                .value as $profile |
                if $shipped_profiles[$tier] then
                    .value = ($profile + {
                        "judge":         $shipped_profiles[$tier]["judge"],
                        "judge-strict":  $shipped_profiles[$tier]["judge-strict"],
                        "orchestrator":  $shipped_profiles[$tier]["orchestrator"],
                        "code-analyst":  $shipped_profiles[$tier]["code-analyst"],
                        "pattern-coder": $shipped_profiles[$tier]["pattern-coder"],
                        "deep-coder":    $shipped_profiles[$tier]["deep-coder"]
                    })
                else
                    .
                end
            ) | from_entries
        ) |
        if (.agent_to_capability == null) then
            .agent_to_capability = $shipped[0].agent_to_capability
        else
            .
        end |
        if (.model_routes["devstral-small:2"] == null) then
            .model_routes["devstral-small:2"] = "ollama_local" |
            .model_routes["qwen3.6:35b"] = "ollama_local" |
            .model_routes["qwen3.5:122b"] = "ollama_local" |
            .model_routes["qwen3.5:27b"] = "ollama_local" |
            .model_routes["qwen3.5:9b"] = "ollama_local" |
            .model_routes["qwen3.5:1.7b"] = "ollama_local"
        else
            .
        end
    ' "$system_map" > "$tmp" || { echo -e "  ${RED}❌ jq merge failed${NC}" >&2; rm -f "$tmp"; return 1; }

    # Validate before atomic rename (config-swap-invariant).
    # Use explicit return-code capture — pipe-to-grep is unreliable under pipefail.
    local validate_rc=0 validate_out
    validate_out=$(node "$TOOLS_SRC/model-map-validate.js" "$tmp" 2>&1) || validate_rc=$?
    if [ "$validate_rc" -eq 0 ]; then
        mv "$tmp" "$system_map"
        echo -e "  ${GREEN}✅ model-map.system.json extended with 6 capability aliases + agent_to_capability${NC}"
    else
        echo -e "  ${RED}❌ model-map.system.json validation failed — not writing${NC}" >&2
        echo "$validate_out" >&2
        rm -f "$tmp"
        return 1
    fi
}

# --- User model-map: system defaults + user overrides split ---
# Three files: model-map.system.json (system, overwritten on upgrade),
#              model-map.overrides.json (user, never touched on upgrade),
#              model-map.json (derived effective, written by sync).
echo ""
echo "Model-map:"
SYS_MAP="$CLAUDE_DIR/model-map.system.json"
OVR_MAP="$CLAUDE_DIR/model-map.overrides.json"
USER_MAP="$CLAUDE_DIR/model-map.json"
SHIPPED_MAP="$REPO_DIR/config/model-map.json"

if [ ! -f "$OVR_MAP" ]; then
    echo '{}' > "$OVR_MAP"
    echo -e "  ${GREEN}✅ seeded model-map.overrides.json (empty — edit here to customize over shipped defaults)${NC}"
fi

if [ -f "$SHIPPED_MAP" ] && command -v node >/dev/null 2>&1; then
    local_sync="$TOOLS_SRC/model-map-sync.js"
    local_validate="$TOOLS_SRC/model-map-validate.js"

    # Migrate legacy providers schema in-place before we diff against defaults.
    # Must run before syncLayeredConfig uses USER_MAP as bootstrapEffectivePath,
    # otherwise old providers[] entries would be captured as-is into overrides.
    if [ -f "$USER_MAP" ]; then
        migrate_providers_schema "$USER_MAP"
    fi

    # Banner if user modified model-map.system.json (changes will be overwritten)
    if [ -f "$SYS_MAP" ]; then
        PRIOR_SYS_SHA="$(shasum -a 256 "$SYS_MAP" 2>/dev/null | awk '{print $1}')"
        SHIPPED_SHA="$(shasum -a 256 "$SHIPPED_MAP" 2>/dev/null | awk '{print $1}')"
        if [ -n "$PRIOR_SYS_SHA" ] && [ -n "$SHIPPED_SHA" ] && [ "$PRIOR_SYS_SHA" != "$SHIPPED_SHA" ]; then
            echo -e "  ${YELLOW}⚠️  model-map.system.json was modified — overwriting with shipped defaults${NC}"
            echo -e "  ${YELLOW}   To preserve customizations, edit model-map.overrides.json instead${NC}"
        fi
    fi

    # Write effective to tmp first — if interrupted: old system + new effective (safe),
    # never new system + old effective.
    if [ -f "$local_sync" ]; then
        node "$local_sync" "$SHIPPED_MAP" "$OVR_MAP" "$USER_MAP.tmp" "$USER_MAP" 2>/dev/null || true
    fi
    # Atomic system write
    cp "$SHIPPED_MAP" "$SYS_MAP.tmp" && mv "$SYS_MAP.tmp" "$SYS_MAP"
    # Finalize effective
    if [ -f "$USER_MAP.tmp" ]; then
        mv "$USER_MAP.tmp" "$USER_MAP"
    elif [ ! -f "$USER_MAP" ]; then
        cp "$SHIPPED_MAP" "$USER_MAP"
    fi

    # Validate effective
    if [ -f "$local_validate" ] && [ -f "$USER_MAP" ]; then
        if node "$local_validate" "$USER_MAP" 2>/dev/null; then
            echo -e "  ${GREEN}✅ model-map.system.json updated (shipped defaults)${NC}"
            override_keys="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.keys(o).length);}catch{console.log(0);}' "$OVR_MAP" 2>/dev/null || echo 0)"
            echo -e "  ${GRAY}✓  model-map.overrides.json (${override_keys} override keys)${NC}"
            echo -e "  ${GRAY}✓  model-map.json (effective merged config, valid)${NC}"
        else
            echo -e "  ${YELLOW}⚠️  effective model-map.json failed validation — run: node ${local_validate} ${USER_MAP}${NC}"
        fi
    else
        echo -e "  ${GREEN}✅ model-map.system.json updated (validator unavailable)${NC}"
    fi

    # Print detected hardware tier
    if [ -f "$TOOLS_SRC/hw-profile.js" ]; then
        active_tier="$(node -e \
            'try{const os=require("os");const {tierForGb}=require(process.argv[1]);const gb=Math.ceil(os.totalmem()/(1024**3));process.stdout.write(tierForGb(gb)+" ("+gb+" GB detected)");}catch(e){process.exit(1);}' \
            "$TOOLS_SRC/hw-profile.js" 2>/dev/null || true)"
        if [ -n "$active_tier" ]; then
            echo -e "  ${GRAY}ℹ  active hardware profile: ${active_tier}${NC}"
        fi
    fi
elif [ -f "$SHIPPED_MAP" ]; then
    cp "$SHIPPED_MAP" "$USER_MAP"
    echo -e "  ${GREEN}✅ Seeded from config/model-map.json (node unavailable for layered sync)${NC}"
else
    echo -e "  ${YELLOW}⚠️  No config/model-map.json found; skipping seed. Copy manually if needed.${NC}"
fi

echo ""
echo "Ollama GC state:"
"$TOOLS_DEST/c-thru-ollama-gc" init

echo ""
echo "Ollama:"
_probe_out=""
if [ -x "$TOOLS_SRC/c-thru-ollama-probe.sh" ]; then
    _probe_out=$("$TOOLS_SRC/c-thru-ollama-probe.sh")
fi
case "$_probe_out" in
    OK*)
        _tag_count="${_probe_out#OK }"
        echo -e "  ${GREEN}✓  Ollama running — ${_tag_count} model(s) available${NC}"
        ;;
    DOWN*)
        _probe_host="${_probe_out#DOWN }"
        echo -e "  ${YELLOW}⚠️  Ollama not detected at http://${_probe_host}${NC}"
        echo -e "  ${YELLOW}   Install: https://ollama.com  |  Then: ollama pull <model>${NC}"
        echo -e "  ${YELLOW}   c-thru will use cloud-only (Anthropic/OpenRouter) until Ollama is running.${NC}"
        ;;
    *)
        _ollama_host="${OLLAMA_HOST:-127.0.0.1:11434}"
        echo -e "  ${YELLOW}⚠️  Ollama probe unavailable; check manually: http://${_ollama_host}/api/tags${NC}"
        unset _ollama_host
        ;;
esac
unset _probe_out _tag_count _probe_host

echo ""
echo "MCP server:"
register_mcp_server

echo ""
echo "Permissions:"
add_permission

echo ""
echo "Skills:"
install_skill
install_cplan_command

echo ""
echo "Agents (agentic plan/wave):"
install_agents

echo ""
echo "Skills (agentic plan/wave):"
install_skills_cthru

echo ""
echo "Model-map (capability aliases):"
extend_model_map

echo ""
echo "Hooks:"
register_hooks
install_planner_hint_hook

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
            echo "       \$(bash ~/.claude/tools/c-thru-statusline-overlay 2>/dev/null)"
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
echo "  /c-thru-config diag                       full diagnostics (mode, tier, capabilities, proxy)"
echo "  /c-thru-config resolve <cap>              what does deep-coder resolve to right now?"
echo "  ~/.claude/tools/c-thru --list             list routes, active profile, local models"
echo ""
echo "Configuration:"
echo "  ~/.claude/model-map.overrides.json        edit here to override shipped defaults"
echo "  /c-thru-config mode <connected|semi-offload|cloud-judge-only|offline>"
echo "  /c-thru-config remap <cap> <model>        rebind a capability to a different model"
echo "  /c-thru-config reload                     apply config changes to running proxy"
echo ""
echo "Agents & skills (c-thru namespace):"
echo "  ~/.claude/agents/c-thru/                  agent overrides"
echo "  ~/.claude/skills/c-thru/                  skill files"
echo ""
echo "Troubleshooting:"
echo "  tail ~/.claude/proxy.*.log                proxy startup / request logs"
echo "  pkill -f claude-proxy                     restart proxy after config edits"
echo "  CLAUDE_PROXY_BYPASS=1 claude ...          bypass proxy for direct Anthropic"
echo ""
echo "Optional (not auto-enabled — add to ~/.claude/settings.json manually):"
echo "  c-thru-stop-hook                          token-usage summary on session stop"
echo "  c-thru-statusline / c-thru-statusline-overlay   live proxy status in editor statusbar"
echo ""
echo -e "${GREEN}✅ Done.${NC}"
