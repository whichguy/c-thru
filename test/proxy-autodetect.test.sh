#!/usr/bin/env bash
# Validates proxy hardware-tier auto-detection against the real machine RAM.
# Computes the expected tier from sysctl/meminfo, passes it to the Node test,
# and reports pass/fail with a human-readable summary.
#
# Run with: bash test/proxy-autodetect.test.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Detect machine RAM ─────────────────────────────────────────────────────

if [[ "$(uname)" == "Darwin" ]]; then
  total_bytes="$(sysctl -n hw.memsize 2>/dev/null)"
elif [[ -f /proc/meminfo ]]; then
  total_kb="$(grep '^MemTotal:' /proc/meminfo | awk '{print $2}')"
  total_bytes=$(( total_kb * 1024 ))
else
  echo "SKIP: cannot detect RAM on this platform (uname=$(uname))" >&2
  exit 0
fi

total_gb=$(( total_bytes / 1073741824 ))

# Match hw-profile.js breakpoints exactly.
if   (( total_gb < 24 )); then expected_tier="16gb"
elif (( total_gb < 40 )); then expected_tier="32gb"
elif (( total_gb < 56 )); then expected_tier="48gb"
elif (( total_gb < 96 )); then expected_tier="64gb"
else                            expected_tier="128gb"
fi

echo "=== proxy-autodetect ==="
echo "Machine RAM : ${total_gb}GB"
echo "Expected tier: ${expected_tier}"
echo ""

# ── Run Node test ──────────────────────────────────────────────────────────

EXPECTED_TIER="$expected_tier" node test/proxy-autodetect.test.js
exit_code=$?

echo ""
if [[ $exit_code -eq 0 ]]; then
  echo "PASS  proxy auto-detected tier=${expected_tier} matches machine RAM (${total_gb}GB)"
else
  echo "FAIL  proxy auto-detected wrong tier (expected ${expected_tier} for ${total_gb}GB machine)"
fi

exit $exit_code
