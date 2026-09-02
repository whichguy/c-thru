#!/usr/bin/env node
'use strict';
// Hermetic regressions for the hierarchy test's proxy lifecycle and the
// hierarchy e2e timeout contract. No provider credentials or Ollama process.
//
// Run: node test/hierarchy-runtime-contract.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  assert,
  assertEq,
  summary,
  spawnCapture,
  stubBackend,
  writeConfig,
} = require('./helpers');

const REPO_DIR = path.resolve(__dirname, '..');
const HIERARCHY_TEST = path.join(__dirname, 'agent-prompt-hierarchy.test.js');
const HIERARCHY_E2E = path.join(__dirname, 'run-hierarchy-e2e.sh');
const C_THRU = path.join(REPO_DIR, 'tools', 'c-thru');
const HARD_TIMEOUT_SUPERVISOR = path.join(REPO_DIR, 'tools', 'run-with-hard-timeout.js');
const TEST_SUPERVISOR_CAPABILITY = path.join(
  REPO_DIR,
  'tools',
  'test-supervisor-capability.js',
);

function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function portIsClosed(port) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/ping' },
      res => {
        res.resume();
        finish(false);
      },
    );
    req.on('error', () => finish(true));
    req.setTimeout(1000, () => {
      req.destroy();
      finish(true);
    });
  });
}

function hierarchyStubResponse(id, text) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'hierarchy-stub',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function installHierarchyHandler(backend, responseLinesForBody) {
  backend.setHandler((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {}
      const record = backend.requests[backend.requests.length - 1];
      record.body = body;
      record.model_used = body?.model || null;

      const responseLines = responseLinesForBody(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(
        hierarchyStubResponse('msg_hierarchy_stub', responseLines.join('\n')),
      ));
    });
    return true;
  });
}

function installHierarchySuccessHandler(backend) {
  installHierarchyHandler(backend, body => {
    const responseLines = ['TASK_STATUS: COMPLETE'];
    if (body?.model === 'plan-reviewer') {
      responseLines.push('VERDICT: APPROVED');
    } else if (body?.model === 'code-reviewer') {
      responseLines.push('VERDICT: APPROVE');
    }
    return responseLines;
  });
}

