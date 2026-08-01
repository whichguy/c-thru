#!/usr/bin/env bash
# Run the full c-thru test suite.
# Exit 0 = all tests passed.  Exit 1 = one or more suites failed.
#
# Usage: bash test/run-all.sh [--skip-smoke | --fast]
#   (default)       full suite including smoke-check and long e2e (exclusive lock)
#   --skip-smoke    hermetic CI/pre-push suite — skip slow smoke & long e2e
#   --fast          deprecated synonym for --skip-smoke (kept for back-compat)
# Prefer: make test (skip-smoke) | make test-all (full)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_SUPERVISOR="$REPO_DIR/tools/run-with-hard-timeout.js"
TEST_SUPERVISOR_CAPABILITY="$REPO_DIR/tools/test-supervisor-capability.js"
TEST_EVIDENCE_TOOL="$REPO_DIR/tools/test-run-evidence.js"
TEST_TIMEOUT_SECONDS="${C_THRU_TEST_TIMEOUT_SECONDS:-3600}"
if [[ ! "$TEST_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || (( ${#TEST_TIMEOUT_SECONDS} > 4 )) \
  || { (( ${#TEST_TIMEOUT_SECONDS} == 4 )) && [[ "$TEST_TIMEOUT_SECONDS" > "3600" ]]; }; then
  echo "run-all: C_THRU_TEST_TIMEOUT_SECONDS must be an integer from 1 to 3600" >&2
  exit 2
fi

has_active_test_supervisor() {
  node "$TEST_SUPERVISOR_CAPABILITY" --verify-shell-child
}

if ! has_active_test_supervisor; then
  exec node "$TEST_SUPERVISOR" \
    --timeout-seconds "$TEST_TIMEOUT_SECONDS" \
    -- bash "$0" "$@"
fi
export C_THRU_TEST_TIMEOUT_SECONDS="$TEST_TIMEOUT_SECONDS"

FAST=0
# FAST=1 means skip smoke/long-e2e (the hermetic suite). Preferred flag is
# --skip-smoke; --fast remains accepted as a deprecated synonym.
case "${1:-}" in
  --skip-smoke|--fast) FAST=1 ;;
esac

LIVE_SHARD="${C_THRU_LIVE_SHARD:-}"
case "$LIVE_SHARD" in
  ""|provider|agent) ;;
  *)
    echo "run-all: C_THRU_LIVE_SHARD must be provider or agent" >&2
    exit 2
    ;;
esac

PASS=0
FAIL=0
SKIP=0
BLOCKED=0
STRICT_LIVE_PROVIDERS=0
if [[ "${C_THRU_STRICT_LIVE_PROVIDERS:-0}" == "1" ]]; then
  STRICT_LIVE_PROVIDERS=1
fi

# EXCLUDED: provider-live-prerequisites.js — shared billing/quota classifier imported by live suites
# EXCLUDED: agent-contract-fixtures.js — shared current-agent roster/parser library imported by suites
# EXCLUDED: offload-artifact-fixtures.js — generated-artifact helper covered by its registered test

# Every aggregate run leaves a sanitized, incrementally durable evidence file.
# Initialize it before any full-run lock wait so an outer hard timeout still
# leaves a parseable running artifact at the configured path.
if [[ -n "${C_THRU_TEST_EVIDENCE_PATH:-}" ]]; then
  TEST_EVIDENCE_PATH=$(node "$TEST_EVIDENCE_TOOL" allocate \
    --path "$C_THRU_TEST_EVIDENCE_PATH") || exit 1
else
  TEST_EVIDENCE_PATH=$(node "$TEST_EVIDENCE_TOOL" allocate) || exit 1
fi
export C_THRU_TEST_EVIDENCE_PATH="$TEST_EVIDENCE_PATH"
EVIDENCE_ENABLED=1
EVIDENCE_FAILURE=0
RUN_EVIDENCE_MODE="full"
[[ $FAST -eq 1 ]] && RUN_EVIDENCE_MODE="hermetic"
[[ -n "$LIVE_SHARD" ]] && RUN_EVIDENCE_MODE="live-${LIVE_SHARD}"
EVIDENCE_INIT_ARGS=(
  init
  --path "$TEST_EVIDENCE_PATH"
  --repo "$REPO_DIR"
  --mode "$RUN_EVIDENCE_MODE"
)
[[ -n "$LIVE_SHARD" ]] && EVIDENCE_INIT_ARGS+=(--shard "$LIVE_SHARD")
if ! node "$TEST_EVIDENCE_TOOL" "${EVIDENCE_INIT_ARGS[@]}"; then
  echo "run-all: failed to initialize test evidence" >&2
  exit 1
fi
echo "C_THRU_TEST_EVIDENCE_PATH=$TEST_EVIDENCE_PATH"

# ── Exclusive lock for full runs ───────────────────────────────────────────────
# Two concurrent full runs cross-fail: proxy-e2e talks to the live Ollama backend
# (timeouts under contention — observed empirically) and smoke-check exercises the
# shared proxy lifecycle. Most unit suites bind random free ports and are safe,
# so --skip-smoke/--fast runs skip the lock; full runs hold it for the whole run.
# mkdir-lock with a stale-pid check — NOT flock(1), which is absent on stock
# macOS (this repo's primary dev machine); flock may be added as a parenthetical
# fast-path for Linux CI only.
resolve_test_lock_root() {
  local requested="${C_THRU_TEST_LOCK_ROOT:-}"
  local selection="override"
  if [[ -z "$requested" ]]; then
    selection="default"
  fi

  C_THRU_LOCK_ROOT_REQUESTED="$requested" \
  C_THRU_LOCK_ROOT_SELECTION="$selection" \
    node <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');

function fail(message) {
  throw new Error(message);
}

function validateOwnedDirectory(requested, label, { privateDirectory }) {
  let entry;
  try {
    entry = fs.lstatSync(requested);
  } catch {
    fail(`${label} does not exist`);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    fail(`${label} must be a real directory, not a symlink`);
  }
  const real = fs.realpathSync(requested);
  const stats = fs.statSync(real);
  if (stats.uid !== process.geteuid()) {
    fail(`${label} must be owned by the current user`);
  }
  const permissions = stats.mode & 0o777;
  if (privateDirectory ? permissions !== 0o700 : (permissions & 0o022) !== 0) {
    fail(privateDirectory
      ? `${label} must have mode 0700`
      : `${label} must not be group- or world-writable`);
  }
  return real;
}

function createDirectoryExclusive(directory, label) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      fail(`could not create ${label}: ${error.message}`);
    }
  }
}

try {
  const selection = process.env.C_THRU_LOCK_ROOT_SELECTION;
  let root;
  if (selection === 'override') {
    const requested = process.env.C_THRU_LOCK_ROOT_REQUESTED || '';
    if (!path.isAbsolute(requested) ||
        requested === path.parse(requested).root ||
        /[\u0000-\u001f\u007f]/.test(requested)) {
      fail('C_THRU_TEST_LOCK_ROOT must be an absolute non-root path');
    }
    root = validateOwnedDirectory(
      requested,
      'C_THRU_TEST_LOCK_ROOT',
      { privateDirectory: true },
    );
  } else {
    const home = process.env.HOME || '';
    if (!path.isAbsolute(home) ||
        home === path.parse(home).root ||
        /[\u0000-\u001f\u007f]/.test(home)) {
      fail('HOME must be an absolute non-root path for the full-run lock');
    }
    const homeReal = fs.realpathSync(home);
    const homeStats = fs.statSync(homeReal);
    if (!homeStats.isDirectory() ||
        homeStats.uid !== process.geteuid() ||
        (homeStats.mode & 0o022) !== 0) {
      fail('HOME must be an owner-controlled directory for the full-run lock');
    }
    const stateDirectory = path.join(homeReal, '.claude');
    createDirectoryExclusive(stateDirectory, 'the c-thru state directory');
    const stateReal = validateOwnedDirectory(
      stateDirectory,
      'the c-thru state directory',
      { privateDirectory: false },
    );
    const defaultRoot = path.join(stateReal, 'c-thru-run-locks');
    createDirectoryExclusive(defaultRoot, 'the c-thru full-run lock root');
    root = validateOwnedDirectory(
      defaultRoot,
      'the c-thru full-run lock root',
      { privateDirectory: true },
    );
  }
  process.stdout.write(`${root}\n`);
} catch (error) {
  console.error(`run-all: ${error.message}`);
  process.exit(1);
}
NODE
}

LOCK_ROOT=""
LOCK_DIR=""
LOCK_HELD=""

release_lock() {
  [[ -n "$LOCK_HELD" ]] && rm -rf "$LOCK_DIR"
}

acquire_lock() {
  while ! (umask 077; mkdir -m 700 "$LOCK_DIR") 2>/dev/null; do
    local owner=""
    owner=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then
      echo "  removing stale lock (pid $owner no longer running)"
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [[ -z "$owner" ]]; then
      # mkdir→pid-write window is microseconds; a pid-less lock older than 60s
      # means the holder crashed before writing its pid — reclaim it.
      local now mtime age
      now=$(date +%s)
      mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo "$now")
      age=$(( now - mtime ))
      if (( age > 60 )); then
        echo "  removing stale pid-less lock (age ${age}s)"
        rm -rf "$LOCK_DIR"
        continue
      fi
    fi
    echo "  waiting for concurrent run-all.sh (pid ${owner:-unknown}) to release the full-run lock..."
    sleep 5
  done
  echo "$$" > "$LOCK_DIR/pid"
  LOCK_HELD=1
  trap release_lock EXIT
}

prepare_full_run_lock() {
  LOCK_ROOT=$(resolve_test_lock_root) || return 1
  LOCK_DIR="$LOCK_ROOT/c-thru-run-all.lock"
  acquire_lock
}

