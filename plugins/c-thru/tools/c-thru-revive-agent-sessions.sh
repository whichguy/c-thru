#!/usr/bin/env bash
# c-thru-revive-agent-sessions.sh — rehydrate agent-view sessions onto the
# *current* c-thru gateway (new ANTHROPIC_BASE_URL), not the old dead port.
#
# Claude Code constraints (v2.1.209):
#   • Live workers freeze gateway env at spawn; hooks cannot rewrite the parent.
#   • Job providerEnv allowlist is mostly CLAUDE_CONFIG_DIR (+ cloud keys).
#     ANTHROPIC_BASE_URL is stripped on state parse — writing it into state.json
#     does NOT survive `claude respawn`.
#   • Respawn uses saved providerEnv; HO_() (shell gateway) is skipped when
#     providerEnv is non-empty.
#   • Therefore we stage a durable CLAUDE_CONFIG_DIR shadow whose settings.json
#     `env` carries the NEW base URL, point each stale job at that dir
#     (allowlisted), then `claude respawn <id>`.
#
# Usage:  bash tools/c-thru-revive-agent-sessions.sh
# Opt-out: C_THRU_NO_SESSION_REVIVE=1
# Dry-run: C_THRU_REVIVE_DRY_RUN=1
# Also revive done/stopped: C_THRU_REVIVE_ALL=1
# Cap respawns per run: C_THRU_REVIVE_MAX (default 20)
# Fail-open: always exit 0.
# shellcheck shell=bash
set -uo pipefail

if [[ "${C_THRU_NO_SESSION_REVIVE:-0}" == "1" ]]; then
  exit 0
fi

CURRENT_BASE="${ANTHROPIC_BASE_URL:-}"
[[ -n "$CURRENT_BASE" ]] || exit 0
case "$CURRENT_BASE" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *) exit 0 ;;
esac

