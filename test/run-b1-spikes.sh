#!/usr/bin/env bash
# test/run-b1-spikes.sh
# Empirical research spike for the B1 Outcome Template pattern.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPIKE_DIR="$REPO_ROOT/test/.b1-spike-results"
PROXY_URL="${CLAUDE_PROXY_URL:-http://127.0.0.1:9001}/v1/messages"
MODEL="${CLAUDE_MODEL:-qwen3.6:27b-coding-nvfp4}"

mkdir -p "$SPIKE_DIR"

function run_spike() {
  local name="$1"
  local task="$2"
  local agent="${3:-implementer}"
  local resources="${4:-[]}"
  
  echo "--- Running Spike: $name ---"
  
  local digest_file="$SPIKE_DIR/digest-$name.md"
  
  # 1. Generate base digest
  cat <<EOF > "$digest_file"
agent: $agent
target_resources: $resources
---
## Mission context
B1 Pattern Validation Spike: $name

## Your task
$task

Success criteria:
- [ ] Task completed
- [ ] Correct STATUS block returned
EOF

  # 2. Inject contract and template via harness
  node "$REPO_ROOT/tools/c-thru-plan-harness.js" inject-contract \
    --contract "$REPO_ROOT/shared/_worker-contract.md" \
    --digests-dir "$SPIKE_DIR"
    
  local prompt_payload=$(cat "$digest_file")
  
  # 3. Call proxy directly
  echo "Calling $MODEL via proxy..."
  local response_file="$SPIKE_DIR/response-$name.json"
  
  curl -s -X POST "$PROXY_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": $(echo "$prompt_payload" | jq -Rs .)}],
      \"max_tokens\": 4000
    }" > "$response_file"
    
  # 4. Extract and save raw markdown
  local raw_md_file="$SPIKE_DIR/raw-$name.md"
  jq -r '.content[0].text' "$response_file" > "$raw_md_file"
  
  echo "  DONE. Result saved to $raw_md_file"
  echo ""
}

# Ensure proxy is running
if ! curl -s -o /dev/null "$PROXY_URL"; then
  echo "ERROR: Proxy not found at $PROXY_URL. Start it with 'tools/claude-proxy --port 9001' first."
  exit 1
fi

# SPIKE 1: The Lazy Placeholder Test
run_spike "lazy" \
  "Add a comment saying '// B1 Test' to src/stub.js." \
  "implementer" \
  "[src/stub.js]"

# SPIKE 2: The Improvement Mandate
run_spike "improvement" \
  "Extract the 'sum' function from math.js into its own file." \
  "implementer" \
  "[math.js, sum.js]"

# SPIKE 3: The Honest Recusal
run_spike "recusal" \
  "Optimize the calculateEntropy function in core/crypto.c" \
  "implementer" \
  "[core/crypto.c]"

# SPIKE 4: Multi-File Index
run_spike "multi-file" \
  "Rename the User class to Account in models/user.ts, controllers/user.ts, and test/user.test.ts" \
  "implementer" \
  "[models/user.ts, controllers/user.ts, test/user.test.ts]"

echo "All spikes completed. Review results in $SPIKE_DIR/raw-*.md"
