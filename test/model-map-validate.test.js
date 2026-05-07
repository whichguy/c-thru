#!/usr/bin/env node
'use strict';
// Schema validator golden corpus — tests validateConfig() directly via its
// exported errors-array API, plus one CLI process-spawn to confirm exit code.
// Run: node test/model-map-validate.test.js

const { spawnSync } = require('child_process');
const path = require('path');
const { validateConfig, validateRecommendedMappings } = require('../tools/model-map-validate.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

function validate(config, options) {
  const errors = [];
  validateConfig(config, errors, options);
  return errors;
}

// Minimal valid config used as a base throughout.
// Schema: llm_profiles[capability][mode][tier] (capability-outer, mode-middle,
// tier-innermost). Old tier-outer shape with connected_model/disconnect_model
// is no longer accepted by the validator — tests migrated 2026-05.
const VALID_BASE = {
  backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
  model_routes: { 'test-model': 'local' },
  llm_profiles: {
    workhorse: { 'best-cloud': { '16gb': 'test-model' } },
    judge:     { 'best-cloud': { '16gb': 'test-model' } },
  },
  llm_mode: 'best-cloud',
};

// ── 1. Valid config passes ─────────────────────────────────────────────────
console.log('1. Valid minimal config');
{
  const errs = validate(VALID_BASE);
  assert(errs.length === 0, 'valid config → no errors');
}

// ── 2. Invalid llm_mode value ──────────────────────────────────────────────
console.log('\n2. Invalid llm_mode value');
{
  const cfg = Object.assign({}, VALID_BASE, { llm_mode: 'totally-bogus-mode' });
  const errs = validate(cfg);
  assert(errs.length > 0, 'bad llm_mode → error');
  assert(errs.some(e => e.includes('llm_mode')), `error mentions llm_mode (got: ${errs[0]})`);
}

// ── 3. Route cycle detected ────────────────────────────────────────────────
console.log('\n3. Route cycle');
{
  const cfg = Object.assign({}, VALID_BASE, { routes: { a: 'b', b: 'a' } });
  const errs = validate(cfg);
  assert(errs.length > 0, 'route cycle → error');
  assert(errs.some(e => e.includes('cycle')), `error mentions cycle (got: ${errs[0]})`);
}

// ── 4. model_overrides maps key to itself ──────────────────────────────────
console.log('\n4. model_overrides self-map');
{
  const cfg = Object.assign({}, VALID_BASE, { model_overrides: { 'test-model': 'test-model' } });
  const errs = validate(cfg);
  assert(errs.length > 0, 'self-referencing override → error');
  assert(errs.some(e => e.includes('model_overrides')), `error mentions model_overrides (got: ${errs[0]})`);
}

// ── 5. agent_to_capability references unknown alias ────────────────────────
console.log('\n5. agent_to_capability unknown alias');
{
  const cfg = Object.assign({}, VALID_BASE, { agent_to_capability: { 'my-agent': 'nonexistent-alias' } });
  const errs = validate(cfg);
  assert(errs.length > 0, 'unknown capability alias → error');
  assert(errs.some(e => e.includes('agent_to_capability')), `error mentions agent_to_capability (got: ${errs[0]})`);
}

// ── 6. llm_profiles capability with no mode keys ──────────────────────────
console.log('\n6. llm_profiles capability with no mode keys');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'test-model': 'local' },
    llm_profiles: {
      workhorse: { on_failure: 'cascade' }, // only reserved key, no mode
    },
  };
  const errs = validate(cfg);
  assert(errs.length > 0, 'no mode keys → error');
  assert(errs.some(e => e.includes('no mode keys') || e.includes('mode')),
    `error mentions missing modes (got: ${errs[0]})`);
}

// ── 7. model_routes @sigil references undeclared backend ──────────────────
console.log('\n7. model_routes @backend sigil → undeclared backend');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'mymodel@ghost': 'local' }, // @ghost not in backends
  };
  const errs = validate(cfg);
  assert(errs.length > 0, '@undeclared backend → error');
  assert(errs.some(e => e.includes('ghost')), `error mentions the missing backend id (got: ${errs[0]})`);
}

