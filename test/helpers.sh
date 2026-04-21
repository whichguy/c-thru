#!/usr/bin/env bash
# Shared test helpers sourced by regression test files.

PASS=0; FAIL=0

check() {
    local label="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        echo "  PASS  $label"; PASS=$((PASS+1))
    else
        echo "  FAIL  $label (expected '$expected', got '$actual')"; FAIL=$((FAIL+1))
    fi
}

# mock_hw_tier: set CLAUDE_LLM_MEMORY_GB to a value within a named tier.
# Note: install.sh's hw-profile.js banner reads os.totalmem() directly —
# this env var affects proxy-side resolution but not the install banner.
mock_hw_tier() {
    local tier="$1" gb
    case "$tier" in
        16gb)  gb=14  ;;
        32gb)  gb=28  ;;
        48gb)  gb=44  ;;
        64gb)  gb=60  ;;
        128gb) gb=120 ;;
        *) echo "mock_hw_tier: unknown tier '$tier'" >&2; return 1 ;;
    esac
    export CLAUDE_LLM_MEMORY_GB="$gb"
}
unset_hw_tier() { unset CLAUDE_LLM_MEMORY_GB; }

# mock_node_version: inject a fake node binary reporting a specific major.
# Returns the stub_dir path so the caller can rm -rf it on cleanup.
mock_node_version() {
    local version="$1"
    local stub_dir
    stub_dir=$(mktemp -d)
    cat > "$stub_dir/node" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *"process.versions.node"* ]]; then
    printf '%s' "${version}"
else
    exec /usr/bin/env node "\$@"
fi
EOF
    chmod +x "$stub_dir/node"
    export PATH="$stub_dir:$PATH"
    echo "$stub_dir"
}

# start_ollama_stub: spawn a minimal python3 HTTP server on a given port
# simulating Ollama /api/tags. Returns the server PID.
start_ollama_stub() {
    local port="$1" model_count="${2:-0}"
    # Redirect stdin/stdout/stderr so the background process does not
    # inherit the pipe used by command substitution $(start_ollama_stub ...),
    # which would hang the substitution waiting for EOF.
    python3 -c "
import http.server, json
count = $model_count
models = [{'name': 'm' + str(i)} for i in range(count)]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'models': models}).encode())
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', $port), H).serve_forever()
" </dev/null >/dev/null 2>&1 &
    echo $!
    sleep 0.4
}
stop_ollama_stub() { kill "$1" 2>/dev/null || true; }
