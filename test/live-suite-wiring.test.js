#!/usr/bin/env node
'use strict';

// Static contract for the live aggregate and checkout-only smoke bootstrap.
// The live calls remain opt-in; this only proves that their gates and secrets
// are wired all the way from scheduled workflow → Makefile → run-all registry.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const routeLive = require('./claude-agent-route-live.test.js');
const { parseAgentContractResult } = require('./helpers');
const {
  AGENT_CONTRACT_CASES,
  AGENT_CONTRACT_MAX_TOKENS,
  FAILURE_RESPONSE_TAIL_CHARS,
  FINAL_BLOCK_RULE_AGENTS,
  STRUCTURED_AGENTS,
  formatContractFailureDiagnostics,
  hasMandatoryFinalBlockRule,
  preflightAgentContracts,
  universalNormalRecusalError,
  validateContractCase,
  validateContractResponseIntegrity,
} = require('./agent-contract-fixtures');

const repo = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');
const makefile = read('Makefile');
const runAll = read('test/run-all.sh');
const workflow = read('.github/workflows/live-suites.yml');
const smoke = read('test/smoke-check.sh');
const livePrereqs = read('test/provider-live-prerequisites.js');
const helpers = read('test/helpers.js');
const hardTimeoutSupervisor = read('tools/run-with-hard-timeout.js');
const supervisorCapability = read('tools/test-supervisor-capability.js');
const openaiLive = read('test/proxy-openai-live-shapes.test.js');
const xaiLive = read('test/proxy-xai-live.test.js');
const headerDocs = read('docs/headers.md');
const agentDelegationFindings = read('docs/planning/agent-delegation-findings.md');
const testAuthoringDocs = read('docs/test-authoring.md');
const coverageAuditDocs = read('docs/test-coverage-audit.md');
const functionalityVerificationDocs = read('docs/functionality-verification.md');
const envVarDocs = read('docs/env-vars.md');
const offloadArtifactFixtures = read('test/offload-artifact-fixtures.js');

function makeTargetBody(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return makefile.match(new RegExp(`^${escaped}:\\n((?:\\t.*\\n)+)`, 'm'))?.[1] || '';
}

function workflowJobBody(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const bodyStart = start + marker.length;
  const remaining = workflow.slice(bodyStart);
  const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return marker + (nextJob < 0 ? remaining : remaining.slice(0, nextJob));
}

const liveChildren = [
  ['cross-provider', 'proxy-cross-provider-parity', 'test/proxy-cross-provider-parity.test.js', process.execPath],
  ['anthropic', 'anthropic-api-coverage-live', 'test/anthropic-api-coverage-live.test.js', process.execPath],
  ['anthropic', 'judge-canary', 'test/judge-canary.test.js', process.execPath],
  ['anthropic', 'agent-selection-llm-judge', 'test/agent-selection-llm-judge.test.js', process.execPath],
  ['agent', 'agent-contract-behavioral', 'test/agent-contract-behavioral.test.js', process.execPath],
  ['agent', 'agent-contract-live', 'test/agent-contract-live.test.js', process.execPath],
  ['agent', 'claude-agent-route-live', 'test/claude-agent-route-live.test.js', process.execPath],
  ['agent', 'agent-offload-coverage', 'test/agent-offload-coverage.js', process.execPath, {}],
  [
    'agent',
    'agent-offload-artifacts',
    'test/agent-offload-coverage.js',
    process.execPath,
    // Suite id for gate-off markers without enabling the lane (ARTIFACTS stays 0).
    { C_THRU_OFFLOAD_SUITE: 'agent-offload-artifacts' },
  ],
  ['gemini', 'proxy-gemini-live-shapes', 'test/proxy-gemini-live-shapes.test.js', process.execPath],
  ['gemini', 'proxy-gemini-live-thinking', 'test/proxy-gemini-live-thinking.test.js', process.execPath],
  ['gemini', 'proxy-gemini-live-e2e', 'test/proxy-gemini-live-e2e.test.sh', '/bin/bash'],
  ['vertex', 'proxy-gemini-live-vertex', 'test/proxy-gemini-live-vertex.test.sh', '/bin/bash'],
  ['openai', 'proxy-openai-live-shapes', 'test/proxy-openai-live-shapes.test.js', process.execPath],
  ['xai', 'proxy-xai-live', 'test/proxy-xai-live.test.js', process.execPath],
].map(([provider, suite, relative, command, env = {}]) => ({
  provider, suite, relative, command, env, source: read(relative),
}));

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

const liveShardTarget = makeTargetBody('test-live-shard');
const liveArtifactsTarget = makeTargetBody('test-live-artifacts');
const liveTarget = makeTargetBody('test-live-all');
check(/\.PHONY:[^\n]*\btest-live-shard\b/.test(makefile),
  'Makefile declares test-live-shard phony');
check(/\bSHARD must be provider or agent\b/.test(liveShardTarget),
  'Makefile test-live-shard rejects a missing or unknown shard');
check((liveShardTarget.match(/\bC_THRU_TEST_TIMEOUT_SECONDS=3300\b/g) || []).length === 2 &&
      !/\bC_THRU_TEST_TIMEOUT_SECONDS=(?:3[4-9][0-9][0-9]|[4-9][0-9]{3,})\b/.test(liveShardTarget),
  'both live shard branches enforce the 3,300-second maximum');
check(/\bC_THRU_TEST_TIMEOUT_SECONDS=3300\b/.test(liveTarget),
  'Makefile test-live-all compatibility aggregate enforces the 3,300-second maximum');
check(
  /\.PHONY:[^\n]*\btest-live-artifacts\b/.test(makefile) &&
    /\bC_THRU_TEST_TIMEOUT_SECONDS=3300\b/.test(liveArtifactsTarget) &&
    /\bC_THRU_LIVE_SHARD=agent\b/.test(liveArtifactsTarget) &&
    /\bC_THRU_STRICT_LIVE_PROVIDERS=1\b/.test(liveArtifactsTarget) &&
    /\bC_THRU_OFFLOAD=1\b/.test(liveArtifactsTarget) &&
    /\bC_THRU_OFFLOAD_ARTIFACTS=1\b/.test(liveArtifactsTarget),
  'manual artifact lane is strict, agent-only, and capped at 3,300 seconds',
);
check(
  /\bCLAUDE_LLM_MODE=best-cloud\b/.test(liveArtifactsTarget) &&
    /\bCLAUDE_LLM_PROFILE=32gb\b/.test(liveArtifactsTarget) &&
    !/\bC_THRU_OFFLOAD_GATE=1\b/.test(liveArtifactsTarget),
  'artifact lane pins its multimodal route while leaving stochastic quality advisory',
);

const providerBranchStart = liveShardTarget.indexOf('provider)');
const agentBranchStart = liveShardTarget.indexOf('agent)');
const invalidBranchStart = liveShardTarget.indexOf('*)');
const providerBranch = liveShardTarget.slice(providerBranchStart, agentBranchStart);
const agentBranch = liveShardTarget.slice(agentBranchStart, invalidBranchStart);
const providerGates = [
  'C_THRU_LIVE_ANTHROPIC',
  'C_THRU_LIVE_GEMINI',
  'C_THRU_LIVE_OPENAI',
  'C_THRU_LIVE_XAI',
  'C_THRU_LIVE_PARITY',
];
const agentGates = [
  'C_THRU_BEHAVIORAL_TESTS',
  'C_THRU_LIVE_AGENT_TESTS',
  'C_THRU_LIVE_CLAUDE_AGENT_ROUTE',
  'C_THRU_OFFLOAD',
  'C_THRU_LIVE_SELECTION',
];
check(
  providerBranchStart >= 0 &&
    agentBranchStart > providerBranchStart &&
    invalidBranchStart > agentBranchStart &&
    /\bC_THRU_LIVE_SHARD=provider\b/.test(providerBranch) &&
    providerGates.every(gate => providerBranch.includes(`${gate}=1`)) &&
    agentGates.every(gate => !providerBranch.includes(`${gate}=1`)),
  'provider shard exports only provider live gates',
);
check(
  /\bC_THRU_LIVE_SHARD=agent\b/.test(agentBranch) &&
    agentGates.every(gate => agentBranch.includes(`${gate}=1`)) &&
    providerGates.every(gate => !agentBranch.includes(`${gate}=1`)),
  'agent shard exports only agent live gates',
);
check(
  !/\bC_THRU_OFFLOAD_GATE=1\b/.test(liveShardTarget) &&
    !/\bC_THRU_OFFLOAD_GATE=1\b/.test(liveTarget),
  'live entrypoints keep single-run offload quality advisory unless explicitly requested',
);
check(
  !/\bC_THRU_HIERARCHY_TESTS=1\b/.test(agentBranch) &&
    !/\bC_THRU_E2E=1\b/.test(agentBranch),
  'agent live shard does not advertise ordinary suites suppressed by live-shard selection',
);
check((liveShardTarget.match(/\bC_THRU_STRICT_LIVE_PROVIDERS=1\b/g) || []).length === 2,
  'both live shards make missing requested coverage fatal');

