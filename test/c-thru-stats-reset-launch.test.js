#!/usr/bin/env node
'use strict';
// A2: C_THRU_STATS_RESET=launch clears lifetime usage once when proxy is ready.
// Run: node test/c-thru-stats-reset-launch.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
} = require('./helpers');

console.log('c-thru-stats-reset-launch tests\n');

const REPO = path.resolve(__dirname, '..');

async function main() {
  const stub = await stubBackend();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-stats-reset-'));
  const statsFile = path.join(tmpHome, 'usage-stats.json');
  const configPath = writeConfig(tmpHome, {
    backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stub.port}` } },
    model_routes: { 'reset-test-model': 'stub' },
    llm_profiles: {
      '16gb': {
        workhorse: {
          connected_model: 'reset-test-model@stub',
          disconnect_model: 'reset-test-model@stub',
        },
      },
    },
    agent_to_capability: {},
  });

  const { child, port } = await spawnProxy({
    configPath,
    tmpHome,
    env: {
      CLAUDE_PROXY_USAGE_STATS_FILE: statsFile,
      CLAUDE_LLM_MEMORY_GB: '16',
      CLAUDE_LLM_MODE: 'best-cloud',
    },
  });
  await waitForPing(port);

  try {
    // Seed usage
    const msg = await httpJson(port, 'POST', '/v1/messages', {
      model: 'reset-test-model',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 10,
    }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
    assertEq(msg.status, 200, 'seed request 200');

    // Force flush by waiting debounce or reading after clear path — seed file may
    // still be only in-memory; hit status then clear via launch helper.
    // Direct seed of file for never-path comparison:
    fs.writeFileSync(statsFile, JSON.stringify({
      total_input: 99,
      total_output: 9,
      total_duration_ms: 1,
      by_model: { 'reset-test-model': { input: 99, output: 9, calls: 3, total_duration_ms: 1, first_call: null, last_call: null } },
      by_agent: {},
      by_backend: {},
      first_recorded: '2026-01-01T00:00:00.000Z',
      last_recorded: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    // default never: launch reset must not clear
    const neverScript = `
set -euo pipefail
C_THRU_STATS_RESET=never
PROXY_PORT=${port}
CLAUDE_PROXY_PORT=${port}
_C_THRU_STATS_RESET_DONE=0
source "${REPO}/tools/c-thru-lib.sh" 2>/dev/null || true
# inline the same gate as maybe_reset_usage_stats_on_launch
if [[ "\${C_THRU_STATS_RESET:-never}" == "launch" ]]; then
  curl -sf --max-time 2.0 -X POST "http://127.0.0.1:\${PROXY_PORT}/c-thru/stats/clear" >/dev/null
fi
`;
    let r = spawnSync('bash', ['-c', neverScript], { encoding: 'utf8' });
    assertEq(r.status, 0, 'never path script exits 0');
    let disk = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    assertEq(disk.by_model['reset-test-model'].calls, 3, 'never does not clear seeded calls');

    // launch: must clear (inline contract — same POST as the real helper)
    const launchScript = `
set -euo pipefail
C_THRU_STATS_RESET=launch
PROXY_PORT=${port}
CLAUDE_PROXY_PORT=${port}
_C_THRU_STATS_RESET_DONE=0
if [[ "\${C_THRU_STATS_RESET:-never}" == "launch" ]]; then
  if curl -sf --max-time 2.0 -X POST "http://127.0.0.1:\${PROXY_PORT}/c-thru/stats/clear"; then
    echo cleared
  else
    echo fail >&2; exit 1
  fi
fi
`;
    r = spawnSync('bash', ['-c', launchScript], { encoding: 'utf8' });
    assertEq(r.status, 0, 'launch path script exits 0');
    assert(/cleared/.test(r.stdout), 'launch path performed clear');

    const status = await httpJson(port, 'GET', '/c-thru/statusline');
    const body = status.json || status.body;
    assertEq(body.usage_window.calls, 0, 'usage_window.calls is 0 after launch clear');
    assertEq(body.usage_window.input, 0, 'usage_window.input is 0 after launch clear');

    // Gap 2: exercise the *actual* functions extracted from tools/c-thru
    // (control_token_curl_args + maybe_reset_usage_stats_on_launch), not a
    // re-implemented curl gate. Re-seed file, then call the real helper twice.
    fs.writeFileSync(statsFile, JSON.stringify({
      total_input: 11,
      total_output: 2,
      total_duration_ms: 1,
      by_model: { 'reset-test-model': { input: 11, output: 2, calls: 5, total_duration_ms: 1, first_call: null, last_call: null } },
      by_agent: {},
      by_backend: {},
      first_recorded: '2026-01-01T00:00:00.000Z',
      last_recorded: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const harness = path.join(tmpHome, 'reset-harness.sh');
    // T-E / P5: real helpers live in c-thru-lib.sh (sourceable, no side effects
    // at source time). Intentionally NO control token — empty _ct_args + set -u.
    fs.writeFileSync(harness, `#!/usr/bin/env bash
set -euo pipefail
CLAUDE_PROFILE_DIR="${tmpHome}"
CLAUDE_DIR="${tmpHome}"
unset CLAUDE_PROXY_CONTROL_TOKEN CLAUDE_PROXY_CONTROL_TOKEN_FILE 2>/dev/null || true
# shellcheck source=c-thru-lib.sh
source "${REPO}/tools/c-thru-lib.sh"
C_THRU_STATS_RESET=launch
PROXY_PORT=${port}
CLAUDE_PROXY_PORT=${port}
_C_THRU_STATS_RESET_DONE=0
maybe_reset_usage_stats_on_launch
echo "done_flag=\${_C_THRU_STATS_RESET_DONE:-0}"
maybe_reset_usage_stats_on_launch
echo "done_flag2=\${_C_THRU_STATS_RESET_DONE:-0}"
`);
    fs.chmodSync(harness, 0o755);
    r = spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        // Strip any ambient control token so empty-array path is exercised.
        CLAUDE_PROXY_CONTROL_TOKEN: '',
        CLAUDE_PROXY_CONTROL_TOKEN_FILE: path.join(tmpHome, 'no-such-token'),
      }),
    });
    assertEq(r.status, 0, 'real maybe_reset harness exit 0 (empty control token + set -u)');
    assert(/done_flag=1/.test(r.stdout), 'sets _C_THRU_STATS_RESET_DONE=1 after clear');
    assert(/done_flag2=1/.test(r.stdout), 'second call keeps done flag (no double-clear attempt)');
    const afterReal = await httpJson(port, 'GET', '/c-thru/status');
    const afterUsage = (afterReal.json || afterReal.body || {}).usage || {};
    const afterCalls = (afterUsage.by_model && afterUsage.by_model['reset-test-model']
      && afterUsage.by_model['reset-test-model'].calls) || 0;
    assertEq(afterCalls, 0, 'real helper cleared by_model calls');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    try { stub.close(); } catch {}
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }

  process.exit(summary() ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