# Extract port for 127.0.0.1 / localhost / [::1] (plain grep breaks on IPv6).
CURRENT_PORT=""
if [[ "$CURRENT_BASE" =~ ^https?://\[::1\]:([0-9]+)(/|$) ]]; then
  CURRENT_PORT="${BASH_REMATCH[1]}"
elif [[ "$CURRENT_BASE" =~ ^https?://(127\.0\.0\.1|localhost):([0-9]+)(/|$) ]]; then
  CURRENT_PORT="${BASH_REMATCH[2]}"
fi
[[ -n "$CURRENT_PORT" ]] || exit 0

JOBS_DIR="${CLAUDE_JOBS_DIR:-${HOME}/.claude/jobs}"
[[ -d "$JOBS_DIR" ]] || exit 0

PROFILE="${CLAUDE_DIR:-${HOME}/.claude}"
GATEWAY_DIR="${C_THRU_AGENT_GATEWAY_DIR:-$PROFILE/c-thru-agent-gateway}"
export_token="${ANTHROPIC_AUTH_TOKEN:-}"

CLAUDE_CLI="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
if [[ -z "$CLAUDE_CLI" || ! -x "$CLAUDE_CLI" ]]; then
  for cand in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
    [[ -x "$cand" ]] && CLAUDE_CLI="$cand" && break
  done
fi
[[ -n "${CLAUDE_CLI:-}" && -x "$CLAUDE_CLI" ]] || exit 0

# Prefer real vendor binary over a c-thru wrapper (respawn must hit Claude Code).
if [[ -L "$CLAUDE_CLI" ]]; then
  _resolved="$(readlink "$CLAUDE_CLI" 2>/dev/null || true)"
  case "$_resolved" in
    *c-thru*|*cthru*)
      for cand in "$HOME/.local/share/claude/versions/"*/claude "$HOME/.local/bin/claude"; do
        if [[ -x "$cand" && ! -L "$cand" ]]; then CLAUDE_CLI="$cand"; break; fi
        if [[ -x "$cand" ]]; then
          _r2="$(readlink "$cand" 2>/dev/null || true)"
          case "$_r2" in *c-thru*|*cthru*) continue ;; *) CLAUDE_CLI="$cand"; break ;; esac
        fi
      done
      ;;
  esac
fi

# Stage durable gateway profile: settings.env carries the NEW base URL only.
# Do NOT persist real auth tokens (OAuth/API keys) to disk — proxy sessions use
# placeholders (ollama) or keychain; writing sk-ant-* would leak credentials.
stage_gateway_dir() {
  local base="$1" token="$2"
  mkdir -p "$GATEWAY_DIR" || return 1

  if [[ -d "$PROFILE" ]]; then
    # Safe, non-word-splitting symlink loop (null-delimited find).
    # Cap entries so a bloated ~/.claude never stalls brand agent open.
    local src bn dest linked=0
    local max_links="${C_THRU_GATEWAY_SYMLINK_MAX:-200}"
    while IFS= read -r -d '' src; do
      bn="$(basename -- "$src")"
      # Never re-enter the gateway dir or overwrite staged settings.
      case "$bn" in
        c-thru-agent-gateway|settings.json|settings.local.json) continue ;;
      esac
      # Skip empty/odd basenames and path separators (paranoia).
      [[ -n "$bn" && "$bn" != "." && "$bn" != ".." ]] || continue
      case "$bn" in
        *'/'*|*$'\n'*) continue ;;
      esac
      dest="$GATEWAY_DIR/$bn"
      # Idempotent: leave existing entries alone.
      [[ -L "$dest" || -e "$dest" ]] && continue
      # Only link regular files or directories; skip sockets/devices/fifos.
      if [[ -d "$src" || -f "$src" || -L "$src" ]]; then
        ln -s "$src" "$dest" 2>/dev/null || true
        linked=$((linked + 1))
      fi
      if [[ "$linked" -ge "$max_links" ]]; then
        echo "c-thru: gateway symlink cap ($max_links) reached under $PROFILE" >&2
        break
      fi
    done < <(find "$PROFILE" -mindepth 1 -maxdepth 1 -print0 2>/dev/null || true)
  fi

  # Only persist placeholder tokens safe for local proxy spoofing.
  local safe_token=""
  case "$token" in
    ollama|unused|test-token|"")
      safe_token="$token"
      ;;
    *)
      # Real-looking secrets: omit from on-disk settings.
      safe_token=""
      ;;
  esac

  node -e '
    const fs = require("fs");
    const path = require("path");
    const gatewayDir = process.argv[1];
    const profileDir = process.argv[2];
    const base = process.argv[3];
    const token = process.argv[4] || "";
    const settingsPath = path.join(gatewayDir, "settings.json");
    const profileSettings = path.join(profileDir, "settings.json");
    let s = {};
    try { s = JSON.parse(fs.readFileSync(profileSettings, "utf8")); } catch {}
    if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
    delete s.model;
    delete s.apiKeyHelper;
    s.env = (s.env && typeof s.env === "object" && !Array.isArray(s.env)) ? { ...s.env } : {};
    // Scrub secret-shaped keys copied from the user profile settings.env.
    const secretRe = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION)$/i;
    for (const k of Object.keys(s.env)) {
      if (secretRe.test(k) || /^sk-[a-z0-9]/i.test(String(s.env[k] || ""))) {
        delete s.env[k];
      }
    }
    s.env.ANTHROPIC_BASE_URL = base;
    // Never leave a prior real token in the staged gateway file.
    delete s.env.ANTHROPIC_AUTH_TOKEN;
    if (token) s.env.ANTHROPIC_AUTH_TOKEN = token;
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  ' "$GATEWAY_DIR" "$PROFILE" "$base" "$safe_token" 2>/dev/null || return 1
  return 0
}

if ! stage_gateway_dir "$CURRENT_BASE" "$export_token"; then
  echo "c-thru: session revive — could not stage gateway dir at $GATEWAY_DIR" >&2
  exit 0
fi

# One process-table snapshot for the whole run (needs_revive used to shell out
# to `ps eww -A` once per job — O(jobs × procs) and slow on busy machines).
if [[ -z "${C_THRU_REVIVE_PS_SNAPSHOT+x}" ]]; then
  C_THRU_REVIVE_PS_SNAPSHOT="$(ps eww -A 2>/dev/null | head -c 16777216 || true)"
  export C_THRU_REVIVE_PS_SNAPSHOT
fi

# Cache current-gateway /ping once (avoids N curls across jobs).
if [[ -z "${C_THRU_REVIVE_CURRENT_PORT_OK+x}" ]]; then
  if curl -sf --max-time 1 "http://127.0.0.1:${CURRENT_PORT}/ping" >/dev/null 2>&1; then
    C_THRU_REVIVE_CURRENT_PORT_OK=1
  else
    C_THRU_REVIVE_CURRENT_PORT_OK=0
  fi
  export C_THRU_REVIVE_CURRENT_PORT_OK