async function testManagedHierarchyProxy() {
  console.log('1. hierarchy test owns a dynamic proxy when no proxy is supplied');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-hierarchy-runtime-'));
  let legacyBackend = null;
  let recusalBackend = null;
  let missingCodeVerdictBackend = null;
  let missingPlanVerdictBackend = null;
  let conflictingVerdictBackend = null;
  const backend = await stubBackend();
  installHierarchySuccessHandler(backend);

  try {
    const hierarchyConfig = port => ({
      endpoints: {
        hierarchy_stub: {
          url: `http://127.0.0.1:${port}`,
          format: 'anthropic',
          auth: 'none',
        },
      },
      model_routes: {
        explore: 'hierarchy_stub',
        coder: 'hierarchy_stub',
        tester: 'hierarchy_stub',
        'code-reviewer': 'hierarchy_stub',
        'plan-reviewer': 'hierarchy_stub',
        planner: 'hierarchy_stub',
      },
      llm_mode: 'best-cloud-oss',
    });
    const configPath = writeConfig(tmpDir, hierarchyConfig(backend.port));
    const env = { ...process.env };
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_DIR',
      'CLAUDE_PROFILE_DIR',
      'CLAUDE_PROXY_PORT',
      'C_THRU_AGENT_SENTINEL_SECRET',
      'C_THRU_AGENT_SENTINEL_SECRET_FILE',
      'PROXY_PORT',
    ]) {
      delete env[key];
    }
    Object.assign(env, {
      C_THRU_HIERARCHY_TESTS: '1',
      C_THRU_MODEL_TEST_TIMEOUT_MS: '10000',
      CLAUDE_MODEL_MAP_PATH: configPath,
    });

    const result = await spawnCapture(
      process.execPath,
      [HIERARCHY_TEST],
      { cwd: REPO_DIR, env, timeout: 30000 },
    );
    assertEq(result.status, 0,
      `managed hierarchy run exits 0 (stderr: ${JSON.stringify(result.stderr.slice(-300))})`);
    assert(result.stdout.includes('Hierarchy Test Completed Successfully.'),
      'managed hierarchy run completes all phases');
    assertEq(backend.requests.length, 11, 'all 11 hierarchy requests reached the stub backend');
    assertEq(backend.requests[9]?.body?.model, 'plan-reviewer',
      'plan review phase dispatches to plan-reviewer');
    const firstUserMessage = backend.requests[0]?.body?.messages?.[0]?.content || '';
    assert(firstUserMessage.includes('Use TASK_STATUS for a normal outcome.'),
      'hierarchy requests remind agents to use the current TASK_STATUS schema');
    assert(!firstUserMessage.includes('# Worker contract'),
      'hierarchy requests do not inject the plan-harness worker contract');

    const portMatch = result.stdout.match(/Hierarchy test proxy: 127\.0\.0\.1:(\d+) \(managed\)/);
    assert(!!portMatch, 'managed hierarchy run reports its dynamic proxy port');
    if (portMatch) {
      assert(await portIsClosed(Number(portMatch[1])),
        'managed hierarchy proxy is closed before the test process exits');
    }

    missingCodeVerdictBackend = await stubBackend({
      responseBody: hierarchyStubResponse(
        'msg_hierarchy_missing_code_verdict',
        'TASK_STATUS: COMPLETE',
      ),
    });
    writeConfig(tmpDir, hierarchyConfig(missingCodeVerdictBackend.port));
    const missingCodeVerdictResult = await spawnCapture(
      process.execPath,
      [HIERARCHY_TEST],
      { cwd: REPO_DIR, env, timeout: 30000 },
    );
    assertEq(missingCodeVerdictResult.status, 1,
      'code review without a contract verdict fails the hierarchy');
    assert(/Expected exactly one VERDICT in \{APPROVE, APPROVE_WITH_SUGGESTIONS, REQUEST_CHANGES\}; got none/.test(
      missingCodeVerdictResult.stderr,
    ), 'missing code-review verdict reports the accepted vocabulary');
    assertEq(missingCodeVerdictBackend.requests.length, 6,
      'missing code-review verdict fails at the first review phase');

    missingPlanVerdictBackend = await stubBackend({
      responseBody: hierarchyStubResponse(
        'msg_hierarchy_missing_plan_verdict',
        'TASK_STATUS: COMPLETE\nVERDICT: APPROVE',
      ),
    });
    writeConfig(tmpDir, hierarchyConfig(missingPlanVerdictBackend.port));
    const missingPlanVerdictResult = await spawnCapture(
      process.execPath,
      [HIERARCHY_TEST],
      { cwd: REPO_DIR, env, timeout: 30000 },
    );
    assertEq(missingPlanVerdictResult.status, 1,
      'plan review without a plan verdict fails the hierarchy');
    assert(/Expected exactly one VERDICT in \{APPROVED, NEEDS_REVISION\}; got APPROVE/.test(
      missingPlanVerdictResult.stderr,
    ), 'wrong plan-review verdict vocabulary is rejected');
    assertEq(missingPlanVerdictBackend.requests.length, 10,
      'missing plan verdict fails at the plan-reviewer phase');

    conflictingVerdictBackend = await stubBackend();
    installHierarchyHandler(conflictingVerdictBackend, body => {
      if (body?.model === 'code-reviewer') {
        return [
          'VERDICT: APPROVE',
          'TASK_STATUS: COMPLETE',
          'VERDICT: REQUEST_CHANGES',
        ];
      }
      return ['TASK_STATUS: COMPLETE'];
    });
    writeConfig(tmpDir, hierarchyConfig(conflictingVerdictBackend.port));
    const conflictingVerdictResult = await spawnCapture(
      process.execPath,
      [HIERARCHY_TEST],
      { cwd: REPO_DIR, env, timeout: 30000 },
    );
    assertEq(conflictingVerdictResult.status, 1,
      'multiple contradictory review verdicts fail the hierarchy');
    assert(
      /Expected exactly one VERDICT in \{APPROVE, APPROVE_WITH_SUGGESTIONS, REQUEST_CHANGES\}; got APPROVE, REQUEST_CHANGES/.test(
        conflictingVerdictResult.stderr,
      ),
      'contradictory verdict rejection reports every observed verdict',
    );
    assertEq(conflictingVerdictBackend.requests.length, 6,
      'contradictory verdicts fail at the first review phase');

    legacyBackend = await stubBackend({
      responseBody: {
        id: 'msg_hierarchy_legacy_status',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'STATUS: COMPLETE' }],
        model: 'hierarchy-stub',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    writeConfig(tmpDir, hierarchyConfig(legacyBackend.port));
    const legacyResult = await spawnCapture(
      process.execPath,
      [HIERARCHY_TEST],
      { cwd: REPO_DIR, env, timeout: 30000 },
    );
    assertEq(legacyResult.status, 1,
      'legacy STATUS: COMPLETE cannot pass an actionable hierarchy phase');
    assert(/legacy normal STATUS "COMPLETE" is not accepted/.test(legacyResult.stderr),
      'legacy normal STATUS rejection reports the schema boundary');
    assertEq(legacyBackend.requests.length, 1,
      'legacy normal STATUS is rejected at the first actionable phase');
    const legacyPortMatch = legacyResult.stdout.match(
      /Hierarchy test proxy: 127\.0\.0\.1:(\d+) \(managed\)/,
    );
    assert(!!legacyPortMatch, 'legacy STATUS run reports its managed proxy port');
    if (legacyPortMatch) {
      assert(await portIsClosed(Number(legacyPortMatch[1])),
        'managed hierarchy proxy closes after legacy STATUS rejection');
    }

    recusalBackend = await stubBackend({
      responseBody: {
        id: 'msg_hierarchy_recusal',
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'text',
          text: [
            'STATUS: RECUSE',
            'RECUSAL_REASON: hermetic recusal response',
          ].join('\n'),
        }],
        model: 'hierarchy-stub',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    writeConfig(tmpDir, hierarchyConfig(recusalBackend.port));
    const recusalResult = await spawnCapture(
      process.execPath,
      [HIERARCHY_TEST],
      { cwd: REPO_DIR, env, timeout: 30000 },
    );
    assertEq(recusalResult.status, 1,
      'STATUS: RECUSE cannot pass an actionable hierarchy phase');
    assert(/got STATUS: RECUSE/.test(recusalResult.stderr),
      'actionable recusal rejection identifies the separate recusal path');
    assertEq(recusalBackend.requests.length, 1,
      'recusal is rejected at the first actionable phase');
    const recusalPortMatch = recusalResult.stdout.match(
      /Hierarchy test proxy: 127\.0\.0\.1:(\d+) \(managed\)/,
    );
    assert(!!recusalPortMatch, 'recusal run reports its managed proxy port');
    if (recusalPortMatch) {
      assert(await portIsClosed(Number(recusalPortMatch[1])),
        'managed hierarchy proxy closes after recusal rejection');
    }
  } finally {
    if (conflictingVerdictBackend) await conflictingVerdictBackend.close();
    if (missingPlanVerdictBackend) await missingPlanVerdictBackend.close();
    if (missingCodeVerdictBackend) await missingCodeVerdictBackend.close();
    if (recusalBackend) await recusalBackend.close();
    if (legacyBackend) await legacyBackend.close();
    await backend.close();
    removeTree(tmpDir);
  }
}