# Full runs are exclusive; hermetic (--skip-smoke) runs are concurrency-safe and skip the lock.
if [[ $FAST -eq 0 ]]; then
  prepare_full_run_lock || exit 1
fi

# ── Proxy-spawn serialization (assessed, intentionally NOT forced) ──────────────
# An assessment recommended running the ~54 proxy-spawn suites (those invoking
# withProxy/spawnProxy) SERIALLY even in the hermetic suite, so waitForPing ECONNRESET timer
# races can't make green/red untrustworthy. We assessed this and did NOT add a
# parallel-then-serial split, because:
#   1. run-all.sh ALREADY runs every suite strictly sequentially — run_suite uses
#      a blocking `out=$("$@" 2>&1)` command substitution; there is no `&` / `wait`
#      / job-control anywhere. So within one run-all invocation the spawn suites
#      are already serialized; there is nothing to "make serial."
#   2. The only concurrency is ACROSS run-all invocations, and that is already
#      gated: full runs hold the exclusive mkdir-lock above; hermetic runs skip it
#      precisely because their suites bind random free ports (getFreePort) and are
#      port-isolated, so two --fast runs don't contend on a fixed port.
#   3. The waitForPing ECONNRESET flake the assessment cites is load-dependent
#      (a busy machine slows first-bind), not a same-process concurrency race —
#      helpers.js waitForPing already fast-retries ECONNRESET/ECONNREFUSED, and the
#      per-suite teardown timers are now cleared (no stray timers leak across the
#      sequential boundary). Forcing a parallel batch for the NON-spawn suites to
#      preserve wall-clock would INTRODUCE the very concurrency this guards against
#      and add real complexity for no correctness gain.
# If a future change adds intra-run parallelism (e.g. a `&`+`wait` fan-out for the
# non-spawn unit suites), the spawn suites MUST stay in a sequential group here.

# Failing-suite output is persisted under one directory owned exclusively by
# this aggregate. CI supplies an exact non-existing leaf so its later artifact
# step never needs a broad temp-directory glob; local runs use mktemp. These
# files contain raw, unsanitized child output and therefore stay private on disk.
failure_log_root() {
  local requested_root="${TMPDIR:-/tmp}"
  local resolved_root
  if [[ "$requested_root" != /* || ! -d "$requested_root" ||
        ! -w "$requested_root" || ! -x "$requested_root" ]]; then
    echo "run-all: TMPDIR must name an absolute, writable directory" >&2
    return 1
  fi
  resolved_root=$(cd -P "$requested_root" 2>/dev/null && pwd) || {
    echo "run-all: could not resolve TMPDIR" >&2
    return 1
  }
  if [[ "$resolved_root" == "/" ]]; then
    echo "run-all: refusing to allocate failure logs directly under /" >&2
    return 1
  fi
  if ! C_THRU_FAILURE_LOG_ROOT="$resolved_root" node -e '
    const fs = require("fs");
    const stats = fs.statSync(process.env.C_THRU_FAILURE_LOG_ROOT);
    const sticky = (stats.mode & 0o1000) !== 0;
    const sharedWritable = (stats.mode & 0o022) !== 0;
    if ((!sticky && sharedWritable) ||
        (!sticky && stats.uid !== process.geteuid())) {
      process.exit(1);
    }
  '; then
    echo "run-all: TMPDIR must be owner-controlled or a sticky temporary directory" >&2
    return 1
  fi
  printf '%s\n' "$resolved_root"
}

allocate_failure_log_dir() {
  local root trusted_parent requested requested_parent resolved_parent leaf allocated
  root=$(failure_log_root) || return 1
  trusted_parent="${TMPDIR:-/tmp}"
  [[ "$trusted_parent" == "/" ]] || trusted_parent="${trusted_parent%/}"
  requested="${C_THRU_TEST_FAILURE_LOG_DIR:-}"

  if [[ -n "$requested" ]]; then
    if [[ "$requested" != /* || "$requested" == */ ]]; then
      echo "run-all: C_THRU_TEST_FAILURE_LOG_DIR must be an absolute non-existing leaf" >&2
      return 1
    fi
    requested_parent="${requested%/*}"
    leaf="${requested##*/}"
    if [[ -z "$requested_parent" || "$leaf" != c-thru-runall-* ||
          "$leaf" == *[!A-Za-z0-9._-]* ]]; then
      echo "run-all: C_THRU_TEST_FAILURE_LOG_DIR must be a c-thru-runall-* leaf under TMPDIR" >&2
      return 1
    fi
    if [[ "$requested_parent" != "$trusted_parent" &&
          "$requested_parent" != "$root" ]]; then
      echo "run-all: C_THRU_TEST_FAILURE_LOG_DIR parent must be TMPDIR itself" >&2
      return 1
    fi
    resolved_parent=$(cd -P "$requested_parent" 2>/dev/null && pwd) || {
      echo "run-all: C_THRU_TEST_FAILURE_LOG_DIR parent does not exist" >&2
      return 1
    }
    if [[ "$resolved_parent" != "$root" ]]; then
      echo "run-all: C_THRU_TEST_FAILURE_LOG_DIR must be a direct child of TMPDIR" >&2
      return 1
    fi
    if ! (umask 077; mkdir -m 700 "$requested") 2>/dev/null; then
      echo "run-all: refusing pre-existing C_THRU_TEST_FAILURE_LOG_DIR: $requested" >&2
      return 1
    fi
    if ! chmod 700 "$requested"; then
      rmdir "$requested" 2>/dev/null || true
      echo "run-all: could not set failure-log directory mode 0700" >&2
      return 1
    fi
    printf '%s\n' "$requested"
    return 0
  fi

  allocated=$(umask 077; mktemp -d "$root/c-thru-runall.XXXXXXXXXX") || {
    echo "run-all: could not allocate a private failure-log directory" >&2
    return 1
  }
  if ! chmod 700 "$allocated"; then
    rmdir "$allocated" 2>/dev/null || true
    echo "run-all: could not set failure-log directory mode 0700" >&2
    return 1
  fi
  printf '%s\n' "$allocated"
}

save_suite_output() {
  local label="$1"
  local out="$2"
  local slug staging token log_path
  slug=$(printf '%s' "$label" | tr -c 'a-zA-Z0-9._-' '-' | sed 's/--*/-/g; s/^-//; s/-$//')
  [[ -n "$slug" ]] || slug="suite"
  staging=$(umask 077; mktemp "$FAIL_LOG_DIR/.pending.XXXXXXXXXX") || {
    echo "    could not allocate a private failure log for: $label" >&2
    return 1
  }
  if ! chmod 600 "$staging" || ! printf '%s\n' "$out" > "$staging"; then
    rm -f "$staging"
    echo "    could not write private failure log for: $label" >&2
    return 1
  fi

  token="${staging##*.pending.}"
  log_path="$FAIL_LOG_DIR/${slug}-${token}.log"
  if ! C_THRU_FAILURE_LOG_STAGING="$staging" \
       C_THRU_FAILURE_LOG_DEST="$log_path" \
       node -e '
         const fs = require("fs");
         fs.linkSync(
           process.env.C_THRU_FAILURE_LOG_STAGING,
           process.env.C_THRU_FAILURE_LOG_DEST,
         );
         fs.unlinkSync(process.env.C_THRU_FAILURE_LOG_STAGING);
       '; then
    rm -f "$staging"
    echo "    refusing to replace pre-existing failure log: $log_path" >&2
    return 1
  fi
  echo "    output saved: $log_path" >&2
}
# End failure-log helpers.

FAIL_LOG_DIR=$(allocate_failure_log_dir) || exit 1
export C_THRU_TEST_FAILURE_LOG_DIR="$FAIL_LOG_DIR"
echo "C_THRU_TEST_FAILURE_LOG_DIR=$FAIL_LOG_DIR"

SUITE_EVIDENCE_ID=""
record_evidence_write_failure() {
  if [[ $EVIDENCE_FAILURE -eq 0 ]]; then
    echo "run-all: test evidence update failed; aggregate will fail closed" >&2
  fi
  EVIDENCE_FAILURE=1
}

start_suite_evidence() {
  local kind="$1"
  local label="$2"
  local provider="${3:-}"
  local suite="${4:-}"
  SUITE_EVIDENCE_ID=""
  [[ $EVIDENCE_ENABLED -eq 1 ]] || return 0
  local -a args=(
    suite-start
    --path "$TEST_EVIDENCE_PATH"
    --kind "$kind"
    --label "$label"
  )
  [[ -n "$provider" ]] && args+=(--provider "$provider")
  [[ -n "$suite" ]] && args+=(--suite "$suite")
  if ! SUITE_EVIDENCE_ID=$(node "$TEST_EVIDENCE_TOOL" "${args[@]}"); then
    record_evidence_write_failure
    SUITE_EVIDENCE_ID=""
    return 1
  fi
}

finish_suite_evidence() {
  local id="$1"
  local status="$2"
  local exit_code="${3:-}"
  local reason="${4:-}"
  [[ $EVIDENCE_ENABLED -eq 1 && -n "$id" ]] || return 0
  local -a args=(
    suite-finish
    --path "$TEST_EVIDENCE_PATH"
    --id "$id"
    --status "$status"
  )
  [[ -n "$exit_code" ]] && args+=(--exit-code "$exit_code")
  [[ -n "$reason" ]] && args+=(--reason "$reason")
  if ! node "$TEST_EVIDENCE_TOOL" "${args[@]}"; then
    record_evidence_write_failure
    return 1
  fi
}

sanitize_suite_reason() {
  local reason
  reason=$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.:/+-' '_' | cut -c 1-160)
  if printf '%s' "$reason" |
      grep -Eq 'AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z_-]{16,}|Bearer_|SECRET_CANARY'; then
    printf '%s' "redacted_sensitive_reason"
  else
    printf '%s' "$reason"
  fi
}