fi

# Classify a job for revive.
# Exit codes: 0 = full respawn, 2 = patch providerEnv only (healthy live), 1 = skip.
needs_revive() {
  local job_id="$1" state_file="$2"
  node -e '
    const fs = require("fs");
    const { execSync } = require("child_process");
    const statePath = process.argv[1];
    const jobId = process.argv[2];
    const currentPort = process.argv[3];
    const gatewayDir = process.argv[4];
    const reviveAll = process.env.C_THRU_REVIVE_ALL === "1";
    let st;
    try { st = JSON.parse(fs.readFileSync(statePath, "utf8")); }
    catch { process.exit(1); }

    const state = String(st.state || "");
    // Terminal states: skip unless C_THRU_REVIVE_ALL=1
    if (!reviveAll && /^(done|stopped|failed)$/i.test(state)) process.exit(1);

    const flags = Array.isArray(st.respawnFlags) ? st.respawnFlags : [];
    const pe = st.providerEnv && typeof st.providerEnv === "object" ? st.providerEnv : {};
    const model = (() => {
      const i = flags.indexOf("--model");
      return i >= 0 ? String(flags[i + 1] || "") : "";
    })();
    const brandish = /^(grok|gemini|deepseek|kimi|qwen|glm|minimax|moonshot|xai)/i.test(model)
      || (model && !/^(sonnet|opus|haiku|fable|claude)/i.test(model));
    const cthruShadow = typeof pe.CLAUDE_CONFIG_DIR === "string"
      && (pe.CLAUDE_CONFIG_DIR.includes("c-thru-session.")
          || pe.CLAUDE_CONFIG_DIR.includes("c-thru-agent-gateway"));
    const alreadyGateway = pe.CLAUDE_CONFIG_DIR === gatewayDir;

    let liveBase = "";
    try {
      // Prefer the one-shot snapshot from the parent shell; fall back to a
      // live ps only if the env snapshot was not provided.
      let out = process.env.C_THRU_REVIVE_PS_SNAPSHOT || "";
      if (!out) {
        out = execSync("ps eww -A 2>/dev/null || true", {
          encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        });
      }
      const short = String(st.daemonShort || jobId);
      for (const line of out.split("\n")) {
        if (!/claude|daemon/i.test(line)) continue;
        if (!line.includes(jobId) && !line.includes(short)) continue;
        const m = line.match(/ANTHROPIC_BASE_URL=(https?:\/\/[^\s]+)/);
        if (m) { liveBase = m[1]; break; }
      }
    } catch { /* ignore */ }

    // Prefer loopback host:port; tolerate [::1]:port and bare :port tails.
    let livePort = "";
    const m6 = liveBase.match(/\[::1\]:(\d+)/);
    const m4 = liveBase.match(/(?:127\.0\.0\.1|localhost):(\d+)/);
    const mAny = liveBase.match(/:(\d+)(?:\/|$)/);
    if (m6) livePort = m6[1];
    else if (m4) livePort = m4[1];
    else if (mAny) livePort = mAny[1];

    function portOk(port) {
      if (!port) return false;
      if (port === currentPort) {
        const cached = process.env.C_THRU_REVIVE_CURRENT_PORT_OK;
        if (cached === "1") return true;
        if (cached === "0") return false;
      }
      try {
        execSync("curl -sf --max-time 1 http://127.0.0.1:" + port + "/ping", { stdio: "ignore" });
        return true;
      } catch { return false; }
    }

    const candidate = brandish || cthruShadow || !!livePort;
    if (!candidate) process.exit(1);

    const currentOk = portOk(currentPort);
    // Healthy on current gateway + already pointed at gateway dir — skip.
    if (livePort === currentPort && currentOk && alreadyGateway) process.exit(1);

    const liveWrong = livePort && livePort !== currentPort;
    const liveDead = livePort && !portOk(livePort);
    const active = /^(working|blocked)$/i.test(state);

    // Full respawn (exit 0):
    //  • live process on wrong port, or live port is dead
    //  • active job with no live env (daemon gone) — includes alreadyGateway
    if (liveWrong || liveDead) process.exit(0);
    if (!livePort && active) process.exit(0);

    // Patch-only (exit 2): worker is healthy on the *current* gateway but
    // state still points at an old c-thru-session shadow. Do NOT kill the
    // live worker — only update providerEnv so a later respawn picks up the
    // staged gateway settings.env.
    if (livePort === currentPort && currentOk && !alreadyGateway) process.exit(2);

    process.exit(1);
  ' "$state_file" "$job_id" "$CURRENT_PORT" "$GATEWAY_DIR" 2>/dev/null
}

