#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { validateConfig, isObject } = require('./model-map-validate.js');
const { loadLayeredConfig, computeOverrideDiff } = require('./model-map-layered.js');

function fail(message) {
  console.error(`model-map-edit: ${message}`);
  process.exit(1);
}

function ensureObject(value, context) {
  if (!isObject(value)) fail(`${context} must be an object`);
  return value;
}

function applyRouteUpdates(config, routes) {
  if (routes == null) return;
  ensureObject(routes, "'routes' update payload");
  config.routes = isObject(config.routes) ? { ...config.routes } : {};
  for (const [label, target] of Object.entries(routes)) {
    if (typeof label !== 'string' || !label.trim()) fail('route labels must be non-empty strings');
    if (typeof target !== 'string' || !target.trim()) fail(`route '${label}' target must be a non-empty string`);
    config.routes[label] = target;
  }
}

function applyFallbackUpdates(config, fallbackStrategies) {
  if (fallbackStrategies == null) return;
  ensureObject(fallbackStrategies, "'fallback_strategies' update payload");
  config.fallback_strategies = isObject(config.fallback_strategies) ? { ...config.fallback_strategies } : {};
  for (const [modelName, strategy] of Object.entries(fallbackStrategies)) {
    if (typeof modelName !== 'string' || !modelName.trim()) fail('fallback strategy keys must be non-empty strings');
    config.fallback_strategies[modelName] = strategy;
  }
}

function applyUpdates(config, spec) {
  if (!isObject(config)) fail('top-level effective model-map config must be an object');
  if (!isObject(spec)) fail('edit spec must be a JSON object');

  const next = JSON.parse(JSON.stringify(config));
  applyRouteUpdates(next, spec.routes);
  applyFallbackUpdates(next, spec.fallback_strategies);

  if (spec.default_model != null) {
    if (typeof spec.default_model !== 'string' || !spec.default_model.trim()) fail("'default_model' must be a non-empty string");
    next.routes = isObject(next.routes) ? { ...next.routes } : {};
    next.routes.default = spec.default_model;
  }

  if (spec.active_profile != null) {
    if (typeof spec.active_profile !== 'string' || !spec.active_profile.trim()) fail("'active_profile' must be a non-empty string");
    next.llm_active_profile = spec.active_profile;
  }

  validateConfig(next);
  return next;
}

function main() {
  const [, , defaultsPathArg, overridesPathArg, effectivePathArg, specArg] = process.argv;
  if (!defaultsPathArg || !overridesPathArg || !effectivePathArg || !specArg) {
    fail('usage: model-map-edit.js <defaults-path> <overrides-path> <effective-output-path> \'<json-edit-spec>\'');
  }

  const defaultsPath = path.resolve(defaultsPathArg);
  const overridesPath = path.resolve(overridesPathArg);
  const effectivePath = path.resolve(effectivePathArg);

  let spec;
  try {
    spec = JSON.parse(specArg);
  } catch (error) {
    fail(`failed to parse edit spec JSON: ${error.message}`);
  }

  try {
    const { defaults, effective } = loadLayeredConfig(defaultsPath, overridesPath);
    const nextEffective = applyUpdates(effective, spec);
    const nextOverrides = computeOverrideDiff(defaults, nextEffective) || {};
    fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
    fs.mkdirSync(path.dirname(effectivePath), { recursive: true });
    fs.writeFileSync(overridesPath, `${JSON.stringify(nextOverrides, null, 2)}\n`);
    fs.writeFileSync(effectivePath, `${JSON.stringify(nextEffective, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      defaults_path: defaultsPath,
      overrides_path: overridesPath,
      effective_path: effectivePath,
      updated_sections: Object.keys(spec).sort(),
      override_keys: Object.keys(nextOverrides).sort(),
    }, null, 2)}\n`);
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  applyUpdates,
};
