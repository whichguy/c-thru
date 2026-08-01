#!/usr/bin/env bash
# Guard: when a proxy was started by this shell, run_real_claude must run
# Claude as a true foreground child — not `cmd &; wait`.
#
# Background launch was implicated in TUI garbling when the user types text,
# presses left-arrow, then moves the mouse over the terminal (plain claude
# is clean; no keystroke hook exists in c-thru).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTHRU="$ROOT/tools/c-thru"

fail=0
pass() { echo "  PASS  $1"; }
fail_() { echo "  FAIL  $1"; fail=1; }

body="$(awk '
  /^run_real_claude\(\)/ { capture=1 }
  capture { print }
  capture && /^}/ { exit }
' "$CTHRU")"

[[ -n "$body" ]] || { echo "FAIL: could not extract run_real_claude"; exit 1; }

echo "run_real_claude foreground TTY ownership"

# Proxied path must arm cleanup (proxy reaped on EXIT) without exec.
if printf '%s\n' "$body" | grep -q 'arm_proxy_cleanup'; then
  pass "arms proxy cleanup before launching Claude"
else
  fail_ "missing arm_proxy_cleanup"
fi

# Historical bug: background then wait.
if printf '%s\n' "$body" | grep -E '\$\{cmd\[@\]\}"[[:space:]]*&' >/dev/null; then
  fail_ "still backgrounds Claude via cmd & (use pure foreground)"
else
  pass "does not background Claude with cmd &"
fi

if printf '%s\n' "$body" | grep -q 'if \[\[ -t 0 \]\]' &&
   printf '%s\n' "$body" | grep -q 'wait "\$CLAUDE_CHILD_PID"'; then
  pass "keeps foreground TTY launch while using interruptible wait only headlessly"
else
  fail_ "missing TTY foreground/headless interruptible-wait split"
fi

# Must still run via env so ANTHROPIC_* are set without eval.
if printf '%s\n' "$body" | grep -q 'env ANTHROPIC_BASE_URL'; then
  pass "launches via env with ANTHROPIC_BASE_URL"
else
  fail_ "missing env ANTHROPIC_BASE_URL launch"
fi

# Transparent path (no proxy child) still execs.
if printf '%s\n' "$body" | grep -q 'exec env'; then
  pass "exec path retained when PROXY_STARTED_PID is empty"
else
  fail_ "missing exec env for non-proxy path"
fi

if [[ "$fail" -eq 0 ]]; then
  echo
  echo "All run_real_claude foreground checks passed."
  exit 0
fi
echo
echo "Some checks failed."
exit 1