live_suite_class() {
  local provider="$1"
  local suite="$2"
  if [[ "$provider" == "agent" || "$suite" == "agent-selection-llm-judge" ]]; then
    printf '%s' "agent"
  else
    printf '%s' "provider"
  fi
}

live_suite_selected() {
  local provider="$1"
  local suite="$2"
  [[ -z "$LIVE_SHARD" ]] && return 0
  [[ "$(live_suite_class "$provider" "$suite")" == "$LIVE_SHARD" ]]
}

run_test_command() {
  node "$TEST_SUPERVISOR" \
    --timeout-seconds "$TEST_TIMEOUT_SECONDS" \
    -- "$@"
}

run_suite() {
  local label="$1"
  shift
  [[ -n "$LIVE_SHARD" ]] && return 0
  start_suite_evidence "ordinary" "$label" || true
  local evidence_id="$SUITE_EVIDENCE_ID"
  printf "  %-55s" "$label"
  local out ec=0
  out=$(run_test_command "$@" 2>&1) || ec=$?
  if [[ $ec -eq 0 ]]; then
    echo "✓"
    PASS=$(( PASS + 1 ))
    finish_suite_evidence "$evidence_id" "passed" "$ec" || true
  else
    echo "✗"
    FAIL=$(( FAIL + 1 ))
    echo "$out" | sed 's/^/    /' >&2
    save_suite_output "$label" "$out"
    finish_suite_evidence "$evidence_id" "failed" "$ec" || true
  fi
}

# Provider-aware runner. Every child registered here must emit exactly one
# terminal line using this stable protocol:
#   C_THRU_LIVE_OUTCOME|provider=...|suite=...|status=...|reason=...
#
# `skipped` is reserved for a mandatory advertised contract that the child
# could not exercise. Trigger-dependent probes (for example, "did a 429 happen
# under load?") are opportunistic and do not make the whole child `skipped`;
# their child emits `passed` once all mandatory contracts were exercised.
# Strict aggregate runs turn blocked and mandatory-skip outcomes into failures.
# Missing, duplicate, mismatched, or exit-incoherent markers are always harness
# failures so an exit-0 child can never synthesize provider coverage.
record_live_protocol_failure() {
  local provider="$1"
  local suite="$2"
  local label="$3"
  local reason="$4"
  local out="$5"
  local evidence_id="${6:-}"
  local exit_code="${7:-}"
  local outcome
  reason=$(sanitize_suite_reason "$reason")
  outcome="C_THRU_LIVE_OUTCOME|provider=${provider}|suite=${suite}|status=failed|reason=${reason}"
  echo "✗ OUTCOME"
  FAIL=$(( FAIL + 1 ))
  printf '%s\n' "$outcome"
  [[ -n "$out" ]] && printf '%s\n' "$out" | sed 's/^/    /' >&2
  save_suite_output "$label" "${out:-$outcome}"
  finish_suite_evidence "$evidence_id" "failed" "$exit_code" "$reason" || true
}

run_live_suite() {
  local provider="$1"
  local suite="$2"
  local label="$3"
  shift 3
  live_suite_selected "$provider" "$suite" || return 0
  start_suite_evidence "live" "$label" "$provider" "$suite" || true
  local evidence_id="$SUITE_EVIDENCE_ID"
  printf "  %-55s" "$label"

  local out ec=0 child_outcome="" outcome_count=0
  out=$(run_test_command "$@" 2>&1) || ec=$?
  outcome_count=$(printf '%s\n' "$out" | awk '/^C_THRU_LIVE_OUTCOME\|/{count++} END{print count+0}')
  child_outcome=$(printf '%s\n' "$out" | awk '/^C_THRU_LIVE_OUTCOME\|/{line=$0} END{print line}')

  if [[ $outcome_count -ne 1 ]]; then
    if [[ $outcome_count -eq 0 ]]; then
      record_live_protocol_failure "$provider" "$suite" "$label" \
        "missing_outcome_marker_exit_${ec}" "$out" "$evidence_id" "$ec"
    else
      record_live_protocol_failure "$provider" "$suite" "$label" \
        "multiple_outcome_markers_${outcome_count}_exit_${ec}" "$out" "$evidence_id" "$ec"
    fi
    return
  fi

  local expected_prefix outcome_status="" outcome_reason evidence_reason
  expected_prefix="C_THRU_LIVE_OUTCOME|provider=${provider}|suite=${suite}|status="
  case "$child_outcome" in
    "${expected_prefix}passed|reason="*) outcome_status="passed" ;;
    "${expected_prefix}skipped|reason="*) outcome_status="skipped" ;;
    "${expected_prefix}blocked|reason="*) outcome_status="blocked" ;;
    "${expected_prefix}failed|reason="*) outcome_status="failed" ;;
  esac
  outcome_reason="${child_outcome#*|reason=}"
  if [[ -z "$outcome_status" || "$child_outcome" != *"|reason="* ||
        -z "$outcome_reason" || "$outcome_reason" == *"|"* ]]; then
    record_live_protocol_failure "$provider" "$suite" "$label" \
      "invalid_or_mismatched_outcome_marker_exit_${ec}" "$out" "$evidence_id" "$ec"
    return
  fi
  evidence_reason=$(sanitize_suite_reason "$outcome_reason")

  if [[ "$outcome_status" == "passed" && $ec -ne 0 ]]; then
    record_live_protocol_failure "$provider" "$suite" "$label" \
      "passed_outcome_with_exit_${ec}" "$out" "$evidence_id" "$ec"
    return
  fi
  if [[ ( "$outcome_status" == "skipped" || "$outcome_status" == "blocked" ) &&
        $ec -ne 0 && $ec -ne 2 ]]; then
    record_live_protocol_failure "$provider" "$suite" "$label" \
      "${outcome_status}_outcome_with_exit_${ec}" "$out" "$evidence_id" "$ec"
    return
  fi
  if [[ "$outcome_status" == "failed" && $ec -eq 0 ]]; then
    record_live_protocol_failure "$provider" "$suite" "$label" \
      "failed_outcome_with_exit_0" "$out" "$evidence_id" "$ec"
    return
  fi

  if [[ "$outcome_status" == "blocked" ]]; then
    BLOCKED=$(( BLOCKED + 1 ))
    if [[ $STRICT_LIVE_PROVIDERS -eq 1 ]]; then
      echo "✗ BLOCKED"
      FAIL=$(( FAIL + 1 ))
      save_suite_output "$label" "$out"
    else
      echo "BLOCKED"
    fi
    printf '%s\n' "$child_outcome"
    [[ -n "$out" ]] && printf '%s\n' "$out" | sed 's/^/    /'
    finish_suite_evidence "$evidence_id" "blocked" "$ec" "$evidence_reason" || true
    return
  fi

  if [[ "$outcome_status" == "skipped" ]]; then
    SKIP=$(( SKIP + 1 ))
    if [[ $STRICT_LIVE_PROVIDERS -eq 1 ]]; then
      echo "✗ SKIPPED"
      FAIL=$(( FAIL + 1 ))
      save_suite_output "$label" "$out"
    else
      echo "SKIP"
    fi
    printf '%s\n' "$child_outcome"
    [[ -n "$out" ]] && printf '%s\n' "$out" | sed 's/^/    /'
    finish_suite_evidence "$evidence_id" "skipped" "$ec" "$evidence_reason" || true
    return
  fi

  if [[ "$outcome_status" == "failed" ]]; then
    echo "✗"
    FAIL=$(( FAIL + 1 ))
    printf '%s\n' "$child_outcome"
    [[ -n "$out" ]] && printf '%s\n' "$out" | sed 's/^/    /' >&2
    save_suite_output "$label" "$out"
    finish_suite_evidence "$evidence_id" "failed" "$ec" "$evidence_reason" || true
    return
  fi

  echo "✓"
  PASS=$(( PASS + 1 ))
  printf '%s\n' "$child_outcome"
  [[ -n "$out" ]] && printf '%s\n' "$out" | sed 's/^/    /'
  finish_suite_evidence "$evidence_id" "passed" "$ec" "$evidence_reason" || true
}

block_live_suite() {
  local provider="$1"
  local suite="$2"
  local label="$3"
  local reason="$4"
  live_suite_selected "$provider" "$suite" || return 0
  start_suite_evidence "live-blocked" "$label" "$provider" "$suite" || true
  local evidence_id="$SUITE_EVIDENCE_ID"
  local outcome
  reason=$(sanitize_suite_reason "$reason")
  outcome="C_THRU_LIVE_OUTCOME|provider=${provider}|suite=${suite}|status=blocked|reason=${reason}"
  printf "  %-55s" "$label"
  BLOCKED=$(( BLOCKED + 1 ))
  if [[ $STRICT_LIVE_PROVIDERS -eq 1 ]]; then
    echo "✗ BLOCKED"
    FAIL=$(( FAIL + 1 ))
    save_suite_output "$label" "$outcome"
  else
    echo "BLOCKED"
  fi
  printf '%s\n' "$outcome"
  finish_suite_evidence "$evidence_id" "blocked" "2" "$reason" || true
}

skip_suite() {
  local label="$1"
  [[ -n "$LIVE_SHARD" ]] && return 0
  start_suite_evidence "skipped" "$label" || true
  local evidence_id="$SUITE_EVIDENCE_ID"
  printf "  %-55s" "$label"
  echo "SKIP"
  SKIP=$(( SKIP + 1 ))
  finish_suite_evidence "$evidence_id" "skipped" || true
}

echo ""
echo "c-thru test suite"
echo "-----------------"
echo ""
echo "Shell tests:"
run_suite "install-smoke (idempotency, symlinks, ephemeral arch)" \
  bash "$REPO_DIR/test/install-smoke.test.sh"
run_suite "uninstall-smoke (symlink removal C24, hook scrub, overrides preserved)" \
  bash "$REPO_DIR/test/uninstall-smoke.test.sh"
