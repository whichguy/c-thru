#!/usr/bin/env bash
# Unit tests for strip_cthru_cli_args (allowlist strip of c-thru flags).
# Run: bash test/c-thru-strip-args.test.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CTHRU="$SCRIPT_DIR/../tools/c-thru"
[[ -f "$CTHRU" ]] || { echo "fatal: cannot find $CTHRU" >&2; exit 1; }

eval "$(awk '/^cthru_flag_width\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^is_claude_native_model_name\(\) \{/,/^\}$/' "$CTHRU")"
eval "$(awk '/^strip_cthru_cli_args\(\) \{/,/^\}$/' "$CTHRU")"

PASS=0
FAIL=0

assert() {
  local label="$1"
  shift
  # Use `test`/`[` form — do not pass `[[` via "$@"; quoting breaks the keyword.
  if "$@"; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label" >&2
    FAIL=$((FAIL + 1))
  fi
}

# Join FORWARDED_ARGS with SOH so multi-word tokens stay distinct in comparisons.
joined() {
  local IFS=$'\x01'
  # shellcheck disable=SC2145
  printf '%s' "${FORWARDED_ARGS[*]-}"
}

expect_forward() {
  local label="$1"
  shift
  local -a want=("$@")
  local got want_s
  got="$(joined)"
  local IFS=$'\x01'
  want_s="${want[*]}"
  if [[ "$got" == "$want_s" ]]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label (got $(printf '%q' "$got") want $(printf '%q' "$want_s"))" >&2
    FAIL=$((FAIL + 1))
  fi
}

run_native() {
  ORIG_ARGS=("$@")
  FORWARDED_ARGS=()
  STRIPPED_MODEL=""
  set +u
  strip_cthru_cli_args native_subcmd
  set -u
}

run_main() {
  local desired="${1:-}"
  shift || true
  ORIG_ARGS=("$@")
  FORWARDED_ARGS=()
  STRIPPED_MODEL=""
  CALLER_SETTINGS_PARSEABLE=()
  CALLER_AGENTS_PARSEABLE=()
  set +u
  strip_cthru_cli_args main "$desired"
  set -u
}

echo "c-thru strip_cthru_cli_args tests"
echo ""

echo "1. native: agents --model grok --json → strip brand model, keep agents/json"
run_native agents --model grok --json
expect_forward "native strips --model grok" agents --json
assert "STRIPPED_MODEL=grok" test "${STRIPPED_MODEL}" = "grok"

echo ""
echo "1b. native: Claude-native aliases are forwarded (sonnet/opus/fable/haiku)"
run_native agents --model sonnet --json
expect_forward "native keeps --model sonnet" agents --model sonnet --json
assert "no strip for sonnet" test -z "${STRIPPED_MODEL}"

run_native agents --model=opus --json
expect_forward "native keeps --model=opus" agents --model=opus --json

run_native agents --model fable --json
expect_forward "native keeps --model fable" agents --model fable --json

run_native agents --model haiku --json
expect_forward "native keeps --model haiku" agents --model haiku --json

run_native agents --model claude-sonnet-4-6 --json
expect_forward "native keeps full claude-* id" agents --model claude-sonnet-4-6 --json

run_native agents --model claude-via-gemini-pro --json
expect_forward "native strips claude-via-* (c-thru picker alias)" agents --json
assert "STRIPPED_MODEL claude-via" test "${STRIPPED_MODEL}" = "claude-via-gemini-pro"

echo ""
echo "2. native: --model=grok equals form"
run_native agents --model=grok --help
expect_forward "native strips --model=grok" agents --help
assert "STRIPPED_MODEL from equals" test "${STRIPPED_MODEL}" = "grok"

echo ""
echo "3. native: --mode best-cloud agents --help"
run_native --mode best-cloud agents --help
expect_forward "native strips --mode" agents --help

echo ""
echo "4. native: after --, --model grok is forwarded (escape hatch)"
run_native agents -- --model grok
expect_forward "escape hatch after --" agents -- --model grok
assert "no STRIPPED_MODEL when after --" test -z "${STRIPPED_MODEL}"

echo ""
echo "5. native: unknown Claude flags pass through one token each"
run_native agents --effort high --json
expect_forward "unknown Claude flags forwarded" agents --effort high --json

echo ""
echo "6. native: -p and prompt never stripped (even next to c-thru flags)"
# native path rarely uses -p, but stripper must not own -p
run_native --mode best-cloud -p "hello world" agents
expect_forward "-p prompt adjacent after strip" -p "hello world" agents

echo ""
echo "7. main: reinject desired model; keep -p prompt adjacent"
run_main "resolved-model" --model grok -p "hello world"
# order: reinjected model may be prepended if saw_model set during consume
# When user passed --model, reinject happens at consume site as --model desired
set +u
has_p=0 has_prompt=0 has_resolved=0 has_grok=0
for a in "${FORWARDED_ARGS[@]-}"; do
  [[ "$a" == "-p" ]] && has_p=1
  [[ "$a" == "hello world" ]] && has_prompt=1
  [[ "$a" == "resolved-model" || "$a" == "--model=resolved-model" || "$a" == "--model" ]] && {
    [[ "$a" == "resolved-model" || "$a" == "--model=resolved-model" ]] && has_resolved=1
  }
  [[ "$a" == "resolved-model" ]] && has_resolved=1
  [[ "$a" == "--model=resolved-model" ]] && has_resolved=1
  [[ "$a" == "grok" ]] && has_grok=1
done
# also accept adjacent --model resolved-model
for i in "${!FORWARDED_ARGS[@]}"; do
  if [[ "${FORWARDED_ARGS[i]}" == "--model" && "${FORWARDED_ARGS[i+1]:-}" == "resolved-model" ]]; then
    has_resolved=1
  fi
done
set -u
assert "main keeps -p" test "$has_p" -eq 1
assert "main keeps prompt text" test "$has_prompt" -eq 1
assert "main has resolved model" test "$has_resolved" -eq 1
assert "main drops user grok token" test "$has_grok" -eq 0
# adjacency
set +u
p_idx=-1 prompt_idx=-1
for i in "${!FORWARDED_ARGS[@]}"; do
  [[ "${FORWARDED_ARGS[i]}" == "-p" ]] && p_idx=$i
  [[ "${FORWARDED_ARGS[i]}" == "hello world" ]] && prompt_idx=$i
done
set -u
assert "-p adjacent to prompt" test "$prompt_idx" -eq $((p_idx + 1))

echo ""
echo "8. main: --model not consumed when next looks like a flag (-p)"
run_main "resolved-model" --model -p "hello"
set +u
# --model width 1 (next is -p); reinject may still add resolved; -p and hello forward
has_p=0 has_hello=0
for a in "${FORWARDED_ARGS[@]-}"; do
  [[ "$a" == "-p" ]] && has_p=1
  [[ "$a" == "hello" ]] && has_hello=1
done
set -u
assert "--model does not swallow -p" test "$has_p" -eq 1 -a "$has_hello" -eq 1

echo ""
echo "9. pure c-thru flags all stripped on native"
run_native --route foo --profile 64gb --memory-gb 32 --bypass-proxy --journal \
  --proxy-debug 1 --router-debug --no-update --no-agents --print-routing --dry-run \
  --local-only --best-cloud --offline --thinking agents --json
expect_forward "all private flags gone" agents --json

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "$PASS/$PASS passed"
  exit 0
fi
echo "$((PASS))/$((PASS+FAIL)) passed — $FAIL FAILED" >&2
exit 1
