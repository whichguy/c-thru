#!/usr/bin/env bash
set -euo pipefail

echo "--- Testing C_THRU_STRICT_MODELS=1 ---"

# 1. Unknown model should fail with STRICT=1
if C_THRU_STRICT_MODELS=1 ./tools/c-thru --model unknown-999 --version >/dev/null 2>&1; then
  echo "❌ FAILED: Unknown model did not fail with C_THRU_STRICT_MODELS=1"
  exit 1
fi
echo "✅ OK: Unknown model rejected with STRICT=1"

# 2. Known model (from model-map.json) should pass with STRICT=1
# We'll use 'classifier' alias which resolves to a model in the default map.
if ! C_THRU_STRICT_MODELS=1 ./tools/c-thru --model classifier --version >/dev/null 2>&1; then
  echo "❌ FAILED: Known capability alias rejected with C_THRU_STRICT_MODELS=1"
  exit 1
fi
echo "✅ OK: Known model allowed with STRICT=1"

# 3. Default behavior (STRICT unset) should allow unknown models (passthrough)
if ! ./tools/c-thru --model unknown-999 --version >/dev/null 2>&1; then
  # Note: This might still fail if 'claude' isn't installed or similar, 
  # but the ROUTER logic should reach the passthrough phase.
  # If it fails with 'error: unknown model', that's a problem.
  # Let's check the stderr specifically.
  out=$(./tools/c-thru --model unknown-999 --version 2>&1 || true)
  if [[ "$out" == *"is unknown and C_THRU_STRICT_MODELS=1 is set"* ]]; then
     echo "❌ FAILED: Unknown model rejected even when STRICT is not set"
     exit 1
  fi
fi
echo "✅ OK: Default behavior preserved"

echo "--- All Strict Model Tests Passed ---"
