#!/usr/bin/env bash
# Advisory Ollama probe: prints "OK <n>" (model count) or "DOWN <host>".
# Reads OLLAMA_HOST (default 127.0.0.1:11434). Always exits 0.
set -uo pipefail

host="${OLLAMA_HOST:-127.0.0.1:11434}"

tag_count=$(curl -sf --max-time 2 "http://${host}/api/tags" 2>/dev/null \
    | jq -r '.models | length' 2>/dev/null || true)

if [ -n "$tag_count" ]; then
    printf 'OK %s\n' "$tag_count"
else
    printf 'DOWN %s\n' "$host"
fi