for (const shard of ['', 'unknown']) {
  const args = ['-s', 'test-live-shard'];
  if (shard) args.push(`SHARD=${shard}`);
  const invalidShard = spawnSync('make', args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30000,
  });
  check(
    invalidShard.status === 2 &&
      `${invalidShard.stdout || ''}\n${invalidShard.stderr || ''}`.includes(
        'SHARD must be provider or agent',
      ),
    `make test-live-shard rejects ${shard || 'a missing'} SHARD before running tests`,
  );
}

check(/\bC_THRU_LIVE_XAI=1\b/.test(liveTarget),
  'Makefile test-live-all exports C_THRU_LIVE_XAI=1');
check(/\bC_THRU_LIVE_CLAUDE_AGENT_ROUTE=1\b/.test(liveTarget),
  'Makefile test-live-all exports C_THRU_LIVE_CLAUDE_AGENT_ROUTE=1');
check(/\bC_THRU_STRICT_LIVE_PROVIDERS=1\b/.test(liveTarget),
  'Makefile test-live-all makes requested live-provider blocks fatal');
check(/if \[\[ "\$\{C_THRU_LIVE_XAI:-0\}" == "1" \]\]; then[\s\S]*?run_live_suite "xai" "proxy-xai-live"/.test(runAll),
  'run-all executes proxy-xai-live through the provider-aware runner');
check(/if \[\[ "\$\{C_THRU_LIVE_CLAUDE_AGENT_ROUTE:-0\}" == "1" \]\]; then[\s\S]*?run_live_suite "agent" "claude-agent-route-live"/.test(runAll),
  'run-all executes the real Claude Agent route proof through the provider-aware runner');
check(/skip_suite "proxy-xai-live \(set C_THRU_LIVE_XAI=1 \+ XAI_API_KEY to enable\)"/.test(runAll),
  'run-all records the xAI live suite as skipped when its gate is off');
check(/skip_suite "claude-agent-route-live \(set C_THRU_LIVE_CLAUDE_AGENT_ROUTE=1 to enable\)"/.test(runAll),
  'run-all records the real Claude Agent route proof as skipped when its gate is off');
check(/run_live_suite\(\)[\s\S]*?status=blocked[\s\S]*?STRICT_LIVE_PROVIDERS/.test(runAll),
  'provider-aware runner distinguishes blocked outcomes and fails them in strict mode');
check(/block_live_suite "openai" "proxy-openai-live-shapes"[\s\S]*?missing_OPENAI_API_KEY/.test(runAll),
  'an explicitly requested OpenAI suite is blocked, not passed, without credentials');
check(/LIVE_OUTCOME_PREFIX = 'C_THRU_LIVE_OUTCOME'/.test(livePrereqs) &&
      /status.*passed.*skipped.*blocked.*failed/s.test(livePrereqs),
  'provider prerequisite helper defines the four-state machine-readable protocol');
check(/emitLiveOutcome\('openai', LIVE_SUITE, 'blocked', providerUnavailable\)/.test(openaiLive),
  'OpenAI exact quota block emits a blocked outcome');
check(/emitLiveOutcome\('xai', LIVE_SUITE, 'blocked', billingBlock\)/.test(xaiLive),
  'xAI exact credit block emits a blocked outcome');
check(
  /dispatchOpenAIBackend/.test(headerDocs) &&
    /x-c-thru-agent-identity/.test(headerDocs) &&
    !/501 stub|returns 501 until an OpenAI translator|claude-proxy:~[0-9]+/.test(headerDocs),
  'header reference documents current OpenAI, agent-identity, and trigger surfaces',
);
check(
  /requires loopback \+ a nonempty\s+`x-claude-code-agent-id`/.test(agentDelegationFindings) &&
    /Historical TL;DR \(pre-fix/.test(agentDelegationFindings) &&
    /Historical proposed interim fix/.test(agentDelegationFindings) &&
    !/\*\*c-thru today\*\*/.test(agentDelegationFindings),
  'agent delegation record separates the current agent-ID trust gate from historical failures',
);

check(/missing_outcome_marker_exit_\$\{ec\}/.test(runAll) &&
      /multiple_outcome_markers_\$\{outcome_count\}_exit_\$\{ec\}/.test(runAll) &&
      /invalid_or_mismatched_outcome_marker_exit_\$\{ec\}/.test(runAll) &&
      /failed_outcome_with_exit_0/.test(runAll),
  'provider-aware runner rejects missing, duplicate, mismatched, and exit-incoherent markers');

const gateOffEnv = {
  ...process.env,
  C_THRU_LIVE_PARITY: '0',
  C_THRU_LIVE_ANTHROPIC: '0',
  C_THRU_LIVE_SELECTION: '0',
  C_THRU_BEHAVIORAL_TESTS: '0',
  C_THRU_LIVE_AGENT_TESTS: '0',
  C_THRU_LIVE_CLAUDE_AGENT_ROUTE: '0',
  C_THRU_OFFLOAD: '0',
  C_THRU_OFFLOAD_ARTIFACTS: '0',
  C_THRU_LIVE_GEMINI: '0',
  C_THRU_LIVE_OPENAI: '0',
  C_THRU_LIVE_XAI: '0',
};
for (const key of [
  'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_TOKEN',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_REGION', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'XAI_API_KEY',
]) delete gateOffEnv[key];

for (const child of liveChildren) {
  check(runAll.includes(`run_live_suite "${child.provider}" "${child.suite}"`),
    `run-all registers ${child.suite} with its exact provider identity`);
  check(/C_THRU_LIVE_OUTCOME|emitLiveOutcome/.test(child.source),
    `${child.suite} contains the terminal outcome protocol`);

  // Gate-off execution is hermetic and must still prove the one-marker child
  // contract. Keep this protocol self-test narrow; no provider call is made.
  const result = spawnSync(child.command, [path.join(repo, child.relative)], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...gateOffEnv, ...child.env },
    timeout: 30000,
  });
  const markers = (result.stdout || '').split(/\r?\n/)
    .filter(line => line.startsWith('C_THRU_LIVE_OUTCOME|'));
  const expected =
    `C_THRU_LIVE_OUTCOME|provider=${child.provider}|suite=${child.suite}|status=skipped|`;
  check(result.status === 0 && markers.length === 1 && markers[0].startsWith(expected),
    `${child.suite} gate-off path exits 0 with exactly one matching skipped marker`);
}

const missingAnthropicKey = spawnSync(
  process.execPath,
  [path.join(repo, 'test/anthropic-api-coverage-live.test.js')],
  {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...gateOffEnv,
      C_THRU_LIVE_ANTHROPIC: '1',
    },
    timeout: 30000,
  },
);
const missingAnthropicMarkers = (missingAnthropicKey.stdout || '').split(/\r?\n/)
  .filter(line => line.startsWith('C_THRU_LIVE_OUTCOME|'));
check(
  missingAnthropicKey.status === 2 &&
    missingAnthropicMarkers.length === 1 &&
    missingAnthropicMarkers[0] ===
      'C_THRU_LIVE_OUTCOME|provider=anthropic|suite=anthropic-api-coverage-live|' +
      'status=blocked|reason=missing_ANTHROPIC_API_KEY',
  'explicit Anthropic live request without credentials exits 2 with one blocked marker',
);
const missingAnthropicMakeEnv = { ...gateOffEnv };
delete missingAnthropicMakeEnv.ANTHROPIC_AUTH_TOKEN;
delete missingAnthropicMakeEnv.CLAUDE_CODE_OAUTH_TOKEN;
const missingAnthropicMake = spawnSync('make', ['-s', 'test-live'], {
  cwd: repo,
  encoding: 'utf8',
  env: missingAnthropicMakeEnv,
  timeout: 30000,
});
check(
  missingAnthropicMake.status !== 0 &&
    `${missingAnthropicMake.stdout || ''}\n${missingAnthropicMake.stderr || ''}`.includes(
      'status=blocked|reason=missing_ANTHROPIC_API_KEY',
    ),
  'make test-live cannot paint a requested missing-credential suite green',
);

const agentGateBySuite = new Map([
  ['agent-contract-behavioral', 'C_THRU_BEHAVIORAL_TESTS'],
  ['agent-contract-live', 'C_THRU_LIVE_AGENT_TESTS'],
  ['claude-agent-route-live', 'C_THRU_LIVE_CLAUDE_AGENT_ROUTE'],
  ['agent-offload-coverage', 'C_THRU_OFFLOAD'],
  ['agent-offload-artifacts', 'C_THRU_OFFLOAD'],
]);
for (const [suite, gate] of agentGateBySuite) {
  const child = liveChildren.find(entry => entry.suite === suite);
  const result = spawnSync(child.command, [path.join(repo, child.relative)], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...gateOffEnv,
      ...child.env,
      [gate]: '1',
      CLAUDE_BIN: '/bin/true',
      C_THRU_MODEL_TEST_TIMEOUT_MS: 'invalid',
    },
    timeout: 30000,
  });
  const markers = (result.stdout || '').split(/\r?\n/)
    .filter(line => line.startsWith('C_THRU_LIVE_OUTCOME|'));
  const expected =
    `C_THRU_LIVE_OUTCOME|provider=agent|suite=${suite}|status=failed|`;
  check(result.status === 1 && markers.length === 1 && markers[0].startsWith(expected),
    `${suite} fatal prerequisite path exits 1 with exactly one failed marker`);
}