run_suite "ollama-probe (health-check script)" \
  bash "$REPO_DIR/test/ollama-probe.test.sh"
run_suite "c-thru-ollama-gc (sweep/purge state-tracking invariants)" \
  bash "$REPO_DIR/test/c-thru-ollama-gc.test.sh"
run_suite "c-thru-contract-check (agent/skill contracts)" \
  bash "$REPO_DIR/test/c-thru-contract-check.test.sh"
run_suite "c-thru-hygiene-check (cross-user/secrets/bak/stale-worktree findings)" \
  bash "$REPO_DIR/test/c-thru-hygiene-check.test.sh"
run_suite "contract-check-guards-bite (10/11/14/15 fail-loud guards bite on mutation)" \
  bash "$REPO_DIR/test/contract-check-guards-bite.test.sh"
run_suite "c-thru-explain-bash (bash integration: _explain_all_json cache + TSV contracts)" \
  bash "$REPO_DIR/test/c-thru-explain-bash.test.sh"
run_suite "model-route shared adapter (shell + CLI + JS golden contract)" \
  bash "$REPO_DIR/test/model-route-parity.test.sh"
run_suite "c-thru-bootstrap-auth-env (bootstrap auth env helper)" \
  bash "$REPO_DIR/test/c-thru-bootstrap-auth-env.test.sh"
run_suite "shape-c-bootstrap (stamp, scrub, gate, install-cli path)" \
  bash "$REPO_DIR/test/shape-c-bootstrap.test.sh"
run_suite "shape-c-spec-contract (R0/W0 named anchors)" \
  bash "$REPO_DIR/test/shape-c-spec-contract.test.sh"
run_suite "uninstall-shape-c (stamp, c-thru-src links, --purge-src)" \
  bash "$REPO_DIR/test/uninstall-shape-c.test.sh"
run_suite "setup-docs-alignment (Shape C marketplace docs + lean bundle)" \
  node "$REPO_DIR/test/setup-docs-alignment.test.js"
run_suite "c-thru-lib (env/discovery resolvers: port ladder, profile-dir shadow split, ollama url)" \
  bash "$REPO_DIR/test/c-thru-lib.test.sh"
run_suite "c-thru-listen-port (ANTHROPIC_BASE_URL port discovery)" \
  bash "$REPO_DIR/test/c-thru-listen-port.test.sh"
run_suite "hook-payload-extraction (hook payload extraction)" \
  bash "$REPO_DIR/test/hook-payload-extraction.test.sh"
run_suite "map-changed-hook (validate + warn-only lineage drift guard)" \
  bash "$REPO_DIR/test/c-thru-map-changed-hook.test.sh"
run_suite "plan-visibility-hook (approved plan spool, auto-open, rotation)" \
  bash "$REPO_DIR/test/c-thru-plan-visibility-hook.test.sh"
run_suite "c-thru-stop-hook (fallback systemMessage: real proxy, real fallback, session isolation)" \
  node "$REPO_DIR/test/c-thru-stop-hook.test.js"
run_suite "c-thru-autonomous-gate (Stop-hook gate sentinel/block matrix)" \
  bash "$REPO_DIR/test/c-thru-autonomous-gate.test.sh"
run_suite "c-thru-statusline-overlay (fallback badge: real proxy, real fallback, session isolation)" \
  node "$REPO_DIR/test/c-thru-statusline-overlay.test.js"
run_suite "c-thru-statusline (default bar + recent stats + dash hint)" \
  node "$REPO_DIR/test/c-thru-statusline.test.js"
run_suite "statusline absent-only injection (c-thru never overwrites a user statusLine)" \
  node "$REPO_DIR/test/c-thru-statusline-injection.test.js"
run_suite "c-thru-durable-profile (statusline writes survive session shadow)" \
  node "$REPO_DIR/test/c-thru-durable-profile.test.js"
run_suite "proxy-statusline-endpoint (GET /c-thru/statusline slim feed)" \
  node "$REPO_DIR/test/proxy-statusline-endpoint.test.js"
run_suite "c-thru-stats-reset-launch (C_THRU_STATS_RESET=launch clears usage)" \
  node "$REPO_DIR/test/c-thru-stats-reset-launch.test.js"
run_suite "c-thru-control-stats (NL/argv clear → POST /c-thru/stats/clear)" \
  node "$REPO_DIR/test/c-thru-control-stats.test.js"
run_suite "c-thru-statusline-command-routing (static skill/command clear+statusline pins)" \
  node "$REPO_DIR/test/c-thru-statusline-command-routing.test.js"
run_suite "c-thru-stats-cli (Usage totals label + cleared_at window)" \
  node "$REPO_DIR/test/c-thru-stats-cli.test.js"
run_suite "agent-router-hook (subagent_type → capability model rewrite)" \
  bash "$REPO_DIR/test/agent-router-hook.test.js"
run_suite "strict-models (C_THRU_STRICT_MODELS=1 enforcement)" \
  bash "$REPO_DIR/test/strict-models.test.sh"
if [ "${C_THRU_DESTRUCTIVE_TESTS:-}" = "1" ]; then
  if command -v jq >/dev/null 2>&1; then
    run_suite "self-update-divergence (diverged/stale-WIP advisories)" \
      bash "$REPO_DIR/test/self-update-divergence.test.sh"
  else
    skip_suite "self-update-divergence (jq not installed)"
  fi
else
  skip_suite "self-update-divergence (git-mutating fixture; opt-in via C_THRU_DESTRUCTIVE_TESTS=1)"
fi
run_suite "session-start-seeding (first-run seed + settings registration)" \
  bash "$REPO_DIR/test/session-start-seeding.test.sh"
run_suite "c-thru-ensure-proxy-on-port (resurrect dead loopback proxy port)" \
  bash "$REPO_DIR/test/c-thru-ensure-proxy-on-port.test.sh"
run_suite "c-thru-upstream-url (eligibility + kill-allowed unit)" \
  node "$REPO_DIR/test/c-thru-upstream-url.test.js"
run_suite "brand-identity-unit (binding identity + pin matcher + score)" \
  node "$REPO_DIR/test/brand-identity-unit.test.js"
run_suite "latest-models-expand (shorthand always-latest + compact brand prompts)" \
  node "$REPO_DIR/test/latest-models-expand.test.js"
run_suite "c-thru-revive-agent-sessions (rehydrate jobs onto new gateway)" \
  bash "$REPO_DIR/test/c-thru-revive-agent-sessions.test.sh"
run_suite "c-thru-stop-failure-hook (same-port ensure after API refuse)" \
  bash "$REPO_DIR/test/c-thru-stop-failure-hook.test.sh"
run_suite "c-thru-proxy-keep-alive (EXIT skip kill when peers need port)" \
  bash "$REPO_DIR/test/c-thru-proxy-keep-alive.test.sh"
run_suite "c-thru-ephemeral-settings (user preferences + denylist)" \
  bash "$REPO_DIR/test/c-thru-ephemeral-settings.test.sh"
run_suite "c-thru-strip-args (allowlist strip c-thru flags; keep -p/prompts)" \
  bash "$REPO_DIR/test/c-thru-strip-args.test.sh"
run_suite "launcher-secret-gen-proxy-enforcement (distinct agent/control tokens → live proxy enforces)" \
  bash "$REPO_DIR/test/launcher-secret-gen-proxy-enforcement.test.sh"
run_suite "cross-session-secret-stability (stable agent token supports fixed-proxy reuse)" \
  bash "$REPO_DIR/test/cross-session-secret-stability.test.sh"
run_suite "proxy-reuse-lock (explicit-port cross-session reuse: 2nd attach, no duplicate spawn)" \
  bash "$REPO_DIR/test/proxy-reuse-lock.test.sh"
run_suite "benchmarks-update (durable stamp vs shadow pid + SIGHUP)" \
  bash "$REPO_DIR/test/benchmarks-update.test.sh"
run_suite "marketplace-update (third-party marketplace refresh safety + debounce)" \
  bash "$REPO_DIR/test/c-thru-marketplace-update.test.sh"

echo ""
echo "Node tests:"
run_suite "exit-code-gating (every Node suite ties exit code to its failure count)" \
  node "$REPO_DIR/test/exit-code-gating.test.js"
run_suite "helpers (self-test: waitForPing ECONNRESET retry, stub routing, spawnCapture)" \
  node "$REPO_DIR/test/helpers.test.js"
run_suite "hard-timeout-supervisor (wall cap + owned process-group cleanup)" \
  node "$REPO_DIR/test/hard-timeout-supervisor.test.js"
run_suite "test-run-evidence (atomic sanitized aggregate manifest)" \
  node "$REPO_DIR/test/test-run-evidence.test.js"
# DEFERRED: hierarchy-runtime-contract needs launcher timeout-export product work (WIP under test/deferred/).
# run_suite "hierarchy-runtime-contract (managed proxy + one-hour timeout propagation)" \
#   node "$REPO_DIR/test/hierarchy-runtime-contract.test.js"
run_suite "hooks-declaration-parity (ephemeral c-thru ↔ plugin hooks.json drift)" \
  node "$REPO_DIR/test/hooks-declaration-parity.test.js"
run_suite "hook-port-resolution (proxy-health + classify spawn, tools + plugin, fail-open)" \
  node "$REPO_DIR/test/hook-port-resolution.test.js"
run_suite "session-start-injection (proxy /hooks/context block injected once)" \
  node "$REPO_DIR/test/session-start-injection.test.js"
run_suite "c-thru-postcompact-context (PreCompact hook: port resolution + re-wrap)" \
  node "$REPO_DIR/test/c-thru-postcompact-context.test.js"
run_suite "preflight-model-readiness (/v1/active-models → PULL decisions)" \
  node "$REPO_DIR/test/preflight-model-readiness.test.js"
