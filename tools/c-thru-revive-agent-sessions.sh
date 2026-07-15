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
#     (allowlisted), then `claude respawn <id>` only when the worker is NOT live.
#
# Live detection does NOT require ANTHROPIC_BASE_URL in the process env (bg
# workers often omit it). Signals: process table job/session id, CLAUDE_JOB_DIR,
# rv sock under /tmp/cc-daemon-*/rv/<id>.sock, optional `claude agents --json`.
#
# Usage:  bash tools/c-thru-revive-agent-sessions.sh
# Opt-out: C_THRU_NO_SESSION_REVIVE=1
# Dry-run: C_THRU_REVIVE_DRY_RUN=1
# Also respawn done/stopped: C_THRU_REVIVE_ALL=1
# Cap respawns per run: C_THRU_REVIVE_MAX (default 20)
# Skip agents --json probe: C_THRU_REVIVE_SKIP_AGENTS_JSON=1
# Test overrides: C_THRU_REVIVE_PS_SNAPSHOT, C_THRU_CC_DAEMON_DIR, C_THRU_REVIVE_LIVE_IDS
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

# Shared gateway is used by many brand jobs — never store a session-scoped
# /s/<id> URL (one job's scope would poison every attach/resume).
# Host preserves 127.0.0.1 vs localhost vs [::1] from the caller when possible.
GATEWAY_BASE=""
if [[ "$CURRENT_BASE" =~ ^https?://\[::1\]: ]]; then
  GATEWAY_BASE="http://[::1]:${CURRENT_PORT}"
elif [[ "$CURRENT_BASE" =~ ^https?://localhost: ]]; then
  GATEWAY_BASE="http://localhost:${CURRENT_PORT}"
else
  GATEWAY_BASE="http://127.0.0.1:${CURRENT_PORT}"
fi

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

  # Auth for durable gateway (bg workers load CLAUDE_CONFIG_DIR=gateway):
  #   • Claude with a custom ANTHROPIC_BASE_URL does NOT consult keychain for
  #     the login gate — it needs ANTHROPIC_AUTH_TOKEN in env/settings.
  #   • Placeholder tokens (ollama / unused / test-token) make the client show
  #     "Not logged in · Please run /login" and block all turns.
  #   • Prefer a real subscription OAuth token from the process env, else the
  #     macOS keychain / credentials store (same source as c-thru inject).
  #   • Never write placeholders. Empty token → omit AUTH_TOKEN (BASE_URL only).
  local safe_token=""
  case "$token" in
    ollama|unused|test-token|proxied-placeholder|"")
      safe_token=""
      ;;
    sk-ant-*|sk-*)
      safe_token="$token"
      ;;
    *)
      # Other non-empty values (e.g. long opaque oauth): keep if looks substantial.
      if [[ ${#token} -ge 20 ]]; then
        safe_token="$token"
      else
        safe_token=""
      fi
      ;;
  esac
  if [[ -z "$safe_token" ]]; then
    # Best-effort keychain/credentials (fail-open).
    local raw="" tok=""
    case "$(uname -s 2>/dev/null)" in
      Darwin)
        raw="$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || true)"
        ;;
      *)
        if [[ -r "${HOME}/.claude/.credentials.json" ]]; then
          raw="$(cat "${HOME}/.claude/.credentials.json" 2>/dev/null || true)"
        fi
        ;;
    esac
    if [[ -n "$raw" ]] && command -v node >/dev/null 2>&1; then
      tok="$(printf '%s' "$raw" | node -e '
        let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
          try {
            const j=JSON.parse(d);
            const t=(j.claudeAiOauth&&j.claudeAiOauth.accessToken)||"";
            process.stdout.write(t||"");
          } catch { process.stdout.write(""); }
        });
      ' 2>/dev/null || true)"
      if [[ -n "$tok" && "$tok" != "null" ]]; then
        safe_token="$tok"
      fi
    fi
  fi

  # Durable apiKeyHelper: Claude runs this at request time (attach/resume/live
  # workers). Fixes "Not logged in" when static env was ollama/empty/stale.
  # Prefer install symlink under durable ~/.claude/tools when present.
  local auth_helper=""
  if [[ -x "${HOME}/.claude/tools/c-thru-gateway-auth-helper" ]]; then
    auth_helper="${HOME}/.claude/tools/c-thru-gateway-auth-helper"
  elif [[ -x "${CLAUDE_DIR:-}/tools/c-thru-gateway-auth-helper" ]]; then
    # Only if CLAUDE_DIR is not an ephemeral c-thru-session shadow.
    case "${CLAUDE_DIR:-}" in
      *c-thru-session.*) ;;
      *) auth_helper="${CLAUDE_DIR}/tools/c-thru-gateway-auth-helper" ;;
    esac
  fi
  if [[ -z "$auth_helper" && -f "${BASH_SOURCE[0]%/*}/c-thru-gateway-auth-helper.sh" ]]; then
    auth_helper="${BASH_SOURCE[0]%/*}/c-thru-gateway-auth-helper.sh"
  fi

  # Prints "changed|unchanged" on stdout (for caller); returns 0 on write success.
  node -e '
    const fs = require("fs");
    const path = require("path");
    const gatewayDir = process.argv[1];
    const profileDir = process.argv[2];
    const base = process.argv[3];
    let token = process.argv[4] || "";
    const authHelper = process.argv[5] || "";
    const settingsPath = path.join(gatewayDir, "settings.json");
    const profileSettings = path.join(profileDir, "settings.json");
    const placeholders = new Set(["ollama", "unused", "test-token", "proxied-placeholder", ""]);
    const isReal = (t) => !!(t && !placeholders.has(t) && String(t).length >= 20);

    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
    const prevEnv = (prev && prev.env && typeof prev.env === "object") ? prev.env : {};
    const prevBase = String(prevEnv.ANTHROPIC_BASE_URL || "");
    const prevTok = String(prevEnv.ANTHROPIC_AUTH_TOKEN || "");
    const prevHelper = String(prev.apiKeyHelper || "");

    // Never downgrade: if we have no new real token but a prior real token exists, keep it.
    // (Keychain can fail briefly after reboot/login; wiping it causes "Not logged in".)
    if (!isReal(token) && isReal(prevTok)) {
      token = prevTok;
    }

    let s = {};
    try { s = JSON.parse(fs.readFileSync(profileSettings, "utf8")); } catch {}
    if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
    delete s.model;
    s.env = (s.env && typeof s.env === "object" && !Array.isArray(s.env)) ? { ...s.env } : {};
    // Scrub secret-shaped keys copied from the user profile settings.env
    // (we re-add a deliberate token below when available).
    const secretRe = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION)$/i;
    for (const k of Object.keys(s.env)) {
      if (secretRe.test(k) || /^sk-[a-z0-9]/i.test(String(s.env[k] || ""))) {
        delete s.env[k];
      }
    }
    s.env.ANTHROPIC_BASE_URL = base;
    // Clear prior token (including poisoned "ollama"), then set real if we have one.
    // Prefer apiKeyHelper for live refresh on attach; static token is a fallback.
    delete s.env.ANTHROPIC_AUTH_TOKEN;
    delete s.env.ANTHROPIC_API_KEY;
    if (isReal(token)) {
      s.env.ANTHROPIC_AUTH_TOKEN = token;
    }
    if (authHelper) {
      s.apiKeyHelper = authHelper;
    } else {
      delete s.apiKeyHelper;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");

    const newTok = String(s.env.ANTHROPIC_AUTH_TOKEN || "");
    const newHelper = String(s.apiKeyHelper || "");
    const baseChanged = prevBase !== base;
    const tokChanged = prevTok !== newTok;
    const helperChanged = prevHelper !== newHelper;
    // Auth became usable: empty/placeholder → real token, or helper installed
    const authUpgraded = (isReal(newTok) && !isReal(prevTok)) || (!!newHelper && !prevHelper);
    const material = baseChanged || tokChanged || helperChanged || authUpgraded;
    process.stdout.write(material ? "changed" : "unchanged");
  ' "$GATEWAY_DIR" "$PROFILE" "$base" "$safe_token" "$auth_helper" 2>/dev/null || return 1
  return 0
}

