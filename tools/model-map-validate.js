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
  'review_plan',
  'review_code',
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
    if (required) fail(`missing required object '${key}'`);
    return null;
  }
  if (!isObject(value)) fail(`'${key}' must be an object`);
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
      fail(`route cycle detected involving '${current}'`);
    }
    seen.add(current);
    current = routes[current];
    if (typeof current !== 'string' || !current.trim()) {
      fail(`routes entry for '${start}' resolves to an empty value`);
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
    if (strategy.on != null) {
      if (!isObject(strategy.on)) fail(`'fallback_strategies.${modelName}.on' must be an object`);
      for (const candidates of Object.values(strategy.on)) {
        if (!Array.isArray(candidates)) fail(`'fallback_strategies.${modelName}.on' entries must be arrays`);
        for (const candidate of candidates) {
          if (typeof candidate !== 'string' || !candidate.trim()) {
            fail(`fallback candidate for '${modelName}' must be a non-empty string`);
          }
          const target = resolveRoute(routes, candidate);
          if (target === source) {
            fail(`fallback strategy for '${modelName}' cycles back to itself via '${candidate}'`);
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
      fail(`fallback strategy cycle detected: ${cycle.join(' -> ')}`);
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

function validateConfig(config) {
  if (!isObject(config)) fail('top-level config must be an object');

  for (const key of ['backends', 'model_routes', 'routes']) {
    if (config[key] != null && !isObject(config[key])) {
      fail(`'${key}' must be an object when present`);
    }
  }

  if (config.routes) {
    for (const routeName of Object.keys(config.routes)) {
      resolveRoute(config.routes, routeName);
    }
  }

  if (config.llm_connectivity_mode != null && !CONNECTIVITY_MODES.has(config.llm_connectivity_mode)) {
    fail("'llm_connectivity_mode' must be 'connected' or 'disconnect'");
  }

  if (config.llm_active_profile != null) {
    if (typeof config.llm_active_profile !== 'string' || !config.llm_active_profile.trim()) {
      fail("'llm_active_profile' must be a non-empty string");
    }
  }

  const profiles = expectObject(config, 'llm_profiles', false);
  if (profiles) {
    for (const [profileName, profileValue] of Object.entries(profiles)) {
      if (!isObject(profileValue)) fail(`'llm_profiles.${profileName}' must be an object`);
      for (const aliasName of PROFILE_KEYS) {
        validateProfileEntry(profileName, aliasName, profileValue[aliasName]);
      }
    }

    const active = config.llm_active_profile || 'auto';
    if (active !== 'auto' && !profiles[active]) {
      fail(`'llm_active_profile' references unknown profile '${active}'`);
    }
  }

  const capabilities = expectObject(config, 'llm_capabilities', false);
  if (capabilities) {
    for (const [capabilityName, entry] of Object.entries(capabilities)) {
      if (!CAPABILITY_KEYS.has(capabilityName)) {
        fail(`unsupported llm_capabilities entry '${capabilityName}'`);
      }
      if (!isObject(entry)) fail(`'llm_capabilities.${capabilityName}' must be an object`);
      expectNonEmptyString(entry, 'model', `llm_capabilities.${capabilityName}`);
    }
  }

  if (config.fallback_strategies != null) {
    if (!isObject(config.fallback_strategies)) fail("'fallback_strategies' must be an object");
    for (const [modelName, strategy] of Object.entries(config.fallback_strategies)) {
      if (!isObject(strategy)) fail(`'fallback_strategies.${modelName}' must be an object`);
    }
    validateFallbackGraph(config);
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
  validateConfig(parsed);
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