run_suite "model-map-v12-adapter (regression)" \
  node "$REPO_DIR/test/model-map-v12-adapter.test.js"
run_suite "proxy-lifecycle (startup, /ping, loopback bind)" \
  node "$REPO_DIR/test/proxy-lifecycle.test.js"
run_suite "c-thru-proxy-lifecycle (launcher exit/signal/readiness cleanup)" \
  node "$REPO_DIR/test/c-thru-proxy-lifecycle.test.js"
run_suite "proxy-unhandled-rejection (unhandledRejection handler + log)" \
  node "$REPO_DIR/test/proxy-unhandled-rejection.test.js"
run_suite "proxy-body-size-cap (MAX_BODY_BYTES 413 guard)" \
  node "$REPO_DIR/test/proxy-body-size-cap.test.js"
run_suite "proxy-forward-ollama-midstream-error" \
  node "$REPO_DIR/test/proxy-forward-ollama-midstream-error.test.js"
run_suite "proxy-upstream-midstream-failure (transport failure post-commitment: terminate, never hang/crash)" \
  node "$REPO_DIR/test/proxy-upstream-midstream-failure.test.js"
run_suite "proxy-client-disconnect-cleanup" \
  node "$REPO_DIR/test/proxy-client-disconnect-cleanup.test.js"
run_suite "proxy-anthropic-disconnect-cleanup (F2: forwardAnthropic tears down upstream on client disconnect)" \
  node "$REPO_DIR/test/proxy-anthropic-disconnect-cleanup.test.js"
run_suite "proxy-anthropic-timeout (F1: forwardAnthropic upstream timeout → cascade/502, not a hang)" \
  node "$REPO_DIR/test/proxy-anthropic-timeout.test.js"
run_suite "proxy-content-length-scrub" \
  node "$REPO_DIR/test/proxy-content-length-scrub.test.js"
run_suite "upstream-error-body (gzip/br decode + TUI-safe sanitize)" \
  node "$REPO_DIR/test/upstream-error-body.test.js"
run_suite "proxy-upstream-error-sanitize (gzip 429 never mojibake in error.message)" \
  node "$REPO_DIR/test/proxy-upstream-error-sanitize.test.js"
run_suite "proxy-response-pipe (compressed success intact + /s/ path + sibling require)" \
  node "$REPO_DIR/test/proxy-response-pipe.test.js"
run_suite "model-routes-alias-mode (sonnet/opus/haiku/fable × mode → no Anthropic under OSS)" \
  node "$REPO_DIR/test/model-routes-alias-mode.test.js"
run_suite "proxy-cooldown-ttl" \
  node "$REPO_DIR/test/proxy-cooldown-ttl.test.js"
run_suite "proxy-cross-provider-concurrent (3 providers fired concurrently: routing + no auth bleed)" \
  node "$REPO_DIR/test/proxy-cross-provider-concurrent.test.js"
run_suite "model-map-config-project-overlay" \
  node "$REPO_DIR/test/model-map-config-project-overlay.test.js"
run_suite "proxy-runtime-fallback (fallback chains, cycle detection)" \
  node "$REPO_DIR/test/proxy-runtime-fallback.test.js"
run_suite "capability-alias-resolve (2-hop agent→capability)" \
  node "$REPO_DIR/test/capability-alias-resolve.test.js"
run_suite "gen-brand-agents-ownership (generated-leaf ownership + safe stale pruning)" \
  node "$REPO_DIR/test/gen-brand-agents-ownership.test.js"
run_suite "gen-brand-agents --check (catalog ↔ agents/*.md + a2c drift)" \
  node "$REPO_DIR/tools/gen-brand-agents.js" --check
run_suite "brand-fleet-contract (pins, routes, prompt, selection templates)" \
  node "$REPO_DIR/test/brand-fleet-contract.test.js"
run_suite "agent-mapping-complete (every agent → live endpoint, all modes×tiers)" \
  node "$REPO_DIR/test/agent-mapping-complete.test.js"
run_suite "agent-invocation-headers (per-agent resolved-via/served-by/journal)" \
  node "$REPO_DIR/test/agent-invocation-headers.test.js"
run_suite "agent-dispatch-graph (subagent_type targets resolve agent→capability→model)" \
  node "$REPO_DIR/test/agent-dispatch-graph.test.js"
run_suite "agent-description-quality (description discoverability lint)" \
  node "$REPO_DIR/test/agent-description-quality.test.js"
run_suite "agent-selection-discriminability (descriptions discriminable per the selection corpus)" \
  node "$REPO_DIR/test/agent-selection-discriminability.test.js"
run_suite "proxy-sentinel-detection (structured prompt scan + HMAC + legacy rejection)" \
  node "$REPO_DIR/test/proxy-sentinel-detection.test.js"
run_suite "proxy-control-auth (control-token gate on mutating routes)" \
  node "$REPO_DIR/test/proxy-control-auth.test.js"
run_suite "c-thru-control-skill-modes (SKILL.md mode vocabulary matches runtime enum)" \
  node "$REPO_DIR/test/c-thru-control-skill-modes.test.js"
run_suite "proxy-auth-strip-e2e (C12: incoming Anthropic auth stripped to unknown host)" \
  node "$REPO_DIR/test/proxy-auth-strip-e2e.test.js"
run_suite "proxy-agent-sentinel-e2e (HMAC + spawned-agent ID + optional nested parent + replay rejection + fallback attribution)" \
  node "$REPO_DIR/test/proxy-agent-sentinel-e2e.test.js"
run_suite "c-thru-verify-routing (live-smoke tool: resolved-via header + usage-stats cross-check)" \
  node "$REPO_DIR/test/c-thru-verify-routing.test.js"
run_suite "agent-offload-lib (delegation parser: parse-not-grep, call↔result join)" \
  node "$REPO_DIR/test/agent-offload-lib.test.js"
run_suite "offload-evidence (selection evidence persistence and validation)" \
  node "$REPO_DIR/test/offload-evidence.test.js"
run_suite "offload-artifact-fixtures (real PNG/PDF/large-context generation)" \
  node "$REPO_DIR/test/offload-artifact-fixtures.test.js"
# DEFERRED (marketplace quality 2026-08): suite is untracked WIP with residual
# flaky/failure cases after brand/auth policy drift; re-enable when green hermetically.
# run_suite "agent-offload-failure-integration (failed Claude runs cannot enter selection scoring)" \
#   node "$REPO_DIR/test/agent-offload-failure-integration.test.js"
run_suite "c-thru-agent-usage (per-agent transcript telemetry CLI)" \
  node "$REPO_DIR/test/c-thru-agent-usage.test.js"
run_suite "llm-mode-resolution-matrix (16-mode matrix)" \
  node "$REPO_DIR/test/llm-mode-resolution-matrix.test.js"
run_suite "resolve-capability (capability alias graph)" \
  node "$REPO_DIR/test/resolve-capability.test.js"
run_suite "model-map-filter (mode-based filtering)" \
  node "$REPO_DIR/test/model-map-filter.test.js"
run_suite "model-map-ranking (quality-score ranking)" \
  node "$REPO_DIR/test/model-map-ranking.test.js"
run_suite "proxy-tool-use (tool use / function calling)" \
  node "$REPO_DIR/test/proxy-tool-use.test.js"
run_suite "proxy-count-tokens (count_tokens short-circuit + HEAD /)" \
  node "$REPO_DIR/test/proxy-count-tokens.test.js"
run_suite "hw-profile (hardware tier detection)" \
  node "$REPO_DIR/test/hw-profile.test.js"
run_suite "benchmark-validate (docs/benchmark.json schema + cross-checks)" \
  node "$REPO_DIR/test/benchmark-validate.test.js"
run_suite "model-map-layered (3-tier config merge)" \
  node "$REPO_DIR/test/model-map-layered.test.js"
run_suite "llm-profiles-editor (profile edit helpers)" \
  node "$REPO_DIR/test/llm-profiles-editor.test.js"
run_suite "llm-capabilities-shared (classify_intent logic shared by mcp+proxy)" \
  node "$REPO_DIR/test/llm-capabilities-shared.test.js"
run_suite "model-map-config (config path resolution)" \
  node "$REPO_DIR/test/model-map-config.test.js"
run_suite "proxy-cli-flags (parseCliFlags edge cases)" \
  node "$REPO_DIR/test/proxy-cli-flags.test.js"
run_suite "proxy-usage-stats (debounce, SIGTERM flush, multi-instance merge)" \
  node "$REPO_DIR/test/proxy-usage-stats.test.js"
run_suite "proxy-correlation-headers (preserve vs scrub Claude Code correlation)" \
  node "$REPO_DIR/test/proxy-correlation-headers.test.js"
run_suite "proxy-anthropic-upstream-override (transport/identity + Loose OAuth)" \
  node "$REPO_DIR/test/proxy-anthropic-upstream-override.test.js"
run_suite "c-thru-anthropic-upstream-fixes (ambient trust + fingerprint no-kill)" \
  bash "$REPO_DIR/test/c-thru-anthropic-upstream-fixes.test.sh"
run_suite "c-thru-anthropic-upstream-failclosed (A8 override + proxy fail hard-fail)" \
  node "$REPO_DIR/test/c-thru-anthropic-upstream-failclosed.test.js"
run_suite "c-thru-upstream-fingerprint (symmetric match + URL derive)" \
  bash "$REPO_DIR/test/c-thru-upstream-fingerprint.test.sh"
run_suite "proxy-usage-large-stream (F4: message_delta recovered past the 256KB head-cap)" \
  node "$REPO_DIR/test/proxy-usage-large-stream.test.js"
run_suite "proxy-sampling-param-guard (sampling defaults guard)" \
  node "$REPO_DIR/test/proxy-sampling-param-guard.test.js"
run_suite "proxy-recent-requests (ring buffer + /c-thru/recent)" \
  node "$REPO_DIR/test/proxy-recent-requests.test.js"
