#!/usr/bin/env bash
# c-thru-gateway-auth-helper.sh — print a live Claude Code auth token for gateway mode.
#
# Used as settings.apiKeyHelper under ~/.claude/c-thru-agent-gateway so brand
# agent workers (and attach/resume) get a credential at *request* time.
# Claude with a custom ANTHROPIC_BASE_URL does not use keychain by itself;
# a static ANTHROPIC_AUTH_TOKEN=ollama in settings causes "Not logged in".
#
# Prints one line to stdout (the token). Exit 0 on success, 1 if none found.
# Never prints placeholders (ollama / unused / proxied-placeholder).
# shellcheck shell=bash
set -uo pipefail

is_placeholder() {
  case "${1:-}" in
    ""|ollama|unused|test-token|proxied-placeholder) return 0 ;;
    *) return 1 ;;
  esac
}

# 1) Ambient process env (cthru parent often injects real OAuth).
if [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]] && ! is_placeholder "$ANTHROPIC_AUTH_TOKEN"; then
  printf '%s\n' "$ANTHROPIC_AUTH_TOKEN"
  exit 0
fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]] && ! is_placeholder "$ANTHROPIC_API_KEY"; then
  printf '%s\n' "$ANTHROPIC_API_KEY"
  exit 0
fi

# 2) Claude Code credentials store (same source as tools/c-thru inject_subscription_oauth).
raw=""
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
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const t = (j.claudeAiOauth && j.claudeAiOauth.accessToken) || "";
        if (t && t !== "null") process.stdout.write(t);
      } catch { /* empty */ }
    });
  ' 2>/dev/null || true)"
  if [[ -n "$tok" ]] && ! is_placeholder "$tok"; then
    printf '%s\n' "$tok"
    exit 0
  fi
fi

# 3) Last-resort: non-placeholder token already in durable gateway settings
#    (written by a prior successful stage; avoid ollama).
gw="${C_THRU_AGENT_GATEWAY_DIR:-${HOME}/.claude/c-thru-agent-gateway}/settings.json"
if [[ -r "$gw" ]] && command -v node >/dev/null 2>&1; then
  tok="$(node -e '
    try {
      const s = require(process.argv[1]);
      const t = (s.env && s.env.ANTHROPIC_AUTH_TOKEN) || "";
      process.stdout.write(t);
    } catch { /* empty */ }
  ' "$gw" 2>/dev/null || true)"
  if [[ -n "$tok" ]] && ! is_placeholder "$tok"; then
    printf '%s\n' "$tok"
    exit 0
  fi
fi

exit 1