// ── 8. llm_connectivity_mode legacy key → deprecation warning on stderr ───
console.log('\n8. llm_connectivity_mode deprecated key → stderr warning');
{
  // When llm_mode is absent + llm_connectivity_mode present → warning, no error
  // llm_connectivity_mode is a legacy key — its allowed values are the legacy
  // 'connected' / 'disconnect' (NOT the new llm_mode enum like 'best-cloud').
  const cfg = Object.assign({}, VALID_BASE, { llm_connectivity_mode: 'connected' });
  delete cfg.llm_mode;
  const warnLines = [];
  const origWarn = console.warn;
  console.warn = msg => warnLines.push(msg);
  const errs = validate(cfg);
  console.warn = origWarn;
  assert(errs.length === 0, 'deprecated key alone → no error');
  assert(warnLines.some(l => l.includes('deprecated')), `a warning text includes "deprecated" (got: ${warnLines.join(' | ')})`);
}

// ── 9. fallback_strategies cycle → error ──────────────────────────────────
console.log('\n9. fallback_strategies cycle');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'model-a': 'local', 'model-b': 'local' },
    fallback_strategies: {
      'model-a': { event: { network_failure: ['model-b'] } },
      'model-b': { event: { network_failure: ['model-a'] } },
    },
  };
  const errs = validate(cfg);
  assert(errs.length > 0, 'fallback cycle → error');
  assert(errs.some(e => e.includes('cycle')), `error mentions cycle (got: ${errs[0]})`);
}

// ── 10. model_overrides value must be non-empty string ────────────────────
console.log('\n10. model_overrides empty string value');
{
  const cfg = Object.assign({}, VALID_BASE, { model_overrides: { 'test-model': '' } });
  const errs = validate(cfg);
  assert(errs.length > 0, 'empty override target → error');
}

// ── 11. agent_to_capability valid known alias ──────────────────────────────
console.log('\n11. agent_to_capability valid alias passes');
{
  const cfg = Object.assign({}, VALID_BASE, {
    agent_to_capability: { 'my-agent': 'workhorse', 'other-agent': 'judge' },
  });
  const errs = validate(cfg);
  assert(errs.length === 0, 'valid agent_to_capability → no errors');
}

// ── 12. llm_profiles invalid mode key ─────────────────────────────────────
// New schema: modes are direct keys under each capability, not under a
// `modes` sub-object. An unknown mode key (not best-cloud / best-cloud-oss /
// best-local-oss / best-cloud-gov / best-local-gov) is flagged.
console.log('\n12. llm_profiles invalid mode key');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'test-model': 'local' },
    llm_profiles: {
      judge: {
        'disconnected': { '16gb': 'test-model' }, // invalid mode key
      },
    },
  };
  const errs = validate(cfg);
  assert(errs.length > 0, 'bad mode key → error');
  assert(errs.some(e => e.includes('disconnected') || e.includes('valid mode')),
    `error mentions the bad mode (got: ${errs[0]})`);
}

// ── 13. CLI process spawn: invalid file exits 1 ───────────────────────────
console.log('\n13. CLI exit code on invalid config');
{
  const VALIDATOR = path.resolve(__dirname, '..', 'tools', 'model-map-validate.js');
  const bad = JSON.stringify({ llm_mode: 'totally-bogus-mode' });
  const tmp = require('os').tmpdir() + '/validate-test-bad.json';
  require('fs').writeFileSync(tmp, bad);
  const result = spawnSync(process.execPath, [VALIDATOR, tmp], { encoding: 'utf8' });
  require('fs').unlinkSync(tmp);
  assert(result.status === 1, `CLI exits 1 for invalid config (got ${result.status})`);
  assert(result.stderr.includes('llm_mode'), `stderr mentions llm_mode (got: ${result.stderr.slice(0, 120)})`);
}

// ── 14. validateRecommendedMappings — valid passes ─────────────────────────
console.log('\n14. validateRecommendedMappings valid');
{
  const rec = {
    schema_version: 1,
    updated_at: '2026-01-01',
    recommendations: { coder: { '64gb': 'some-model' } },
  };
  const errs = [];
  validateRecommendedMappings(rec, errs);
  assert(errs.length === 0, `valid recommended-mappings → no errors (got: ${errs.join('; ')})`);
}