for (const suite of ['agent-contract-behavioral', 'agent-contract-live']) {
  const child = liveChildren.find(entry => entry.suite === suite);
  check(/withModelTestProxy/.test(child.source) && /modelTestTimeoutMs/.test(child.source),
    `${suite} owns a managed proxy with the shared bounded model timeout`);
  check(/AGENT_CONTRACT_MAX_TOKENS/.test(child.source),
    `${suite} uses the shared ${AGENT_CONTRACT_MAX_TOKENS}-token response budget`);
  check(/configPath: MODEL_MAP/.test(child.source) && /env: managedProxyEnv\(\)/.test(child.source),
    `${suite} passes its selected model map and credentials into the managed proxy`);
  check(
    /preflightAgentContracts\(\{[\s\S]*?preflight ok[\s\S]*?await withModelTestProxy\(\{/.test(
      child.source,
    ),
    `${suite} reports a successful roster preflight before starting its provider proxy`,
  );
}
check(/MAX_MODEL_TEST_TIMEOUT_MS = 60 \* 60 \* 1000/.test(helpers) &&
      /DEFAULT_MODEL_TEST_TIMEOUT_MS = MAX_MODEL_TEST_TIMEOUT_MS/.test(helpers) &&
      /function withModelTestProxy\([\s\S]*?modelTestProxyEnv\(\)/.test(helpers),
  'managed model-test proxies propagate the one-hour hard cap to internal watchdogs');
check(
  /ARTIFACT_FIXTURE_IDS/.test(offloadArtifactFixtures) &&
    /materializeOffloadArtifactFixture/.test(offloadArtifactFixtures) &&
    /C_THRU_OFFLOAD_ARTIFACTS/.test(read('test/agent-offload-coverage.js')),
  'artifact live suite is backed by the deterministic six-fixture generator',
);
check(
  /test-supervisor-capability\.js/.test(runAll) &&
    /run_test_command\(\)/.test(runAll) &&
    /out=\$\(run_test_command "\$@" 2>&1\)/.test(runAll) &&
    /hard-timeout-supervisor\.test\.js/.test(runAll),
  'run-all and every registered child suite use the hard wall-clock supervisor',
);
check(
    /detached: true/.test(hardTimeoutSupervisor) &&
    /process\.kill\(-child\.pid, signal\)/.test(hardTimeoutSupervisor) &&
    /signalGroup\('SIGKILL'\)/.test(hardTimeoutSupervisor) &&
    /childEnv\.C_THRU_TEST_SUPERVISOR_PID = String\(process\.pid\)/.test(
      hardTimeoutSupervisor,
    ) &&
    hardTimeoutSupervisor.indexOf('scheduleAt(termAt') <
      hardTimeoutSupervisor.indexOf('child = spawn(process.execPath') &&
    /runBootstrapWorker/.test(hardTimeoutSupervisor) &&
    /\[CAPABILITY_FD_ENV\]: String\(CAPABILITY_CHILD_FD\)/.test(hardTimeoutSupervisor) &&
    /childStdio\[CAPABILITY_CHILD_FD\] = capability\.fd/.test(hardTimeoutSupervisor) &&
    /value > MAX_TIMEOUT_SECONDS/.test(hardTimeoutSupervisor),
  'hard timeout supervisor owns bootstrap and test process groups, arms before setup, escalates, and rejects caps above one hour',
);
check(
  /supervisorPid !== claimantParentPid/.test(supervisorCapability) &&
    /stats\.nlink !== 0/.test(supervisorCapability) &&
    /stats\.size !== CAPABILITY_BYTES/.test(supervisorCapability) &&
    supervisorCapability.includes('/^[a-f0-9]{64}$/') &&
    /fs\.readSync\(/.test(supervisorCapability),
  'supervision requires a direct-parent, unlinked, exact one-shot nonce descriptor',
);
check(
  (workflow.match(/^\s*timeout-minutes:\s*70\s*$/gm) || []).length === 3 &&
    !/^\s*timeout-minutes:\s*60\s*$/m.test(workflow),
  'all scheduled jobs reserve a 70-minute lifecycle around the 3,300-second test command',
);

const failureLogHelpersStart = runAll.indexOf('failure_log_root() {');
const failureLogHelpersEnd = runAll.indexOf('# End failure-log helpers.');
const failureLogHelpers =
  failureLogHelpersStart >= 0 && failureLogHelpersEnd > failureLogHelpersStart
    ? runAll.slice(failureLogHelpersStart, failureLogHelpersEnd)
    : '';
check(
  failureLogHelpers &&
    /mktemp -d/.test(failureLogHelpers) &&
    /mkdir -m 700/.test(failureLogHelpers) &&
    /chmod 600/.test(failureLogHelpers) &&
    /linkSync/.test(failureLogHelpers),
  'run-all allocates private exclusive directories and atomically publishes private logs',
);

if (failureLogHelpers) {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-failure-log-wiring-'));
  const probeEnv = { ...process.env, TMPDIR: probeRoot };
  delete probeEnv.C_THRU_TEST_FAILURE_LOG_DIR;
  const runFailureLogProbe = (command, env = probeEnv) => spawnSync(
    '/bin/bash',
    ['-c', `set -uo pipefail\n${failureLogHelpers}\n${command}`],
    {
      cwd: repo,
      encoding: 'utf8',
      env,
      timeout: 30000,
    },
  );
  const allocatedPath = result =>
    (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
  const mode = target => fs.statSync(target).mode & 0o777;

  try {
    const firstAllocation = runFailureLogProbe('allocate_failure_log_dir');
    const secondAllocation = runFailureLogProbe('allocate_failure_log_dir');
    const firstDir = allocatedPath(firstAllocation);
    const secondDir = allocatedPath(secondAllocation);
    check(
      firstAllocation.status === 0 &&
        secondAllocation.status === 0 &&
        firstDir !== secondDir &&
        path.dirname(firstDir) === fs.realpathSync(probeRoot) &&
        path.dirname(secondDir) === fs.realpathSync(probeRoot) &&
        mode(firstDir) === 0o700 &&
        mode(secondDir) === 0o700,
      'default failure-log allocation is unique and 0700 under the resolved TMPDIR',
    );

    const untrustedRoot = path.join(probeRoot, 'shared-nonsticky');
    fs.mkdirSync(untrustedRoot);
    fs.chmodSync(untrustedRoot, 0o777);
    const untrustedAllocation = runFailureLogProbe('allocate_failure_log_dir', {
      ...probeEnv,
      TMPDIR: untrustedRoot,
    });
    check(
      untrustedAllocation.status !== 0 && fs.readdirSync(untrustedRoot).length === 0,
      'failure-log allocation rejects a shared-writable non-sticky TMPDIR',
    );

    const exactDir = path.join(probeRoot, 'c-thru-runall-exact-probe');
    const exactAllocation = runFailureLogProbe('allocate_failure_log_dir', {
      ...probeEnv,
      C_THRU_TEST_FAILURE_LOG_DIR: exactDir,
    });
    check(
      exactAllocation.status === 0 &&
        allocatedPath(exactAllocation) === exactDir &&
        mode(exactDir) === 0o700,
      'an exact non-existing CI failure-log leaf is created once with mode 0700',
    );

    const precreatedDir = path.join(probeRoot, 'c-thru-runall-precreated-probe');
    fs.mkdirSync(precreatedDir, { mode: 0o700 });
    const precreatedAllocation = runFailureLogProbe('allocate_failure_log_dir', {
      ...probeEnv,
      C_THRU_TEST_FAILURE_LOG_DIR: precreatedDir,
    });
    check(
      precreatedAllocation.status !== 0 && fs.statSync(precreatedDir).isDirectory(),
      'failure-log allocation refuses a precreated directory instead of reusing it',
    );

    const symlinkTargetDir = path.join(probeRoot, 'symlink-target');
    const symlinkDir = path.join(probeRoot, 'c-thru-runall-symlink-probe');
    fs.mkdirSync(symlinkTargetDir, { mode: 0o700 });
    fs.symlinkSync(symlinkTargetDir, symlinkDir, 'dir');
    const symlinkAllocation = runFailureLogProbe('allocate_failure_log_dir', {
      ...probeEnv,
      C_THRU_TEST_FAILURE_LOG_DIR: symlinkDir,
    });
    check(
      symlinkAllocation.status !== 0 &&
        fs.lstatSync(symlinkDir).isSymbolicLink() &&
        fs.readdirSync(symlinkTargetDir).length === 0,
      'failure-log allocation refuses a precreated symlink without touching its target',
    );

    const aliasedParent = path.join(probeRoot, 'parent-alias');
    fs.symlinkSync(probeRoot, aliasedParent, 'dir');
    const aliasedLeaf = path.join(aliasedParent, 'c-thru-runall-aliased-parent');
    const aliasedAllocation = runFailureLogProbe('allocate_failure_log_dir', {
      ...probeEnv,
      C_THRU_TEST_FAILURE_LOG_DIR: aliasedLeaf,
    });
    check(
      aliasedAllocation.status !== 0 &&
        !fs.existsSync(path.join(probeRoot, 'c-thru-runall-aliased-parent')),
      'exact-path allocation rejects an alternate symlink alias to TMPDIR',
    );

    const privateWrite = runFailureLogProbe(
      'FAIL_LOG_DIR="$C_THRU_TEST_FAILURE_LOG_DIR"\n' +
        'save_suite_output "probe suite" "SECRET_CANARY raw diagnostic"',
      {
        ...probeEnv,
        C_THRU_TEST_FAILURE_LOG_DIR: exactDir,
      },
    );
    const privateLogName = fs.readdirSync(exactDir)
      .find(name => /^probe-suite-[A-Za-z0-9]+\.log$/.test(name));
    const privateLog = privateLogName ? path.join(exactDir, privateLogName) : '';
    check(
      privateWrite.status === 0 &&
        privateLog &&
        fs.readFileSync(privateLog, 'utf8') === 'SECRET_CANARY raw diagnostic\n' &&
        mode(privateLog) === 0o600,
      'failure output is stored verbatim in a private 0600 log',
    );

    const precreatedLog = path.join(exactDir, 'precreated-PRECREATED.log');
    fs.writeFileSync(precreatedLog, 'do not replace\n', { mode: 0o600 });
    const precreatedWrite = runFailureLogProbe(
      'FAIL_LOG_DIR="$C_THRU_TEST_FAILURE_LOG_DIR"\n' +
        'mktemp() {\n' +
        '  local forced="$FAIL_LOG_DIR/.pending.PRECREATED"\n' +
        '  (umask 077; set -o noclobber; : > "$forced") || return 1\n' +
        '  printf "%s\\n" "$forced"\n' +
        '}\n' +
        'save_suite_output "precreated" "attacker-controlled overwrite"',
      {
        ...probeEnv,
        C_THRU_TEST_FAILURE_LOG_DIR: exactDir,
      },
    );
    check(
      precreatedWrite.status !== 0 &&
        fs.readFileSync(precreatedLog, 'utf8') === 'do not replace\n',
      'exclusive log publication refuses a precreated regular file',
    );

    const symlinkVictim = path.join(probeRoot, 'symlink-victim.log');
    const symlinkLog = path.join(exactDir, 'symlink-SYMLINK.log');
    fs.writeFileSync(symlinkVictim, 'victim stays intact\n', { mode: 0o600 });
    fs.symlinkSync(symlinkVictim, symlinkLog);
    const symlinkWrite = runFailureLogProbe(
      'FAIL_LOG_DIR="$C_THRU_TEST_FAILURE_LOG_DIR"\n' +
        'mktemp() {\n' +
        '  local forced="$FAIL_LOG_DIR/.pending.SYMLINK"\n' +
        '  (umask 077; set -o noclobber; : > "$forced") || return 1\n' +
        '  printf "%s\\n" "$forced"\n' +
        '}\n' +
        'save_suite_output "symlink" "must not follow"',
      {
        ...probeEnv,
        C_THRU_TEST_FAILURE_LOG_DIR: exactDir,
      },
    );
    check(
      symlinkWrite.status !== 0 &&
        fs.lstatSync(symlinkLog).isSymbolicLink() &&
        fs.readFileSync(symlinkVictim, 'utf8') === 'victim stays intact\n',
      'exclusive log publication refuses a symlink without modifying its target',
    );
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

const directlyRunnableModelTests = [
  'test/agent-contract-behavioral.test.js',
  'test/agent-contract-live.test.js',
  'test/agent-prompt-hierarchy.test.js',
  'test/agent-prompt-unit.js',
  'test/agent-offload-coverage.js',
  'test/agent-selection-llm-judge.test.js',
  'test/claude-agent-route-live.test.js',
  'test/anthropic-api-coverage-live.test.js',
  'test/judge-canary.test.js',
  'test/proxy-cross-provider-parity.test.js',
  'test/proxy-gemini-live-shapes.test.js',
  'test/proxy-gemini-live-thinking.test.js',
  'test/proxy-openai-live-shapes.test.js',
  'test/proxy-xai-live.test.js',
  'test/proxy-e2e.test.js',
];
for (const relative of directlyRunnableModelTests) {
  check(/ensureModelTestSupervisor/.test(read(relative)),
    `${relative} self-supervises direct model-backed execution`);
}
for (const relative of [
  'test/agent-scenarios-e2e.sh',
  'test/run-hierarchy-e2e.sh',
  'test/proxy-gemini-live-e2e.test.sh',
  'test/proxy-gemini-live-vertex.test.sh',
]) {
  const source = read(relative);
  check(
    /test-supervisor-capability\.js" --verify-shell-child/.test(source) &&
      /tools\/run-with-hard-timeout\.js/.test(source),
    `${relative} authenticates then self-supervises direct shell execution`,
  );
}

for (const relative of [
  'test/agent-scenarios-e2e.sh',
  'test/proxy-gemini-live-e2e.test.sh',
  'test/proxy-gemini-live-vertex.test.sh',
]) {
  const source = read(relative);
  check(
    /\$\{#MODEL_TEST_TIMEOUT_MS\} > 7/.test(source) &&
      /\$\{#[A-Z0-9_]*TIMEOUT_SECONDS\} > 4/.test(source),
    `${relative} rejects oversized numeric timeout strings before Bash arithmetic`,
  );
}

for (const suite of ['proxy-gemini-live-e2e', 'proxy-gemini-live-vertex']) {
  const child = liveChildren.find(entry => entry.suite === suite);
  check(
    /export C_THRU_KEEP_PROXY=0/.test(child.source) &&
      /mktemp -d "\$ARTIFACT_PARENT\/c-thru-/.test(child.source) &&
      !/pgrep -f claude-proxy/.test(child.source) &&
      !/kill -9 "\$pid"/.test(child.source),
    `${suite} uses launcher-owned cleanup and collision-free artifacts without killing peer proxies`,
  );
}

// Agent contract preflight and parser checks are hermetic. They intentionally
// run in the default suite so roster/schema regressions fail before any opt-in
// provider test can start.
{
  const config = JSON.parse(read('config/model-map.json'));
  let preflight = null;
  let preflightError = null;
  try {
    preflight = preflightAgentContracts({
      agentsDir: path.join(repo, 'agents'),
      modelMapPath: path.join(repo, 'config', 'model-map.json'),
      cases: AGENT_CONTRACT_CASES,
      requiredCaseAgents: STRUCTURED_AGENTS,
      requiredRecusalCaseAgents: STRUCTURED_AGENTS,
      suiteName: 'live-suite-wiring',
    });
  } catch (error) {
    preflightError = error;
  }
  check(!preflightError,
    `current agent contract roster passes preflight${preflightError ? `: ${preflightError.message}` : ''}`);
  check(preflight?.structuredAgents.length === STRUCTURED_AGENTS.length,
    `current fleet has exactly ${STRUCTURED_AGENTS.length} structured agents (got ${preflight?.structuredAgents.length})`);
  check(
    preflight?.structuredAgents.every(
      agent => preflight.capabilityByAgent[agent] === config.agent_to_capability[agent],
    ),
    'structured capabilities are derived from config agent_to_capability',
  );

  const normalCases = AGENT_CONTRACT_CASES.filter(entry => entry.scenario === 'normal');
  const recusalCases = AGENT_CONTRACT_CASES.filter(entry => entry.scenario === 'recusal');
  check(
    normalCases.length === 14 &&
      normalCases.every(entry => entry.expectedContract === 'task-status') &&
      new Set(normalCases.map(entry => entry.agent)).size === 14,
    'all 14 actionable agent cases uniquely require TASK_STATUS',
  );
  check(
    recusalCases.length === 15 &&
      new Set(recusalCases.map(entry => entry.agent)).size === 14 &&
      STRUCTURED_AGENTS.every(
        agent => recusalCases.some(entry => entry.agent === agent),
      ) &&
      recusalCases.filter(entry => entry.agent === 'plan-scheduler').length === 2 &&
      recusalCases.some(
        entry => entry.caseId === 'plan-scheduler-missing-skill' &&
          entry.recusalResponsePatterns?.some(
            pattern => pattern.test('INSTALL: /plugin install planning-suite@claude-craft'),
          ),
      ),
    'all 14 structured agents have live recusal coverage and scheduler covers both documented boundaries',
  );
  check(
    FINAL_BLOCK_RULE_AGENTS.every(agent =>
      hasMandatoryFinalBlockRule(read(`agents/${agent}.md`))),
    'previously noncompliant live agents make TASK_STATUS final-block salience explicit',
  );
  check(
    !hasMandatoryFinalBlockRule([
      'Emit STATUS: RECUSE at a documented boundary.',
      'TASK_STATUS: COMPLETE | PARTIAL | FAILED',
    ].join('\n')),
    'a schema declaration alone cannot satisfy the mandatory final-block salience rule',
  );
}

{
  for (const status of ['COMPLETE', 'PARTIAL', 'FAILED']) {
    const result = parseAgentContractResult(`TASK_STATUS: ${status}`);
    check(result.valid && result.kind === 'task' && result.status === status,
      `agent contract parser accepts TASK_STATUS: ${status}`);
  }

  const canonicalRecusal = parseAgentContractResult([
    'STATUS: RECUSE',
    'RECUSAL_REASON: plan_dir was not provided',
  ].join('\n'));
  check(
    canonicalRecusal.valid &&
      canonicalRecusal.kind === 'recusal' &&
      canonicalRecusal.recusalReason === 'plan_dir was not provided',
    'agent contract parser accepts separate STATUS: RECUSE with RECUSAL_REASON',
  );
  const conciseRecusal = parseAgentContractResult([
    'STATUS: RECUSE',
    'REASON: current.md is absent under plan_dir',
  ].join('\n'));
  check(conciseRecusal.valid && conciseRecusal.kind === 'recusal',
    'agent contract parser accepts the current plan-scheduler REASON field');
  const installRecusal = parseAgentContractResult([
    'STATUS: RECUSE',
    'INSTALL: /plugin install planning-suite@claude-craft',
    'REASON: planning-suite plugin required — schedule-plan-tasks skill not found',
  ].join('\n'));
  check(
    installRecusal.valid &&
      installRecusal.kind === 'recusal' &&
      installRecusal.fields.INSTALL === '/plugin install planning-suite@claude-craft',
    'agent contract parser accepts the documented scheduler INSTALL field',
  );
  check(!parseAgentContractResult('STATUS: RECUSE').valid,
    'agent contract parser rejects recusal without a reason');
  check(!parseAgentContractResult('STATUS: COMPLETE').valid,
    'agent contract parser rejects legacy normal STATUS');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'STATUS: RECUSE',
    'RECUSAL_REASON: contradictory schemas',
  ].join('\n')).valid,
  'agent contract parser rejects mixed normal and recusal schemas');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'RECUSAL_REASON: stray recusal field',
  ].join('\n')).valid,
  'agent contract parser keeps normal and recusal fields separate');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'This prose appears after the claimed final contract block.',
  ].join('\n')).valid,
  'agent contract parser rejects trailing prose after TASK_STATUS');
  check(!parseAgentContractResult([
    'STATUS: RECUSE',
    'RECUSAL_REASON: plan_dir was not provided',
    'This prose appears after the claimed final recusal block.',
  ].join('\n')).valid,
  'agent contract parser rejects trailing prose after recusal');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    '- trailing prose',
  ].join('\n')).valid,
  'agent contract parser rejects an unattached bullet after TASK_STATUS');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    '  indented trailing prose',
  ].join('\n')).valid,
  'agent contract parser rejects unattached indented prose after TASK_STATUS');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'SURPRISE: trailing prose',
  ].join('\n')).valid,
  'agent contract parser rejects undeclared fields after TASK_STATUS');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    '  STATUS: RECUSE',
    'REASON: hidden second block',
  ].join('\n')).valid,
  'agent contract parser rejects an indented second status marker');
  check(parseAgentContractResult([
    'Analysis appears before the final contract.',
    'TASK_STATUS: COMPLETE',
    'ATTEMPTED: mapped the requested path',
    'COMPLETED:',
    '  - identified the caller',
  ].join('\n')).valid,
  'agent contract parser accepts prose before a structured final block');
  check(parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'VERDICT: REQUEST_CHANGES',
    'COMPLETED:',
    '  - one critical issue',
  ].join('\n')).valid,
  'agent contract parser accepts the declared reviewer VERDICT field');
  check(parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'UNBLOCKED_TASKS:',
    'Task("Run focused tests", subagent_type="tester")',
  ].join('\n')).valid,
  'agent contract parser accepts the declared Task handoff under UNBLOCKED_TASKS');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'COMPLETED: implementation finished',
    'Task("Unattached trailing call", subagent_type="tester")',
  ].join('\n')).valid,
  'an unattached Task call cannot hide after another contract field');
  check(parseAgentContractResult([
    '```text',
    'TASK_STATUS: COMPLETE',
    'ATTEMPTED: mapped the requested path',
    'COMPLETED:',
    '  - identified the caller',
    '```',
  ].join('\n')).valid,
  'agent contract parser accepts a sole closing Markdown fence after the final block');
  check(!parseAgentContractResult([
    'TASK_STATUS: COMPLETE',
    'ATTEMPTED: mapped the requested path',
    '```',
    'trailing prose',
  ].join('\n')).valid,
  'a Markdown fence cannot hide prose after the final block');

  const recusalCase = AGENT_CONTRACT_CASES.find(
    entry => entry.caseId === 'plan-scheduler-missing-plan-dir',
  );
  check(validateContractCase(recusalCase, canonicalRecusal).length === 0,
    'plan-scheduler recusal fixture accepts a reason naming plan_dir');
  const wrongReason = parseAgentContractResult([
    'STATUS: RECUSE',
    'RECUSAL_REASON: generic model preference',
  ].join('\n'));
  check(validateContractCase(recusalCase, wrongReason).some(error => /did not match/.test(error)),
    'plan-scheduler recusal fixture rejects a reason outside its documented boundary');
  const missingSkillCase = AGENT_CONTRACT_CASES.find(
    entry => entry.caseId === 'plan-scheduler-missing-skill',
  );
  check(
    validateContractCase(
      missingSkillCase,
      installRecusal,
      [
        'STATUS: RECUSE',
        'INSTALL: /plugin install planning-suite@claude-craft',
        'REASON: planning-suite plugin required — schedule-plan-tasks skill not found',
      ].join('\n'),
    ).length === 0,
    'scheduler missing-skill recusal requires and accepts its INSTALL instruction',
  );
  check(
    validateContractCase(
      missingSkillCase,
      parseAgentContractResult([
        'STATUS: RECUSE',
        'REASON: planning-suite plugin required — schedule-plan-tasks skill not found',
      ].join('\n')),
      [
        'STATUS: RECUSE',
        'REASON: planning-suite plugin required — schedule-plan-tasks skill not found',
      ].join('\n'),
    ).some(error => /required contract fields/.test(error)),
    'scheduler missing-skill recusal cannot omit its INSTALL instruction',
  );

  const securityCase = AGENT_CONTRACT_CASES.find(
    entry => entry.caseId === 'reviewer-security-command-injection',
  );
  const canonicalTask = parseAgentContractResult('TASK_STATUS: COMPLETE');
  const failedTask = parseAgentContractResult('TASK_STATUS: FAILED');
  check(
    validateContractCase(
      securityCase,
      failedTask,
      'This is command injection with HIGH severity. Use spawn with an argument array and shell disabled.',
    ).some(error => /expected actionable TASK_STATUS/.test(error)),
    'TASK_STATUS: FAILED cannot satisfy an actionable behavioral case',
  );
  check(
    validateContractCase(
      securityCase,
      canonicalTask,
      'The exec path has command injection risk.',
    ).some(error => /required behavioral evidence patterns/.test(error)),
    'one copied security keyword cannot satisfy a behavioral contract',
  );
  check(
    validateContractCase(
      securityCase,
      canonicalTask,
      'This is command injection with HIGH severity. Use spawn with an argument array and shell disabled.',
    ).length === 0,
    'multi-signal security analysis satisfies the behavioral contract',
  );
  check(
    validateContractCase(
      securityCase,
      canonicalTask,
      [
        '## HIGH',
        'The external ref reaches exec and permits command injection.',
        'Mitigation: use spawn with a fixed argument array and shell disabled.',
      ].join('\n'),
    ).length === 0,
    'a clearly labeled HIGH heading satisfies severity evidence',
  );
  check(
    validateContractCase(
      securityCase,
      canonicalTask,
      [
        '- CRITICAL: external ref reaches exec and permits command injection.',
        '- Mitigation: use spawn with a fixed argument array and shell disabled.',
      ].join('\n'),
    ).length === 0,
    'a clearly labeled CRITICAL finding bullet satisfies severity evidence',
  );
  check(
    validateContractCase(
      securityCase,
      canonicalTask,
      [
        'The external ref reaches exec and permits command injection (CRITICAL).',
        'Mitigation: use spawn with a fixed argument array and shell disabled.',
      ].join('\n'),
    ).length === 0,
    'a parenthesized CRITICAL severity label satisfies severity evidence',
  );
  check(
    validateContractCase(
      securityCase,
      canonicalTask,
      [
        'Identified a CRITICAL command injection vulnerability in the exec call.',
        'Mitigation: use spawn with a fixed argument array and shell disabled.',
      ].join('\n'),
    ).length === 0,
    'a CRITICAL command-injection label satisfies severity evidence',
  );
  check(
    validateContractCase(
      securityCase,
      canonicalTask,
      [
        '## CRITICAL',
        'Use spawn with a fixed argument array and shell disabled.',
      ].join('\n'),
    ).some(error => /required behavioral evidence patterns/.test(error)),
    'a severity heading plus mitigation cannot pass without injection evidence',
  );
  check(
    validateContractCase(
      securityCase,
      canonicalTask,
      [
        '## HIGH',
        'The external ref reaches exec and permits command injection.',
      ].join('\n'),
    ).some(error => /required behavioral evidence patterns/.test(error)),
    'a severity heading plus injection cannot pass without mitigation evidence',
  );
  const diagnostic = formatContractFailureDiagnostics(
    { json: { stop_reason: 'max_tokens' } },
    `discarded-prefix-${'x'.repeat(FAILURE_RESPONSE_TAIL_CHARS)}-useful-tail`,
  );
  check(
    diagnostic.includes('stop_reason="max_tokens"') &&
      diagnostic.includes('-useful-tail') &&
      !diagnostic.includes('discarded-prefix') &&
      diagnostic.length < FAILURE_RESPONSE_TAIL_CHARS + 100,
    'contract failure diagnostics retain stop_reason and a bounded response tail',
  );
  const validLookingTruncatedText = [
    'The external ref reaches exec and permits command injection with HIGH severity.',
    'Mitigation: use spawn with a fixed argument array and shell disabled.',
    'TASK_STATUS: COMPLETE',
  ].join('\n');
  const validLookingTruncatedErrors = [
    ...validateContractResponseIntegrity({ json: { stop_reason: 'max_tokens' } }),
    ...validateContractCase(
      securityCase,
      parseAgentContractResult(validLookingTruncatedText),
      validLookingTruncatedText,
    ),
  ];
  check(
    validLookingTruncatedErrors.length === 1 &&
      /truncated at max_tokens=5000/.test(validLookingTruncatedErrors[0]),
    'a valid-looking contract still fails when stop_reason is max_tokens',
  );
  check(
    validateContractResponseIntegrity({
      json: { stop_reason: 'end_turn' },
    }).length === 0,
    'an ordinary end_turn response passes the shared integrity check',
  );
  const redactedDiagnostic = formatContractFailureDiagnostics(
    { json: { stop_reason: 'end_turn' } },
    [
      'OPENAI_API_KEY=sk-this-must-not-appear-123456',
      'Authorization: Bearer bearer-secret-material',
    ].join('\n'),
  );
  check(
    !redactedDiagnostic.includes('this-must-not-appear') &&
      !redactedDiagnostic.includes('bearer-secret-material') &&
      (redactedDiagnostic.match(/\[REDACTED\]/g) || []).length >= 2,
    'contract failure diagnostics redact credential-shaped response text',
  );
  const secretRecusalText = [
    'STATUS: RECUSE',
    'REASON: sk-abcdefghijklmnopqrstuv',
  ].join('\n');
  const secretRecusalErrors = validateContractCase(
    recusalCase,
    parseAgentContractResult(secretRecusalText),
    secretRecusalText,
  );
  check(
    secretRecusalErrors.some(error => error.includes('[REDACTED]')) &&
      secretRecusalErrors.every(error => !error.includes('sk-abcdefghijklmnopqrstuv')),
    'recusal mismatch diagnostics redact credential-shaped model text',
  );
  const coderCase = AGENT_CONTRACT_CASES.find(
    entry => entry.caseId === 'coder-clamp-function',
  );
  check(
    validateContractCase(
      coderCase,
      canonicalTask,
      [
        'function clamp(value, min, max) {',
        '  return Math.min(max, Math.max(min, value));',
        '}',
        'exports.clamp = clamp;',
      ].join('\n'),
    ).length === 0,
    'coder behavioral contract accepts a named CommonJS export',
  );
  check(
    validateContractCase(
      coderCase,
      canonicalTask,
      [
        'export function clamp(value, min, max) {',
        '  if (value < min) return min;',
        '  if (value > max) return max;',
        '  return value;',
        '}',
      ].join('\n'),
    ).length === 0,
    'coder behavioral contract accepts an equivalent branch-based implementation',
  );
  const hypothesisCase = AGENT_CONTRACT_CASES.find(
    entry => entry.caseId === 'debugger-hypothesis-timeout',
  );
  check(
    validateContractCase(
      hypothesisCase,
      canonicalTask,
      [
        'Hypothesis 1: a shared port bind race explains parallel-only timeout failures.',
        'Confidence: 75%',
        'Diagnostic: log a unique port for each worker; reject if all ports differ.',
        'Ranked above a cache race because failures correlate with concurrency.',
      ].join('\n'),
    ).length === 0,
    'debugger-hypothesis accepts an ordinary percentage confidence value',
  );
  const schedulerCase = AGENT_CONTRACT_CASES.find(
    entry => entry.caseId === 'plan-scheduler-ready-items',
  );
  check(
    validateContractCase(
      schedulerCase,
      canonicalTask,
      schedulerCase.userMessage,
    ).some(error => /required behavioral evidence patterns/.test(error)),
    'echoing plan-scheduler input cannot satisfy the behavioral contract',
  );
  check(
    validateContractCase(
      schedulerCase,
      canonicalTask,
      [
        'TASK_STATUS: COMPLETE',
        'ATTEMPTED: dispatched 2 items from /tmp/current-plan to wave 001',
        'COMPLETED:',
        '  - item-001 -> task-101 (coder)',
        '  - item-002 -> task-102 (tester)',
      ].join('\n'),
    ).length === 0,
    'structured plan-scheduler dispatch evidence satisfies the behavioral contract',
  );
  check(
    AGENT_CONTRACT_CASES
      .filter(entry => entry.scenario === 'normal')
      .every(entry => {
        const echo = `${entry.userMessage}\nTASK_STATUS: COMPLETE`;
        return validateContractCase(
          entry,
          parseAgentContractResult(echo),
          echo,
        ).some(error => /required behavioral evidence patterns/.test(error));
      }),
    'literal fixture echo plus TASK_STATUS cannot satisfy any actionable behavioral case',
  );

  const universalRecusals = AGENT_CONTRACT_CASES
    .filter(entry => entry.scenario === 'normal')
    .map(entry => ({ caseId: entry.caseId, result: canonicalRecusal }));
  check(
    /all 14 actionable normal cases/.test(
      universalNormalRecusalError(AGENT_CONTRACT_CASES, universalRecusals) || '',
    ),
    'universal recusal across actionable normal cases is rejected',
  );
  universalRecusals[0] = {
    caseId: universalRecusals[0].caseId,
    result: parseAgentContractResult('TASK_STATUS: COMPLETE'),
  };
  check(universalNormalRecusalError(AGENT_CONTRACT_CASES, universalRecusals) === null,
    'a real TASK_STATUS result clears the universal-recusal guard');
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-agent-contract-preflight-'));
  const agentsDir = path.join(scratch, 'agents');
  const modelMapPath = path.join(scratch, 'model-map.json');
  const alphaCase = {
    caseId: 'alpha-normal',
    agent: 'alpha',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'perform alpha work',
    behaviorPatterns: [/alpha/, /work/, /evidence/],
  };
  const classifications = {
    structured: ['alpha'],
    intentionallyUnstructured: [],
    routingOnly: [],
  };
  const writeMap = value => fs.writeFileSync(modelMapPath, JSON.stringify(value));
  const runPreflight = options => {
    try {
      return {
        value: preflightAgentContracts({
          agentsDir,
          modelMapPath,
          cases: [alphaCase],
          requiredCaseAgents: ['alpha'],
          expectedStructuredCount: 1,
          classifications,
          suiteName: 'synthetic-agent-contract',
          ...options,
        }),
        error: null,
      };
    } catch (error) {
      return { value: null, error };
    }
  };

  try {
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), [
      '---',
      'name: alpha',
      'model: alpha',
      '---',
      'Emit STATUS: RECUSE at the documented boundary.',
      'REASON: documented boundary',
      'TASK_STATUS: COMPLETE | PARTIAL | FAILED',
    ].join('\n'));
    writeMap({
      llm_profiles: { alpha: {} },
      agent_to_capability: { alpha: 'alpha' },
    });
    check(runPreflight({}).value?.capabilityByAgent.alpha === 'alpha',
      'synthetic complete roster and capability mapping pass preflight');
    check(
      /no documented recusal case coverage/.test(
        runPreflight({ requiredRecusalCaseAgents: ['alpha'] }).error?.message || '',
      ),
      'preflight rejects a structured agent missing required recusal-case coverage',
    );
    const alphaRecusalCase = {
      caseId: 'alpha-recusal',
      agent: 'alpha',
      scenario: 'recusal',
      expectedContract: 'recusal',
      userMessage: 'The documented alpha boundary applies.',
      recusalReasonPattern: /alpha boundary/i,
    };
    check(
      runPreflight({
        cases: [alphaCase, alphaRecusalCase],
        requiredRecusalCaseAgents: ['alpha'],
      }).value?.cases.length === 2,
      'preflight accepts normal and recusal coverage for the same structured agent',
    );
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), [
      '---',
      'name: alpha',
      'model: alpha',
      '---',
      'Emit STATUS: RECUSE at the documented boundary.',
      'TASK_STATUS: COMPLETE | PARTIAL | FAILED',
    ].join('\n'));
    check(/does not require a non-empty REASON/.test(runPreflight({}).error?.message || ''),
      'preflight rejects a structured prompt whose recusal schema omits a reason');
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), [
      '---',
      'name: alpha',
      'model: alpha',
      '---',
      'Emit STATUS: RECUSE at the documented boundary.',
      'REASON: documented boundary',
      'TASK_STATUS: COMPLETE | PARTIAL | FAILED',
    ].join('\n'));
    const promptOnlyEvidence = runPreflight({
      cases: [{
        ...alphaCase,
        behaviorPatterns: [/perform/, /alpha/],
      }],
    }).error;
    check(/behavioral signal not already present/.test(
      promptOnlyEvidence?.message || '',
    ), 'preflight rejects behavioral cases satisfiable entirely by prompt echo');

    const duplicate = runPreflight({
      classifications: { ...classifications, structured: ['alpha', 'alpha'] },
      expectedStructuredCount: 2,
    }).error;
    check(/duplicate\/overlapping classifications/.test(duplicate?.message || ''),
      'preflight rejects duplicate structured roster entries');

    writeMap({ llm_profiles: { alpha: {} }, agent_to_capability: {} });
    check(/agent_to_capability\["alpha"\] is missing/.test(runPreflight({}).error?.message || ''),
      'preflight rejects a structured agent missing its capability mapping');

    writeMap({
      llm_profiles: { alpha: {} },
      agent_to_capability: { alpha: 'missing-capability' },
    });
    check(/unknown llm_profiles capability/.test(runPreflight({}).error?.message || ''),
      'preflight rejects an unresolvable capability mapping');

    fs.writeFileSync(path.join(agentsDir, 'beta.md'), [
      '---',
      'name: beta',
      'model: beta',
      '---',
      'Native unclassified helper.',
    ].join('\n'));
    writeMap({
      llm_profiles: { alpha: {}, beta: {} },
      agent_to_capability: { alpha: 'alpha', beta: 'beta' },
    });
    check(/agents\/beta\.md has no explicit contract classification/.test(
      runPreflight({}).error?.message || '',
    ), 'preflight rejects an unclassified added agent file');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-route-env-'));
  const ambientProfile = path.join(scratch, 'installed-profile');
  const ambientMap = path.join(ambientProfile, 'model-map.json');
  const providerCredentialCanaries = Object.fromEntries(
    (routeLive.ACTIVE_PROVIDER_ENV_KEYS || [])
      .filter(key => key !== 'ANTHROPIC_API_KEY')
      .map(key => [key, `fixture-provider-${key.toLowerCase()}`]),
  );
  fs.mkdirSync(ambientProfile, { recursive: true });
  fs.writeFileSync(ambientMap, '{}');
  const contaminated = {
    ...providerCredentialCanaries,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: 'fixture-claude-api-key',
    ANTHROPIC_AUTH_TOKEN: 'fixture-claude-auth-token',
    AWS_ACCESS_KEY_ID: 'fixture-unrelated-aws-access-key',
    AWS_SECRET_ACCESS_KEY: 'fixture-unrelated-aws-secret-key',
    CLAUDE_CONFIG_DIR: ambientProfile,
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-claude-oauth-token',
    CLAUDE_DIR: ambientProfile,
    CLAUDE_MODEL_MAP_DEFAULTS_PATH: ambientMap,
    CLAUDE_MODEL_MAP_OVERRIDES_PATH: ambientMap,
    CLAUDE_MODEL_MAP_PATH: ambientMap,
    CLAUDE_MODEL_MAP_SYNC_STATE_FILE: ambientMap,
    CLAUDE_PROFILE_DIR: ambientProfile,
    CLAUDE_PROXY_BYPASS: '1',
    CLAUDE_PROXY_PORT: '9',
    CLAUDE_PROXY_USE_OLLAMA_PORT: '1',
    CLAUDE_ROUTER_SKIP_PROXY_AUTOSTART: '1',
    C_THRU_KEEP_PROXY: '1',
    C_THRU_PROXY_ALWAYS: '0',
    C_THRU_SKIP_PROXY_AUTOSTART: '1',
    GITHUB_TOKEN: 'fixture-unrelated-github-token',
    HTTP_PROXY: 'http://proxy.invalid:8080',
    HTTPS_PROXY: 'https://fixture-proxy-user:secret@proxy.invalid:8443',
    PROXY_PORT: '9',
    UNRELATED_SECRET: 'fixture-unrelated-arbitrary-secret',
  };
  const prior = Object.fromEntries(
    Object.keys(contaminated).map(key => [key, process.env[key]]),
  );
  Object.assign(process.env, contaminated);
  try {
    const env = routeLive.cleanLiveEnv(
      scratch,
      path.join(scratch, 'proxy.log'),
      '/bin/true',
    );
    const isolatedProfile = path.join(scratch, 'claude-profile');
    check(env.CLAUDE_MODEL_MAP_PATH === path.join(repo, 'config', 'model-map.json'),
      'Claude Agent route proof overrides an ambient installed model map with the checkout map');
    check(
      env.CLAUDE_DIR === isolatedProfile &&
      env.CLAUDE_CONFIG_DIR === isolatedProfile &&
      env.CLAUDE_PROFILE_DIR === isolatedProfile,
      'Claude Agent route proof replaces all installed-profile selectors with an isolated profile',
    );
    check(
      env.C_THRU_KEEP_PROXY === '0' &&
      env.C_THRU_PROXY_ALWAYS === '1' &&
      routeLive.C_THRU === path.join(repo, 'tools', 'c-thru'),
      'Claude Agent route proof forces a test-owned proxy through checkout tools/c-thru',
    );
    check([
      'ANTHROPIC_BASE_URL',
      'CLAUDE_PROXY_BYPASS',
      'CLAUDE_PROXY_PORT',
      'CLAUDE_PROXY_USE_OLLAMA_PORT',
      'CLAUDE_ROUTER_SKIP_PROXY_AUTOSTART',
      'C_THRU_SKIP_PROXY_AUTOSTART',
      'PROXY_PORT',
    ].every(key => env[key] === undefined),
    'Claude Agent route proof clears every ambient proxy-selection escape hatch');
    check([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'UNRELATED_SECRET',
    ].every(key => !Object.hasOwn(env, key)),
    'Claude Agent route proof excludes AWS, GitHub, and arbitrary ambient secrets');
    check(
      env.ANTHROPIC_API_KEY === contaminated.ANTHROPIC_API_KEY &&
      env.ANTHROPIC_AUTH_TOKEN === contaminated.ANTHROPIC_AUTH_TOKEN &&
      env.CLAUDE_CODE_OAUTH_TOKEN === contaminated.CLAUDE_CODE_OAUTH_TOKEN,
      'Claude Agent route proof preserves explicit Claude authentication',
    );
    check(
      Object.keys(providerCredentialCanaries).length > 0 &&
      Object.entries(providerCredentialCanaries)
        .every(([key, value]) => env[key] === value),
      'Claude Agent route proof preserves provider env required by the active model map',
    );
    check(
      env.HTTP_PROXY === contaminated.HTTP_PROXY &&
      !Object.hasOwn(env, 'HTTPS_PROXY'),
      'Claude Agent route proof preserves credential-free proxy URLs and excludes credentialed URLs',
    );
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  const agentToolUseId = 'toolu_01AgentRoute220Fixture';
  const sessionId = 'session-claude-2-1-220-fixture';
  const streamJson = [
    'c-thru routing preamble is not JSON',
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5',
        id: 'msg_parent',
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: agentToolUseId,
          name: 'Agent',
          input: {
            subagent_type: 'coder',
            description: 'Return the live route token',
            prompt: 'Return LIVE_AGENT_ROUTE_OK',
          },
          caller: { type: 'direct' },
        }],
        stop_reason: null,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: 'uuid-parent',
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5',
        id: 'msg_wrong_parent',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'WRONG_PARENT_TEXT' }],
      },
      parent_tool_use_id: 'toolu_01UnrelatedAgent',
      subagent_type: 'coder',
      session_id: sessionId,
      uuid: 'uuid-wrong-parent',
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5',
        id: 'msg_forwarded',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'LIVE_AGENT_ROUTE_OK' }],
      },
      parent_tool_use_id: agentToolUseId,
      session_id: sessionId,
      uuid: 'uuid-forwarded',
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'LIVE_AGENT_ROUTE_OK',
      session_id: sessionId,
      uuid: 'uuid-result',
    }),
  ].join('\n');
  const events = routeLive.parseStreamJson(streamJson);
  const call = routeLive.findAgentToolUse(events, 'coder');
  check(call?.block?.id === agentToolUseId,
    'Claude 2.1.220 stream fixture resolves the Agent tool_use correlation ID');
  check(
    routeLive.forwardedSubagentText(events, call?.block?.id) === 'LIVE_AGENT_ROUTE_OK',
    'Claude 2.1.220 stream fixture accepts only assistant text linked by parent_tool_use_id',
  );
  const routeSource = read('test/claude-agent-route-live.test.js');
  check(/'--forward-subagent-text'/.test(routeSource) &&
      !/event\?\.subagent_type === AGENT/.test(routeSource),
    'live route invocation requests forwarded text and does not rely on top-level subagent_type');
}