# Patch job state.providerEnv.CLAUDE_CONFIG_DIR → gateway (no respawn).
patch_job_gateway() {
  local job_id="$1" state_file="$2"
  if [[ "${C_THRU_REVIVE_DRY_RUN:-0}" == "1" ]]; then
    echo "c-thru: revive dry-run patch-only job=$job_id → CLAUDE_CONFIG_DIR=$GATEWAY_DIR" >&2
    return 0
  fi
  if ! node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const gatewayDir = process.argv[2];
    let st;
    try { st = JSON.parse(fs.readFileSync(path, "utf8")); }
    catch { process.exit(2); }
    st.providerEnv = st.providerEnv && typeof st.providerEnv === "object" ? st.providerEnv : {};
    st.providerEnv.CLAUDE_CONFIG_DIR = gatewayDir;
    delete st.providerEnv.ANTHROPIC_BASE_URL;
    delete st.providerEnv.ANTHROPIC_AUTH_TOKEN;
    st.updatedAt = new Date().toISOString();
    fs.writeFileSync(path, JSON.stringify(st, null, 2) + "\n");
  ' "$state_file" "$GATEWAY_DIR" 2>/dev/null; then
    echo "c-thru: revive skip $job_id (state patch failed)" >&2
    return 1
  fi
  return 0
}

revive_one() {
  local job_id="$1" state_file="$2"
  if [[ "${C_THRU_REVIVE_DRY_RUN:-0}" == "1" ]]; then
    echo "c-thru: revive dry-run job=$job_id → CLAUDE_CONFIG_DIR=$GATEWAY_DIR base=$CURRENT_BASE" >&2
    return 0
  fi

  if ! patch_job_gateway "$job_id" "$state_file"; then
    return 0
  fi

  local out
  if out="$("$CLAUDE_CLI" respawn "$job_id" 2>&1)"; then
    echo "c-thru: revived session $job_id with gateway $CURRENT_BASE" >&2
  else
    sleep 0.5
    if out="$("$CLAUDE_CLI" respawn "$job_id" 2>&1)"; then
      echo "c-thru: revived session $job_id with gateway $CURRENT_BASE (retry)" >&2
    else
      echo "c-thru: revive respawn failed for $job_id: ${out:0:160}" >&2
    fi
  fi
}

revived=0
patched=0
# Cap respawns so a jobs dir full of stale brand jobs cannot thrash on open.
REVIVE_MAX="${C_THRU_REVIVE_MAX:-20}"
if ! [[ "$REVIVE_MAX" =~ ^[0-9]+$ ]] || [[ "$REVIVE_MAX" -le 0 ]]; then
  REVIVE_MAX=20
fi

for state_file in "$JOBS_DIR"/*/state.json; do
  [[ -f "$state_file" ]] || continue
  job_id="$(basename "$(dirname "$state_file")")"
  # Real Claude job dirs are short hex (e.g. 13eca995); keep the filter tight.
  [[ "$job_id" =~ ^[a-f0-9]{6,}$ ]] || continue

  needs_revive "$job_id" "$state_file"
  nr=$?
  if [[ "$nr" -eq 0 ]]; then
    if [[ "$revived" -ge "$REVIVE_MAX" ]]; then
      echo "c-thru: revive cap ($REVIVE_MAX) reached; remaining jobs skipped" >&2
      break
    fi
    revive_one "$job_id" "$state_file"
    revived=$((revived + 1))
  elif [[ "$nr" -eq 2 ]]; then
    # Healthy live worker: retarget state only (counts against patch budget,
    # not the respawn cap).
    if patch_job_gateway "$job_id" "$state_file"; then
      patched=$((patched + 1))
      if [[ -n "${C_THRU_DEBUG:-}" && "${C_THRU_DEBUG}" != "0" ]]; then
        echo "c-thru: revive patch-only job=$job_id (healthy live on :$CURRENT_PORT)" >&2
      fi
    fi
  fi
done

if [[ -n "${C_THRU_DEBUG:-}" && "${C_THRU_DEBUG}" != "0" ]]; then
  echo "c-thru: session revive complete revived=$revived patched=$patched gateway=$GATEWAY_DIR base=$CURRENT_BASE" >&2
fi

exit 0