run_suite "proxy-dashboard (/c-thru/dashboard + discovery header)" \
  node "$REPO_DIR/test/proxy-dashboard.test.js"
run_suite "plan-dashboard (/c-thru/plan + live plan HTML)" \
  node "$REPO_DIR/test/plan-dashboard.test.js"
run_suite "proxy-info-injection-e2e (real proxy ↔ session-start hook ↔ --list discovery + skill)" \
  node "$REPO_DIR/test/proxy-info-injection-e2e.test.js"
run_suite "agent-contract-static (agent/skill static contracts)" \
  node "$REPO_DIR/test/agent-contract-static.test.js"
run_suite "agent-status-schema (STATUS block schema)" \
  node "$REPO_DIR/test/agent-status-schema.test.js"
run_suite "c-thru-config-helpers (config helper functions)" \
  node "$REPO_DIR/test/c-thru-config-helpers.test.js"
run_suite "c-thru-explain (explain command resolution)" \
  node "$REPO_DIR/test/c-thru-explain.test.js"
run_suite "advisor-panels-resolve (advisor_panels seats per mode)" \
  node "$REPO_DIR/test/advisor-panels-resolve.test.js"
run_suite "advisor-panels-validate (advisor_panels schema)" \
  node "$REPO_DIR/test/advisor-panels-validate.test.js"
run_suite "c-thru-plan-harness (plan harness utilities)" \
  node "$REPO_DIR/test/c-thru-plan-harness.test.js"
run_suite "plan-state-lib (native plans + wave/session aggregation)" \
  node "$REPO_DIR/test/plan-state-lib.test.js"
run_suite "plan-orchestrator-integration (orchestrator wave lifecycle, hermetic)" \
  node "$REPO_DIR/test/plan-orchestrator-integration.test.js"
run_suite "c-thru-target-launch (target launch helpers)" \
  node "$REPO_DIR/test/c-thru-target-launch.test.js"
run_suite "c-thru-run-real-claude-fg (foreground TTY ownership for proxied launch)" \
  bash "$REPO_DIR/test/c-thru-run-real-claude-fg.test.sh"
run_suite "cli-e2e-flags (CLI flag forwarding e2e)" \
  node "$REPO_DIR/test/cli-e2e-flags.test.js"
run_suite "compile-prompts (agent prompt compilation)" \
  node "$REPO_DIR/test/compile-prompts.test.js"
run_suite "llm-capabilities-mcp (MCP server tools)" \
  node "$REPO_DIR/test/llm-capabilities-mcp.test.js"
run_suite "model-map-pollution (config isolation / no cross-test leak)" \
  node "$REPO_DIR/test/model-map-pollution.test.js"
run_suite "model-map-validate (schema validator unit)" \
  node "$REPO_DIR/test/model-map-validate.test.js"
run_suite "model-map-validate-dedupe (duplicate-key detection)" \
  node "$REPO_DIR/test/model-map-validate-dedupe.test.js"
run_suite "planner-return-schema (planner output schema)" \
  node "$REPO_DIR/test/planner-return-schema.test.js"
run_suite "proxy-active-models (/v1/active-models endpoint)" \
  node "$REPO_DIR/test/proxy-active-models.test.js"
run_suite "proxy-autodetect (backend auto-detection)" \
  node "$REPO_DIR/test/proxy-autodetect.test.js"
run_suite "proxy-concurrent (concurrent request handling)" \
  node "$REPO_DIR/test/proxy-concurrent.test.js"
run_suite "proxy-config-reload (SIGHUP config reload)" \
  node "$REPO_DIR/test/proxy-config-reload.test.js"
run_suite "proxy-config-watcher (watcher failure logs warning, no crash)" \
  node "$REPO_DIR/test/proxy-config-watcher.test.js"
run_suite "proxy-observability-headers (backend latency, auth-missing, tier headers)" \
  node "$REPO_DIR/test/proxy-observability-headers.test.js"
run_suite "proxy-init-race (READY_FAILED sentinel on EADDRINUSE)" \
  node "$REPO_DIR/test/proxy-init-race.test.js"
run_suite "proxy-pid-file-profile (proxy.pid honors CLAUDE_PROFILE_DIR)" \
  node "$REPO_DIR/test/proxy-pid-file-profile.test.js"
run_suite "proxy-session-mode-isolation (per-session /s/<id> mode isolation, in-flight pin, reload invalidation)" \
  node "$REPO_DIR/test/proxy-session-mode-isolation.test.js"
run_suite "proxy-fallback-reload (fallback chain stable across SIGHUP reload)" \
  node "$REPO_DIR/test/proxy-fallback-reload.test.js"
run_suite "proxy-e2e (end-to-end proxy request flow)" \
  node "$REPO_DIR/test/proxy-e2e.test.js"
run_suite "proxy-fallback-cascade (fallback chain cascade)" \
  node "$REPO_DIR/test/proxy-fallback-cascade.test.js"
run_suite "proxy-form-factor (form factor detection)" \
  node "$REPO_DIR/test/proxy-form-factor.test.js"
run_suite "proxy-journal (journaling JSONL output)" \
  node "$REPO_DIR/test/proxy-journal.test.js"
run_suite "proxy-messages (messages API translation)" \
  node "$REPO_DIR/test/proxy-messages.test.js"
run_suite "proxy-mode-filters (mode-based request filtering)" \
  node "$REPO_DIR/test/proxy-mode-filters.test.js"
run_suite "proxy-mode-multi-backend (multi-backend mode routing)" \
  node "$REPO_DIR/test/proxy-mode-multi-backend.test.js"
run_suite "proxy-mode-overrides (mode override precedence)" \
  node "$REPO_DIR/test/proxy-mode-overrides.test.js"
run_suite "proxy-custom-mode-routing (custom_modes positive routing + gov-based filter)" \
  node "$REPO_DIR/test/proxy-custom-mode-routing.test.js"
run_suite "proxy-mode-ranking (mode-aware quality ranking)" \
  node "$REPO_DIR/test/proxy-mode-ranking.test.js"
run_suite "proxy-probe-llm (/v1/probe-llm endpoint)" \
  node "$REPO_DIR/test/proxy-probe-llm.test.js"
run_suite "proxy-resolution-matrix (full resolution matrix)" \
  node "$REPO_DIR/test/proxy-resolution-matrix.test.js"
run_suite "proxy-streaming-ollama (SSE streaming to Ollama)" \
  node "$REPO_DIR/test/proxy-streaming-ollama.test.js"
run_suite "proxy-streaming (SSE streaming)" \
  node "$REPO_DIR/test/proxy-streaming.test.js"
run_suite "proxy-tier-resolution (hw-tier model resolution)" \
  node "$REPO_DIR/test/proxy-tier-resolution.test.js"
run_suite "proxy-translation (Anthropic→provider translation)" \
  node "$REPO_DIR/test/proxy-translation.test.js"
run_suite "anthropic-api-coverage (501 gating + translation-gap header)" \
  node "$REPO_DIR/test/anthropic-api-coverage.test.js"
run_suite "proxy-gateway-protocol (Claude Code LLM gateway contract pins)" \
  node "$REPO_DIR/test/proxy-gateway-protocol.test.js"
run_suite "resolution-coverage (full resolution coverage)" \
  node "$REPO_DIR/test/resolution-coverage.test.js"
run_suite "proxy-model-pin-routing (model pin + routing)" \
  node "$REPO_DIR/test/proxy-model-pin-routing.test.js"
if [[ "${C_THRU_LIVE_PARITY:-0}" == "1" ]]; then
  if [[ -n "${ANTHROPIC_API_KEY:-}" && -n "${GOOGLE_API_KEY:-}" && -n "${OPENROUTER_API_KEY:-}" ]]; then
    run_live_suite "cross-provider" "proxy-cross-provider-parity" \
      "proxy-cross-provider-parity (real Anthropic/Gemini/OpenRouter tool parity)" \
      node "$REPO_DIR/test/proxy-cross-provider-parity.test.js"
  else
    block_live_suite "cross-provider" "proxy-cross-provider-parity" \
      "proxy-cross-provider-parity (real Anthropic/Gemini/OpenRouter tool parity)" \
      "missing_required_provider_credentials"
  fi
else
  skip_suite "proxy-cross-provider-parity (set C_THRU_LIVE_PARITY=1 + provider keys to enable)"
fi
run_suite "proxy-gemini-routing (Gemini routing + picker aliases)" \
  node "$REPO_DIR/test/proxy-gemini-routing.test.js"
run_suite "proxy-gemini-translation (Anthropic→Gemini translation)" \
  node "$REPO_DIR/test/proxy-gemini-translation.test.js"
run_suite "proxy-openai-routing (OpenAI Responses routing + fallback)" \
  node "$REPO_DIR/test/proxy-openai-routing.test.js"
run_suite "proxy-openai-translation (Anthropic→OpenAI Responses translation)" \
  node "$REPO_DIR/test/proxy-openai-translation.test.js"
run_suite "proxy-responses-reasoning-cache (privacy scope + finite bounds)" \
  node "$REPO_DIR/test/proxy-responses-reasoning-cache.test.js"
run_suite "proxy-responses-timeout (Responses watchdog + Gemini isolation)" \
  node "$REPO_DIR/test/proxy-responses-timeout.test.js"
run_suite "proxy-gemini-timeout (C32: hang-on-headers → timeout listener fires)" \
  node "$REPO_DIR/test/proxy-gemini-timeout.test.js"

run_suite "proxy-ollama-passthrough (Ollama /v1/messages passthrough + tool block preservation)" \
  node "$REPO_DIR/test/proxy-ollama-passthrough.test.js"
run_suite "model-map-lineage (full resolution matrix snapshot)" \
  node "$REPO_DIR/test/model-map-lineage.test.js"