for (const key of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY']) {
  check(new RegExp(`^\\s+${key}: \\$\\{\\{ secrets\\.${key} \\}\\}$`, 'm').test(workflow),
    `live workflow exposes ${key} from the same-named repository secret`);
}

const blockingLiveJob = workflowJobBody('blocking-live-shards');
const latestAgentJob = workflowJobBody('latest-agent-canary');
const macosHermeticJob = workflowJobBody('macos-hermetic');
check(
  /^\s+runs-on: ubuntu-latest$/m.test(blockingLiveJob) &&
    /^\s+timeout-minutes: 70$/m.test(blockingLiveJob) &&
    /^\s+shard: \[provider, agent\]$/m.test(blockingLiveJob),
  'blocking Ubuntu job defines disjoint provider and agent shards inside a 70-minute job',
);
check(
  /npm install --global @anthropic-ai\/claude-code@2\.1\.220/.test(blockingLiveJob) &&
    !/@anthropic-ai\/claude-code@latest/.test(blockingLiveJob) &&
    !/continue-on-error:\s*true/.test(blockingLiveJob),
  'blocking live shards pin Claude Code 2.1.220 and remain blocking',
);
check(
  /run: make test-live-shard SHARD=\$\{\{ matrix\.shard \}\}/.test(blockingLiveJob),
  'blocking matrix invokes the selected live shard instead of the aggregate',
);
check(
  /^\s+runs-on: ubuntu-latest$/m.test(latestAgentJob) &&
    /^\s+timeout-minutes: 70$/m.test(latestAgentJob) &&
    /^\s+continue-on-error: true$/m.test(latestAgentJob) &&
    /@anthropic-ai\/claude-code@latest/.test(latestAgentJob) &&
    /run: make test-live-shard SHARD=agent/.test(latestAgentJob),
  'latest Claude Code agent canary is Ubuntu-only and advisory',
);
for (const key of [
  'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_TOKEN',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_REGION', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'XAI_API_KEY',
]) {
  check(
    new RegExp(`^\\s+${key}: \\$\\{\\{ secrets\\.${key} \\}\\}$`, 'm').test(latestAgentJob),
    `latest agent canary exposes ${key} for any configured mapped backend`,
  );
}
check(
  /^\s+runs-on: macos-latest$/m.test(macosHermeticJob) &&
    /^\s+timeout-minutes: 70$/m.test(macosHermeticJob) &&
    /^\s+run: make test$/m.test(macosHermeticJob) &&
    !/test-live-(?:all|shard)/.test(macosHermeticJob),
  'macOS lane runs the hermetic suite once without duplicating live shards',
);
check(
  !/run:\s*make test-live-all/.test(workflow) &&
    (workflow.match(/run:\s*make test-live-shard/g) || []).length === 2 &&
    (workflow.match(/run:\s*make test\s*$/gm) || []).length === 1,
  'scheduled workflow never duplicates the full deterministic suite inside live aggregates',
);
for (const [jobName, body] of [
  ['blocking live shards', blockingLiveJob],
  ['latest agent canary', latestAgentJob],
  ['macOS hermetic lane', macosHermeticJob],
]) {
  check(
    /^\s+C_THRU_TEST_TIMEOUT_SECONDS: "3300"$/m.test(body),
    `${jobName} caps every test command at 3,300 seconds`,
  );
  const evidencePath =
    body.match(/^\s+C_THRU_TEST_EVIDENCE_PATH:\s*(.*?)\s*$/m)?.[1] || '';
  check(
    evidencePath &&
      evidencePath.includes('${{ github.run_id }}') &&
      evidencePath.includes('${{ github.run_attempt }}') &&
      (body.match(/^\s+if: always\(\)$/gm) || []).length === 1 &&
      body.split(evidencePath).length - 1 === 2 &&
      /uses: actions\/upload-artifact@v4/.test(body),
    `${jobName} always uploads its unique evidence path`,
  );
  check(
    (body.match(
      /^\s+if: failure\(\) && github\.event\.repository\.private$/gm,
    ) || []).length === 1 &&
      /^\s+C_THRU_TEST_FAILURE_LOG_DIR:\s*(.*?)\s*$/m.test(body),
    `${jobName} declares one exact current-run failure-log directory for private-repo upload`,
  );
  const failureLogPath =
    body.match(/^\s+C_THRU_TEST_FAILURE_LOG_DIR:\s*(.*?)\s*$/m)?.[1] || '';
  check(
    failureLogPath &&
      failureLogPath.startsWith('${{ runner.temp }}/c-thru-runall-') &&
      failureLogPath.includes('${{ github.run_id }}') &&
      failureLogPath.includes('${{ github.run_attempt }}') &&
      body.split(failureLogPath).length - 1 === 2 &&
      body.includes(`path: ${failureLogPath}`) &&
      !/c-thru-runall-\*|\/tmp\/c-thru-runall/.test(body) &&
      !/^\s+if: failure\(\)\s*$/m.test(body),
    `${jobName} uploads only its exact failure-log directory without temp globs`,
  );
  const failureUpload = body.slice(body.indexOf('Upload '), body.length);
  check(
    /failure logs[\s\S]*?^\s+retention-days:\s*1\s*$/m.test(failureUpload),
    `${jobName} limits unsanitized failure-log artifact retention to one day`,
  );
}
const evidencePaths = [...workflow.matchAll(
  /^\s+C_THRU_TEST_EVIDENCE_PATH:\s*(.*?)\s*$/gm,
)].map(match => match[1]);
check(evidencePaths.length === 3 && new Set(evidencePaths).size === 3,
  'provider/agent matrix, latest canary, and macOS lane use collision-free evidence paths');