// ── 15. validateRecommendedMappings — unknown capability ──────────────────
console.log('\n15. validateRecommendedMappings unknown capability');
{
  const rec = {
    schema_version: 1,
    updated_at: '2026-01-01',
    recommendations: { 'not-a-real-cap': { '64gb': 'some-model' } },
  };
  const errs = [];
  validateRecommendedMappings(rec, errs);
  assert(errs.length > 0, 'unknown capability → error');
}

// ── 16. Invalid on_failure value ────────────────────────────────────────────
console.log('\n16. Invalid on_failure value');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  cfg.llm_profiles.judge.on_failure = 'hard-fial';
  const errs = validate(cfg);
  assert(errs.length > 0, 'bad on_failure → error');
  assert(errs.some(e => e.includes('on_failure')), `error mentions on_failure (got: ${errs[0]})`);
}

// ── 17. model_routes unknown backend id ─────────────────────────────────────
console.log('\n17. model_routes unknown backend id');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  cfg.model_routes['test-model'] = 'ghost';
  const errs = validate(cfg);
  assert(errs.length > 0, 'unknown model_routes backend → error');
  assert(errs.some(e => e.includes('ghost')), `error mentions missing backend id (got: ${errs[0]})`);
}

// ── 17a. model_routes mode-conditional object — valid backend ids ───────────
console.log('\n17a. model_routes mode-conditional object form (valid)');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  cfg.model_routes['claude-haiku'] = { connected: 'local', offline: 'local' };
  const errs = validate(cfg);
  assert(errs.length === 0, 'object-form target with valid backends → no error');
}

// ── 17b. model_routes mode-conditional object — model-name fallback ─────────
console.log('\n17b. model_routes mode-conditional object form (model name)');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  // Target contains '@' → treat as model name, skip backend-id validation
  cfg.model_routes['claude-haiku'] = { connected: 'local', offline: 'qwen3.6:35b@local' };
  const errs = validate(cfg);
  assert(errs.length === 0, 'object-form target with model-name shape → no error (heuristic)');
}

// ── 17c. model_routes mode-conditional object — bare typo flagged ───────────
console.log('\n17c. model_routes mode-conditional object form (typo per-mode)');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  cfg.model_routes['claude-haiku'] = { connected: 'local', offline: 'ghost' };
  const errs = validate(cfg);
  assert(errs.length > 0, 'object-form target with bare-id typo → error');
  assert(errs.some(e => e.includes("(mode='offline')")), `error labels which mode (got: ${errs[0]})`);
  assert(errs.some(e => e.includes('ghost')), `error names the bad target (got: ${errs[0]})`);
}

// ── 17d. validator checks backends BEFORE applying heuristic ────────────────
console.log('\n17d. validator: backend named with `.` checked first, not skipped by heuristic');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  // Add a backend whose id contains '.' — heuristic would treat as model name.
  // Validator should still recognize it as a known backend.
  cfg.backends['ollama.local'] = { kind: 'ollama', url: 'http://localhost:11434' };
  cfg.model_routes['my-model'] = 'ollama.local';
  const errs = validate(cfg);
  assert(errs.length === 0, 'backend id with `.` matched as known backend (not falsely accepted via heuristic)');
}

// ── 18. targets.default required ────────────────────────────────────────────
console.log('\n18. targets.default required');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  cfg.targets = {
    'named-target': { backend: 'local', model: 'test-model' },
  };
  const errs = validate(cfg);
  assert(errs.length > 0, 'missing targets.default → error');
  assert(errs.some(e => e.includes('targets.default')), `error mentions targets.default (got: ${errs[0]})`);
}

// ── 19. route and target key overlap ────────────────────────────────────────
console.log('\n19. route and target key overlap');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  cfg.routes = { 'shared-id': 'test-model' };
  cfg.targets = {
    default: { backend: 'local' },
    'shared-id': { backend: 'local', model: 'test-model' },
  };
  const errs = validate(cfg);
  assert(errs.length > 0, 'route/target overlap → error');
  assert(errs.some(e => e.includes('conflicts')), `error mentions conflict (got: ${errs[0]})`);
}

