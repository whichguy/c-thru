#!/usr/bin/env node
'use strict';
// Schema validator for docs/benchmark.json. Pure stdlib.
//
// Run: node tools/benchmark-validate.js [path/to/benchmark.json]
//
// Validates:
//   - schema_version === 1
//   - each model has provider in known set
//   - ram_gb null or positive number
//   - tokens_per_sec null or positive number
//   - quality_per_role values in [0, 5]
//   - every model_routes key (excluding re: patterns) has a corresponding model entry
//     OR is in the allowlist
//   - every benchmark.json model key exists in model_routes

const fs   = require('fs');
const path = require('path');

const VALID_PROVIDERS = new Set(['claude', 'openrouter', 'ollama_local', 'ollama_cloud', 'gemini']);
const SUPPORTED_VERSION = 1;

// Models that may exist in model_routes without a benchmark entry
// (test stubs, deprecated aliases, etc.)
const ALLOWLIST_NO_BENCHMARK = new Set([
  // pattern routes are excluded automatically; this is for literal entries
]);

const repoRoot = path.resolve(__dirname, '..');
const benchPath = process.argv[2] || path.join(repoRoot, 'docs', 'benchmark.json');
const configPath = path.join(repoRoot, 'config', 'model-map.json');

let bench, config;
try {
  bench = JSON.parse(fs.readFileSync(benchPath, 'utf8'));
} catch (e) {
  console.error(`benchmark-validate: cannot read ${benchPath}: ${e.message}`);
  process.exit(1);
}
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`benchmark-validate: cannot read ${configPath}: ${e.message}`);
  process.exit(1);
}

let errors = 0;
function err(msg) { console.error(`benchmark-validate: ${msg}`); errors++; }

// 1. Schema version — forward-compat: WARN on newer, ERR on older or missing
if (bench.schema_version == null) {
  err(`missing schema_version (expected ${SUPPORTED_VERSION})`);
} else if (typeof bench.schema_version !== 'number') {
  err(`schema_version must be a number (got ${JSON.stringify(bench.schema_version)})`);
} else if (bench.schema_version < SUPPORTED_VERSION) {
  err(`schema_version ${bench.schema_version} is older than supported ${SUPPORTED_VERSION}`);
} else if (bench.schema_version > SUPPORTED_VERSION) {
  console.warn(`benchmark-validate: WARN  schema_version ${bench.schema_version} is newer than this validator's ${SUPPORTED_VERSION} (forward-compat)`);
}

// 2. Required top-level keys
for (const key of ['models', 'role_minimums', 'capability_to_role']) {
  if (!bench[key] || typeof bench[key] !== 'object') {
    err(`missing or non-object top-level field: ${key}`);
  }
}

// 3. Per-model checks
const models = bench.models || {};
for (const [name, m] of Object.entries(models)) {
  if (!m || typeof m !== 'object') {
    err(`models.${name}: not an object`);
    continue;
  }
  if (m.provider == null) {
    err(`models.${name}.provider: required (one of ${[...VALID_PROVIDERS].join('|')})`);
  } else if (!VALID_PROVIDERS.has(m.provider)) {
    err(`models.${name}.provider: must be one of ${[...VALID_PROVIDERS].join('|')} (got ${JSON.stringify(m.provider)})`);
  }
  if (m.ram_gb != null && (typeof m.ram_gb !== 'number' || m.ram_gb <= 0)) {
    err(`models.${name}.ram_gb: must be null or positive number (got ${JSON.stringify(m.ram_gb)})`);
  }
  if (m.tokens_per_sec != null && (typeof m.tokens_per_sec !== 'number' || m.tokens_per_sec <= 0)) {
    err(`models.${name}.tokens_per_sec: must be null or positive number (got ${JSON.stringify(m.tokens_per_sec)})`);
  }
  if (m.quality_per_role) {
    for (const [role, q] of Object.entries(m.quality_per_role)) {
      if (typeof q !== 'number' || q < 0 || q > 5) {
        err(`models.${name}.quality_per_role.${role}: must be number in [0, 5] (got ${q})`);
      }
    }
  }
}

// 4. Role minimums
const roleMin = bench.role_minimums || {};
for (const [role, q] of Object.entries(roleMin)) {
  if (typeof q !== 'number' || q < 0 || q > 5) {
    err(`role_minimums.${role}: must be number in [0, 5] (got ${q})`);
  }
}

// 5. capability_to_role values must reference roles in role_minimums
const c2r = bench.capability_to_role || {};
for (const [cap, role] of Object.entries(c2r)) {
  if (!roleMin[role]) {
    err(`capability_to_role.${cap}: references role '${role}' which has no role_minimums entry`);
  }
}

// 6. Cross-check: every benchmark model exists in model_routes (or matches a re: pattern)
const modelRoutes = config.model_routes || {};
const literalRoutes = new Set(Object.keys(modelRoutes).filter(k => !k.startsWith('re:')));
const patternRoutes = Object.keys(modelRoutes).filter(k => k.startsWith('re:')).map(k => {
  try { return new RegExp(k.slice(3)); } catch { return null; }
}).filter(Boolean);

for (const name of Object.keys(models)) {
  if (literalRoutes.has(name)) continue;
  if (patternRoutes.some(re => re.test(name))) continue;
  err(`models.${name}: not present in config/model-map.json model_routes`);
}

// 7. Reverse: every model_routes literal (not pattern) should have a benchmark entry
//    or be allowlisted (warn-not-fail to avoid blocking — coverage-coverage is separate)
let coverage_warns = 0;
for (const route of literalRoutes) {
  if (!models[route] && !ALLOWLIST_NO_BENCHMARK.has(route)) {
    console.warn(`benchmark-validate: WARN  model_routes['${route}'] has no benchmark entry`);
    coverage_warns++;
  }
}

if (errors > 0) {
  console.error(`benchmark-validate: ${errors} error(s); ${coverage_warns} coverage warn(s)`);
  process.exit(1);
}
console.log(`benchmark-validate: OK — ${Object.keys(models).length} models, ${Object.keys(roleMin).length} roles, ${coverage_warns} coverage warn(s)`);
process.exit(0);