GATEWAY_STAGE_STATUS="unchanged"
if ! GATEWAY_STAGE_STATUS="$(stage_gateway_dir "$GATEWAY_BASE" "$export_token")"; then
  echo "c-thru: session revive — could not stage gateway dir at $GATEWAY_DIR" >&2
  exit 0
fi
GATEWAY_STAGE_STATUS="${GATEWAY_STAGE_STATUS//$'\n'/}"
[[ -n "$GATEWAY_STAGE_STATUS" ]] || GATEWAY_STAGE_STATUS="unchanged"
export C_THRU_GATEWAY_STAGE_STATUS="$GATEWAY_STAGE_STATUS"
if [[ -n "${C_THRU_DEBUG:-}" && "${C_THRU_DEBUG}" != "0" ]]; then
  echo "c-thru: gateway stage status=$GATEWAY_STAGE_STATUS base=$GATEWAY_BASE (unscoped)" >&2
fi
# One process-table snapshot for the whole run.
# IMPORTANT: never put multi-MB data into the process environment — that makes
# every subsequent exec fail with "Argument list too long" (E2BIG). Always use
# a temp file in production. Tests may inject a *small* C_THRU_REVIVE_PS_SNAPSHOT;
# oversized snapshots are spilled to a file automatically.
_cthru_revive_ps_cleanup() { rm -f "${C_THRU_REVIVE_PS_FILE:-}"; }
if [[ -z "${C_THRU_REVIVE_PS_FILE+x}" ]]; then
  if [[ -n "${C_THRU_REVIVE_PS_SNAPSHOT+x}" && ${#C_THRU_REVIVE_PS_SNAPSHOT} -le 65536 ]]; then
    # Small test fixture stays in env (node reads C_THRU_REVIVE_PS_SNAPSHOT).
    :
  else
    C_THRU_REVIVE_PS_FILE="$(mktemp "${TMPDIR:-/tmp}/c-thru-revive-ps.XXXXXX")"
    if [[ -n "${C_THRU_REVIVE_PS_SNAPSHOT+x}" ]]; then
      # Oversized injected snapshot → spill, then drop env to avoid E2BIG.
      printf '%s' "$C_THRU_REVIVE_PS_SNAPSHOT" >"$C_THRU_REVIVE_PS_FILE" || true
      unset C_THRU_REVIVE_PS_SNAPSHOT
    else
      ps eww -A 2>/dev/null | head -c 16777216 >"$C_THRU_REVIVE_PS_FILE" || true
    fi
    export C_THRU_REVIVE_PS_FILE
    trap '_cthru_revive_ps_cleanup' EXIT
  fi
fi

# Build set of live job ids (newline-separated, sorted unique).
# Does NOT require ANTHROPIC_BASE_URL in process env.
build_live_job_ids() {
  # Explicit test override
  if [[ -n "${C_THRU_REVIVE_LIVE_IDS:-}" ]]; then
    printf '%s\n' $C_THRU_REVIVE_LIVE_IDS | tr ' ' '\n' | grep -E '^[a-f0-9]{6,}$' | sort -u
    return 0
  fi

  node -e '
    const fs = require("fs");
    const path = require("path");
    const { execSync } = require("child_process");
    const live = new Set();
    const hex = /^[a-f0-9]{6,}$/;
    const add = (id) => { if (id && hex.test(id)) live.add(id); };

    // L1: process table — job id, session id, CLAUDE_JOB_DIR, --resume path.
    // Prefer file (production) over env snapshot (tests / small fixtures).
    let ps = "";
    if (process.env.C_THRU_REVIVE_PS_FILE) {
      try { ps = fs.readFileSync(process.env.C_THRU_REVIVE_PS_FILE, "utf8"); } catch { ps = ""; }
    } else if (process.env.C_THRU_REVIVE_PS_SNAPSHOT != null) {
      ps = process.env.C_THRU_REVIVE_PS_SNAPSHOT || "";
    } else {
      try {
        ps = execSync("ps eww -A 2>/dev/null || true", {
          encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        });
      } catch { ps = ""; }
    }
    for (const line of ps.split("\n")) {
      if (!line) continue;
      // CLAUDE_JOB_DIR=.../jobs/<id>
      let m = line.match(/CLAUDE_JOB_DIR=[^\s]*\/jobs\/([a-f0-9]{6,})(?:\s|$|\/)/);
      if (m) add(m[1]);
      // CLAUDE_BG_RENDEZVOUS_SOCK=.../rv/<id>.sock
      m = line.match(/\/rv\/([a-f0-9]{6,})\.sock/);
      if (m) add(m[1]);
      // --resume .../<uuid>.jsonl where short id is first 8 hex of uuid
      m = line.match(/--resume\s+\S*?\/([a-f0-9]{8})-[a-f0-9-]{27}\.jsonl/);
      if (m) add(m[1]);
      // bare job id as path segment jobs/<id>
      m = line.match(/\/jobs\/([a-f0-9]{6,})(?:\s|$|\/)/);
      if (m) add(m[1]);
      // Explicit env markers (no free-token scan — avoids PID false positives)
      m = line.match(/\bdaemonShort=([a-f0-9]{6,})\b/);
      if (m) add(m[1]);
      m = line.match(/\bCLAUDE_CODE_SESSION_ID=([a-f0-9]{8})-[a-f0-9-]{27}\b/);
      if (m) add(m[1]);
    }

    // L2: rendezvous sockets under cc-daemon dirs.
    // Prefer C_THRU_CC_DAEMON_DIR (exact root or parent of rv/); else /tmp/cc-daemon-*.
    const now = Date.now() / 1000;
    const maxAgeSec = Number(process.env.C_THRU_REVIVE_SOCK_MAX_AGE_SEC || 86400);
    const roots = [];
    if (process.env.C_THRU_CC_DAEMON_DIR) {
      roots.push(process.env.C_THRU_CC_DAEMON_DIR);
    } else {
      try {
        for (const name of fs.readdirSync("/tmp")) {
          if (name.startsWith("cc-daemon-")) roots.push(path.join("/tmp", name));
        }
      } catch { /* ignore */ }
    }
    for (const root of roots) {
      const rvDirs = [];
      try {
        const st = fs.statSync(root);
        if (!st.isDirectory()) continue;
      } catch { continue; }
      // root may be daemon dir (has rv/) or already rv/
      const candidates = [path.join(root, "rv"), root];
      for (const d of candidates) {
        let entries;
        try { entries = fs.readdirSync(d); } catch { continue; }
        for (const name of entries) {
          const m = name.match(/^([a-f0-9]{6,})\.sock$/);
          if (!m) continue;
          const full = path.join(d, name);
          try {
            const st = fs.statSync(full);
            // Accept socket or any file (tests may use plain files).
            const age = now - st.mtimeMs / 1000;
            // Sock alone is NOT enough (stale after agent stop / partial cleanup).
            // Require process-table corroboration, or a very fresh sock (<120s)
            // which is almost certainly from a live worker.
            const inPs = ps.includes(full) || ps.includes("/rv/" + m[1] + ".sock") || ps.includes(name);
            if (inPs) add(m[1]);
            else if (age <= 120) add(m[1]);
            else if (age <= maxAgeSec && ps.includes(m[1])) add(m[1]);
          } catch { /* ignore */ }
        }
      }
    }

    // L3: optional budgeted claude agents --json (skip when opt-out or no binary).
    // Use spawnSync timeout (macOS often lacks GNU timeout).
    if (process.env.C_THRU_REVIVE_SKIP_AGENTS_JSON !== "1") {
      const cli = process.env.CLAUDE_BIN || process.env.CLAUDE_CLI || "claude";
      try {
        const { spawnSync } = require("child_process");
        // Strip any leftover huge snapshot from the child env (E2BIG defense).
        const env = { ...process.env };
        delete env.C_THRU_REVIVE_PS_SNAPSHOT;
        const r = spawnSync(cli, ["agents", "--json"], {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: 4 * 1024 * 1024,
          env,
        });
        const out = (r.stdout || "").trim();
        if (out) {
          const j = JSON.parse(out);
          const arr = Array.isArray(j) ? j : (j.sessions || j.agents || []);
          for (const e of arr) {
            if (e && e.pid != null && String(e.pid) !== "" && Number(e.pid) !== 0) {
              add(String(e.id || e.daemonShort || ""));
            }
          }
        }
      } catch { /* fail-open */ }
    }

    process.stdout.write([...live].sort().join("\n") + (live.size ? "\n" : ""));
  ' 2>/dev/null || true
}

LIVE_JOB_IDS="$(build_live_job_ids)"
# Do not export LIVE_JOB_IDS (keep shell-local; no need on child env).

job_is_live() {
  local job_id="$1"
  [[ -n "$job_id" && -n "$LIVE_JOB_IDS" ]] || return 1
  # Fixed-string line match; avoid piping huge lists through external grep when empty.
  case $'\n'"$LIVE_JOB_IDS"$'\n' in
    *$'\n'"$job_id"$'\n'*) return 0 ;;
  esac
  return 1
}

# Resolve durable hook binaries (never ephemeral c-thru-session shadows).
resolve_durable_hook() {
  local stem="$1" # e.g. c-thru-session-start
  local profile_tools="${CLAUDE_DIR:-${HOME}/.claude}/tools"
  # Prefer install symlink under durable profile tools.
  if [[ -x "$profile_tools/$stem" ]]; then
    # Prefer the symlink under durable ~/.claude/tools — install keeps it
    # pointed at the repo tools/*.sh; do not walk through c-thru-session shadows.
    printf '%s' "$profile_tools/$stem"
    return 0
  fi
  if [[ -f "${CTHRU_SELF_DIR:-}/$stem.sh" ]]; then
    printf '%s' "${CTHRU_SELF_DIR}/$stem.sh"
    return 0
  fi
  # Repo layout when revive is run from tools/
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$here/$stem.sh" ]]; then
    printf '%s' "$here/$stem.sh"
    return 0
  fi
  return 1
}

DURABLE_SESSION_START="$(resolve_durable_hook c-thru-session-start || true)"
DURABLE_STOP_FAILURE="$(resolve_durable_hook c-thru-stop-failure-hook || true)"
export DURABLE_SESSION_START DURABLE_STOP_FAILURE

# Classify a job for revive.
# Exit codes: 0 = full respawn, 2 = patch providerEnv only, 1 = skip.
needs_revive() {
  local job_id="$1" state_file="$2"
  local is_live=0
  if job_is_live "$job_id"; then is_live=1; fi

  node -e '
    const fs = require("fs");
    const statePath = process.argv[1];
    const jobId = process.argv[2];
    const gatewayDir = process.argv[3];
    const isLive = process.argv[4] === "1";
    const reviveAll = process.env.C_THRU_REVIVE_ALL === "1";
    let st;
    try { st = JSON.parse(fs.readFileSync(statePath, "utf8")); }
    catch { process.exit(1); }

    const state = String(st.state || "");
    const terminal = /^(done|stopped|failed)$/i.test(state);
    const active = /^(working|blocked)$/i.test(state);

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

    // Stale --settings hook paths baked under deleted c-thru-session.* shadows.
    function hasStaleHookPaths(fl) {
      const i = fl.indexOf("--settings");
      if (i < 0) return false;
      const raw = String(fl[i + 1] || "");
      if (!raw) return false;
      let obj;
      try { obj = JSON.parse(raw); } catch { return /c-thru-session\./.test(raw); }
      const cmds = [];
      const hooks = obj && obj.hooks;
      if (!hooks || typeof hooks !== "object") return /c-thru-session\./.test(raw);
      for (const ev of Object.keys(hooks)) {
        for (const entry of hooks[ev] || []) {
          for (const h of (entry.hooks || [])) {
            if (h && h.command) cmds.push(String(h.command));
          }
        }
      }
      for (const c of cmds) {
        // Only c-thru hooks — do not thrash on unrelated third-party commands.
        if (!/c-thru-(session-start|stop-failure)/.test(c)) continue;
        if (c.includes("c-thru-session.")) return true;
        // Missing durable path also counts as stale (resume would fail).
        try { if (!fs.existsSync(c)) return true; } catch { return true; }
      }
      return false;
    }
    const staleHooks = hasStaleHookPaths(flags);

    const candidate = brandish || cthruShadow || staleHooks;
    if (!candidate) process.exit(1);

    // Gateway auth/base was just refreshed (e.g. after reboot / new proxy port).
    // Live workers freeze env at spawn — they keep "ollama"/empty/old port until
    // stop+respawn. Signal exit 3 = force recycle even if live.
    const gatewayChanged = process.env.C_THRU_GATEWAY_STAGE_STATUS === "changed";

    // Live worker: normally NEVER respawn (avoids "already running as bg").
    // Exception: gateway settings material change → need recycle to pick up
    // real OAuth / new BASE_URL (otherwise "Not logged in" forever).
    if (isLive) {
      if (gatewayChanged && (brandish || cthruShadow || alreadyGateway)) {
        process.exit(3); // force recycle
      }
      if (alreadyGateway && !staleHooks) process.exit(1); // skip
      process.exit(2); // patch-only
    }

    // Dead worker + terminal: patch durable gateway / hooks; respawn only if ALL.
    if (terminal) {
      if (reviveAll) process.exit(0);
      if (!alreadyGateway || staleHooks) process.exit(2); // patch-only
      process.exit(1);
    }

    // Dead + active: respawn (daemon gone) — whether already on gateway or not.
    // (Stale hooks get rewritten during the patch step before respawn.)
    if (active) process.exit(0);

    // Other non-terminal states with brand/cthru shadow: patch only if needed.
    if (!alreadyGateway || staleHooks) process.exit(2);
    process.exit(1);
  ' "$state_file" "$job_id" "$GATEWAY_DIR" "$is_live" 2>/dev/null
}

# Patch job state: providerEnv → gateway + rewrite ephemeral hook paths in
# respawnFlags --settings (SessionStart:resume must not point at deleted tmp).
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
    const sessionStart = process.argv[3] || "";
    const stopFailure = process.argv[4] || "";
    let st;
    try { st = JSON.parse(fs.readFileSync(path, "utf8")); }
    catch { process.exit(2); }
    st.providerEnv = st.providerEnv && typeof st.providerEnv === "object" ? st.providerEnv : {};
    st.providerEnv.CLAUDE_CONFIG_DIR = gatewayDir;
    delete st.providerEnv.ANTHROPIC_BASE_URL;
    delete st.providerEnv.ANTHROPIC_AUTH_TOKEN;

    // Rewrite --settings hook command paths that live under deleted
    // c-thru-session.* shadows (or any missing path) to durable tools.
    if (Array.isArray(st.respawnFlags)) {
      const fi = st.respawnFlags.indexOf("--settings");
      if (fi >= 0 && st.respawnFlags[fi + 1]) {
        let obj = null;
        const raw = String(st.respawnFlags[fi + 1]);
        try { obj = JSON.parse(raw); } catch { obj = null; }
        if (obj && obj.hooks && typeof obj.hooks === "object") {
          let changed = false;
          function rewriteCmd(cmd) {
            if (!cmd || typeof cmd !== "string") return cmd;
            const isEphemeral = cmd.includes("c-thru-session.");
            let missing = false;
            try { missing = !fs.existsSync(cmd); } catch { missing = true; }
            if (!isEphemeral && !missing) return cmd;
            if (/c-thru-session-start/.test(cmd) && sessionStart) {
              changed = true;
              return sessionStart;
            }
            if (/c-thru-stop-failure/.test(cmd) && stopFailure) {
              changed = true;
              return stopFailure;
            }
            return cmd;
          }
          for (const ev of Object.keys(obj.hooks)) {
            for (const entry of obj.hooks[ev] || []) {
              if (!entry || !Array.isArray(entry.hooks)) continue;
              for (const h of entry.hooks) {
                if (h && h.command) h.command = rewriteCmd(h.command);
              }
            }
          }
          if (changed) {
            st.respawnFlags[fi + 1] = JSON.stringify(obj);
          }
        }
      }
    }

    st.updatedAt = new Date().toISOString();
    fs.writeFileSync(path, JSON.stringify(st, null, 2) + "\n");
  ' "$state_file" "$GATEWAY_DIR" "${DURABLE_SESSION_START:-}" "${DURABLE_STOP_FAILURE:-}" 2>/dev/null; then
    echo "c-thru: revive skip $job_id (state patch failed)" >&2
    return 1
  fi
  return 0
}

is_already_running_bg_error() {
  local msg
  msg="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$msg" in
    *'currently running as a background agent'*|*'running as a background agent'*)
      return 0 ;;
  esac
  if [[ "$msg" == *'exit_with_message'* && "$msg" == *'background agent'* ]]; then
    return 0
  fi
  return 1
}

