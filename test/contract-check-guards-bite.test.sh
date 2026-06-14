#!/usr/bin/env bash
# Meta-test: the hardened contract-check fail-loud guards (Checks 10/11/14/15,
# commit 71a6c4c) must FAIL LOUD — not narrow silently — when their extraction
# input changes. This encodes, as a registered regression net, the negative
# controls that were previously only run by hand.
#
# Approach: snapshot the WORKING TREE into a scratch dir (so we exercise the
# live checker, including uncommitted edits), confirm the clean snapshot passes,
# then mutate exactly one guard's input per case and assert the checker exits 1
# with that guard's specific message. Restore between cases so each case proves
# its own guard fires on an otherwise-clean tree.
#
# Run: bash test/contract-check-guards-bite.test.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
check()    { if [ "$1" = "$2" ]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3 (expected '$1', got '$2')" >&2; FAIL=$((FAIL+1)); fi; }
checkmsg() { if printf '%s' "$1" | grep -qF "$2"; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3 (message not found: '$2')" >&2; FAIL=$((FAIL+1)); fi; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/cc-guards-bite.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Snapshot the working tree minus .git/node_modules (BSD + GNU tar both support
# --exclude). The checker computes REPO_DIR from its own location, and Checks
# 10/11/14/15 read $REPO_DIR/tools/… , so every input resolves inside SCRATCH.
( cd "$REPO_DIR" && tar -cf - --exclude='./.git' --exclude='./node_modules' . ) | ( cd "$SCRATCH" && tar -xf - )

CHECKER="$SCRATCH/tools/c-thru-contract-check.sh"
[ -f "$CHECKER" ] || { echo "fatal: snapshot missing $CHECKER" >&2; exit 1; }
restore() { cp "$REPO_DIR/$1" "$SCRATCH/$1"; }   # re-copy the pristine file

# ── Baseline: the clean snapshot must pass, else a mutation-induced exit 1 is meaningless ──
out="$(bash "$CHECKER" 2>&1)"; rc=$?
check 0 "$rc" "baseline: clean snapshot passes (exit 0)"

# ── Check 10: removed `grep -qxF` divergence sentinel → fail loud ──────────────
echo "Check 10 — divergence sentinel removed:"
grep -v 'grep -qxF' "$REPO_DIR/test/stubs/preflight-skeleton.sh" > "$SCRATCH/test/stubs/preflight-skeleton.sh"
out="$(bash "$CHECKER" 2>&1)"; rc=$?
check 1 "$rc" "missing sentinel → exit 1"
checkmsg "$out" "divergence sentinel missing" "emits 'divergence sentinel missing'"
restore test/stubs/preflight-skeleton.sh

# ── Check 11/14: LLM_MODE_ENUM no longer extractable → fail loud ───────────────
echo "Check 11/14 — LLM_MODE_ENUM declaration renamed:"
sed 's/const LLM_MODE_ENUM =/const LLM_MODE_ENUM_RENAMED =/' "$REPO_DIR/tools/model-map-resolve.js" > "$SCRATCH/tools/model-map-resolve.js"
out="$(bash "$CHECKER" 2>&1)"; rc=$?
check 1 "$rc" "unextractable enum → exit 1"
checkmsg "$out" "could not extract LLM_MODE_ENUM" "emits 'could not extract LLM_MODE_ENUM'"
restore tools/model-map-resolve.js

# ── Check 15: LEGACY_LLM_MODES declaration renamed → fail loud (not silent pass) ─
echo "Check 15 — LEGACY_LLM_MODES declaration renamed:"
sed 's/LEGACY_LLM_MODES = new Set/LEGACY_LLM_MODES_RENAMED = new Set/' "$REPO_DIR/tools/model-map-validate.js" > "$SCRATCH/tools/model-map-validate.js"
out="$(bash "$CHECKER" 2>&1)"; rc=$?
check 1 "$rc" "renamed declaration → exit 1"
checkmsg "$out" "LEGACY_LLM_MODES declaration not found" "emits 'LEGACY_LLM_MODES declaration not found'"
restore tools/model-map-validate.js

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