async function testHierarchyE2eEnvironment() {
  console.log('\n2. hierarchy e2e exports the one-hour cap and test-owned cleanup');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-hierarchy-e2e-env-'));
  const fixtureTestDir = path.join(fixture, 'test');
  const fixtureToolsDir = path.join(fixture, 'tools');
  fs.mkdirSync(fixtureTestDir);
  fs.mkdirSync(fixtureToolsDir);
  fs.copyFileSync(HIERARCHY_E2E, path.join(fixtureTestDir, 'run-hierarchy-e2e.sh'));
  fs.copyFileSync(HARD_TIMEOUT_SUPERVISOR, path.join(fixtureToolsDir, 'run-with-hard-timeout.js'));
  fs.copyFileSync(
    TEST_SUPERVISOR_CAPABILITY,
    path.join(fixtureToolsDir, 'test-supervisor-capability.js'),
  );
  const fakeCthru = path.join(fixtureToolsDir, 'c-thru');
  fs.writeFileSync(fakeCthru, `#!/usr/bin/env node
'use strict';
const keys = [
  'C_THRU_MODEL_TEST_TIMEOUT_MS',
  'CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS',
  'CLAUDE_PROXY_GEMINI_TIMEOUT_MS',
  'CLAUDE_PROXY_RESPONSES_TIMEOUT_MS',
  'CLAUDE_PROXY_OLLAMA_TIMEOUT_MS',
  'CLAUDE_PROXY_OLLAMA_TTFT_MS',
  'CLAUDE_PROXY_STREAM_STALL_MS',
  'CLAUDE_PROXY_STREAM_WALL_MS',
  'C_THRU_KEEP_PROXY',
];
const captured = Object.fromEntries(keys.map(key => [key, process.env[key]]));
captured.args = process.argv.slice(2);
process.stdout.write('ENV_CAPTURE ' + JSON.stringify(captured) + '\\n');
`);
  fs.chmodSync(fakeCthru, 0o755);

  try {
    const env = { ...process.env };
    delete env.C_THRU_MODEL_TEST_TIMEOUT_MS;
    Object.assign(env, {
      CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS: 'stale',
      CLAUDE_PROXY_GEMINI_TIMEOUT_MS: 'stale',
      CLAUDE_PROXY_RESPONSES_TIMEOUT_MS: 'stale',
      CLAUDE_PROXY_OLLAMA_TIMEOUT_MS: 'stale',
      CLAUDE_PROXY_OLLAMA_TTFT_MS: 'stale',
      CLAUDE_PROXY_STREAM_STALL_MS: 'stale',
      CLAUDE_PROXY_STREAM_WALL_MS: 'stale',
      C_THRU_KEEP_PROXY: '1',
    });
    const result = await spawnCapture(
      'bash',
      [path.join(fixtureTestDir, 'run-hierarchy-e2e.sh')],
      { cwd: fixture, env, timeout: 5000 },
    );
    assertEq(result.status, 0,
      `hierarchy e2e fixture exits 0 (stderr: ${JSON.stringify(result.stderr)})`);
    const match = result.stdout.match(/^ENV_CAPTURE (.+)$/m);
    assert(!!match, 'fixture captured the environment passed to c-thru');
    if (match) {
      const captured = JSON.parse(match[1]);
      const timeoutKeys = [
        'C_THRU_MODEL_TEST_TIMEOUT_MS',
        'CLAUDE_PROXY_ANTHROPIC_TIMEOUT_MS',
        'CLAUDE_PROXY_GEMINI_TIMEOUT_MS',
        'CLAUDE_PROXY_RESPONSES_TIMEOUT_MS',
        'CLAUDE_PROXY_OLLAMA_TIMEOUT_MS',
        'CLAUDE_PROXY_OLLAMA_TTFT_MS',
        'CLAUDE_PROXY_STREAM_STALL_MS',
        'CLAUDE_PROXY_STREAM_WALL_MS',
      ];
      for (const key of timeoutKeys) {
        assertEq(captured[key], '3600000', `${key} receives the one-hour cap`);
      }
      assertEq(captured.C_THRU_KEEP_PROXY, '0', 'hierarchy e2e lets c-thru reap its proxy');
      assertEq(captured.args.join(' '), '--model qwen3:1.7b', 'hierarchy e2e preserves its model invocation');
    }
  } finally {
    removeTree(fixture);
  }
}