run_suite "lineage-update-roundtrip (--update no-op/update/corrupt behaviors)" \
  node "$REPO_DIR/test/lineage-update-roundtrip.test.js"
run_suite "proxy-quality (mapping, fallback cascade, v1 passthrough)" \
  node "$REPO_DIR/test/proxy-quality.test.js"
run_suite "proxy-xai-routing (xAI endpoint, named model pins, auth strip, path)" \
  node "$REPO_DIR/test/proxy-xai-routing.test.js"
run_suite "proxy-xai-sanitize (fold role:system out of messages for xAI)" \
  node "$REPO_DIR/test/proxy-xai-sanitize.test.js"
run_suite "proxy-xai-upstream-error-log (400 body logged for xAI forensics)" \
  node "$REPO_DIR/test/proxy-xai-upstream-error-log.test.js"
run_suite "proxy-log-maintain (age prune + size rotate)" \
  node "$REPO_DIR/test/proxy-log-maintain.test.js"
run_suite "proxy-log-write-warn (unwritable ops log → stderr warn, proxy stays up)" \
  node "$REPO_DIR/test/proxy-log-write-warn.test.js"
run_suite "proxy-brand-agent-routing (agent name → concrete model + correct API path)" \
  node "$REPO_DIR/test/proxy-brand-agent-routing.test.js"
run_suite "proxy-brand-pin-failclosed (model: pin hard_fail; no cross-family cascade)" \
  node "$REPO_DIR/test/proxy-brand-pin-failclosed.test.js"
run_suite "proxy-routing-headers-parity (resolved-via + fallback-from on Gemini/xAI)" \
  node "$REPO_DIR/test/proxy-routing-headers-parity.test.js"
run_suite "proxy-ollama-fallback-url (OLLAMA_URL honored in not-in-routes fallback)" \
  node "$REPO_DIR/test/proxy-ollama-fallback-url.test.js"

# EXCLUDED: proxy-targets.test.js — targets{} request_defaults are not implemented
# EXCLUDED: benchmark-coverage.test.js — low value while its mode fixture checks zero cells
# EXCLUDED: proxy-autodetect.test.sh — host-RAM-dependent; hermetic .js variant is registered
skip_suite "benchmark-coverage (excluded — 0 cells checked, mode fixture not populated)"
skip_suite "proxy-targets (excluded — targets{} config feature not implemented in proxy)"
skip_suite "proxy-autodetect.test.sh (excluded — machine-RAM-dependent; .js variant registered)"

if [[ "${C_THRU_LIVE_ANTHROPIC:-0}" == "1" ]]; then
  echo ""
  echo "Live API tests (C_THRU_LIVE_ANTHROPIC=1):"
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    run_live_suite "anthropic" "anthropic-api-coverage-live" \
      "anthropic-api-coverage-live (real api.anthropic.com via proxy)" \
      node "$REPO_DIR/test/anthropic-api-coverage-live.test.js"
    run_live_suite "anthropic" "judge-canary" \
      "judge-canary (one real judge call — judge path health)" \
      node "$REPO_DIR/test/judge-canary.test.js"
  else
    block_live_suite "anthropic" "anthropic-api-coverage-live" \
      "anthropic-api-coverage-live (real api.anthropic.com via proxy)" \
      "missing_ANTHROPIC_API_KEY"
    block_live_suite "anthropic" "judge-canary" \
      "judge-canary (one real judge call — judge path health)" \
      "missing_ANTHROPIC_API_KEY"
  fi
else
  skip_suite "anthropic-api-coverage-live (set C_THRU_LIVE_ANTHROPIC=1 + ANTHROPIC_API_KEY to enable)"
  skip_suite "judge-canary (set C_THRU_LIVE_ANTHROPIC=1 + ANTHROPIC_API_KEY to enable)"
fi

if [[ "${C_THRU_LIVE_SELECTION:-0}" == "1" ]]; then
  echo ""
  echo "Live agent-selection judge (C_THRU_LIVE_SELECTION=1):"
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    run_live_suite "anthropic" "agent-selection-llm-judge" \
      "agent-selection-llm-judge (descriptions → right subagent, LLM judge, threshold-gated)" \
      node "$REPO_DIR/test/agent-selection-llm-judge.test.js"
  else
    block_live_suite "anthropic" "agent-selection-llm-judge" \
      "agent-selection-llm-judge (descriptions → right subagent, LLM judge, threshold-gated)" \
      "missing_ANTHROPIC_API_KEY"
  fi
else
  skip_suite "agent-selection-llm-judge (set C_THRU_LIVE_SELECTION=1 + ANTHROPIC_API_KEY to enable)"
fi

# Agent-facing live tests are opt-in behind their own gates. The contract suites
# own a wide-watchdog proxy; the Claude route/offload suites make c-thru own one.
echo ""
echo "Proxy-required agent tests (opt-in):"
if [[ "${C_THRU_BEHAVIORAL_TESTS:-0}" == "1" ]]; then
  run_live_suite "agent" "agent-contract-behavioral" \
    "agent-contract-behavioral (behavioral contracts via managed proxy)" \
    node "$REPO_DIR/test/agent-contract-behavioral.test.js"
else
  skip_suite "agent-contract-behavioral (set C_THRU_BEHAVIORAL_TESTS=1 to enable; proxy is managed)"
fi
if [[ "${C_THRU_LIVE_AGENT_TESTS:-0}" == "1" ]]; then
  run_live_suite "agent" "agent-contract-live" \
    "agent-contract-live (live agent contract smoke via managed proxy)" \
    node "$REPO_DIR/test/agent-contract-live.test.js"
else
  skip_suite "agent-contract-live (set C_THRU_LIVE_AGENT_TESTS=1 to enable)"
fi
if [[ "${C_THRU_LIVE_CLAUDE_AGENT_ROUTE:-0}" == "1" ]]; then
  run_live_suite "agent" "claude-agent-route-live" \
    "claude-agent-route-live (real Claude Agent header → mapped backend)" \
    node "$REPO_DIR/test/claude-agent-route-live.test.js"
else
  skip_suite "claude-agent-route-live (set C_THRU_LIVE_CLAUDE_AGENT_ROUTE=1 to enable)"
fi
# OSS brand leaf identity + proxy lifecycle (opt-in; needs Ollama/cloud + Claude for print).
if [[ "${C_THRU_LIVE_OSS_BRAND:-0}" == "1" ]]; then
  run_live_suite "agent" "brand-identity-direct" \
    "brand-identity-direct (OSS pins via proxy POST; stats/identity)" \
    env MODE=direct STATS=1 STRICT_HOST=0 \
      AGENTS="${C_THRU_BRAND_AGENTS:-deepseek qwen kimi glm}" \
      CLAUDE_LLM_MODE="${CLAUDE_LLM_MODE:-best-cloud-oss}" \
      bash "$REPO_DIR/test/c-thru-brand-identity-live.sh"
  run_live_suite "agent" "brand-identity-print" \
    "brand-identity-print (fleet c-thru -p stdin; journal + proxy_dead + identity)" \
    env MODE=print STRICT_HOST=1 STATS=1 \
      AGENTS="${C_THRU_BRAND_AGENTS:-deepseek qwen kimi glm}" \
      CLAUDE_LLM_MODE="${CLAUDE_LLM_MODE:-best-cloud-oss}" \
      bash "$REPO_DIR/test/c-thru-brand-identity-live.sh"
else
  skip_suite "brand-identity-direct (set C_THRU_LIVE_OSS_BRAND=1 + Ollama/cloud to enable)"
  skip_suite "brand-identity-print (set C_THRU_LIVE_OSS_BRAND=1 + Claude + Ollama/cloud to enable)"
fi
# Drives real `claude -p` sessions on NATURAL prompts and scores whether the
# injected descriptions make Claude delegate to the right subagent. The
# generated-artifact lane is intentionally disjoint so its six expensive cases
# can be piloted and repeated independently. Quality is advisory unless
# C_THRU_OFFLOAD_GATE=1; integrity failures always fail.
if [[ "${C_THRU_OFFLOAD_ARTIFACTS:-0}" == "1" ]]; then
  run_live_suite "agent" "agent-offload-artifacts" \
    "agent-offload-artifacts (real PNG/PDF/large-context selection scorecard)" \
    node "$REPO_DIR/test/agent-offload-coverage.js"
else
  if [[ "${C_THRU_OFFLOAD:-0}" == "1" ]]; then
    run_live_suite "agent" "agent-offload-coverage" \
      "agent-offload-coverage (natural-prompt offload scorecard)" \
      node "$REPO_DIR/test/agent-offload-coverage.js"
  else
    skip_suite "agent-offload-coverage (set C_THRU_OFFLOAD=1 + a claude binary to enable)"
  fi
  skip_suite "agent-offload-artifacts (use make test-live-artifacts to enable real generated inputs)"
fi
if [[ "${C_THRU_HIERARCHY_TESTS:-0}" == "1" ]]; then
  run_suite "agent-prompt-hierarchy (prompt hierarchy via proxy)" \
    node "$REPO_DIR/test/agent-prompt-hierarchy.test.js"
else
  skip_suite "agent-prompt-hierarchy (set C_THRU_HIERARCHY_TESTS=1 to enable; proxy is managed)"
fi

