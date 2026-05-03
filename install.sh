#!/usr/bin/env bash
# c-thru installer: symlinks router/proxy + helpers into ~/.claude/tools/
# and seeds a user-level model-map on first run.
# Safe to re-run: each step checks current state before acting.
#
# Environment opt-outs:
#   C_THRU_INSTALL_NO_PATH=1  Skip appending the ~/.claude/tools PATH block to
#                             the user's shell rc file (zshrc/bashrc/fish).
#                             Useful for CI, containers, or users managing PATH
#                             manually.

set -euo pipefail

# --- Arg parsing (minimal) ---
SKIP_E2E=0
for arg in "$@"; do
    case "$arg" in
        --skip-e2e)
            SKIP_E2E=1
            ;;
        -h|--help)
            cat <<USAGE
Usage: install.sh [--skip-e2e]

  --skip-e2e   Skip post-install end-to-end validation (CI / sandboxed envs).
USAGE
            exit 0
            ;;
        *)
            echo "install.sh: unknown arg: $arg" >&2
            exit 2
            ;;
    esac
done

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
chmod +x "$TOOLS_SRC/c-thru-contract-check.sh" "$TOOLS_SRC/c-thru-self-update.sh" "$TOOLS_SRC/c-thru-hygiene-check.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/model-map-apply-recommendations.js" "$TOOLS_SRC/verify-lmstudio-ollama-compat.sh" 2>/dev/null || true
chmod +x "$TOOLS_SRC/model-map-resolve.js" "$TOOLS_SRC/c-thru-resolve" 2>/dev/null || true
chmod +x "$TOOLS_SRC/c-thru-enter-plan-hook.sh" "$TOOLS_SRC/c-thru-agent-router-hook.sh" 2>/dev/null || true

mkdir -p "$TOOLS_DEST"

