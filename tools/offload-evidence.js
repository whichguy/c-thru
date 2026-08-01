#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;
const EVIDENCE_TYPE = 'c-thru.agent-offload';
const QUALITY_POLICIES = new Set(['advisory', 'single_run']);
const QUALITY_STATUSES = new Set(['passed', 'failed', 'not_evaluated']);
const INTEGRITY_STATUSES = new Set(['passed', 'failed']);
const CLASSIFICATIONS = new Set([
  'exact',
  'acceptable',
  'ambiguous-correct',
  'unexpected',
  'no-offload',
  'not_evaluated',
]);
const SCORED_CLASSIFICATIONS = new Set([
  'exact',
  'acceptable',
  'ambiguous-correct',
  'unexpected',
  'no-offload',
]);
const CORRECT_CLASSIFICATIONS = new Set([
  'exact',
  'acceptable',
  'ambiguous-correct',
]);
const FIXTURE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const INTEGRITY_REASON_RE = /^[a-z][a-z0-9_]{0,79}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLI_VERSION_RE =
  /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?(?: \([A-Za-z0-9 ._-]{1,80}\))?$/;
const EXECUTION_COORDINATE_RE = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,255}$/;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
}

function boundedAbsolutePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\0\r\n]/.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError(`${label} must be a bounded absolute path`);
  }
  return value;
}

function isoTimestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function cliVersion(value) {
  if (typeof value !== 'string' || !CLI_VERSION_RE.test(value)) {
    throw new TypeError('cliVersion must be a bounded semantic CLI version');
  }
  return value;
}

