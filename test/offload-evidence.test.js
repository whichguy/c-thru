#!/usr/bin/env node
'use strict';
// Unit tests for the sanitized, atomic agent-offload evidence artifact and the
// provider-free pooled campaign evaluator.
//
// Run: node test/offload-evidence.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  buildOffloadEvidence,
  evaluatePooledCampaigns,
  qualityPolicyFromEnv,
  writeEvidenceAtomic,
} = require('../tools/offload-evidence.js');
const { assert, assertEq, summary } = require('./helpers');

const SECRET_CANARY = 'sk-live-offload-evidence-secret-canary-abcdefghijklmnopqrstuvwxyz';
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-offload-evidence-'));
const DEFAULT_EXECUTION_COORDINATES = Object.freeze({
  requestedLlmMode: 'best-cloud',
  effectiveLlmMode: 'best-cloud',
  requestedLlmProfile: '32gb',
  effectiveLlmProfile: '32gb',
  launchRoute: 'default',
  requestedModel: 'claude-parent',
  resolvedModel: 'claude-parent-resolved',
  backendId: 'anthropic',
  backendFormat: 'anthropic',
});

function campaign({
  agentDescriptionsSha256 = 'd'.repeat(64),
  entrypointMapSha256 = 'a'.repeat(64),
  classifications = ['exact'],
  expected = [['coder']],
  selected = [['coder']],
  primaryNeverSelected = [],
  policy = 'advisory',
  runId = crypto.randomUUID(),
  runIntegrityReasons = [],
  fixtureIntegrityReason = null,
  executionCoordinates = DEFAULT_EXECUTION_COORDINATES,
} = {}) {
  const startedAt = '2026-07-27T12:00:00.000Z';
  const finishedAt = '2026-07-27T12:00:01.000Z';
  return buildOffloadEvidence({
    runId,
    startedAt,
    finishedAt,
    cliPath: '/opt/claude/bin/claude',
    cliVersion: '2.1.220 (Claude Code)',
    entrypointMapPath: '/repo/config/model-map.json',
    entrypointMapSha256,
    selectionCorpusSha256: 'c'.repeat(64),
    agentDescriptionsSha256,
    executionCoordinates,
    qualityPolicy: policy,
    threshold: 0.70,
    primaryNeverSelected,
    runIntegrityReasons,
    fixtureRecords: classifications.map((classification, index) => ({
      id: `fixture-${index + 1}`,
      expected: expected[index] || ['coder'],
      selected: selected[index] || [],
      classification: fixtureIntegrityReason ? 'not_evaluated' : classification,
      integrityReason: fixtureIntegrityReason,
      routeProof: fixtureIntegrityReason ? false : (selected[index] || []).length > 0,
      routeObservations: (selected[index] || []).map(agent => ({
        incomingModel: agent,
        resolvedModel: `${agent}-resolved`,
        backendId: 'anthropic',
        backendFormat: 'anthropic',
        logicalRole: agent,
        llmMode: executionCoordinates.effectiveLlmMode,
        llmProfile: executionCoordinates.effectiveLlmProfile,
      })),
      prompt: `private prompt ${SECRET_CANARY}`,
      rawOutput: `private raw output ${SECRET_CANARY}`,
      transcriptPath: `/private/transcript/${SECRET_CANARY}`,
      totalTokens: 12345,
      credentials: { apiKey: SECRET_CANARY },
    })),
  });
}

function cloneCampaignsWithFreshRunIds(documents) {
  return documents.map(document => {
    const clone = JSON.parse(JSON.stringify(document));
    clone.run_id = crypto.randomUUID();
    return clone;
  });
}

function setCoderChildRoute(document, {
  resolvedModel,
  backendId,
  backendFormat = backendId,
  llmMode = 'best-cloud',
  llmProfile = '32gb',
  incomingModel = 'coder',
  logicalRole = 'coder',
}) {
  const observation = document.fixtures[0].route_observations.find(route => (
    route.incoming_model === 'coder' &&
    route.logical_role === 'coder'
  ));
  if (!observation) {
    throw new Error('test fixture does not expose the selected coder child route');
  }
  Object.assign(observation, {
    incoming_model: incomingModel,
    logical_role: logicalRole,
    resolved_model: resolvedModel,
    backend_id: backendId,
    backend_format: backendFormat,
    llm_mode: llmMode,
    llm_profile: llmProfile,
  });
  return document;
}