async function testLauncherWarmupCap() {
  console.log('\n3. launcher enforces the shared timeout as a wall-clock warm-up deadline');
  const source = fs.readFileSync(C_THRU, 'utf8');
  const functionMatch = source.match(
    /^ollama_model_load_wait_seconds\(\) \{[\s\S]*?^\}$/m,
  );
  assert(!!functionMatch, 'launcher defines the model-load deadline conversion helper');
  assert(
    /max_wait_seconds="\$\(ollama_model_load_wait_seconds\)" \|\| exit 2/.test(source) &&
      /remaining=\$\(\( max_wait_seconds - elapsed \)\)/.test(source) &&
      /probe_timeout=\$\(\( remaining - 1 \)\)/.test(source),
    'active Ollama warm-up uses the validated conversion helper',
  );
  if (!functionMatch) return;

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-model-load-cap-'));
  const probe = path.join(fixture, 'probe.sh');
  fs.writeFileSync(probe, `#!/usr/bin/env bash
${functionMatch[0]}
ollama_model_load_wait_seconds
`);
  fs.chmodSync(probe, 0o755);
  try {
    const defaultEnv = { ...process.env };
    delete defaultEnv.C_THRU_MODEL_TEST_TIMEOUT_MS;
    const defaultResult = await spawnCapture('bash', [probe], { env: defaultEnv, timeout: 3000 });
    assertEq(defaultResult.status, 0, 'default warm-up cap is valid');
    assertEq(defaultResult.stdout, '120', 'default warm-up cap becomes a 120-second deadline');

    const maxResult = await spawnCapture(
      'bash',
      [probe],
      { env: { ...process.env, C_THRU_MODEL_TEST_TIMEOUT_MS: '3600000' }, timeout: 3000 },
    );
    assertEq(maxResult.status, 0, 'one-hour warm-up cap is valid');
    assertEq(maxResult.stdout, '3600', 'one-hour cap becomes a 3,600-second deadline');

    const overCapResult = await spawnCapture(
      'bash',
      [probe],
      { env: { ...process.env, C_THRU_MODEL_TEST_TIMEOUT_MS: '3600001' }, timeout: 3000 },
    );
    assertEq(overCapResult.status, 2, 'warm-up cap above one hour is rejected');
    assert(/integer from 1 to 3600000/.test(overCapResult.stderr),
      'over-cap warm-up reports the accepted one-hour range');

    const invalidResult = await spawnCapture(
      'bash',
      [probe],
      { env: { ...process.env, C_THRU_MODEL_TEST_TIMEOUT_MS: 'invalid' }, timeout: 3000 },
    );
    assertEq(invalidResult.status, 2, 'invalid warm-up cap is rejected');
    assert(/integer from 1 to 3600000/.test(invalidResult.stderr),
      'invalid warm-up cap reports the accepted range');
  } finally {
    removeTree(fixture);
  }
}

async function main() {
  console.log('hierarchy runtime contract tests\n');
  await testManagedHierarchyProxy();
  await testHierarchyE2eEnvironment();
  await testLauncherWarmupCap();
  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