const failureLogPaths = [...workflow.matchAll(
  /^\s+C_THRU_TEST_FAILURE_LOG_DIR:\s*(.*?)\s*$/gm,
)].map(match => match[1]);
check(
  failureLogPaths.length === 3 &&
    new Set(failureLogPaths).size === 3 &&
    /export C_THRU_TEST_FAILURE_LOG_DIR="\$FAIL_LOG_DIR"/.test(runAll) &&
    /C_THRU_TEST_FAILURE_LOG_DIR=\$FAIL_LOG_DIR/.test(runAll),
  'all jobs use distinct exact log paths and run-all exports and records the allocated path',
);
const offloadEvidencePaths = [...workflow.matchAll(
  /^\s+C_THRU_OFFLOAD_EVIDENCE_PATH:\s*(.*?)\s*$/gm,
)].map(match => match[1]);
check(
  offloadEvidencePaths.length === 2 &&
    new Set(offloadEvidencePaths).size === 2 &&
    offloadEvidencePaths.every(evidencePath =>
      evidencePath.includes('${{ github.run_id }}') &&
      evidencePath.includes('${{ github.run_attempt }}') &&
      workflow.split(evidencePath).length - 1 === 2),
  'pinned and latest live jobs upload collision-free detailed offload scorecards',
);
check(
  !/C_THRU_OFFLOAD_EVIDENCE_PATH/.test(macosHermeticJob),
  'macOS hermetic lane does not advertise a model-backed scorecard it cannot create',
);

