#!/bin/bash
set -eo pipefail

SCRIPT_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0")"
TOOLS_DIR="$(dirname "$SCRIPT_REAL")"
REPO_DIR="$(dirname "$TOOLS_DIR")"
CLAUDE_DIR="${CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
CLAUDE_JSON="$HOME/.claude.json"
INSTALLED_TOOL="$CLAUDE_DIR/tools/llm-capabilities-mcp"
DO_CALL=0

if [[ "${1:-}" == "--call" ]]; then
  DO_CALL=1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "verify-llm-capabilities-mcp: node is required" >&2
  exit 1
fi

if [[ ! -x "$INSTALLED_TOOL" ]]; then
  echo "verify-llm-capabilities-mcp: missing installed MCP server at $INSTALLED_TOOL" >&2
  exit 1
fi

if [[ ! -f "$CLAUDE_JSON" ]]; then
  echo "verify-llm-capabilities-mcp: missing $CLAUDE_JSON" >&2
  exit 1
fi

python3 - "$CLAUDE_JSON" "$REPO_DIR" "$INSTALLED_TOOL" <<'PY'
import json
import os
import pathlib
import sys

cfg = pathlib.Path(sys.argv[1])
repo = os.path.realpath(sys.argv[2])
tool = os.path.realpath(sys.argv[3])
data = json.loads(cfg.read_text())
project = ((data.get("projects") or {}).get(repo) or {})
servers = project.get("mcpServers") or {}
entry = servers.get("llm-capabilities")
if not isinstance(entry, dict):
    raise SystemExit(f"verify-llm-capabilities-mcp: no llm-capabilities entry for {repo}")
command = entry.get("command")
args = entry.get("args") or []
command_real = os.path.realpath(command or "") if isinstance(command, str) and command else ""
tool_matches = command_real == tool
if not tool_matches and isinstance(args, list) and args:
    first = args[0]
    if isinstance(first, str) and first:
        tool_matches = os.path.realpath(first) == tool
if not tool_matches:
    raise SystemExit(f"verify-llm-capabilities-mcp: unexpected command path {command!r}")
env = entry.get("env") or {}
if env.get("CLAUDE_PROJECT_DIR") != repo:
    raise SystemExit("verify-llm-capabilities-mcp: CLAUDE_PROJECT_DIR mismatch")
if env.get("CLAUDE_MODEL_MAP_LAUNCH_CWD") != repo:
    raise SystemExit("verify-llm-capabilities-mcp: CLAUDE_MODEL_MAP_LAUNCH_CWD mismatch")
print(f"verified local MCP registration for {repo}")
PY

VERIFY_TOOL="$INSTALLED_TOOL" VERIFY_REPO="$REPO_DIR" VERIFY_CALL="$DO_CALL" node <<'NODE'
const { spawn } = require('child_process');

const tool = process.env.VERIFY_TOOL;
const cwd = process.env.VERIFY_REPO;
const doCall = process.env.VERIFY_CALL === '1';

function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`);
}

let buf = Buffer.alloc(0);
let initialized = false;
let listed = false;

function parse(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const split = buf.indexOf('\r\n\r\n');
    if (split === -1) return;
    const header = buf.slice(0, split).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) throw new Error(`missing Content-Length in header: ${header}`);
    const len = Number(match[1]);
    const end = split + 4 + len;
    if (buf.length < end) return;
    const body = JSON.parse(buf.slice(split + 4, end).toString('utf8'));
    buf = buf.slice(end);
    handle(body);
  }
}

function finish(code, message) {
  if (message) process.stdout.write(`${message}\n`);
  child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 20);
}

function handle(msg) {
  if (msg.id === 1 && !initialized) {
    initialized = true;
    child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }));
    child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    return;
  }

  if (msg.id === 2 && !listed) {
    listed = true;
    const tools = (((msg || {}).result || {}).tools || []).map(t => t.name).sort();
    process.stdout.write(`tools (${tools.length}): ${tools.join(', ')}\n`);
    if (!doCall) return finish(0);
    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'classify_intent',
        arguments: {
          prompt: 'Classify this prompt and recommend the best next tool.',
          context: 'Verification smoke test for llm-capabilities-mcp.',
        },
      },
    }));
    return;
  }

  if (msg.id === 3) {
    const result = msg.result || {};
    const structured = result.structuredContent || {};
    const summary = {
      result: structured.result || null,
      confidence: structured.confidence || null,
      recommended_tool: structured.recommended_tool || null,
    };
    process.stdout.write(`classify_intent smoke: ${JSON.stringify(summary)}\n`);
    return finish(0);
  }
}

const child = spawn(tool, {
  cwd,
  env: { ...process.env, HOME: process.env.HOME || process.env.USERPROFILE || '' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

child.on('error', err => finish(1, `verify-llm-capabilities-mcp: failed to spawn MCP server: ${err.message}`));
child.stdout.on('data', parse);
child.on('exit', (code, signal) => {
  if (!initialized || !listed) {
    const why = signal ? `signal ${signal}` : `code ${code}`;
    process.stderr.write(`verify-llm-capabilities-mcp: MCP server exited before completing handshake (${why})\n`);
    process.exit(1);
  }
});

setTimeout(() => {
  process.stderr.write('verify-llm-capabilities-mcp: timed out waiting for MCP response\n');
  finish(1);
}, 10000);

child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
NODE