// ── 20. target JS wrapper rejected when disabled ────────────────────────────
console.log('\n20. target JS wrapper rejected when disabled');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  cfg.targets = {
    default: { backend: 'local' },
    'named-target': {
      backend: 'local',
      model: 'test-model',
      request_defaults: {
        options: {
          num_predict: { '$js': '(ctx) => 42' },
        },
      },
    },
  };
  const errs = validate(cfg, { jsEnabled: false, trustedJs: true });
  assert(errs.length > 0, 'disabled JS wrapper → error');
  assert(errs.some(e => e.includes('$js')), `error mentions $js (got: ${errs[0]})`);
}

// ── 21. target JS wrapper allowed when enabled + trusted ───────────────────
console.log('\n21. target JS wrapper allowed when enabled + trusted');
{
  const cfg = JSON.parse(JSON.stringify(VALID_BASE));
  cfg.targets = {
    default: { backend: 'local' },
    'named-target': {
      backend: 'local',
      model: 'test-model',
      request_defaults: {
        options: {
          num_predict: { '$js': '(ctx) => 42' },
        },
      },
    },
  };
  const errs = validate(cfg, { jsEnabled: true, trustedJs: true });
  assert(errs.length === 0, 'enabled trusted JS wrapper → no error');
}

// ── 22. endpoint.vertex must be boolean ────────────────────────────────────
console.log('\n22. endpoint.vertex must be boolean');
{
  const ok = JSON.parse(JSON.stringify(VALID_BASE));
  ok.endpoints = { vert: { format: 'gemini', vertex: true, url: 'https://x.example', auth_env: 'X' } };
  delete ok.backends;
  const errsOk = validate(ok);
  assert(!errsOk.some(e => /vertex/.test(e)), `vertex:true + format:gemini → no vertex error (got: ${errsOk.join('; ')})`);

  const bad = JSON.parse(JSON.stringify(VALID_BASE));
  bad.endpoints = { vert: { format: 'gemini', vertex: 'true', url: 'https://x.example', auth_env: 'X' } };
  delete bad.backends;
  const errsBad = validate(bad);
  assert(errsBad.some(e => /vertex.*boolean/.test(e)), `vertex:'true' → boolean error (got: ${errsBad.join('; ')})`);

  const warn = JSON.parse(JSON.stringify(VALID_BASE));
  warn.endpoints = { vert: { format: 'anthropic', vertex: true, url: 'https://x.example', auth_env: 'X' } };
  delete warn.backends;
  const errsWarn = validate(warn);
  assert(!errsWarn.some(e => /vertex/.test(e)), `vertex:true + format:anthropic → no hard error, only warning (got: ${errsWarn.join('; ')})`);
}

// ── 23. /model picker exposure: claude-via-gemini-* aliases resolve to gemini_ai
console.log('\n23. claude-via-gemini-* aliases resolve to gemini_ai');
{
  const shippedConfig = require('../config/model-map.json');
  const routes = shippedConfig.model_routes || {};
  const proRoute = routes['claude-via-gemini-pro'];
  const flashRoute = routes['claude-via-gemini-flash'];
  assert(proRoute && proRoute.endpoint === 'gemini_ai',
    `claude-via-gemini-pro routes to gemini_ai (got ${JSON.stringify(proRoute)})`);
  assert(proRoute && proRoute.name === 'gemini-pro-latest',
    `claude-via-gemini-pro names gemini-pro-latest (got ${proRoute && proRoute.name})`);
  assert(flashRoute && flashRoute.endpoint === 'gemini_ai',
    `claude-via-gemini-flash routes to gemini_ai (got ${JSON.stringify(flashRoute)})`);
  assert(flashRoute && flashRoute.name === 'gemini-flash-latest',
    `claude-via-gemini-flash names gemini-flash-latest (got ${flashRoute && flashRoute.name})`);
  // The shipped config must validate cleanly with the new aliases in place.
  const errs = validate(shippedConfig);
  assert(errs.length === 0, `shipped config validates with new aliases (errs: ${errs.slice(0,3).join('; ')})`);
}

