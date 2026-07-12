#!/usr/bin/env bash
# c-thru-verify-routing.sh — live routing validator.
#
# Cross-checks that a capability/agent resolves to the model c-thru's own
# config predicts, using TWO independent signals from the running proxy:
#   1. The x-c-thru-resolved-via response header on a real request.
#   2. The persisted /c-thru/status usage.by_agent[...].served_by delta —
#      catches what the header alone would miss (e.g. the right model was
#      dispatched but the response was zero-token and recordUsage skipped
#      it as noise, so nothing was actually confirmed end-to-end).
#
# Discovers the live proxy the same way `c-thru reload` does (PID file +
# lsof for the actual listening port, since it's dynamically assigned),
# unless ANTHROPIC_BASE_URL is already set (e.g. run from inside an active
# c-thru session, which exports it).
set -euo pipefail

CLAUDE_PROFILE_DIR="${CLAUDE_PROFILE_DIR:-$HOME/.claude}"

AGENTS=()
DRY_RUN=0
JSON_OUT=0
BASE_URL="${ANTHROPIC_BASE_URL:-}"
AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"

usage() {
  cat <<'EOF'
Usage: c-thru-verify-routing.sh --agent <name> [--agent <name> ...] [options]

Validates that each --agent's live routing matches c-thru's own predicted
resolution, cross-checked against TWO independent proxy signals: the
x-c-thru-resolved-via response header AND the persisted /c-thru/status
usage-by-agent delta. Sends ONE real request per --agent through the
running proxy — this has real cost against a cloud-backed capability.

Options:
  --agent <name>     Agent/capability to verify (repeatable, required unless --dry-run)
  --base-url <url>   Proxy base URL (default: $ANTHROPIC_BASE_URL, else discovered
                      from $CLAUDE_PROFILE_DIR/proxy.pid via lsof)
  --auth <token>     Bearer/x-api-key token for the live request (default:
                      $ANTHROPIC_AUTH_TOKEN or $ANTHROPIC_API_KEY)
  --dry-run          Only print predicted resolution from /c-thru/status — no
                      request is sent, zero cost.
  --json             Machine-readable JSON output instead of a table.
  -h, --help         Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENTS+=("$2"); shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --auth) AUTH_TOKEN="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --json) JSON_OUT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "c-thru-verify-routing: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${#AGENTS[@]} -eq 0 ]]; then
  echo "c-thru-verify-routing: at least one --agent is required" >&2
  usage >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "c-thru-verify-routing: jq is required" >&2
  exit 2
fi

if [[ -z "$BASE_URL" ]]; then
  pid_file="$CLAUDE_PROFILE_DIR/proxy.pid"
  if [[ ! -f "$pid_file" ]]; then
    echo "c-thru-verify-routing: no proxy PID file at $pid_file and ANTHROPIC_BASE_URL unset — is c-thru running?" >&2
    exit 1
  fi
  proxy_pid="$(cat "$pid_file" 2>/dev/null)"
  if [[ -z "$proxy_pid" ]] || ! kill -0 "$proxy_pid" 2>/dev/null; then
    echo "c-thru-verify-routing: stale/empty proxy PID file at $pid_file" >&2
    exit 1
  fi
  proxy_port=""
  if command -v lsof >/dev/null 2>&1; then
    proxy_port="$(lsof -a -iTCP -sTCP:LISTEN -n -P -p "$proxy_pid" 2>/dev/null | awk 'NR>1{print $9}' | grep -oE '[0-9]+$' | head -1 || true)"
  fi
  [[ -z "$proxy_port" ]] && proxy_port="${CLAUDE_PROXY_PORT:-}"
  if [[ -z "$proxy_port" ]]; then
    echo "c-thru-verify-routing: cannot determine proxy port (lsof unavailable and CLAUDE_PROXY_PORT unset)" >&2
    exit 1
  fi
  BASE_URL="http://127.0.0.1:$proxy_port"
fi

if ! curl -sf --max-time 2 "$BASE_URL/ping" >/dev/null 2>&1; then
  echo "c-thru-verify-routing: $BASE_URL/ping did not respond — proxy not reachable" >&2
  exit 1
fi

STATUS_JSON="$(curl -sf --max-time 3 "$BASE_URL/c-thru/status?verbose=1")"
if [[ -z "$STATUS_JSON" ]]; then
  echo "c-thru-verify-routing: $BASE_URL/c-thru/status did not respond" >&2
  exit 1
fi

overall_exit=0
results="[]"

for agent in "${AGENTS[@]}"; do
  predicted="$(jq -r --arg a "$agent" '.agent_resolutions[$a].model // empty' <<<"$STATUS_JSON")"
  if [[ -z "$predicted" ]]; then
    echo "c-thru-verify-routing: agent '$agent' has no predicted resolution (unknown agent?)" >&2
    overall_exit=1
    results="$(jq --arg a "$agent" '. + [{agent:$a, verdict:"FAIL", reason:"no predicted resolution"}]' <<<"$results")"
    continue
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    results="$(jq --arg a "$agent" --arg p "$predicted" '. + [{agent:$a, predicted:$p, verdict:"DRY_RUN"}]' <<<"$results")"
    continue
  fi

  before_count="$(jq -r --arg a "$agent" --arg m "$predicted" '.usage.by_agent[$a].served_by[$m] // 0' <<<"$STATUS_JSON")"

  auth_header=()
  [[ -n "$AUTH_TOKEN" ]] && auth_header=(-H "Authorization: Bearer $AUTH_TOKEN" -H "x-api-key: $AUTH_TOKEN")

  resp_headers="$(mktemp)"
  # ${arr[@]+"${arr[@]}"} — bash-3.2-safe expansion of a possibly-empty array
  # under `set -u` (macOS ships bash 3.2; plain "${auth_header[@]}" throws
  # "unbound variable" there when the array has zero elements).
  if ! curl -sf --max-time 30 -D "$resp_headers" -o /dev/null \
      -H "Content-Type: application/json" "${auth_header[@]+"${auth_header[@]}"}" \
      -d "$(jq -n --arg m "$agent" '{model:$m, max_tokens:1, messages:[{role:"user", content:"ping"}]}')" \
      "$BASE_URL/v1/messages"; then
    echo "c-thru-verify-routing: request for agent '$agent' failed" >&2
    rm -f "$resp_headers"
    overall_exit=1
    results="$(jq --arg a "$agent" --arg p "$predicted" '. + [{agent:$a, predicted:$p, verdict:"FAIL", reason:"request failed"}]' <<<"$results")"
    continue
  fi

  resolved_via="$(grep -i '^x-c-thru-resolved-via:' "$resp_headers" | head -1 | sed 's/^[^:]*: *//' | tr -d '\r')"
  rm -f "$resp_headers"
  served_by="$(jq -r '.served_by // empty' <<<"$resolved_via" 2>/dev/null || true)"

  status_after="$(curl -sf --max-time 3 "$BASE_URL/c-thru/status?verbose=1")"
  after_count="$(jq -r --arg a "$agent" --arg m "$predicted" '.usage.by_agent[$a].served_by[$m] // 0' <<<"$status_after")"

  header_match="false"
  [[ "$served_by" == "$predicted" ]] && header_match="true"
  stats_confirmed="false"
  [[ "$after_count" -gt "$before_count" ]] && stats_confirmed="true"

  verdict="FAIL"
  [[ "$header_match" == "true" && "$stats_confirmed" == "true" ]] && verdict="PASS"
  [[ "$verdict" == "FAIL" ]] && overall_exit=1

  results="$(jq --arg a "$agent" --arg p "$predicted" --arg s "$served_by" \
    --argjson hm "$header_match" --argjson sc "$stats_confirmed" \
    --argjson bc "$before_count" --argjson ac "$after_count" --arg v "$verdict" \
    '. + [{agent:$a, predicted:$p, served_by:$s, header_match:$hm, stats_confirmed:$sc, before_count:$bc, after_count:$ac, verdict:$v}]' <<<"$results")"
done

if [[ "$JSON_OUT" -eq 1 ]]; then
  echo "$results" | jq -c '.'
else
  echo "$results" | jq -r '
    ["AGENT","PREDICTED","SERVED_BY","HEADER_MATCH","STATS_CONFIRMED","VERDICT"],
    (.[] | [.agent, (.predicted // "-"), (.served_by // "-"), (.header_match|tostring), (.stats_confirmed|tostring), .verdict])
    | @tsv' | column -t -s $'\t'
fi

exit "$overall_exit"