function coderChildRouteCohort(route) {
  return Array.from({ length: 3 }, () => setCoderChildRoute(campaign({
    classifications: ['exact'],
    selected: [['coder']],
  }), route));
}

try {
  console.log('offload evidence tests\n');

  console.log('1. quality policy is advisory by default and on CI');
  assertEq(qualityPolicyFromEnv({}), 'advisory',
    'default policy is advisory');
  assertEq(qualityPolicyFromEnv({ CI: 'true' }), 'advisory',
    'CI does not silently promote one noisy campaign to a gate');
  assertEq(qualityPolicyFromEnv({ CI: '1', C_THRU_OFFLOAD_GATE: '1' }), 'single_run',
    'explicit compatibility gate selects single_run policy');

  console.log('\n2. builder emits the exact versioned sanitized schema');
  const failedQuality = campaign({
    classifications: ['unexpected', 'no-offload'],
    selected: [['tester'], []],
    primaryNeverSelected: ['coder'],
  });
  assertEq(failedQuality.schema_version, 2,
    'schema carries an explicit integer version');
  assertEq(failedQuality.evidence_type, 'c-thru.agent-offload',
    'schema carries a stable evidence type');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    failedQuality.run_id,
  ), 'schema carries a sanitized UUID run identity');
  assertEq(failedQuality.integrity_status, 'passed',
    'quality misses do not become integrity failures');
  assertEq(failedQuality.quality_status, 'failed',
    'threshold and primary-selection misses are machine-visible quality failures');
  assertEq(failedQuality.quality_policy, 'advisory',
    'advisory policy is recorded independently of quality status');
  assertEq(failedQuality.quality.threshold_met, false,
    'threshold miss is explicit');
  assertEq(failedQuality.quality.primary_never_selected.join(','), 'coder',
    'never-selected primary is explicit');
  assertEq(failedQuality.run.selection_corpus_sha256, 'c'.repeat(64),
    'run identity includes only the selection corpus hash');
  assertEq(failedQuality.run.agent_descriptions_sha256, 'd'.repeat(64),
    'run identity includes only the agent-description bundle hash');
  assertEq(failedQuality.run.execution.requested_llm_mode, 'best-cloud',
    'run identity records the requested LLM mode');
  assertEq(failedQuality.run.execution.effective_llm_mode, 'best-cloud',
    'run identity records the effective LLM mode');
  assertEq(failedQuality.run.execution.requested_llm_profile, '32gb',
    'run identity records the requested LLM profile');
  assertEq(failedQuality.run.execution.effective_llm_profile, '32gb',
    'run identity records the effective LLM profile');
  assertEq(failedQuality.run.execution.route.launch_route, 'default',
    'run identity records the selected launch route');
  assertEq(failedQuality.run.execution.route.resolved_model, 'claude-parent-resolved',
    'run identity records the resolved parent model');
  assertEq(failedQuality.run.execution.route.backend_id, 'anthropic',
    'run identity records the resolved parent backend');
  assert(/^[a-f0-9]{64}$/.test(
    failedQuality.run.execution.route.identity_sha256,
  ), 'run identity carries a stable sanitized route/config digest');
  assertEq(failedQuality.fixtures[0].classification, 'unexpected',
    'wrong-agent remains an unexpected classification');
  assertEq(failedQuality.fixtures[1].classification, 'no-offload',
    'no-offload remains separate from wrong-agent');
  assertEq(
    Object.keys(failedQuality.fixtures[0]).sort().join(','),
    'classification,expected,id,integrity_reason,route_observations,route_proof,selected',
    'fixture objects expose only the seven allowlisted fields',
  );
  assertEq(
    failedQuality.fixtures[0].route_observations[0].resolved_model,
    'tester-resolved',
    'fixture evidence retains only sanitized observed dispatch identity',
  );
  const serialized = JSON.stringify(failedQuality);
  for (const forbidden of [
    SECRET_CANARY,
    'private prompt',
    'private raw output',
    'transcriptPath',
    'totalTokens',
    'credentials',
  ]) {
    assert(!serialized.includes(forbidden),
      `serialized artifact excludes ${JSON.stringify(forbidden)}`);
  }

  console.log('\n3. integrity failures make quality not_evaluated');
  const integrityFailure = campaign({
    classifications: ['exact'],
    selected: [['coder']],
    fixtureIntegrityReason: 'route_proof_failed',
  });
  assertEq(integrityFailure.integrity_status, 'failed',
    'fixture proof error fails integrity');
  assertEq(integrityFailure.quality_status, 'not_evaluated',
    'quality is not evaluated after an integrity failure');
  assertEq(integrityFailure.quality.threshold_met, null,
    'threshold result is withheld after an integrity failure');
  assertEq(integrityFailure.fixtures[0].integrity_reason, 'route_proof_failed',
    'sanitized fixture integrity reason is retained');
  assertEq(integrityFailure.fixtures[0].route_proof, false,
    'failed proof cannot claim route proof');
  const missingRouteFailure = JSON.parse(JSON.stringify(integrityFailure));
  missingRouteFailure.fixtures[0].route_observations = [];
  const missingRouteFailurePath = path.join(
    fixtureRoot,
    'failed-route-without-observation.json',
  );
  writeEvidenceAtomic(missingRouteFailurePath, missingRouteFailure);
  const persistedMissingRouteFailure = JSON.parse(
    fs.readFileSync(missingRouteFailurePath, 'utf8'),
  );
  assertEq(persistedMissingRouteFailure.integrity_status, 'failed',
    'missing route observations remain a failed-integrity record');
  assertEq(persistedMissingRouteFailure.quality_status, 'not_evaluated',
    'a selected agent without route proof can never enter quality scoring');
  assertEq(persistedMissingRouteFailure.fixtures[0].selected[0], 'coder',
    'failed route evidence retains the sanitized unproved Agent-tool selection');
  assertEq(persistedMissingRouteFailure.fixtures[0].route_observations.length, 0,
    'failed route evidence may honestly record that no dispatch observation exists');
  const cleanupFailure = campaign({
    classifications: ['exact'],
    selected: [['coder']],
    runIntegrityReasons: ['cleanup_failed'],
  });
  assertEq(cleanupFailure.integrity_status, 'failed',
    'run cleanup error fails integrity');
  assertEq(cleanupFailure.quality_status, 'not_evaluated',
    'cleanup failure prevents a quality verdict');

  console.log('\n4. evidence writes atomically with restrictive permissions');
  const evidencePath = path.join(fixtureRoot, 'evidence.json');
  fs.writeFileSync(evidencePath, '{"old":true}\n', { mode: 0o644 });
  writeEvidenceAtomic(evidencePath, failedQuality);
  const written = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assertEq(written.schema_version, 2,
    'atomic write replaces the destination with parseable evidence');
  assertEq(fs.statSync(evidencePath).mode & 0o777, 0o600,
    'evidence file is owner-readable and owner-writable only');
  assertEq(
    fs.readdirSync(fixtureRoot).filter(name => name.includes('.tmp-')).length,
    0,
    'successful atomic write leaves no temporary sibling',
  );

  console.log('\n5. writer rejects schema additions before touching disk');
  const taintedEvidencePath = path.join(fixtureRoot, 'tainted-evidence.json');
  const taintedEvidence = JSON.parse(JSON.stringify(failedQuality));
  taintedEvidence.fixtures[0].prompt = `private ${SECRET_CANARY}`;
  let taintedRejected = false;
  try {
    writeEvidenceAtomic(taintedEvidencePath, taintedEvidence);
  } catch (error) {
    taintedRejected = /unexpected or missing fields/.test(error?.message || '');
  }
  assert(taintedRejected,
    'writer validates the exact fixture schema before serialization');
  assert(!fs.existsSync(taintedEvidencePath),
    'schema rejection creates no destination artifact');
  const inconsistentEvidence = JSON.parse(JSON.stringify(failedQuality));
  inconsistentEvidence.fixtures[0].classification = 'exact';
  let inconsistentRejected = false;
  try {
    writeEvidenceAtomic(taintedEvidencePath, inconsistentEvidence);
  } catch (error) {
    inconsistentRejected = /exact classification is inconsistent/.test(
      error?.message || '',
    );
  }
  assert(inconsistentRejected,
    'writer rejects a classification that disagrees with selected/expected agents');
  assert(!fs.existsSync(taintedEvidencePath),
    'semantic schema rejection also creates no destination artifact');
  const mixedExact = campaign({
    classifications: ['exact'],
    selected: [['coder']],
  });
  mixedExact.fixtures[0].selected.push('tester');
  mixedExact.fixtures[0].route_observations.push({
    incoming_model: 'tester',
    resolved_model: 'tester-resolved',
    backend_id: 'anthropic',
    backend_format: 'anthropic',
    logical_role: 'tester',
    llm_mode: 'best-cloud',
    llm_profile: '32gb',
  });
  let mixedExactRejected = false;
  try {
    writeEvidenceAtomic(taintedEvidencePath, mixedExact);
  } catch (error) {
    mixedExactRejected = /exact classification is inconsistent/.test(
      error?.message || '',
    );
  }
  assert(mixedExactRejected,
    'writer rejects forged exact evidence containing any unexpected agent');
  const mixedAcceptable = campaign({
    classifications: ['acceptable'],
    expected: [['coder', 'coder-fallback']],
    selected: [['coder-fallback']],
  });
  mixedAcceptable.fixtures[0].selected.push('tester');
  mixedAcceptable.fixtures[0].route_observations.push({
    incoming_model: 'tester',
    resolved_model: 'tester-resolved',
    backend_id: 'anthropic',
    backend_format: 'anthropic',
    logical_role: 'tester',
    llm_mode: 'best-cloud',
    llm_profile: '32gb',
  });
  let mixedAcceptableRejected = false;
  try {
    writeEvidenceAtomic(taintedEvidencePath, mixedAcceptable);
  } catch (error) {
    mixedAcceptableRejected = /acceptable classification is inconsistent/.test(
      error?.message || '',
    );
  }
  assert(mixedAcceptableRejected,
    'writer rejects forged acceptable evidence containing any unexpected agent');
  const mixedUnexpected = campaign({
    classifications: ['unexpected'],
    selected: [['coder', 'tester']],
  });
  assertEq(mixedUnexpected.fixtures[0].classification, 'unexpected',
    'mixed expected/unexpected selections are valid only as unexpected evidence');
  const invalidRunIdentity = JSON.parse(JSON.stringify(failedQuality));
  invalidRunIdentity.run_id = `not-a-uuid-${SECRET_CANARY}`;
  let invalidRunIdentityRejected = false;
  try {
    writeEvidenceAtomic(taintedEvidencePath, invalidRunIdentity);
  } catch (error) {
    invalidRunIdentityRejected = /run_id must be a canonical UUID/.test(
      error?.message || '',
    );
  }
  assert(invalidRunIdentityRejected,
    'writer rejects non-UUID run identities before serialization');
  assert(!fs.existsSync(taintedEvidencePath),
    'invalid run identity creates no destination artifact');

  console.log('\n6. failed rename preserves the previous complete artifact');
  fs.writeFileSync(evidencePath, '{"sentinel":"complete"}\n', { mode: 0o600 });
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return () => {
          const error = new Error('injected rename failure');
          error.code = 'EIO';
          throw error;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let renameFailed = false;
  try {
    writeEvidenceAtomic(evidencePath, failedQuality, { fs: failingFs });
  } catch (error) {
    renameFailed = error?.code === 'EIO';
  }
  assert(renameFailed, 'injected rename failure is reported');
  assertEq(
    fs.readFileSync(evidencePath, 'utf8'),
    '{"sentinel":"complete"}\n',
    'failed atomic write does not truncate or replace prior evidence',
  );
  assertEq(
    fs.readdirSync(fixtureRoot).filter(name => name.includes('.tmp-')).length,
    0,
    'failed atomic write removes its temporary sibling',
  );

  console.log('\n7. pooled evaluator requires repeated campaigns and detects regressions');
  const baseline = Array.from({ length: 3 }, () => campaign({
    classifications: ['exact', 'exact'],
    selected: [['coder'], ['coder']],
  }));
  const candidate = Array.from({ length: 3 }, () => campaign({
    classifications: ['exact', 'unexpected'],
    selected: [['coder'], ['tester']],
    primaryNeverSelected: ['coder'],
  }));
  const pooled = evaluatePooledCampaigns(baseline, candidate, {
    nonInferiorityMargin: 0.10,
  });
  assertEq(pooled.status, 'failed',
    'inferior pooled candidate fails');
  assertEq(pooled.pooled.baseline.scored, 6,
    'baseline counts are pooled across three campaigns');
  assertEq(pooled.pooled.candidate.scored, 6,
    'candidate counts are pooled across three campaigns');
  assertEq(pooled.pooled.non_inferior, false,
    'pooled non-inferiority result is explicit');
  assertEq(pooled.reproducible_unexpected_agent_regressions.length, 1,
    'same new unexpected-agent outcome in repeated campaigns is a regression');
  assertEq(
    pooled.reproducible_unexpected_agent_regressions[0].selected,
    'tester',
    'regression identifies the unexpected selected agent',
  );
  const mixedCandidate = Array.from({ length: 3 }, () => campaign({
    classifications: ['unexpected', 'exact'],
    selected: [['coder', 'tester'], ['coder']],
  }));
  const mixedPooled = evaluatePooledCampaigns(baseline, mixedCandidate, {
    nonInferiorityMargin: 0.10,
  });
  assertEq(mixedPooled.status, 'failed',
    'pooled evaluation fails mixed expected/wrong-agent campaigns');
  assertEq(
    mixedPooled.reproducible_unexpected_agent_regressions[0]?.selected,
    'tester',
    'pooled evaluation identifies the wrong agent hidden beside an expected agent',
  );
  let insufficientRejected = false;
  try {
    evaluatePooledCampaigns(baseline.slice(0, 2), candidate);
  } catch (error) {
    insufficientRejected = /at least 3/.test(error?.message || '');
  }
  assert(insufficientRejected,
    'pooled evaluator rejects fewer than three baseline campaigns');
  const equivalentCandidate = Array.from({ length: 3 }, () => campaign({
    classifications: ['exact', 'exact'],
    selected: [['coder'], ['coder']],
  }));
  const pooledPass = evaluatePooledCampaigns(baseline, equivalentCandidate, {
    nonInferiorityMargin: 0,
  });
  assertEq(pooledPass.status, 'passed',
    'equal repeated campaigns pass pooled non-inferiority');
  assertEq(pooledPass.reproducible_unexpected_agent_regressions.length, 0,
    'equal repeated campaigns have no new reproducible unexpected-agent regression');
  const repeatedDocument = campaign({
    classifications: ['exact', 'exact'],
    selected: [['coder'], ['coder']],
  });
  const clonedBaseline = Array.from(
    { length: 3 },
    () => JSON.parse(JSON.stringify(repeatedDocument)),
  );
  let clonedRunsRejected = false;
  try {
    evaluatePooledCampaigns(clonedBaseline, equivalentCandidate);
  } catch (error) {
    clonedRunsRejected = /duplicate run_id/.test(error?.message || '');
  }
  assert(clonedRunsRejected,
    'cloning one evidence document cannot satisfy repeated baseline campaigns');
  const crossCohortDuplicate = cloneCampaignsWithFreshRunIds(equivalentCandidate);
  crossCohortDuplicate[0].run_id = baseline[0].run_id;
  let crossCohortDuplicateRejected = false;
  try {
    evaluatePooledCampaigns(baseline, crossCohortDuplicate);
  } catch (error) {
    crossCohortDuplicateRejected = /duplicate run_id/.test(error?.message || '');
  }
  assert(crossCohortDuplicateRejected,
    'pooled evaluator rejects a run identity reused between cohorts');
  const changedDescriptionCandidate = Array.from({ length: 3 }, () => campaign({
    agentDescriptionsSha256: 'f'.repeat(64),
    classifications: ['exact', 'exact'],
    selected: [['coder'], ['coder']],
  }));
  const changedDescriptionResult = evaluatePooledCampaigns(
    baseline,
    changedDescriptionCandidate,
    { nonInferiorityMargin: 0 },
  );
  assertEq(changedDescriptionResult.status, 'passed',
    'uniform cohorts with distinct agent-description subjects remain comparable');
  assertEq(changedDescriptionResult.subject_hashes.baseline, 'd'.repeat(64),
    'pooled result exposes the baseline agent-description subject hash');
  assertEq(changedDescriptionResult.subject_hashes.candidate, 'f'.repeat(64),
    'pooled result exposes the candidate agent-description subject hash');

  for (const cohort of ['baseline', 'candidate']) {
    const mixedBaseline = JSON.parse(JSON.stringify(baseline));
    const mixedCandidate = JSON.parse(JSON.stringify(changedDescriptionCandidate));
    const mixed = cohort === 'baseline' ? mixedBaseline : mixedCandidate;
    mixed[1].run.agent_descriptions_sha256 = 'e'.repeat(64);
    let mixedSubjectRejected = false;
    try {
      evaluatePooledCampaigns(mixedBaseline, mixedCandidate);
    } catch (error) {
      mixedSubjectRejected = new RegExp(
        `${cohort} cohort agent descriptions SHA-256 differs`,
      ).test(error?.message || '');
    }
    assert(mixedSubjectRejected,
      `pooled evaluator rejects mixed agent-description hashes inside ${cohort} cohort`);
  }

  console.log('\n8. pooled evaluator rejects environment and corpus drift');
  const pathVariedCandidate = cloneCampaignsWithFreshRunIds(baseline);
  pathVariedCandidate.forEach((document, index) => {
    document.run.cli.path = `/host-${index + 1}/bin/claude`;
    document.run.entrypoint_map.path = `/host-${index + 1}/repo/model-map.json`;
  });
  assertEq(
    evaluatePooledCampaigns(baseline, pathVariedCandidate).status,
    'passed',
    'host-local CLI and map paths do not make otherwise identical cohorts incomparable',
  );
  const driftCases = [
    {
      label: 'Claude CLI version',
      pattern: /Claude CLI version differs/,
      mutate(document) {
        document.run.cli.version = '2.1.221 (Claude Code)';
      },
    },
    {
      label: 'entrypoint map hash',
      pattern: /entrypoint map SHA-256 differs/,
      createCandidate() {
        return Array.from({ length: 3 }, () => campaign({
          entrypointMapSha256: 'b'.repeat(64),
        }));
      },
    },
    {
      label: 'selection corpus hash',
      pattern: /selection corpus SHA-256 differs/,
      mutate(document) {
        document.run.selection_corpus_sha256 = 'e'.repeat(64);
      },
    },
    {
      label: 'threshold',
      pattern: /quality threshold differs/,
      mutate(document) {
        document.quality.threshold = 0.75;
      },
    },
    {
      label: 'fixture id',
      pattern: /fixture id\/expected contract differs/,
      mutate(document) {
        document.fixtures[0].id = 'different-fixture';
      },
    },
    {
      label: 'fixture expected set',
      pattern: /fixture id\/expected contract differs/,
      mutate(document) {
        document.fixtures[0].expected = ['tester'];
        document.fixtures[0].selected = ['tester'];
        document.fixtures[0].route_observations[0].incoming_model = 'tester';
        document.fixtures[0].route_observations[0].logical_role = 'tester';
        document.fixtures[0].route_observations[0].resolved_model = 'tester-resolved';
      },
    },
  ];
  for (const driftCase of driftCases) {
    const driftedCandidate = driftCase.createCandidate
      ? driftCase.createCandidate()
      : cloneCampaignsWithFreshRunIds(baseline);
    if (!driftCase.createCandidate) driftCase.mutate(driftedCandidate[0]);
    let rejected = false;
    try {
      evaluatePooledCampaigns(baseline, driftedCandidate);
    } catch (error) {
      rejected = driftCase.pattern.test(error?.message || '');
    }
    assert(rejected, `pooled evaluator rejects ${driftCase.label} drift`);
  }

  const executionDriftCases = [
    {
      label: 'requested LLM mode',
      pattern: /requested LLM mode differs/,
      coordinates: { requestedLlmMode: 'best-local-oss' },
    },
    {
      label: 'effective LLM mode',
      pattern: /effective LLM mode differs/,
      coordinates: { effectiveLlmMode: 'best-local-oss' },
    },
    {
      label: 'requested LLM profile',
      pattern: /requested LLM profile differs/,
      coordinates: { requestedLlmProfile: '64gb' },
    },
    {
      label: 'effective LLM profile',
      pattern: /effective LLM profile differs/,
      coordinates: { effectiveLlmProfile: '64gb' },
    },
    {
      label: 'launch route',
      pattern: /launch route differs/,
      coordinates: { launchRoute: 'background' },
    },
    {
      label: 'resolved parent model',
      pattern: /resolved parent model differs/,
      coordinates: { resolvedModel: 'claude-parent-other' },
    },
    {
      label: 'resolved parent backend',
      pattern: /resolved parent backend differs/,
      coordinates: { backendId: 'openrouter' },
    },
  ];
  for (const driftCase of executionDriftCases) {
    const driftedCandidate = Array.from({ length: 3 }, () => campaign({
      executionCoordinates: {
        ...DEFAULT_EXECUTION_COORDINATES,
        ...driftCase.coordinates,
      },
    }));
    let rejected = false;
    try {
      evaluatePooledCampaigns(baseline, driftedCandidate);
    } catch (error) {
      rejected = driftCase.pattern.test(error?.message || '');
    }
    assert(rejected, `pooled evaluator rejects ${driftCase.label} drift`);
  }

  console.log('\n9. pooled evaluator binds repeated selected agents to stable child routes');
  const childRouteBaseline = coderChildRouteCohort({
    resolvedModel: 'coder-a',
    backendId: 'anthropic',
  });
  const driftedChildRouteCandidate = coderChildRouteCohort({
    resolvedModel: 'coder-b',
    backendId: 'openrouter',
  });
  let childRouteDriftRejected = false;
  try {
    evaluatePooledCampaigns(childRouteBaseline, driftedChildRouteCandidate);
  } catch (error) {
    childRouteDriftRejected = /child route identity differs/.test(
      error?.message || '',
    );
  }
  assert(childRouteDriftRejected,
    'pooled evaluator rejects coder anthropic/coder-a to openrouter/coder-b drift');

  const missingSelectedRouteCandidate = cloneCampaignsWithFreshRunIds(
    childRouteBaseline,
  );
  for (const document of missingSelectedRouteCandidate) {
    document.fixtures[0].route_observations = [];
  }
  let missingSelectedRouteRejected = false;
  try {
    evaluatePooledCampaigns(
      childRouteBaseline,
      missingSelectedRouteCandidate,
      { nonInferiorityMargin: 0 },
    );
  } catch (error) {
    missingSelectedRouteRejected =
      /complete matching child route observation/.test(error?.message || '');
  }
  assert(missingSelectedRouteRejected,
    'pooled evaluator rejects selected agents whose route observations are missing');

  const incompleteSelectedRouteBaseline = cloneCampaignsWithFreshRunIds(
    childRouteBaseline,
  );
  const incompleteSelectedRouteCandidate = cloneCampaignsWithFreshRunIds(
    childRouteBaseline,
  );
  for (const document of [
    ...incompleteSelectedRouteBaseline,
    ...incompleteSelectedRouteCandidate,
  ]) {
    document.fixtures[0].route_observations[0].backend_id = null;
  }
  let incompleteSelectedRouteRejected = false;
  try {
    evaluatePooledCampaigns(
      incompleteSelectedRouteBaseline,
      incompleteSelectedRouteCandidate,
      { nonInferiorityMargin: 0 },
    );
  } catch (error) {
    incompleteSelectedRouteRejected =
      /complete matching child route observation/.test(error?.message || '');
  }
  assert(incompleteSelectedRouteRejected,
    'pooled evaluator rejects selected agents whose route identity is incomplete');

  const childRouteValueDrifts = [
    {
      label: 'child backend format',
      route: {
        resolvedModel: 'coder-a',
        backendId: 'anthropic',
        backendFormat: 'openai',
      },
    },
    {
      label: 'child LLM mode',
      route: {
        resolvedModel: 'coder-a',
        backendId: 'anthropic',
        llmMode: 'best-local-oss',
      },
    },
    {
      label: 'child LLM profile',
      route: {
        resolvedModel: 'coder-a',
        backendId: 'anthropic',
        llmProfile: '64gb',
      },
    },
  ];
  for (const driftCase of childRouteValueDrifts) {
    let childValueDriftRejected = false;
    try {
      evaluatePooledCampaigns(
        childRouteBaseline,
        coderChildRouteCohort(driftCase.route),
      );
    } catch (error) {
      childValueDriftRejected = /child route identity differs/.test(
        error?.message || '',
      );
    }
    assert(childValueDriftRejected,
      `pooled evaluator rejects ${driftCase.label} drift`);
  }

  let childIncomingModelDriftRejected = false;
  try {
    evaluatePooledCampaigns(
      childRouteBaseline,
      coderChildRouteCohort({
        resolvedModel: 'coder-a',
        backendId: 'anthropic',
        incomingModel: 'coder-route-alias',
        logicalRole: 'coder',
      }),
    );
  } catch (error) {
    childIncomingModelDriftRejected = /child route identity differs/.test(
      error?.message || '',
    );
  }
  assert(childIncomingModelDriftRejected,
    'pooled evaluator rejects selected child incoming-model drift');

  const logicalRoleMatchedBaseline = coderChildRouteCohort({
    resolvedModel: 'coder-a',
    backendId: 'anthropic',
    incomingModel: 'coder-route-alias',
    logicalRole: 'coder',
  });
  const logicalRoleMatchedCandidate = cloneCampaignsWithFreshRunIds(
    logicalRoleMatchedBaseline,
  );
  assertEq(
    evaluatePooledCampaigns(
      logicalRoleMatchedBaseline,
      logicalRoleMatchedCandidate,
      { nonInferiorityMargin: 0 },
    ).status,
    'passed',
    'logical-role linkage compares a stable selected child whose incoming model is an alias',
  );

  const matchingChildRouteCandidate = coderChildRouteCohort({
    resolvedModel: 'coder-a',
    backendId: 'anthropic',
  });
  assertEq(
    evaluatePooledCampaigns(
      childRouteBaseline,
      matchingChildRouteCandidate,
      { nonInferiorityMargin: 0 },
    ).status,
    'passed',
    'three-by-three campaigns with a stable selected coder child route pass',
  );

  for (const cohort of ['baseline', 'candidate']) {
    const stableBaseline = coderChildRouteCohort({
      resolvedModel: 'coder-a',
      backendId: 'anthropic',
    });
    const stableCandidate = coderChildRouteCohort({
      resolvedModel: 'coder-a',
      backendId: 'anthropic',
    });
    const conflicted = cohort === 'baseline' ? stableBaseline : stableCandidate;
    setCoderChildRoute(conflicted[1], {
      resolvedModel: 'coder-b',
      backendId: 'openrouter',
    });
    let withinCohortConflictRejected = false;
    try {
      evaluatePooledCampaigns(stableBaseline, stableCandidate);
    } catch (error) {
      withinCohortConflictRejected = new RegExp(
        `${cohort} cohort child route identity differs`,
      ).test(error?.message || '');
    }
    assert(withinCohortConflictRejected,
      `pooled evaluator rejects selected child route conflicts within ${cohort}`);
  }

  const selectionVariableCandidate = [
    setCoderChildRoute(campaign(), {
      resolvedModel: 'coder-a',
      backendId: 'anthropic',
    }),
    campaign({
      classifications: ['no-offload'],
      selected: [[]],
    }),
    setCoderChildRoute(campaign(), {
      resolvedModel: 'coder-a',
      backendId: 'anthropic',
    }),
  ];
  assertEq(
    evaluatePooledCampaigns(
      childRouteBaseline,
      selectionVariableCandidate,
      { nonInferiorityMargin: 0.34 },
    ).status,
    'passed',
    'selection-dependent child-route absence does not make cohorts incomparable',
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

process.exit(summary() > 0 ? 1 : 0);