// ── 24. V1: :TODO placeholder model → warning (not error) ────────────────────
console.log('\n24. V1: :TODO placeholder model emits warning, not error');
{
  const cfg = {
    backends: { local: { kind: 'ollama', url: 'http://localhost:11434' } },
    model_routes: { 'test-model': 'local' },
    llm_profiles: {
      workhorse: { 'best-cloud-gov': { '128gb': 'gpt-oss-120b:TODO' } },
    },
    llm_mode: 'best-cloud-gov',
  };
  const warnMessages = [];
  const origWarn = console.warn;
  console.warn = msg => warnMessages.push(msg);
  const errs = validate(cfg);
  console.warn = origWarn;
  assert(errs.length === 0, 'placeholder :TODO model → no error (only warning)');
  assert(
    warnMessages.some(m => m.includes(':TODO') && m.includes('placeholder')),
    `:TODO warning emitted (got: ${warnMessages[0] || 'none'})`
  );
}

// ── 25. V2: capability_sampling_defaults temperature out of range → error ──
console.log('\n25. V2: sampling_defaults temperature > 2 → error');
{
  const cfg = Object.assign({}, VALID_BASE, {
    capability_sampling_defaults: { coder: { temperature: 3.5 } },
  });
  const errs = validate(cfg);
  assert(errs.length > 0, 'temperature 3.5 → error');
  assert(errs.some(e => e.includes('temperature') && e.includes('[0, 2]')),
    `error mentions temperature range (got: ${errs[0]})`);
}

// ── 26. V2: top_p out of range → error ───────────────────────────────────────
console.log('\n26. V2: sampling_defaults top_p > 1 → error');
{
  const cfg = Object.assign({}, VALID_BASE, {
    capability_sampling_defaults: { coder: { top_p: 1.5 } },
  });
  const errs = validate(cfg);
  assert(errs.length > 0, 'top_p 1.5 → error');
  assert(errs.some(e => e.includes('top_p') && e.includes('[0, 1]')),
    `error mentions top_p range (got: ${errs[0]})`);
}

// ── 27. V2: top_k non-integer → error ────────────────────────────────────────
console.log('\n27. V2: sampling_defaults top_k non-positive-integer → error');
{
  const cfg = Object.assign({}, VALID_BASE, {
    capability_sampling_defaults: { coder: { top_k: 0 } },
  });
  const errs = validate(cfg);
  assert(errs.length > 0, 'top_k 0 → error');
  assert(errs.some(e => e.includes('top_k') && e.includes('positive integer')),
    `error mentions top_k constraint (got: ${errs[0]})`);
}

// ── 28. V2: valid sampling defaults pass ─────────────────────────────────────
console.log('\n28. V2: valid sampling_defaults → no error');
{
  const cfg = Object.assign({}, VALID_BASE, {
    capability_sampling_defaults: { coder: { temperature: 1.0, top_p: 0.95, top_k: 20 } },
  });
  const errs = validate(cfg);
  assert(errs.length === 0, `valid sampling_defaults → no error (got: ${errs.join('; ')})`);
}

// ── 29. V3: URL template var warning when env var unset ──────────────────────
console.log('\n29. V3: endpoint URL with unset template var emits warning');
{
  const savedEnv = process.env.TEST_MISSING_VAR_XYZ;
  delete process.env.TEST_MISSING_VAR_XYZ;
  const cfg = {
    endpoints: {
      vertex: {
        format: 'gemini',
        url: 'https://${TEST_MISSING_VAR_XYZ}-aiplatform.googleapis.com/v1/models',
        auth_env: 'GOOGLE_CLOUD_TOKEN',
      },
    },
    model_routes: {},
    llm_mode: 'best-cloud',
  };
  const warnMessages = [];
  const origWarn = console.warn;
  console.warn = msg => warnMessages.push(msg);
  const errs = validate(cfg);
  console.warn = origWarn;
  if (savedEnv !== undefined) process.env.TEST_MISSING_VAR_XYZ = savedEnv;
  assert(errs.length === 0, 'unset URL template var → no hard error');
  assert(
    warnMessages.some(m => m.includes('TEST_MISSING_VAR_XYZ') && m.includes('not set')),
    `warning emitted for unset URL template var (got: ${warnMessages[0] || 'none'})`
  );
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