# Stop then respawn so a live worker reloads gateway settings.env (auth/base).
recycle_live_job() {
  local job_id="$1" state_file="$2"
  if [[ "${C_THRU_REVIVE_DRY_RUN:-0}" == "1" ]]; then
    echo "c-thru: revive dry-run recycle job=$job_id (gateway changed)" >&2
    return 0
  fi
  if ! patch_job_gateway "$job_id" "$state_file"; then
    return 0
  fi
  # Stop is required: plain respawn on a live bg worker → "already running as bg".
  local out
  out="$("$CLAUDE_CLI" stop "$job_id" 2>&1)" || true
  sleep 0.4
  if out="$("$CLAUDE_CLI" respawn "$job_id" 2>&1)"; then
    echo "c-thru: recycled session $job_id onto gateway $GATEWAY_BASE (auth/base refresh)" >&2
    return 0
  fi
  if is_already_running_bg_error "$out"; then
    # Stop may have been slow — one more stop+respawn attempt.
    "$CLAUDE_CLI" stop "$job_id" >/dev/null 2>&1 || true
    sleep 0.5
    if out="$("$CLAUDE_CLI" respawn "$job_id" 2>&1)"; then
      echo "c-thru: recycled session $job_id onto gateway $GATEWAY_BASE (retry)" >&2
      return 0
    fi
  fi
  echo "c-thru: recycle failed for $job_id: ${out:0:160}" >&2
  return 0
}