function finiteUnitInterval(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite number from 0 to 1`);
  }
  return value;
}

function sha256Digest(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function safeAgentList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = [];
  const seen = new Set();
  for (const agent of value) {
    if (typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) {
      throw new TypeError(`${label} contains an invalid agent name`);
    }
    if (!seen.has(agent)) {
      seen.add(agent);
      result.push(agent);
    }
  }
  return result;
}

function safeIntegrityReasons(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = [];
  const seen = new Set();
  for (const reason of value) {
    if (typeof reason !== 'string' || !INTEGRITY_REASON_RE.test(reason)) {
      throw new TypeError(`${label} contains an invalid integrity reason`);
    }
    if (!seen.has(reason)) {
      seen.add(reason);
      result.push(reason);
    }
  }
  return result;
}

function nullableExecutionCoordinate(value, label) {
  if (value == null) return null;
  if (
    typeof value !== 'string' ||
    !EXECUTION_COORDINATE_RE.test(value)
  ) {
    throw new TypeError(`${label} must be null or a sanitized execution coordinate`);
  }
  return value;
}

function routeIdentitySha256(entrypointMapSha256, execution) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      entrypoint_map_sha256: entrypointMapSha256,
      requested_llm_mode: execution.requested_llm_mode,
      effective_llm_mode: execution.effective_llm_mode,
      requested_llm_profile: execution.requested_llm_profile,
      effective_llm_profile: execution.effective_llm_profile,
      route: {
        launch_route: execution.route.launch_route,
        requested_model: execution.route.requested_model,
        resolved_model: execution.route.resolved_model,
        backend_id: execution.route.backend_id,
        backend_format: execution.route.backend_format,
      },
    }))
    .digest('hex');
}

function buildExecutionCoordinates(value, entrypointMapSha256) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('executionCoordinates must be an object');
  }
  const execution = {
    requested_llm_mode: nullableExecutionCoordinate(
      value.requestedLlmMode,
      'executionCoordinates.requestedLlmMode',
    ),
    effective_llm_mode: nullableExecutionCoordinate(
      value.effectiveLlmMode,
      'executionCoordinates.effectiveLlmMode',
    ),
    requested_llm_profile: nullableExecutionCoordinate(
      value.requestedLlmProfile,
      'executionCoordinates.requestedLlmProfile',
    ),
    effective_llm_profile: nullableExecutionCoordinate(
      value.effectiveLlmProfile,
      'executionCoordinates.effectiveLlmProfile',
    ),
    route: {
      launch_route: nullableExecutionCoordinate(
        value.launchRoute,
        'executionCoordinates.launchRoute',
      ),
      requested_model: nullableExecutionCoordinate(
        value.requestedModel,
        'executionCoordinates.requestedModel',
      ),
      resolved_model: nullableExecutionCoordinate(
        value.resolvedModel,
        'executionCoordinates.resolvedModel',
      ),
      backend_id: nullableExecutionCoordinate(
        value.backendId,
        'executionCoordinates.backendId',
      ),
      backend_format: nullableExecutionCoordinate(
        value.backendFormat,
        'executionCoordinates.backendFormat',
      ),
      identity_sha256: null,
    },
  };
  execution.route.identity_sha256 = routeIdentitySha256(
    entrypointMapSha256,
    execution,
  );
  return execution;
}

function validateExecutionCoordinates(value, entrypointMapSha256) {
  exactKeys(value, [
    'requested_llm_mode',
    'effective_llm_mode',
    'requested_llm_profile',
    'effective_llm_profile',
    'route',
  ], 'evidence.run.execution');
  for (const key of [
    'requested_llm_mode',
    'effective_llm_mode',
    'requested_llm_profile',
    'effective_llm_profile',
  ]) {
    nullableExecutionCoordinate(value[key], `evidence.run.execution.${key}`);
  }
  exactKeys(value.route, [
    'launch_route',
    'requested_model',
    'resolved_model',
    'backend_id',
    'backend_format',
    'identity_sha256',
  ], 'evidence.run.execution.route');
  for (const key of [
    'launch_route',
    'requested_model',
    'resolved_model',
    'backend_id',
    'backend_format',
  ]) {
    nullableExecutionCoordinate(
      value.route[key],
      `evidence.run.execution.route.${key}`,
    );
  }
  sha256Digest(
    value.route.identity_sha256,
    'evidence.run.execution.route.identity_sha256',
  );
  if (
    value.route.identity_sha256 !==
    routeIdentitySha256(entrypointMapSha256, value)
  ) {
    throw new TypeError('evidence route identity does not match execution coordinates');
  }
  return value;
}

function projectRouteObservation(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return {
    incoming_model: nullableExecutionCoordinate(
      value.incomingModel,
      `${label}.incomingModel`,
    ),
    resolved_model: nullableExecutionCoordinate(
      value.resolvedModel,
      `${label}.resolvedModel`,
    ),
    backend_id: nullableExecutionCoordinate(
      value.backendId,
      `${label}.backendId`,
    ),
    backend_format: nullableExecutionCoordinate(
      value.backendFormat,
      `${label}.backendFormat`,
    ),
    logical_role: nullableExecutionCoordinate(
      value.logicalRole,
      `${label}.logicalRole`,
    ),
    llm_mode: nullableExecutionCoordinate(
      value.llmMode,
      `${label}.llmMode`,
    ),
    llm_profile: nullableExecutionCoordinate(
      value.llmProfile,
      `${label}.llmProfile`,
    ),
  };
}

function safeRouteObservations(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > 256) {
    throw new RangeError(`${label} exceeds the maximum observation count`);
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const observation = projectRouteObservation(value[index], `${label}[${index}]`);
    const key = JSON.stringify(observation);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(observation);
    }
  }
  return result;
}

const COMPLETE_CHILD_ROUTE_FIELDS = Object.freeze([
  'incoming_model',
  'resolved_model',
  'backend_id',
  'backend_format',
  'logical_role',
  'llm_mode',
  'llm_profile',
]);

function assertSelectedRouteObservations(
  selected,
  routeProof,
  routeObservations,
  label,
) {
  if (!routeProof) return;
  for (const agent of selected) {
    const completeMatch = routeObservations.some(observation => (
      (
        observation.incoming_model === agent ||
        observation.logical_role === agent
      ) &&
      COMPLETE_CHILD_ROUTE_FIELDS.every(field => observation[field] !== null)
    ));
    if (!completeMatch) {
      throw new TypeError(
        `${label} route proof requires a complete matching child route observation ` +
        `for selected agent ${agent}`,
      );
    }
  }
}

function projectFixtureRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`fixtureRecords[${index}] must be an object`);
  }
  const id = record.id;
  if (typeof id !== 'string' || !FIXTURE_ID_RE.test(id)) {
    throw new TypeError(`fixtureRecords[${index}].id is invalid`);
  }
  const expected = safeAgentList(record.expected, `fixtureRecords[${index}].expected`);
  const selected = safeAgentList(record.selected, `fixtureRecords[${index}].selected`);
  const classification = record.classification;
  if (!CLASSIFICATIONS.has(classification)) {
    throw new TypeError(`fixtureRecords[${index}].classification is invalid`);
  }
  const integrityReason = record.integrityReason == null
    ? null
    : record.integrityReason;
  if (
    integrityReason !== null &&
    (typeof integrityReason !== 'string' || !INTEGRITY_REASON_RE.test(integrityReason))
  ) {
    throw new TypeError(`fixtureRecords[${index}].integrityReason is invalid`);
  }
  if (typeof record.routeProof !== 'boolean') {
    throw new TypeError(`fixtureRecords[${index}].routeProof must be boolean`);
  }
  const routeObservations = safeRouteObservations(
    record.routeObservations || [],
    `fixtureRecords[${index}].routeObservations`,
  );
  assertSelectedRouteObservations(
    selected,
    record.routeProof,
    routeObservations,
    `fixtureRecords[${index}]`,
  );
  if (integrityReason !== null && classification !== 'not_evaluated') {
    throw new TypeError(
      `fixtureRecords[${index}] integrity failure must be not_evaluated`,
    );
  }
  if (classification === 'not_evaluated' && integrityReason === null) {
    throw new TypeError(
      `fixtureRecords[${index}] not_evaluated requires an integrity reason`,
    );
  }
  if (integrityReason === 'route_proof_failed' && record.routeProof) {
    throw new TypeError(
      `fixtureRecords[${index}] failed route proof cannot be true`,
    );
  }
  if (
    integrityReason !== null &&
    record.routeProof &&
    integrityReason !== 'completion_proof_failed'
  ) {
    throw new TypeError(
      `fixtureRecords[${index}] integrity reason cannot claim route proof`,
    );
  }
  const projected = {
    id,
    expected,
    selected,
    classification,
    integrity_reason: integrityReason,
    route_observations: routeObservations,
    route_proof: record.routeProof,
  };
  const selectedExpected = selected.filter(agent => expected.includes(agent));
  const selectedUnexpected = selected.filter(agent => !expected.includes(agent));
  if (classification === 'exact') {
    if (
      !expected.length ||
      !selected.includes(expected[0]) ||
      selectedUnexpected.length ||
      !record.routeProof
    ) {
      throw new TypeError(`fixtureRecords[${index}] exact classification is inconsistent`);
    }
  } else if (classification === 'acceptable') {
    if (
      expected.length < 2 ||
      selected.includes(expected[0]) ||
      !selectedExpected.length ||
      selectedUnexpected.length ||
      !record.routeProof
    ) {
      throw new TypeError(
        `fixtureRecords[${index}] acceptable classification is inconsistent`,
      );
    }
  } else if (classification === 'unexpected') {
    if (!selectedUnexpected.length || !record.routeProof) {
      throw new TypeError(
        `fixtureRecords[${index}] unexpected classification is inconsistent`,
      );
    }
  } else if (classification === 'no-offload') {
    if (!expected.length || selected.length || record.routeProof) {
      throw new TypeError(
        `fixtureRecords[${index}] no-offload classification is inconsistent`,
      );
    }
  } else if (classification === 'ambiguous-correct') {
    if (selected.length || record.routeProof) {
      throw new TypeError(
        `fixtureRecords[${index}] ambiguous-correct classification is inconsistent`,
      );
    }
  } else if (
    classification === 'not_evaluated' &&
    integrityReason === 'completion_proof_failed' &&
    (!selected.length || !record.routeProof)
  ) {
    throw new TypeError(
      `fixtureRecords[${index}] completion proof failure requires route proof`,
    );
  }
  return projected;
}

function qualityPolicyFromEnv(env = process.env) {
  return env.C_THRU_OFFLOAD_GATE === '1' ? 'single_run' : 'advisory';
}

function buildOffloadEvidence(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('offload evidence options must be an object');
  }
  const startedAt = isoTimestamp(options.startedAt, 'startedAt');
  const finishedAt = isoTimestamp(options.finishedAt, 'finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new RangeError('finishedAt must not precede startedAt');
  }
  const policy = options.qualityPolicy;
  if (!QUALITY_POLICIES.has(policy)) {
    throw new TypeError('qualityPolicy must be advisory or single_run');
  }
  const threshold = finiteUnitInterval(options.threshold, 'threshold');
  const primaryNeverSelected = safeAgentList(
    options.primaryNeverSelected || [],
    'primaryNeverSelected',
  ).sort();
  const runIntegrityReasons = safeIntegrityReasons(
    options.runIntegrityReasons || [],
    'runIntegrityReasons',
  );
  if (!Array.isArray(options.fixtureRecords)) {
    throw new TypeError('fixtureRecords must be an array');
  }
  const fixtures = options.fixtureRecords.map(projectFixtureRecord);
  const fixtureIds = new Set();
  for (const fixture of fixtures) {
    if (fixtureIds.has(fixture.id)) {
      throw new TypeError(`duplicate fixture id: ${fixture.id}`);
    }
    fixtureIds.add(fixture.id);
  }

  if (fixtures.length === 0 && !runIntegrityReasons.includes('no_fixtures_selected')) {
    runIntegrityReasons.push('no_fixtures_selected');
  }
  const fixtureIntegrityReasons = fixtures
    .map(fixture => fixture.integrity_reason)
    .filter(Boolean);
  let scored = 0;
  let correct = 0;
  for (const fixture of fixtures) {
    if (SCORED_CLASSIFICATIONS.has(fixture.classification)) scored += 1;
    if (CORRECT_CLASSIFICATIONS.has(fixture.classification)) correct += 1;
  }
  if (
    scored === 0 &&
    fixtureIntegrityReasons.length === 0 &&
    !runIntegrityReasons.length
  ) {
    runIntegrityReasons.push('no_fixtures_scored');
  }
  const integrityReasons = safeIntegrityReasons(
    [...runIntegrityReasons, ...fixtureIntegrityReasons],
    'integrityReasons',
  );
  const integrityStatus = integrityReasons.length ? 'failed' : 'passed';
  const accuracy = integrityStatus === 'passed' && scored > 0
    ? correct / scored
    : null;
  const thresholdMet = accuracy === null ? null : accuracy >= threshold;
  const qualityStatus = integrityStatus === 'failed'
    ? 'not_evaluated'
    : thresholdMet && primaryNeverSelected.length === 0
      ? 'passed'
      : 'failed';
  const entrypointMapSha256 = sha256Digest(
    options.entrypointMapSha256,
    'entrypointMapSha256',
  );
  const execution = buildExecutionCoordinates(
    options.executionCoordinates,
    entrypointMapSha256,
  );

  const document = {
    schema_version: SCHEMA_VERSION,
    evidence_type: EVIDENCE_TYPE,
    run_id: canonicalUuid(options.runId, 'runId'),
    run: {
      started_at: startedAt,
      finished_at: finishedAt,
      cli: {
        path: boundedAbsolutePath(options.cliPath, 'cliPath'),
        version: cliVersion(options.cliVersion),
      },
      entrypoint_map: {
        path: boundedAbsolutePath(options.entrypointMapPath, 'entrypointMapPath'),
        sha256: entrypointMapSha256,
      },
      execution,
      selection_corpus_sha256: sha256Digest(
        options.selectionCorpusSha256,
        'selectionCorpusSha256',
      ),
      agent_descriptions_sha256: sha256Digest(
        options.agentDescriptionsSha256,
        'agentDescriptionsSha256',
      ),
    },
    quality_policy: policy,
    integrity_status: integrityStatus,
    quality_status: qualityStatus,
    integrity_reasons: integrityReasons,
    quality: {
      scored,
      correct,
      accuracy,
      threshold,
      threshold_met: thresholdMet,
      primary_never_selected: primaryNeverSelected,
    },
    fixtures,
  };
  validateEvidenceDocument(document);
  return document;
}

function validateEvidenceDocument(document) {
  exactKeys(document, [
    'schema_version',
    'evidence_type',
    'run_id',
    'run',
    'quality_policy',
    'integrity_status',
    'quality_status',
    'integrity_reasons',
    'quality',
    'fixtures',
  ], 'evidence');
  if (document.schema_version !== SCHEMA_VERSION) {
    throw new TypeError(`unsupported evidence schema version: ${document.schema_version}`);
  }
  if (document.evidence_type !== EVIDENCE_TYPE) {
    throw new TypeError('unsupported evidence type');
  }
  canonicalUuid(document.run_id, 'evidence.run_id');
  if (!QUALITY_POLICIES.has(document.quality_policy)) {
    throw new TypeError('invalid evidence quality policy');
  }
  if (!INTEGRITY_STATUSES.has(document.integrity_status)) {
    throw new TypeError('invalid evidence integrity status');
  }
  if (!QUALITY_STATUSES.has(document.quality_status)) {
    throw new TypeError('invalid evidence quality status');
  }
  exactKeys(document.run, [
    'started_at',
    'finished_at',
    'cli',
    'entrypoint_map',
    'execution',
    'selection_corpus_sha256',
    'agent_descriptions_sha256',
  ], 'evidence.run');
  isoTimestamp(document.run.started_at, 'evidence.run.started_at');
  isoTimestamp(document.run.finished_at, 'evidence.run.finished_at');
  if (Date.parse(document.run.finished_at) < Date.parse(document.run.started_at)) {
    throw new RangeError('evidence run finished before it started');
  }
  exactKeys(document.run.cli, ['path', 'version'], 'evidence.run.cli');
  boundedAbsolutePath(document.run.cli.path, 'evidence.run.cli.path');
  cliVersion(document.run.cli.version);
  exactKeys(
    document.run.entrypoint_map,
    ['path', 'sha256'],
    'evidence.run.entrypoint_map',
  );
  boundedAbsolutePath(
    document.run.entrypoint_map.path,
    'evidence.run.entrypoint_map.path',
  );
  sha256Digest(
    document.run.entrypoint_map.sha256,
    'evidence.run.entrypoint_map.sha256',
  );
  validateExecutionCoordinates(
    document.run.execution,
    document.run.entrypoint_map.sha256,
  );
  sha256Digest(
    document.run.selection_corpus_sha256,
    'evidence.run.selection_corpus_sha256',
  );
  sha256Digest(
    document.run.agent_descriptions_sha256,
    'evidence.run.agent_descriptions_sha256',
  );
  const integrityReasons = safeIntegrityReasons(
    document.integrity_reasons,
    'evidence.integrity_reasons',
  );
  exactKeys(document.quality, [
    'scored',
    'correct',
    'accuracy',
    'threshold',
    'threshold_met',
    'primary_never_selected',
  ], 'evidence.quality');
  for (const key of ['scored', 'correct']) {
    if (!Number.isSafeInteger(document.quality[key]) || document.quality[key] < 0) {
      throw new TypeError(`evidence.quality.${key} must be a nonnegative integer`);
    }
  }
  if (document.quality.correct > document.quality.scored) {
    throw new TypeError('evidence correct count exceeds scored count');
  }
  if (document.quality.accuracy !== null) {
    finiteUnitInterval(document.quality.accuracy, 'evidence.quality.accuracy');
  }
  finiteUnitInterval(document.quality.threshold, 'evidence.quality.threshold');
  if (
    document.quality.threshold_met !== null &&
    typeof document.quality.threshold_met !== 'boolean'
  ) {
    throw new TypeError('evidence.quality.threshold_met must be boolean or null');
  }
  safeAgentList(
    document.quality.primary_never_selected,
    'evidence.quality.primary_never_selected',
  );
  if (!Array.isArray(document.fixtures)) {
    throw new TypeError('evidence.fixtures must be an array');
  }
  const ids = new Set();
  let scored = 0;
  let correct = 0;
  const fixtureReasons = [];
  for (let index = 0; index < document.fixtures.length; index += 1) {
    const fixture = document.fixtures[index];
    exactKeys(fixture, [
      'id',
      'expected',
      'selected',
      'classification',
      'integrity_reason',
      'route_observations',
      'route_proof',
    ], `evidence.fixtures[${index}]`);
    const projected = projectFixtureRecord({
      id: fixture.id,
      expected: fixture.expected,
      selected: fixture.selected,
      classification: fixture.classification,
      integrityReason: fixture.integrity_reason,
      routeObservations: fixture.route_observations.map((observation, routeIndex) => {
        exactKeys(observation, [
          'incoming_model',
          'resolved_model',
          'backend_id',
          'backend_format',
          'logical_role',
          'llm_mode',
          'llm_profile',
        ], `evidence.fixtures[${index}].route_observations[${routeIndex}]`);
        return {
          incomingModel: observation.incoming_model,
          resolvedModel: observation.resolved_model,
          backendId: observation.backend_id,
          backendFormat: observation.backend_format,
          logicalRole: observation.logical_role,
          llmMode: observation.llm_mode,
          llmProfile: observation.llm_profile,
        };
      }),
      routeProof: fixture.route_proof,
    }, index);
    if (ids.has(projected.id)) throw new TypeError(`duplicate fixture id: ${projected.id}`);
    ids.add(projected.id);
    if (SCORED_CLASSIFICATIONS.has(projected.classification)) scored += 1;
    if (CORRECT_CLASSIFICATIONS.has(projected.classification)) correct += 1;
    if (projected.integrity_reason) fixtureReasons.push(projected.integrity_reason);
  }
  if (document.quality.scored !== scored || document.quality.correct !== correct) {
    throw new TypeError('evidence quality counts do not match fixture classifications');
  }
  if (fixtureReasons.some(reason => !integrityReasons.includes(reason))) {
    throw new TypeError('evidence fixture integrity reason is missing from run summary');
  }
  const shouldFailIntegrity = integrityReasons.length > 0 || fixtureReasons.length > 0;
  if ((document.integrity_status === 'failed') !== shouldFailIntegrity) {
    throw new TypeError('evidence integrity status disagrees with integrity reasons');
  }
  if (document.integrity_status === 'failed') {
    if (
      document.quality_status !== 'not_evaluated' ||
      document.quality.accuracy !== null ||
      document.quality.threshold_met !== null
    ) {
      throw new TypeError('failed integrity must leave quality not_evaluated');
    }
  } else {
    const accuracy = scored ? correct / scored : null;
    if (accuracy === null || document.quality.accuracy !== accuracy) {
      throw new TypeError('evidence accuracy does not match fixture classifications');
    }
    const thresholdMet = accuracy >= document.quality.threshold;
    if (document.quality.threshold_met !== thresholdMet) {
      throw new TypeError('evidence threshold result does not match accuracy');
    }
    const shouldPassQuality = (
      thresholdMet &&
      document.quality.primary_never_selected.length === 0
    );
    if ((document.quality_status === 'passed') !== shouldPassQuality) {
      throw new TypeError('evidence quality status disagrees with quality signals');
    }
  }
  return true;
}

function writeEvidenceAtomic(destination, document, options = {}) {
  const fsImpl = options.fs || fs;
  validateEvidenceDocument(document);
  const target = path.resolve(destination);
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  );
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  let fd = null;
  let renamed = false;
  try {
    fd = fsImpl.openSync(temporary, 'wx', 0o600);
    fsImpl.writeFileSync(fd, payload, 'utf8');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(temporary, target);
    renamed = true;
    fsImpl.chmodSync(target, 0o600);
    let directoryFd = null;
    try {
      directoryFd = fsImpl.openSync(directory, 'r');
      fsImpl.fsyncSync(directoryFd);
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
    } finally {
      if (directoryFd !== null) fsImpl.closeSync(directoryFd);
    }
  } finally {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch {}
    }
    if (!renamed) {
      try { fsImpl.unlinkSync(temporary); } catch {}
    }
  }
  return target;
}

function pooledCounts(documents) {
  let scored = 0;
  let correct = 0;
  for (const document of documents) {
    validateEvidenceDocument(document);
    if (document.integrity_status !== 'passed') {
      throw new TypeError('pooled campaigns require passed integrity evidence');
    }
    scored += document.quality.scored;
    correct += document.quality.correct;
  }
  if (scored === 0) throw new TypeError('pooled campaigns contain no scored fixtures');
  return {
    campaigns: documents.length,
    scored,
    correct,
    accuracy: correct / scored,
  };
}

function unexpectedCampaignCounts(documents) {
  const counts = new Map();
  for (const document of documents) {
    const seenThisCampaign = new Set();
    for (const fixture of document.fixtures) {
      if (fixture.classification !== 'unexpected') continue;
      const unexpected = fixture.selected.filter(
        agent => !fixture.expected.includes(agent),
      );
      for (const agent of unexpected) {
        seenThisCampaign.add(`${fixture.id}\0${agent}`);
      }
    }
    for (const key of seenThisCampaign) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function campaignContract(document) {
  validateEvidenceDocument(document);
  return {
    runId: document.run_id,
    cliVersion: document.run.cli.version,
    entrypointMapSha256: document.run.entrypoint_map.sha256,
    selectionCorpusSha256: document.run.selection_corpus_sha256,
    agentDescriptionsSha256: document.run.agent_descriptions_sha256,
    execution: {
      requestedLlmMode: document.run.execution.requested_llm_mode,
      effectiveLlmMode: document.run.execution.effective_llm_mode,
      requestedLlmProfile: document.run.execution.requested_llm_profile,
      effectiveLlmProfile: document.run.execution.effective_llm_profile,
      launchRoute: document.run.execution.route.launch_route,
      requestedModel: document.run.execution.route.requested_model,
      resolvedModel: document.run.execution.route.resolved_model,
      backendId: document.run.execution.route.backend_id,
      backendFormat: document.run.execution.route.backend_format,
      routeIdentitySha256: document.run.execution.route.identity_sha256,
    },
    threshold: document.quality.threshold,
    fixtures: document.fixtures
      .map(fixture => ({
        id: fixture.id,
        // Expected order is part of the contract because expect[0] is primary.
        expected: [...fixture.expected],
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function selectedChildRouteIdentities(documents, cohortName) {
  const identities = new Map();
  for (const document of documents) {
    for (const fixture of document.fixtures) {
      if (fixture.selected.length === 0) continue;
      for (const observation of fixture.route_observations) {
        const selectedAgent = fixture.selected.find(agent => (
          agent === observation.incoming_model ||
          agent === observation.logical_role
        ));
        if (!selectedAgent) continue;
        const key = JSON.stringify([
          fixture.id,
          selectedAgent,
        ]);
        const value = JSON.stringify([
          observation.incoming_model,
          observation.logical_role,
          observation.resolved_model,
          observation.backend_id,
          observation.backend_format,
          observation.llm_mode,
          observation.llm_profile,
        ]);
        const existing = identities.get(key);
        if (existing !== undefined && existing !== value) {
          throw new TypeError(
            `incomparable campaigns: ${cohortName} cohort child route identity differs`,
          );
        }
        if (existing === undefined) identities.set(key, value);
      }
    }
  }
  return identities;
}

function assertComparableCampaigns(baseline, candidate) {
  const baselineContracts = baseline.map(campaignContract);
  const candidateContracts = candidate.map(campaignContract);
  const runIds = new Set();
  for (const contract of [...baselineContracts, ...candidateContracts]) {
    if (runIds.has(contract.runId)) {
      throw new TypeError('pooled campaigns contain a duplicate run_id');
    }
    runIds.add(contract.runId);
  }
  const reference = baselineContracts[0];
  const referenceFixtures = JSON.stringify(reference.fixtures);
  for (const current of [
    ...baselineContracts.slice(1),
    ...candidateContracts,
  ]) {
    if (current.cliVersion !== reference.cliVersion) {
      throw new TypeError('incomparable campaigns: Claude CLI version differs');
    }
    if (current.entrypointMapSha256 !== reference.entrypointMapSha256) {
      throw new TypeError('incomparable campaigns: entrypoint map SHA-256 differs');
    }
    if (current.selectionCorpusSha256 !== reference.selectionCorpusSha256) {
      throw new TypeError('incomparable campaigns: selection corpus SHA-256 differs');
    }
    if (
      current.execution.requestedLlmMode !==
      reference.execution.requestedLlmMode
    ) {
      throw new TypeError('incomparable campaigns: requested LLM mode differs');
    }
    if (
      current.execution.effectiveLlmMode !==
      reference.execution.effectiveLlmMode
    ) {
      throw new TypeError('incomparable campaigns: effective LLM mode differs');
    }
    if (
      current.execution.requestedLlmProfile !==
      reference.execution.requestedLlmProfile
    ) {
      throw new TypeError('incomparable campaigns: requested LLM profile differs');
    }
    if (
      current.execution.effectiveLlmProfile !==
      reference.execution.effectiveLlmProfile
    ) {
      throw new TypeError('incomparable campaigns: effective LLM profile differs');
    }
    if (current.execution.launchRoute !== reference.execution.launchRoute) {
      throw new TypeError('incomparable campaigns: launch route differs');
    }
    if (
      current.execution.requestedModel !==
      reference.execution.requestedModel
    ) {
      throw new TypeError('incomparable campaigns: requested parent model differs');
    }
    if (
      current.execution.resolvedModel !==
      reference.execution.resolvedModel
    ) {
      throw new TypeError('incomparable campaigns: resolved parent model differs');
    }
    if (current.execution.backendId !== reference.execution.backendId) {
      throw new TypeError('incomparable campaigns: resolved parent backend differs');
    }
    if (
      current.execution.backendFormat !==
      reference.execution.backendFormat
    ) {
      throw new TypeError(
        'incomparable campaigns: resolved parent backend format differs',
      );
    }
    if (
      current.execution.routeIdentitySha256 !==
      reference.execution.routeIdentitySha256
    ) {
      throw new TypeError(
        'incomparable campaigns: route/config identity SHA-256 differs',
      );
    }
    if (current.threshold !== reference.threshold) {
      throw new TypeError('incomparable campaigns: quality threshold differs');
    }
    if (JSON.stringify(current.fixtures) !== referenceFixtures) {
      throw new TypeError('incomparable campaigns: fixture id/expected contract differs');
    }
  }
  for (const [cohortName, contracts] of [
    ['baseline', baselineContracts],
    ['candidate', candidateContracts],
  ]) {
    const subjectHash = contracts[0].agentDescriptionsSha256;
    if (contracts.some(contract => (
      contract.agentDescriptionsSha256 !== subjectHash
    ))) {
      throw new TypeError(
        `incomparable campaigns: ${cohortName} cohort agent descriptions SHA-256 differs`,
      );
    }
  }
  const baselineChildRoutes = selectedChildRouteIdentities(
    baseline,
    'baseline',
  );
  const candidateChildRoutes = selectedChildRouteIdentities(
    candidate,
    'candidate',
  );
  for (const [key, baselineRoute] of baselineChildRoutes) {
    if (
      candidateChildRoutes.has(key) &&
      candidateChildRoutes.get(key) !== baselineRoute
    ) {
      throw new TypeError(
        'incomparable campaigns: child route identity differs for the same ' +
        'fixture and selected logical agent',
      );
    }
  }
  return {
    baseline: baselineContracts[0].agentDescriptionsSha256,
    candidate: candidateContracts[0].agentDescriptionsSha256,
  };
}

function evaluatePooledCampaigns(baseline, candidate, options = {}) {
  if (!Array.isArray(baseline) || baseline.length < 3) {
    throw new RangeError('pooled evaluator requires at least 3 baseline campaigns');
  }
  if (!Array.isArray(candidate) || candidate.length < 3) {
    throw new RangeError('pooled evaluator requires at least 3 candidate campaigns');
  }
  const margin = options.nonInferiorityMargin == null
    ? 0.05
    : finiteUnitInterval(
      options.nonInferiorityMargin,
      'nonInferiorityMargin',
    );
  const subjectHashes = assertComparableCampaigns(baseline, candidate);
  const baselineCounts = pooledCounts(baseline);
  const candidateCounts = pooledCounts(candidate);
  const nonInferior = (
    candidateCounts.accuracy + margin >= baselineCounts.accuracy
  );
  const baselineUnexpected = unexpectedCampaignCounts(baseline);
  const candidateUnexpected = unexpectedCampaignCounts(candidate);
  const regressions = [];
  for (const [key, candidateCampaigns] of candidateUnexpected) {
    const baselineCampaigns = baselineUnexpected.get(key) || 0;
    if (candidateCampaigns < 2 || baselineCampaigns !== 0) continue;
    const separator = key.indexOf('\0');
    regressions.push({
      id: key.slice(0, separator),
      selected: key.slice(separator + 1),
      baseline_campaigns: baselineCampaigns,
      candidate_campaigns: candidateCampaigns,
    });
  }
  regressions.sort((left, right) => (
    left.id.localeCompare(right.id) ||
    left.selected.localeCompare(right.selected)
  ));
  return {
    status: nonInferior && regressions.length === 0 ? 'passed' : 'failed',
    required_campaigns_per_cohort: 3,
    non_inferiority_margin: margin,
    subject_hashes: subjectHashes,
    pooled: {
      baseline: baselineCounts,
      candidate: candidateCounts,
      non_inferior: nonInferior,
    },
    reproducible_unexpected_agent_regressions: regressions,
  };
}

module.exports = {
  EVIDENCE_TYPE,
  SCHEMA_VERSION,
  buildOffloadEvidence,
  evaluatePooledCampaigns,
  qualityPolicyFromEnv,
  validateEvidenceDocument,
  writeEvidenceAtomic,
};
