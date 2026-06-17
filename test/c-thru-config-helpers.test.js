#!/usr/bin/env node
/**
 * c-thru-config-helpers.test.js — Unit tests for tools/c-thru-config-helpers.js
 *
 * Tests each subcommand entrypoint with success + error paths.
 * Uses temporary CLAUDE_PROFILE_DIR with synthetic model-map fixtures
 * to avoid touching the real ~/.claude config.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ── Test harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++; }
  else       { console.log(`  FAIL  ${msg}`); failed++; }
}

const HELPERS = path.join(__dirname, '..', 'tools', 'c-thru-config-helpers.js');

function run(args, env = {}, opts = {}) {
  const result = spawnSync(process.execPath, [HELPERS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: opts.cwd,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function tmpClaudeDir(extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));
  const toolsDir = path.join(dir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  // Minimal model-map.json fixture
  const cfg = {
    llm_profiles: {
      'deep-coder': {
        'best-cloud': {
          '16gb': 'devstral-small:2'
        }
      },
      'judge': {
        'best-cloud': {
          '16gb': 'claude-sonnet-4-6'
        }
      },
    },
    agent_to_capability: {
      implementer: 'deep-coder',
      planner: 'judge',
    },
    backends: {},
    model_routes: {},
  };
  fs.writeFileSync(path.join(dir, 'model-map.json'),          JSON.stringify(cfg), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.system.json'),   JSON.stringify(cfg), 'utf8');
  fs.writeFileSync(path.join(dir, 'model-map.overrides.json'), '{}', 'utf8');

  // Stub model-map-resolve.js in tools/
  const resolveStub = `
'use strict';
const LLM_MODE_ENUM = new Set(['best-cloud','best-cloud-oss','best-local-oss','best-cloud-gov','best-local-gov']);
function resolveLlmMode(config) { return process.env.CLAUDE_LLM_MODE || 'best-cloud'; }
function resolveActiveTier(config) { return process.env.CLAUDE_LLM_PROFILE || '16gb'; }
function resolveCapabilityAlias(input, config, tier) {
  const a2c = config.agent_to_capability || {};
  const cap = a2c[input] || input;
  const profiles = config.llm_profiles || {};
  const key = cap === 'general-default' ? 'default' : cap;
  return profiles[key] ? key : null;
}
function resolveProfileModel(entry, tier, mode, baseMode) {
  let v = entry[mode];
  if (!v && baseMode) v = entry[baseMode];
  return (v && v[tier]) || null;
}
function validModes(config) {
  const custom = config && config.custom_modes ? Object.keys(config.custom_modes) : [];
  return new Set([...LLM_MODE_ENUM, ...custom]);
}
function baseModeFor(mode, config) {
  const cm = config && config.custom_modes && config.custom_modes[mode];
  return cm && typeof cm.base === 'string' ? cm.base : null;
}
function isGovMode(mode, config) {
  const GOV = new Set(['best-cloud-gov', 'best-local-gov']);
  if (GOV.has(mode)) return true;
  const b = baseModeFor(mode, config);
  return b != null && GOV.has(b);
}
function isChineseOrigin(model) { return /(^|[/:])(qwen|deepseek|glm|kimi)($|[-_.:/0-9])/.test(String(model || '').toLowerCase()); }
function resolveTerminalTarget(_config, _label) { return null; }
module.exports = { resolveLlmMode, resolveActiveTier, resolveCapabilityAlias, resolveProfileModel, resolveTerminalTarget, validModes, baseModeFor, isGovMode, isChineseOrigin, LLM_MODE_ENUM };
`;
  fs.writeFileSync(path.join(toolsDir, 'model-map-resolve.js'), resolveStub, 'utf8');

  // Stub model-map-edit that records the spec to a file
  const editStub = `#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path');
const [,, systemPath, ovrPath, mergedPath, spec] = process.argv;
// Read existing overrides, merge spec, write back
let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(ovrPath, 'utf8')); } catch {}
const patch = JSON.parse(spec);
const merged = Object.assign({}, overrides, patch);
// Deep merge llm_profiles
if (patch.llm_profiles && overrides.llm_profiles) {
  merged.llm_profiles = Object.assign({}, overrides.llm_profiles);
  for (const [cap, modes] of Object.entries(patch.llm_profiles || {})) {
      merged.llm_profiles[cap] = Object.assign({}, overrides.llm_profiles[cap] || {});
      for (const [mode, tiers] of Object.entries(modes)) {
        merged.llm_profiles[cap][mode] = Object.assign({}, (merged.llm_profiles[cap][mode] || {}), tiers);
      }
    }
}
fs.writeFileSync(ovrPath, JSON.stringify(merged, null, 2), 'utf8');
// Write merged path too
const base = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
const out = Object.assign({}, base, merged);
fs.writeFileSync(mergedPath, JSON.stringify(out, null, 2), 'utf8');
process.stdout.write('model-map-edit: ok\\n');
`;
  const editPath = path.join(toolsDir, 'model-map-edit');
  fs.writeFileSync(editPath, editStub, 'utf8');
  // make executable
  try { fs.chmodSync(editPath, 0o755); } catch {}

  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }

  return dir;
}

// ── 1. resolve ────────────────────────────────────────────────────────────────

console.log('\n1. resolve — capability/agent resolution');

{
  const dir = tmpClaudeDir();
  const r = run(['resolve', 'deep-coder'], { CLAUDE_PROFILE_DIR: dir, CLAUDE_MODEL_MAP_PATH: path.join(dir, 'model-map.json') });
  assert(r.code === 0, 'resolve deep-coder exits 0');
  assert(r.stdout.trim() === 'devstral-small:2', 'resolve deep-coder → devstral-small:2');
  assert(r.stderr.includes('mode:'), 'resolve emits mode to stderr');
}

{
  // Agent name lookup via agent_to_capability
  const dir = tmpClaudeDir();
  const r = run(['resolve', 'implementer'], { CLAUDE_PROFILE_DIR: dir, CLAUDE_MODEL_MAP_PATH: path.join(dir, 'model-map.json') });
  assert(r.code === 0, 'resolve implementer (agent alias) exits 0');
  assert(r.stdout.trim() === 'devstral-small:2', 'agent alias resolves to correct model');
  assert(r.stderr.includes('via agent: implementer'), 'stderr shows agent alias path');
}

{
  // Unknown capability → exit 2
  const dir = tmpClaudeDir();
  const r = run(['resolve', 'nonexistent-cap'], { CLAUDE_PROFILE_DIR: dir, CLAUDE_MODEL_MAP_PATH: path.join(dir, 'model-map.json') });
  assert(r.code === 2, 'resolve unknown capability exits 2');
}

{
  // Project-local selected graph wins over profile graph for resolve
  const dir = tmpClaudeDir();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-project-'));
  const projectClaude = path.join(projectDir, '.claude');
  fs.mkdirSync(projectClaude, { recursive: true });
  const projectCfg = {
    llm_mode: 'best-cloud',
    llm_active_profile: '16gb',
    llm_profiles: { 'deep-coder': { 'best-cloud': { '16gb': 'project-picked-model' } } },
    agent_to_capability: {},
    backends: {},
    model_routes: {},
  };
  fs.writeFileSync(path.join(projectClaude, 'model-map.json'), JSON.stringify(projectCfg), 'utf8');
  const r = run(['resolve', 'deep-coder'], { CLAUDE_PROFILE_DIR: dir }, { cwd: projectDir });
  assert(r.code === 0, 'resolve with project-local model-map exits 0');
  assert(r.stdout.trim() === 'project-picked-model', 'project-local selected graph wins for resolve');
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
}

// ── 2. mode-read ──────────────────────────────────────────────────────────────

console.log('\n2. mode-read — active mode display');

{
  const dir = tmpClaudeDir();
  const r = run(['mode-read'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 0, 'mode-read exits 0');
  assert(r.stdout.includes('best-cloud'), 'mode-read shows best-cloud (from fixture)');
  assert(r.stdout.includes('source:'), 'mode-read shows source');
}

{
  // CLAUDE_LLM_MODE env overrides file
  const dir = tmpClaudeDir();
  const r = run(['mode-read'], { CLAUDE_PROFILE_DIR: dir, CLAUDE_LLM_MODE: 'best-local-oss' });
  assert(r.stdout.includes('best-local-oss'), 'env CLAUDE_LLM_MODE overrides file');
  assert(r.stdout.includes('transient'), 'env source labeled transient');
}

// ── 3. mode-write ─────────────────────────────────────────────────────────────

console.log('\n3. mode-write — persist llm_mode');

{
  const dir = tmpClaudeDir();
  const r = run(['mode-write', 'best-cloud-oss'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 0, 'mode-write best-cloud-oss exits 0');
  const overrides = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.overrides.json'), 'utf8'));
  assert(overrides.llm_mode === 'best-cloud-oss', 'overrides.json updated with llm_mode');
}

{
  // Invalid mode → exit 1
  const dir = tmpClaudeDir();
  const r = run(['mode-write', 'invalid-mode'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 1, 'mode-write invalid mode exits 1');
}

{
  // Roundtrip: mode-write then mode-read reflects the persisted value
  const dir = tmpClaudeDir();
  run(['mode-write', 'best-cloud-oss'], { CLAUDE_PROFILE_DIR: dir });
  const r = run(['mode-read'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 0, 'mode-read after mode-write exits 0');
  assert(r.stdout.includes('best-cloud-oss'), 'mode-read reflects written mode');
  assert(r.stdout.includes(path.join(dir, 'model-map.overrides.json')), 'mode-read source points to overrides file');
}

// ── 4. remap ──────────────────────────────────────────────────────────────────

console.log('\n4. remap — rebind capability model');

{
  const dir = tmpClaudeDir();
  const r = run(['remap', '16gb', 'deep-coder', 'qwen3.5:27b'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 0, 'remap exits 0');
  assert(r.stdout.includes('remapped deep-coder → qwen3.5:27b for mode best-cloud'), 'remap output correct');
  const overrides = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.overrides.json'), 'utf8'));
  assert(((overrides.llm_profiles || {})['deep-coder'] || {})['best-cloud']?.['16gb'] === 'qwen3.5:27b', 'llm_profiles[deep-coder][best-cloud][16gb] updated in overrides');
}

{
  // Missing args → exit 1
  const dir = tmpClaudeDir();
  const r = run(['remap', '16gb', 'deep-coder'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 1, 'remap with missing model arg exits 1');
}

// ── 5. set-cloud-best ─────────────────────────────────────────────────────────

console.log('\n5. set-cloud-best — set cloud_best_model');

{
  const dir = tmpClaudeDir();
  const r = run(['set-cloud-best', '16gb', 'judge', 'claude-opus-4-7'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 0, 'set-cloud-best exits 0');
  const overrides = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.overrides.json'), 'utf8'));
  assert(((overrides.llm_profiles || {})['judge'] || {})['best-cloud']?.['16gb'] === 'claude-opus-4-7', 'llm_profiles[judge][best-cloud][16gb] set in overrides');
}

// ── 6. set-local-best ─────────────────────────────────────────────────────────

console.log('\n6. set-local-best — set local_best_model');

{
  const dir = tmpClaudeDir();
  const r = run(['set-local-best', '16gb', 'deep-coder', 'qwen3.5:27b'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 0, 'set-local-best exits 0');
  const overrides = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.overrides.json'), 'utf8'));
  assert(((overrides.llm_profiles || {})['deep-coder'] || {})['best-local-oss']?.['16gb'] === 'qwen3.5:27b', 'llm_profiles[deep-coder][best-local-oss][16gb] set in overrides');
}

// ── 7. route ──────────────────────────────────────────────────────────────────

console.log('\n7. route — bind model → backend');

{
  const dir = tmpClaudeDir();
  const r = run(['route', 'gemma4:26b', 'local-ollama'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 0, 'route exits 0');
  assert(r.stdout.includes("bound gemma4:26b → backend 'local-ollama'"), 'route output correct');
  const overrides = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.overrides.json'), 'utf8'));
  assert((overrides.model_routes || {})['gemma4:26b'] === 'local-ollama', 'model_routes updated in overrides');
}

// ── 8. backend ────────────────────────────────────────────────────────────────

console.log('\n8. backend — add/update backend entry');

{
  const dir = tmpClaudeDir();
  const r = run(['backend', 'my-lm', 'http://localhost:1234', '--kind', 'openai', '--auth-env', 'MY_KEY'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 0, 'backend exits 0');
  assert(r.stdout.includes("backend 'my-lm' set"), 'backend output correct');
  const overrides = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.overrides.json'), 'utf8'));
  const be = (overrides.backends || {})['my-lm'];
  assert(be && be.url === 'http://localhost:1234', 'backend url set');
  assert(be && be.kind === 'openai', 'backend kind set');
  assert(be && be.auth_env === 'MY_KEY', 'backend auth_env set');
}

{
  // Default kind=ollama when --kind omitted
  const dir = tmpClaudeDir();
  run(['backend', 'local', 'http://localhost:11434'], { CLAUDE_PROFILE_DIR: dir });
  const overrides = JSON.parse(fs.readFileSync(path.join(dir, 'model-map.overrides.json'), 'utf8'));
  assert((overrides.backends || {})['local']?.kind === 'ollama', 'default kind=ollama');
}

// ── 9. error handling — missing required args ─────────────────────────────────

console.log('\n9. error paths — missing required args');

{
  const dir = tmpClaudeDir();
  const r = run(['route'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 1, 'route with no args exits 1');
}

{
  const dir = tmpClaudeDir();
  const r = run(['backend', 'nameonly'], { CLAUDE_PROFILE_DIR: dir });
  assert(r.code === 1, 'backend with only name (no url) exits 1');
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\nc-thru-config-helpers tests\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