revive_one() {
  local job_id="$1" state_file="$2"
  if [[ "${C_THRU_REVIVE_DRY_RUN:-0}" == "1" ]]; then
    echo "c-thru: revive dry-run job=$job_id → CLAUDE_CONFIG_DIR=$GATEWAY_DIR base=$GATEWAY_BASE" >&2
    return 0
  fi

  # Re-check liveness immediately before respawn (race with attach).
  # If gateway just changed, recycle instead of skip (pick up OAuth / new port).
  if job_is_live "$job_id"; then
    if [[ "${C_THRU_GATEWAY_STAGE_STATUS:-}" == "changed" ]]; then
      recycle_live_job "$job_id" "$state_file"
      return 0
    fi
    patch_job_gateway "$job_id" "$state_file" || true
    echo "c-thru: revive skip respawn $job_id (live bg worker)" >&2
    return 0
  fi

  if ! patch_job_gateway "$job_id" "$state_file"; then
    return 0
  fi

  local out
  if out="$("$CLAUDE_CLI" respawn "$job_id" 2>&1)"; then
    echo "c-thru: revived session $job_id with gateway $GATEWAY_BASE" >&2
  else
    if is_already_running_bg_error "$out"; then
      # Process appeared between live-check and respawn — recycle path.
      recycle_live_job "$job_id" "$state_file"
      return 0
    fi
    # One retry only for non-bg failures (e.g. transient CLI).
    sleep 0.5
    if out="$("$CLAUDE_CLI" respawn "$job_id" 2>&1)"; then
      echo "c-thru: revived session $job_id with gateway $GATEWAY_BASE (retry)" >&2
    elif is_already_running_bg_error "$out"; then
      recycle_live_job "$job_id" "$state_file"
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

# Auto-skip agents --json only for *test* stub binaries (never real ~/.local/bin/claude).
# Tests set CLAUDE_BIN under mktemp paths and write a fake that only logs argv.
if [[ -n "${CLAUDE_BIN:-}" && "${C_THRU_REVIVE_SKIP_AGENTS_JSON+x}" != "x" ]]; then
  case "$CLAUDE_BIN" in
    /tmp/*|/var/folders/*/*c-thru-revive*|*c-thru-revive*.XXXX*|*c-thru-revive.XXXX*)
      export C_THRU_REVIVE_SKIP_AGENTS_JSON=1
      ;;
  esac
  # Heuristic: test fixture that is a small shell stub logging FAKE_CLAUDE_LOG.
  if [[ -z "${C_THRU_REVIVE_SKIP_AGENTS_JSON:-}" && -n "${FAKE_CLAUDE_LOG:-}" ]]; then
    export C_THRU_REVIVE_SKIP_AGENTS_JSON=1
  fi
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
  elif [[ "$nr" -eq 3 ]]; then
    # Live worker but gateway auth/base changed — stop+respawn to reload settings.
    if [[ "$revived" -ge "$REVIVE_MAX" ]]; then
      echo "c-thru: revive cap ($REVIVE_MAX) reached; remaining jobs skipped" >&2
      break
    fi
    recycle_live_job "$job_id" "$state_file"
    revived=$((revived + 1))
  elif [[ "$nr" -eq 2 ]]; then
    if patch_job_gateway "$job_id" "$state_file"; then
      patched=$((patched + 1))
      if [[ -n "${C_THRU_DEBUG:-}" && "${C_THRU_DEBUG}" != "0" ]]; then
        echo "c-thru: revive patch-only job=$job_id" >&2
      fi
    fi
  fi
done

if [[ -n "${C_THRU_DEBUG:-}" && "${C_THRU_DEBUG}" != "0" ]]; then
  echo "c-thru: session revive complete revived=$revived patched=$patched gateway=$GATEWAY_DIR base=$GATEWAY_BASE live=$(printf '%s' "$LIVE_JOB_IDS" | tr '\n' ',' )" >&2
fi

exit 0