check(
  !/(?:--omit(?:=|\s+)optional|--no-optional|NPM_CONFIG_OPTIONAL:\s*false|NPM_CONFIG_OMIT:\s*optional)/i
    .test(workflow),
  'hosted live job does not suppress Claude Code platform optional dependencies',
);
check(
  (blockingLiveJob.match(/run: claude --version/g) || []).length === 1 &&
    (latestAgentJob.match(/run: claude --version/g) || []).length === 1,
  'both Claude-backed jobs verify the installed CLI before their shard',
);
check(
  (workflow.match(/^\s+DISABLE_AUTOUPDATER: "1"$/gm) || []).length === 2,
  'pinned and latest Claude Code jobs disable in-job auto-updates');

check(
  /Historical snapshot — superseded/.test(coverageAuditDocs) &&
    /functionality-verification\.md/.test(coverageAuditDocs) &&
    /test\/run-all\.sh/.test(coverageAuditDocs),
  'April coverage audit is explicitly historical and points to current verification sources',
);
check(
  /docs\/functionality-verification\.md/.test(testAuthoringDocs) &&
    /test\/run-all\.sh/.test(testAuthoringDocs) &&
    /test\/run-all-coverage\.test\.js/.test(testAuthoringDocs),
  'test authoring guide points to functionality verification and the executable registry',
);
check(
  /70-minute lifecycle[\s\S]*15 minutes/.test(testAuthoringDocs) &&
    /70-minute[\s\S]*15 minutes/.test(functionalityVerificationDocs) &&
    /70-minute job lifecycle[\s\S]*15 minutes/.test(envVarDocs) &&
    /55-minute execution budget inside the 70-minute CI lifecycle/.test(makefile),
  'timeout documentation distinguishes the 3,300-second command cap from the 70-minute lifecycle',
);
check(
  [testAuthoringDocs, functionalityVerificationDocs, envVarDocs].every(source =>
    /(?:unsanitized|not sanitized)/.test(source) &&
      /one[- ]day/.test(source) &&
      /(?:private repositor|repository is private)/.test(source) &&
      /Actions-artifact access boundary/.test(source)),
  'failure-log documentation records the raw-output access and retention boundary',
);
check(
  [
    'Structural registration',
    'Deterministic semantics',
    'Live integrity',
    'Stochastic quality',
  ].every(layer => functionalityVerificationDocs.includes(`**${layer}**`)),
  'functionality verification keeps structural, deterministic, live, and stochastic evidence distinct',
);
const artifactBearingExclusions = [
  'agent-contract-fixtures.js',
  'provider-live-prerequisites.js',
  'agent-prompt-unit.js',
  'benchmark-coverage.test.js',
  'proxy-autodetect.test.sh',
  'proxy-targets.test.js',
];
check(
  /## Six artifact-bearing exclusions/.test(functionalityVerificationDocs) &&
    artifactBearingExclusions.every(
      artifact => functionalityVerificationDocs.includes(`\`${artifact}\``),
    ),
  'functionality verification names all six artifact-bearing executable exclusions',
);

check(/export HOME="\$SMOKE_HOME"/.test(smoke),
  'smoke check isolates HOME under its disposable scratch directory');
check(/export CLAUDE_MODEL_MAP_PATH="\$REPO_DIR\/config\/model-map\.json"/.test(smoke),
  'smoke check explicitly selects the shipped repository model map');
check(/unset ANTHROPIC_BASE_URL CLAUDE_PROXY_PORT CLAUDE_PROXY_BIND_ADDR CLAUDE_PROXY_BYPASS/.test(smoke),
  'smoke check clears ambient proxy routing before requesting a free loopback port');
check(!/\$HOME\/\.claude\/model-map\.json/.test(smoke),
  'smoke check does not depend on an installed profile model map');

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