# --- Idempotent symlink helper ---
link_tool() {
    local src="$1" dest_name="$2"
    local dest="$TOOLS_DEST/$dest_name"
    local want="$TOOLS_SRC/$src"
    if [ ! -e "$want" ]; then return 0; fi
    if [ ! -x "$want" ]; then
        echo -e "  ${YELLOW}⚠️  ${dest_name} — source ${src} exists but is not executable; skipping (run: chmod +x ${want})${NC}"
        return 0
    fi

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
link_tool c-thru-hygiene-check.sh c-thru-hygiene-check
link_tool c-thru-self-update.sh c-thru-self-update
link_tool verify-lmstudio-ollama-compat.sh verify-lmstudio-ollama-compat
link_tool c-thru-ollama-probe.sh c-thru-ollama-probe
link_tool c-thru-enter-plan-hook.sh c-thru-enter-plan-hook
link_tool c-thru-agent-router-hook.sh c-thru-agent-router-hook
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
    local canonical_line='Show c-thru routes, proxy URL, per-model usage stats'
    mkdir -p "$commands_dir"
    if [ -f "$skill_file" ] && grep -qF "$canonical_line" "$skill_file" 2>/dev/null; then
        echo -e "  ${GRAY}✓  /c-thru-status${NC}"
        return 0
    fi
    cat > "$skill_file" << 'SKILL_EOF'
---
description: "Show c-thru routes, proxy URL, per-model usage stats (calls, tokens, last call time), and backend health. Use 'fix' to pull missing models and reload."
allowed-tools: "Bash"
---
# c-thru Status
Run the list command. It shows: active profile, all 20 agents with model assignments and endpoints,
proxy URL with tier/mode, Ollama model count, backend health, and per-model usage stats
(call count, total tokens, timestamp of last call).

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

# --- Apply community recommendations into the effective model-map ---
apply_recommendations() {
    command -v node >/dev/null 2>&1 || return 0
    local rec_script="$TOOLS_SRC/model-map-apply-recommendations.js"
    [ -f "$rec_script" ] || return 0
    [ -f "$USER_MAP" ] || return 0

    local tmp="${USER_MAP}.rec.$$" stderr_tmp="${USER_MAP}.rec.err.$$"
    if CLAUDE_ROUTER_DEBUG=1 node "$rec_script" "$REPO_DIR" "$USER_MAP" >"$tmp" 2>"$stderr_tmp"; then
        local applied
        applied=$(grep -oE 'applied [0-9]+' "$stderr_tmp" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
        rm -f "$stderr_tmp"
        if [ "${applied:-0}" -gt 0 ] 2>/dev/null; then
            mv "$tmp" "$USER_MAP"
            echo -e "  ${GREEN}✅ model-map.json — ${applied} community recommendation(s) applied (rec)${NC}"
        else
            rm -f "$tmp"
            echo -e "  ${GRAY}✓  recommendations already current${NC}"
        fi
    else
        rm -f "$tmp" "$stderr_tmp"
        echo -e "  ${YELLOW}⚠️  recommendations apply failed (run CLAUDE_ROUTER_DEBUG=1 ./install.sh for details)${NC}"
    fi
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
apply_recommendations

# --- Add ~/.claude/tools to PATH via shell rc file (idempotent) ---
# Markers MUST stay verbatim — uninstall.sh greps these to remove the block.
PATH_MARKER_BEGIN='# >>> c-thru tools on PATH (added by install.sh) >>>'
PATH_MARKER_END='# <<< c-thru tools on PATH <<<'

register_path() {
    if [ "${C_THRU_INSTALL_NO_PATH:-0}" = "1" ]; then
        echo -e "  ${GRAY}✓  PATH edit skipped (C_THRU_INSTALL_NO_PATH=1)${NC}"
        return 0
    fi

    # If c-thru is already resolvable on PATH and points at our install
    # destination (or a path that contains $TOOLS_DEST/c-thru), skip.
    if command -v c-thru >/dev/null 2>&1; then
        local resolved
        resolved="$(command -v c-thru 2>/dev/null || true)"
        # Resolve symlink one level so ~/.local/bin/c-thru -> ~/.claude/tools/c-thru counts.
        local target="$resolved"
        if [ -L "$resolved" ]; then
            target="$(readlink "$resolved" 2>/dev/null || echo "$resolved")"
        fi
        case "$target" in
            "$TOOLS_DEST"/*|"$TOOLS_SRC"/*)
                echo -e "  ${GRAY}✓  c-thru already on PATH (${resolved}); skipping rc edit${NC}"
                return 0
                ;;
        esac
    fi

    # Detect rc file from $SHELL.
    local shell_name rc_file rc_label is_fish=0
    shell_name="$(basename "${SHELL:-}")"
    case "$shell_name" in
        zsh)
            rc_file="$HOME/.zshrc"
            rc_label="~/.zshrc"
            ;;
        bash)
            # On macOS, login shells read .bash_profile not .bashrc, but most
            # interactive Terminal sessions on modern setups read .bashrc via
            # a shim. Pick .bashrc for simplicity; users on bare macOS bash
            # may need to source it from .bash_profile manually.
            rc_file="$HOME/.bashrc"
            rc_label="~/.bashrc"
            ;;
        fish)
            rc_file="$HOME/.config/fish/config.fish"
            rc_label="~/.config/fish/config.fish"
            is_fish=1
            mkdir -p "$(dirname "$rc_file")" 2>/dev/null || true
            ;;
        *)
            echo -e "  ${YELLOW}⚠️  unknown shell '${shell_name:-?}'; skipping PATH edit${NC}"
            echo -e "  ${YELLOW}    Add this to your shell rc manually:${NC}"
            echo -e "  ${YELLOW}      export PATH=\"\$HOME/.claude/tools:\$PATH\"${NC}"
            return 0
            ;;
    esac

    # Idempotency guard: if the marker is already present, skip.
    if [ -f "$rc_file" ] && grep -Fq "$PATH_MARKER_BEGIN" "$rc_file" 2>/dev/null; then
        echo -e "  ${GRAY}✓  PATH block already present in ${rc_label}${NC}"
        return 0
    fi

    # Append the block. Use printf for portability (no echo -e quirks).
    {
        printf '\n%s\n' "$PATH_MARKER_BEGIN"
        if [ "$is_fish" -eq 1 ]; then
            printf '%s\n' 'if test -d $HOME/.claude/tools'
            printf '%s\n' '    set -gx PATH $HOME/.claude/tools $PATH'
            printf '%s\n' 'end'
        else
            printf '%s\n' 'if [ -d "$HOME/.claude/tools" ]; then'
            printf '%s\n' '    export PATH="$HOME/.claude/tools:$PATH"'
            printf '%s\n' 'fi'
        fi
        printf '%s\n' "$PATH_MARKER_END"
    } >> "$rc_file"

    echo -e "  ${GREEN}✅ added ~/.claude/tools to PATH in ${rc_label}${NC}"
    echo -e "  ${YELLOW}   Run \`source ${rc_label}\` (or open a new shell) to put c-thru on your PATH${NC}"
}

echo ""
echo "PATH:"
register_path

# --- Post-install end-to-end validation ---
# Proves the install actually works: syntax sanity, model-map validation,
# proxy boot + /ping, hook executability, and PATH block presence.
# Wall-clock budget: < 30s. Skip with --skip-e2e for CI / sandboxed envs.
run_e2e_checks() {
    if [ "$SKIP_E2E" = "1" ]; then
        echo ""
        echo -e "  ${GRAY}✓  e2e checks skipped (--skip-e2e)${NC}"
        return 0
    fi

    echo ""
    echo "E2E checks:"

    local proxy_pid=""
    # Cleanup helper — invoked on every exit path.
    local _cleanup_done=0
    cleanup_e2e() {
        [ "$_cleanup_done" = "1" ] && return 0
        _cleanup_done=1
        if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then
            kill -TERM "$proxy_pid" 2>/dev/null || true
            # Give it 500ms to exit gracefully, then SIGKILL.
            for _ in 1 2 3 4 5; do
                kill -0 "$proxy_pid" 2>/dev/null || break
                sleep 0.1
            done
            kill -KILL "$proxy_pid" 2>/dev/null || true
        fi
    }
    fail_e2e() {
        local what="$1" reason="$2"
        echo -e "  ${RED}[fail] ${what}: ${reason}${NC}" >&2
        cleanup_e2e
        echo -e "${RED}e2e checks failed; install may be incomplete${NC}" >&2
        exit 1
    }

    # 1. Syntax sanity — bash and node.
    local f
    # bash: tools/c-thru is the bash entrypoint (no .sh suffix) plus all *.sh files.
    for f in "$TOOLS_SRC/c-thru" "$TOOLS_SRC"/*.sh; do
        [ -f "$f" ] || continue
        if bash -n "$f" 2>/dev/null; then
            echo -e "  ${GREEN}[ok]${NC}   syntax: tools/$(basename "$f")"
        else
            fail_e2e "syntax: tools/$(basename "$f")" "bash -n failed"
        fi
    done
    if command -v node >/dev/null 2>&1; then
        # node: claude-proxy (no .js suffix) plus all *.js files.
        for f in "$TOOLS_SRC/claude-proxy" "$TOOLS_SRC"/*.js; do
            [ -f "$f" ] || continue
            if node --check "$f" 2>/dev/null; then
                echo -e "  ${GREEN}[ok]${NC}   syntax: tools/$(basename "$f")"
            else
                fail_e2e "syntax: tools/$(basename "$f")" "node --check failed"
            fi
        done
    else
        echo -e "  ${YELLOW}[skip]${NC} node syntax checks (node not installed)"
    fi

    # 2. Validate shipped model-map.
    if command -v node >/dev/null 2>&1 && [ -f "$SHIPPED_MAP" ]; then
        if node "$TOOLS_SRC/model-map-validate.js" "$SHIPPED_MAP" >/dev/null 2>&1; then
            echo -e "  ${GREEN}[ok]${NC}   validate: config/model-map.json"
        else
            fail_e2e "validate: config/model-map.json" "model-map-validate.js exited non-zero"
        fi
    else
        echo -e "  ${YELLOW}[skip]${NC} model-map validate (node or shipped map missing)"
    fi

    # 3. Spawn proxy on a free port + /ping handshake.
    if command -v node >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
        local free_port=""
        free_port="$(node -e "const s=require('net').createServer(); s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})" 2>/dev/null || true)"
        if [ -z "$free_port" ]; then
            fail_e2e "proxy boot" "could not find a free port"
        fi

        # Spawn proxy detached; collect its pid.
        node "$TOOLS_SRC/claude-proxy" --port "$free_port" >/dev/null 2>&1 &
        proxy_pid=$!

        # Poll /ping for up to 5s (10 iterations × 0.5s).
        local body="" ok_seen=0 i
        for i in 1 2 3 4 5 6 7 8 9 10; do
            if ! kill -0 "$proxy_pid" 2>/dev/null; then
                fail_e2e "proxy boot" "process exited before /ping (pid=$proxy_pid port=$free_port)"
            fi
            body="$(curl -sf --max-time 1 "http://127.0.0.1:${free_port}/ping" 2>/dev/null || true)"
            if [ -n "$body" ]; then
                ok_seen=1
                break
            fi
            sleep 0.5
        done
        if [ "$ok_seen" != "1" ]; then
            fail_e2e "proxy boot" "/ping did not respond within 5s (pid=$proxy_pid port=$free_port)"
        fi
        case "$body" in
            *'"ok":true'*|*'"ok": true'*)
                echo -e "  ${GREEN}[ok]${NC}   proxy boot: pid=${proxy_pid} port=${free_port} /ping returned ok:true"
                ;;
            *)
                fail_e2e "proxy boot" "/ping body missing ok:true (got: ${body:0:120})"
                ;;
        esac
        cleanup_e2e
        proxy_pid=""
        _cleanup_done=0
    else
        echo -e "  ${YELLOW}[skip]${NC} proxy boot (node or curl missing)"
    fi

    # 4. Hook registration round-trip.
    local settings="$CLAUDE_DIR/settings.json"
    if [ -f "$settings" ] && [ "$JQ_AVAILABLE" -eq 1 ]; then
        # Extract any hook command path that lives under TOOLS_DEST and references a c-thru tool.
        local hook_paths total=0 ok=0
        hook_paths="$(jq -r --arg t "$TOOLS_DEST" '
            [ .hooks // {} | to_entries[] | .value[]?.hooks[]?.command // empty ]
            | map(select(startswith($t) or contains("/c-thru-") or contains("/claude-proxy") or contains("/c-thru ")))
            | .[]
        ' "$settings" 2>/dev/null || true)"
        if [ -n "$hook_paths" ]; then
            local hp first_token
            while IFS= read -r hp; do
                [ -z "$hp" ] && continue
                # Hook commands may include args; take the first whitespace-delimited token.
                first_token="${hp%% *}"
                total=$((total + 1))
                if [ ! -e "$first_token" ]; then
                    fail_e2e "hooks" "registered hook missing on disk: $first_token"
                fi
                if [ ! -x "$first_token" ]; then
                    fail_e2e "hooks" "registered hook not executable: $first_token"
                fi
                ok=$((ok + 1))
            done <<< "$hook_paths"
            echo -e "  ${GREEN}[ok]${NC}   hooks: ${ok}/${total} registered hooks executable"
        else
            echo -e "  ${GRAY}[skip]${NC} hooks: no c-thru hooks registered in settings.json"
        fi
    else
        echo -e "  ${GRAY}[skip]${NC} hooks: settings.json or jq unavailable"
    fi

    # 5. PATH integration verification (only if PATH was registered).
    if [ "${C_THRU_INSTALL_NO_PATH:-0}" = "1" ]; then
        echo -e "  ${GRAY}[skip]${NC} PATH check (C_THRU_INSTALL_NO_PATH=1)"
    else
        local shell_name path_rc rc_label
        shell_name="$(basename "${SHELL:-}")"
        case "$shell_name" in
            zsh)  path_rc="$HOME/.zshrc"; rc_label="~/.zshrc" ;;
            bash) path_rc="$HOME/.bashrc"; rc_label="~/.bashrc" ;;
            fish) path_rc="$HOME/.config/fish/config.fish"; rc_label="~/.config/fish/config.fish" ;;
            *)    path_rc=""; rc_label="" ;;
        esac
        if [ -n "$path_rc" ] && [ -f "$path_rc" ]; then
            if grep -Fq "$PATH_MARKER_BEGIN" "$path_rc" 2>/dev/null; then
                echo -e "  ${GREEN}[ok]${NC}   PATH: c-thru block present in ${rc_label}"
            else
                # Block absent could be legitimate (c-thru already on PATH via another route).
                # register_path() prints a "skipping rc edit" message in that case; tolerate it.
                if command -v c-thru >/dev/null 2>&1; then
                    echo -e "  ${GRAY}[skip]${NC} PATH: c-thru already on PATH (no rc edit needed)"
                else
                    fail_e2e "PATH" "c-thru block missing from ${rc_label} and c-thru not on PATH"
                fi
            fi
        else
            echo -e "  ${GRAY}[skip]${NC} PATH: rc file ${rc_label:-unknown} not found"
        fi
    fi
}

run_e2e_checks

# --- Active route summary ---
if [ -f "$USER_MAP" ] && command -v node >/dev/null 2>&1; then
    echo ""
    echo "Active routes (effective model-map):"
    node -e "
try {
  const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  const r = m.routes || {};
  const maxLen = Math.max(...Object.keys(r).map(k=>k.length), 0);
  for (const [k,v] of Object.entries(r))
    console.log('  ' + k.padEnd(maxLen) + '  →  ' + String(v));
  const tier = (m.llm_profiles || {});
  const tiers = Object.keys(tier);
  if (tiers.length) console.log('  hw tiers configured: ' + tiers.join(', '));
} catch(e) { process.exit(0); }
" "$USER_MAP" 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}✅ Done. c-thru is now using ephemeral session control.${NC}"
