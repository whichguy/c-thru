#!/usr/bin/env bash
# Fixture: the routing skeleton of preflight_model_readiness() from tools/c-thru.
# Kept byte-identical (up to the `grep -qxF` divergence sentinel) to tools/c-thru
# by contract-check Check 10 (tools/c-thru-contract-check.sh). Only the action
# block differs: the real ollama pull/warm is replaced with `echo "PULL:<model>"`
# so test/preflight-model-readiness.test.js can assert which models WOULD pull
# without touching a real Ollama.
#
# Invoked as: bash test/stubs/preflight-skeleton.sh <proxy_port>
# Reads OLLAMA_URL and C_THRU_SKIP_PREFLIGHT from the environment.
#
# Lives under test/stubs/ (not test/) so run-all-coverage's non-recursive scan
# treats it as a fixture, not an unregistered suite.
set -uo pipefail

preflight_model_readiness() {
  local port="${1:-}"
  [[ "${C_THRU_SKIP_PREFLIGHT:-0}" == "1" ]] && return 0
  [[ -n "$port" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0

  local response
  response=$(curl -sf --max-time 3 "http://127.0.0.1:$port/v1/active-models" 2>/dev/null) || return 0
  [[ -n "$response" ]] || return 0

  local required_models
  if command -v jq >/dev/null 2>&1; then
    required_models=$(printf '%s' "$response" | jq -r '.local_models[]' 2>/dev/null) || return 0
  elif command -v node >/dev/null 2>&1; then
    required_models=$(node -e "
      try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
          d.local_models.forEach(m=>console.log(m));}catch{}" <<< "$response" 2>/dev/null) || return 0
  else
    return 0
  fi
  [[ -n "$required_models" ]] || return 0

  local ollama_base="${OLLAMA_URL:-http://localhost:11434}"
  local pulled_json pulled_models
  pulled_json=$(curl -sf --max-time 3 "${ollama_base%/}/api/tags" 2>/dev/null) || return 0
  if command -v jq >/dev/null 2>&1; then
    pulled_models=$(printf '%s' "$pulled_json" | jq -r '.models[].name' 2>/dev/null || true)
  else
    pulled_models=$(node -e "
      try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
          d.models.forEach(m=>console.log(m.name));}catch{}" <<< "$pulled_json" 2>/dev/null || true)
  fi

  local any_missing=0
  while IFS= read -r model; do
    [[ -n "$model" ]] || continue
    local bare_model="${model%%@*}"
    if ! printf '%s\n' "$pulled_models" | grep -qxF "$bare_model"; then
      any_missing=1
      echo "PULL:$bare_model"
    fi
  done <<< "$required_models"
  [[ "$any_missing" -eq 0 ]] || true
}

# Run with args: preflight_model_readiness <proxy_port>
# OLLAMA_URL and C_THRU_SKIP_PREFLIGHT are read from env.
preflight_model_readiness "${1:-}"
