#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_KEYS = ['default', 'classifier', 'explorer', 'reviewer', 'workhorse', 'coder'];
const CAPABILITY_KEYS = new Set([
  'default',
  'classify_intent',
  'explore_local',
  'explore_web',
  'review_quality',
  'critique_plan',
  'detect_bugs',
  'navigate_codebase',
  'generate_tests',
  'deep_review',
  'heavy_coder',
  'code_review_lint',
  'summarize_light',
  'code_fix',
  'plan_review',
  'review_code_full',
  'hard_reasoning',
]);
const CONNECTIVITY_MODES = new Set(['connected', 'disconnect']);

function fail(message) {
  console.error(`model-map-validate: ${message}`);
  process.exit(1);
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function expectObject(parent, key, required = false) {
  const value = parent[key];
  if (value == null) {
    if (required) throw new Error(`missing required object '${key}'`);
    return null;
  }
  if (!isObject(value)) throw new Error(`'${key}' must be an object`);
  return value;
}

function expectNonEmptyString(parent, key, context) {
  const value = parent[key];
  if (typeof value !== 'string' || !value.trim()) {
    fail(`'${context}.${key}' must be a non-empty string`);
  }
  return value;
}

function validateProfileEntry(profileName, aliasName, entry) {
  if (!isObject(entry)) fail(`'llm_profiles.${profileName}.${aliasName}' must be an object`);
  expectNonEmptyString(entry, 'connected_model', `llm_profiles.${profileName}.${aliasName}`);
  expectNonEmptyString(entry, 'disconnect_model', `llm_profiles.${profileName}.${aliasName}`);
}

function resolveRoute(routes, start) {
  const seen = new Set();
  let current = start;
  while (isObject(routes) && Object.prototype.hasOwnProperty.call(routes, current)) {
    if (seen.has(current)) {
      throw new Error(`route cycle detected involving '${current}'`);
    }
    seen.add(current);
    current = routes[current];
    if (typeof current !== 'string' || !current.trim()) {
      throw new Error(`routes entry for '${start}' resolves to an empty value`);
    }
  }
  return current;
}

function normalizeFallbackGraph(config) {
  const routes = config.routes || {};
  const strategies = config.fallback_strategies || {};
  const graph = new Map();

  for (const [modelName, strategy] of Object.entries(strategies)) {
    const source = resolveRoute(routes, modelName);
    const targets = graph.get(source) || new Set();
    if (strategy.event != null) {
      if (!isObject(strategy.event)) throw new Error(`'fallback_strategies.${modelName}.event' must be an object`);
      for (const candidates of Object.values(strategy.event)) {
        if (!Array.isArray(candidates)) throw new Error(`'fallback_strategies.${modelName}.event' entries must be arrays`);
        for (const candidate of candidates) {
          if (typeof candidate !== 'string' || !candidate.trim()) {
            throw new Error(`fallback candidate for '${modelName}' must be a non-empty string`);
          }
          const target = resolveRoute(routes, candidate);
          if (target === source) {
            throw new Error(`fallback strategy for '${modelName}' cycles back to itself via '${candidate}'`);
          }
          targets.add(target);
        }
      }
    }
    graph.set(source, targets);
  }

  return graph;
}

function validateFallbackGraph(config) {
  const graph = normalizeFallbackGraph(config);
  const visiting = new Set();
  const visited = new Set();

  function walk(node, trail) {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const cycleStart = trail.indexOf(node);
      const cycle = cycleStart >= 0 ? trail.slice(cycleStart).concat(node) : trail.concat(node);
      throw new Error(`fallback strategy cycle detected: ${cycle.join(' -> ')}`);
    }

    visiting.add(node);
    const nextTrail = trail.concat(node);
    for (const neighbor of graph.get(node) || []) {
      walk(neighbor, nextTrail);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    walk(node, []);
  }
}

function validateConfig(config, _errors) {
  const report = _errors
    ? (msg) => _errors.push(msg)
    : (msg) => fail(msg);

  if (!isObject(config)) { report('top-level config must be an object'); return; }

  for (const key of ['backends', 'model_routes', 'routes']) {
    if (config[key] != null && !isObject(config[key])) {
      report(`'${key}' must be an object when present`);
    }
  }

  if (config.routes) {
    for (const routeName of Object.keys(config.routes)) {
      try { resolveRoute(config.routes, routeName); } catch (e) { report(e.message); }
    }
  }

  if (config.llm_connectivity_mode != null && !CONNECTIVITY_MODES.has(config.llm_connectivity_mode)) {
    report("'llm_connectivity_mode' must be 'connected' or 'disconnect'");
  }

  if (config.llm_active_profile != null) {
    if (typeof config.llm_active_profile !== 'string' || !config.llm_active_profile.trim()) {
      report("'llm_active_profile' must be a non-empty string");
    }
  }

  let profiles = null;
  try { profiles = expectObject(config, 'llm_profiles', false); } catch (e) { report(e.message); }
  if (profiles) {
    for (const [profileName, profileValue] of Object.entries(profiles)) {
      if (!isObject(profileValue)) { report(`'llm_profiles.${profileName}' must be an object`); continue; }
      for (const aliasName of PROFILE_KEYS) {
        if (profileValue[aliasName] != null) {
          if (!isObject(profileValue[aliasName])) {
            report(`'llm_profiles.${profileName}.${aliasName}' must be an object`);
          } else {
            if (typeof profileValue[aliasName].connected_model !== 'string' || !profileValue[aliasName].connected_model.trim()) {
              report(`'llm_profiles.${profileName}.${aliasName}.connected_model' must be a non-empty string`);
            }
            if (typeof profileValue[aliasName].disconnect_model !== 'string' || !profileValue[aliasName].disconnect_model.trim()) {
              report(`'llm_profiles.${profileName}.${aliasName}.disconnect_model' must be a non-empty string`);
            }
          }
        }
      }
    }

    const active = config.llm_active_profile || 'auto';
    if (active !== 'auto' && !profiles[active]) {
      report(`'llm_active_profile' references unknown profile '${active}'`);
    }
  }

  let capabilities = null;
  try { capabilities = expectObject(config, 'llm_capabilities', false); } catch (e) { report(e.message); }
  if (capabilities) {
    for (const [capabilityName, entry] of Object.entries(capabilities)) {
      if (!CAPABILITY_KEYS.has(capabilityName)) {
        report(`unsupported llm_capabilities entry '${capabilityName}'`);
      }
      if (!isObject(entry)) { report(`'llm_capabilities.${capabilityName}' must be an object`); continue; }
      if (typeof entry.model !== 'string' || !entry.model.trim()) {
        report(`'llm_capabilities.${capabilityName}.model' must be a non-empty string`);
      }
    }
  }

  if (config.fallback_strategies != null) {
    if (!isObject(config.fallback_strategies)) { report("'fallback_strategies' must be an object"); return; }
    for (const [modelName, strategy] of Object.entries(config.fallback_strategies)) {
      if (!isObject(strategy)) report(`'fallback_strategies.${modelName}' must be an object`);
    }
    try { validateFallbackGraph(config); } catch (e) { report(e.message); }
  }

  if (config.model_overrides != null) {
    if (!isObject(config.model_overrides)) {
      report("'model_overrides' must be an object");
    } else {
      for (const [from, to] of Object.entries(config.model_overrides)) {
        if (typeof to !== 'string' || !to) {
          report(`'model_overrides.${from}' must be a non-empty string`);
        } else if (from === to) {
          report(`'model_overrides.${from}' maps to itself — remove or change`);
        }
      }
    }
  }
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) fail('usage: model-map-validate.js <path-to-model-map.json>');
  const absolutePath = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`failed to read '${absolutePath}': ${error.message}`);
  }
  const errors = [];
  validateConfig(parsed, errors);
  if (errors.length > 0) {
    for (const e of errors) console.error(`model-map-validate: ${e}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PROFILE_KEYS,
  CAPABILITY_KEYS,
  CONNECTIVITY_MODES,
  isObject,
  resolveRoute,
  validateConfig,
};
