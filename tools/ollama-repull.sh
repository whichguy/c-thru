#!/usr/bin/env bash
set -euo pipefail

models=$(ollama ls 2>&1 | tail -n +2 | awk '{print $1}')

if [[ -z "$models" ]]; then
  echo "No models found." >&2
  exit 0
fi

while IFS= read -r model; do
  echo "Pulling $model..."
  ollama pull "$model" || echo "WARNING: failed to pull $model, skipping"
done <<< "$models"