if [[ "${C_THRU_LIVE_GEMINI:-0}" == "1" ]]; then
  echo ""
  echo "Live Gemini tests (C_THRU_LIVE_GEMINI=1):"
  if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
    run_live_suite "gemini" "proxy-gemini-live-shapes" \
      "proxy-gemini-live-shapes (real Gemini API response shapes)" \
      node "$REPO_DIR/test/proxy-gemini-live-shapes.test.js"
    run_live_suite "gemini" "proxy-gemini-live-thinking" \
      "proxy-gemini-live-thinking (real Gemini thinking blocks)" \
      node "$REPO_DIR/test/proxy-gemini-live-thinking.test.js"
    run_live_suite "gemini" "proxy-gemini-live-e2e" \
      "proxy-gemini-live-e2e (Gemini end-to-end via proxy)" \
      bash "$REPO_DIR/test/proxy-gemini-live-e2e.test.sh"
  else
    block_live_suite "gemini" "proxy-gemini-live-shapes" \
      "proxy-gemini-live-shapes (real Gemini API response shapes)" \
      "missing_GOOGLE_API_KEY"
    block_live_suite "gemini" "proxy-gemini-live-thinking" \
      "proxy-gemini-live-thinking (real Gemini thinking blocks)" \
      "missing_GOOGLE_API_KEY"
    block_live_suite "gemini" "proxy-gemini-live-e2e" \
      "proxy-gemini-live-e2e (Gemini end-to-end via proxy)" \
      "missing_GOOGLE_API_KEY"
  fi
  if [[ -n "${GOOGLE_CLOUD_TOKEN:-}" && -n "${GOOGLE_CLOUD_PROJECT:-}" && -n "${GOOGLE_CLOUD_REGION:-}" ]]; then
    run_live_suite "vertex" "proxy-gemini-live-vertex" \
      "proxy-gemini-live-vertex (Vertex AI endpoint)" \
      bash "$REPO_DIR/test/proxy-gemini-live-vertex.test.sh"
  else
    block_live_suite "vertex" "proxy-gemini-live-vertex" \
      "proxy-gemini-live-vertex (Vertex AI endpoint)" \
      "missing_GOOGLE_CLOUD_TOKEN_PROJECT_or_REGION"
  fi
else
  skip_suite "proxy-gemini-live-shapes (set C_THRU_LIVE_GEMINI=1 + GOOGLE_API_KEY to enable)"
  skip_suite "proxy-gemini-live-thinking (set C_THRU_LIVE_GEMINI=1 + GOOGLE_API_KEY to enable)"
  skip_suite "proxy-gemini-live-e2e (set C_THRU_LIVE_GEMINI=1 + GOOGLE_API_KEY to enable)"
  skip_suite "proxy-gemini-live-vertex (set C_THRU_LIVE_GEMINI=1 + Vertex creds to enable)"
fi

if [[ "${C_THRU_LIVE_OPENAI:-0}" == "1" ]]; then
  echo ""
  echo "Live OpenAI tests (C_THRU_LIVE_OPENAI=1):"
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    run_live_suite "openai" "proxy-openai-live-shapes" \
      "proxy-openai-live-shapes (real OpenAI Responses API response shapes)" \
      node "$REPO_DIR/test/proxy-openai-live-shapes.test.js"
  else
    block_live_suite "openai" "proxy-openai-live-shapes" \
      "proxy-openai-live-shapes (real OpenAI Responses API response shapes)" \
      "missing_OPENAI_API_KEY"
  fi
else
  skip_suite "proxy-openai-live-shapes (set C_THRU_LIVE_OPENAI=1 + OPENAI_API_KEY to enable)"
fi

if [[ "${C_THRU_LIVE_XAI:-0}" == "1" ]]; then
  echo ""
  echo "Live xAI tests (C_THRU_LIVE_XAI=1):"
  if [[ -n "${XAI_API_KEY:-}" ]]; then
    run_live_suite "xai" "proxy-xai-live" \
      "proxy-xai-live (real xAI Responses + proxy translation)" \
      node "$REPO_DIR/test/proxy-xai-live.test.js"
  else
    block_live_suite "xai" "proxy-xai-live" \
      "proxy-xai-live (real xAI Responses + proxy translation)" \
      "missing_XAI_API_KEY"
  fi
else
  skip_suite "proxy-xai-live (set C_THRU_LIVE_XAI=1 + XAI_API_KEY to enable)"
fi

echo ""
echo "Validators:"
run_suite "model-map-validate (config/model-map.json)" \
  node "$REPO_DIR/tools/model-map-validate.js" "$REPO_DIR/config/model-map.json"
run_suite "c-thru-contract-check (agent contracts)" \
  bash "$REPO_DIR/tools/c-thru-contract-check.sh"
run_suite "bash -n tools/c-thru" \
  bash -n "$REPO_DIR/tools/c-thru"
run_suite "node --check tools/claude-proxy" \
  node --check "$REPO_DIR/tools/claude-proxy"
# Drift Validators (always-on for hermetic runs). A former .githooks/pre-commit
# mirrored these; that hook tree is not required. A green full run must still
# prove bundle/README/diagram sync here.
run_suite "sync-plugin-bundle --check (bundle drift)" \
  bash "$REPO_DIR/tools/sync-plugin-bundle.sh" --check
run_suite "gen-routing-doc --check (README routing table drift)" \
  node "$REPO_DIR/tools/gen-routing-doc.js" --check
run_suite "gen-request-flow-doc --check (README step-through vs docs/request-flow.html)" \
  node "$REPO_DIR/tools/gen-request-flow-doc.js" --check
run_suite "docs-html-integrity (dangling refs / duplicate ids / external subresources)" \
  node "$REPO_DIR/test/docs-html-integrity.test.js"
run_suite "check-diagram-sync (shared launch-flow diagram: README ↔ CLAUDE.md)" \
  node "$REPO_DIR/tools/check-diagram-sync.js"
run_suite "hooks-armed (core.hooksPath → .githooks, fail-closed)" \
  bash "$REPO_DIR/test/hooks-armed.test.sh"
run_suite "run-all-coverage (every test/ runnable referenced in this registry)" \
  node "$REPO_DIR/test/run-all-coverage.test.js"
run_suite "live-suite-wiring (aggregate gates, workflow secrets, fresh-checkout smoke config)" \
  node "$REPO_DIR/test/live-suite-wiring.test.js"
run_suite "run-all-live-outcome (provider pass/skip/blocked/failed accounting)" \
  node "$REPO_DIR/test/run-all-live-outcome.test.js"
run_suite "gate-coverage (every pre-commit artifact registered in this suite)" \
  node "$REPO_DIR/test/gate-coverage.test.js"

if [[ $FAST -eq 0 ]]; then
  echo ""
  echo "Smoke tests (slow — skip with --skip-smoke / make test):"
  if [[ -f "$REPO_DIR/test/smoke-check.sh" ]]; then
    run_suite "smoke-check (proxy start, control channel)" \
      bash "$REPO_DIR/test/smoke-check.sh"
  else
    skip_suite "smoke-check (not found)"
  fi
  # Stub-driven plan e2e scripts: hermetic (mktemp scratch repo + deterministic
  # stubs, no network), <1s each — triaged 2026-06-12.
  run_suite "e2e-plan-execution (/c-thru-plan hierarchy, stubbed)" \
    bash "$REPO_DIR/test/e2e-plan-execution.sh"
  run_suite "e2e-programming-assignment (plan harness piecewise e2e, stubbed)" \
    bash "$REPO_DIR/test/e2e-programming-assignment.sh"
  # Advisory, opt-in: a real Ollama-backed session whose prompt elicits a
  # subagent, verified via the journal. Self-skips (exit 0) unless C_THRU_E2E=1
  # and Ollama + a claude binary are present; never fails the suite.
  if [[ "${C_THRU_E2E:-0}" == "1" ]]; then
    run_suite "agent-scenarios-e2e (prompt→agent→journal, advisory)" \
      bash "$REPO_DIR/test/agent-scenarios-e2e.sh"
    run_suite "run-hierarchy-e2e (hierarchy via real c-thru + CLAUDE_BIN override)" \
      bash "$REPO_DIR/test/run-hierarchy-e2e.sh"
  else
    skip_suite "agent-scenarios-e2e (set C_THRU_E2E=1 + Ollama to enable)"
    skip_suite "run-hierarchy-e2e (set C_THRU_E2E=1 to enable)"
  fi
else
  skip_suite "smoke-check (skipped in hermetic suite — use make test-all)"
  skip_suite "e2e-plan-execution (skipped in hermetic suite — use make test-all)"
  skip_suite "e2e-programming-assignment (skipped in hermetic suite — use make test-all)"
  skip_suite "agent-scenarios-e2e (skipped in hermetic suite — use make test-all)"
  skip_suite "run-hierarchy-e2e (skipped in hermetic suite — use make test-all)"
fi

echo ""
echo "-----------------"
if [[ $EVIDENCE_FAILURE -ne 0 ]]; then
  FAIL=$(( FAIL + 1 ))
fi
FINAL_EVIDENCE_STATUS="passed"
[[ $FAIL -ne 0 ]] && FINAL_EVIDENCE_STATUS="failed"
if ! node "$TEST_EVIDENCE_TOOL" finalize \
  --path "$TEST_EVIDENCE_PATH" \
  --repo "$REPO_DIR" \
  --passed "$PASS" \
  --failed "$FAIL" \
  --skipped "$SKIP" \
  --blocked "$BLOCKED" \
  --status "$FINAL_EVIDENCE_STATUS"; then
  echo "run-all: evidence finalization failed (snapshot changed or evidence is incomplete)" >&2
  if [[ $EVIDENCE_FAILURE -eq 0 ]]; then
    FAIL=$(( FAIL + 1 ))
  fi
  EVIDENCE_FAILURE=1
fi
TOTAL=$(( PASS + FAIL ))
if [[ $FAIL -eq 0 ]]; then
  if [[ $SKIP -gt 0 || $BLOCKED -gt 0 ]]; then
    echo "✓ $TOTAL/$TOTAL suites passed ($SKIP skipped, $BLOCKED blocked)"
  else
    echo "✓ $TOTAL/$TOTAL suites passed"
  fi
else
  echo "✗ $FAIL/$TOTAL suites failed ($SKIP skipped, $BLOCKED blocked; failing output saved under $FAIL_LOG_DIR)"
  exit 1
fi
