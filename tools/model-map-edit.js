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

const LLM_PROFILE_MODES = new Set(['best-cloud', 'best-cloud-oss', 'best-local-oss', 'best-cloud-gov', 'best-local-gov']);
const HARDWARE_TIERS = new Set(['16gb', '32gb', '48gb', '64gb', '128gb']);

function applyLlmProfilesUpdates(config, llmProfiles) {
  if (llmProfiles == null) return;
  if (!isObject(llmProfiles)) fail("'llm_profiles' update payload must be an object");
  config.llm_profiles = isObject(config.llm_profiles) ? JSON.parse(JSON.stringify(config.llm_profiles)) : {};
  for (const [cap, entry] of Object.entries(llmProfiles)) {
    if (typeof cap !== 'string' || !cap.trim()) fail('llm_profiles capability keys must be non-empty strings');
    if (entry === null) {
      delete config.llm_profiles[cap];
      continue;
    }
    if (!isObject(entry)) fail(`llm_profiles['${cap}'] must be an object or null`);
    if (entry.connected_model !== undefined || entry.disconnect_model !== undefined) {
      fail(`llm_profiles['${cap}'] uses old schema (connected_model/disconnect_model); migrate to mode-keyed format (best-cloud, best-local-oss, etc.)`);
    }
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'on_failure' || k === 'fallback_to') continue;
      if (!LLM_PROFILE_MODES.has(k)) fail(`llm_profiles['${cap}']['${k}'] is not a valid mode key; valid: ${[...LLM_PROFILE_MODES].join(', ')}`);
      if (v !== null && typeof v !== 'string' && !isObject(v)) {
        fail(`llm_profiles['${cap}']['${k}'] must be a string, tier-keyed object, or null`);
      }
      if (isObject(v)) {
        for (const tier of Object.keys(v)) {
          if (!HARDWARE_TIERS.has(tier)) fail(`llm_profiles['${cap}']['${k}']['${tier}'] is not a valid hardware tier; valid: ${[...HARDWARE_TIERS].join(', ')}`);
        }
      }
    }
    // Deep-merge onto existing entry so unspecified mode keys are preserved.
    // Tier sub-objects are also merged (user can update a single tier without clobbering others).
    const existing = config.llm_profiles[cap];
    if (isObject(existing) && isObject(entry)) {
      const merged = Object.assign({}, existing);
      for (const [k, v] of Object.entries(entry)) {
        if (v === null) { delete merged[k]; continue; }
        if (k === 'on_failure' || k === 'fallback_to') { merged[k] = v; continue; }
        if (isObject(v) && isObject(merged[k])) {
          merged[k] = Object.assign({}, merged[k], v);
        } else {
          merged[k] = v;
        }
      }
      config.llm_profiles[cap] = merged;
    } else {
      config.llm_profiles[cap] = entry;
    }
  }
}

function applyAgentToCapabilityUpdates(config, a2cSpec, defaults) {
  if (a2cSpec == null) return;
  if (!isObject(a2cSpec)) fail("'agent_to_capability' update payload must be an object");
  config.agent_to_capability = isObject(config.agent_to_capability) ? { ...config.agent_to_capability } : {};
  for (const [agent, val] of Object.entries(a2cSpec)) {
    if (val === null) {
      // Restore system default when present so computeOverrideDiff omits this key.
      // Without access to defaults, deleting would produce null in the overrides file,
      // which would suppress the system default on the next merge.
      const defaultVal = defaults && (defaults.agent_to_capability || {})[agent];
      if (defaultVal !== undefined) {
        config.agent_to_capability[agent] = defaultVal;
      } else {
        delete config.agent_to_capability[agent];
      }
      continue;
    }
    if (typeof val !== 'string' || !val.trim()) fail(`agent_to_capability['${agent}'] must be a non-empty string or null`);
    config.agent_to_capability[agent] = val;
  }
}

function applyUpdates(config, spec, defaults) {
  if (!isObject(config)) fail('top-level effective model-map config must be an object');
  if (!isObject(spec)) fail('edit spec must be a JSON object');

  const next = JSON.parse(JSON.stringify(config));
  applyRouteUpdates(next, spec.routes);
  applyFallbackUpdates(next, spec.fallback_strategies);
  applyLlmProfilesUpdates(next, spec.llm_profiles);
  applyAgentToCapabilityUpdates(next, spec.agent_to_capability, defaults);

  if (spec.default_model != null) {
    if (typeof spec.default_model !== 'string' || !spec.default_model.trim()) fail("'default_model' must be a non-empty string");
    next.routes = isObject(next.routes) ? { ...next.routes } : {};
    next.routes.default = spec.default_model;
  }

  if (spec.active_profile != null) {
    if (typeof spec.active_profile !== 'string' || !spec.active_profile.trim()) fail("'active_profile' must be a non-empty string");
    next.llm_active_profile = spec.active_profile;
  }

  if (spec.llm_mode != null) {
    if (typeof spec.llm_mode !== 'string' || !LLM_PROFILE_MODES.has(spec.llm_mode)) {
      fail(`'llm_mode' must be one of: ${[...LLM_PROFILE_MODES].join(', ')}`);
    }
    next.llm_mode = spec.llm_mode;
  }

  if (spec.self_update != null) {
    if (typeof spec.self_update !== 'boolean') fail("'self_update' must be a boolean");
    next.self_update = spec.self_update;
  }

  if (spec.endpoints != null || spec.backends != null) {
    const payload = spec.endpoints != null ? spec.endpoints : spec.backends;
    const payloadKey = spec.endpoints != null ? 'endpoints' : 'backends';
    if (!isObject(payload)) fail(`'${payloadKey}' update payload must be an object`);
    // Write to whichever key already exists in the config; prefer endpoints for new files.
    const writeKey = next.endpoints != null ? 'endpoints' : (next.backends != null ? 'backends' : payloadKey);
    next[writeKey] = isObject(next[writeKey]) ? { ...next[writeKey] } : {};
    for (const [name, val] of Object.entries(payload)) {
      if (val === null) {
        delete next[writeKey][name];
      } else {
        if (!isObject(val)) fail(`endpoint/backend '${name}' must be an object`);
        next[writeKey][name] = val;
      }
    }
  }

  if (spec.model_routes != null) {
    if (!isObject(spec.model_routes)) fail("'model_routes' update payload must be an object");
    next.model_routes = isObject(next.model_routes) ? { ...next.model_routes } : {};
    for (const [model, backendOrNull] of Object.entries(spec.model_routes)) {
      if (backendOrNull === null) {
        delete next.model_routes[model];
      } else {
        if (typeof backendOrNull !== 'string' || !backendOrNull.trim()) fail(`model_routes['${model}'] must be a non-empty string or null`);
        next.model_routes[model] = backendOrNull;
      }
    }
  }

  validateConfig(next);
  return next;
}

function main() {
  const args = process.argv.slice(2);
  const reloadFlag = args.includes('--reload');
  const filteredArgs = args.filter(a => a !== '--reload' && a !== '--no-reload');
  const [defaultsPathArg, overridesPathArg, effectivePathArg, specArg] = filteredArgs;

  if (!defaultsPathArg || !overridesPathArg || !effectivePathArg || !specArg) {
    fail('usage: model-map-edit.js <defaults-path> <overrides-path> <effective-output-path> \'<json-edit-spec>\' [--reload]');
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
    const nextEffective = applyUpdates(effective, spec, defaults);
    const nextOverrides = computeOverrideDiff(defaults, nextEffective) || {};
    fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
    fs.mkdirSync(path.dirname(effectivePath), { recursive: true });
    const overridesTmp = `${overridesPath}.tmp.${process.pid}`;
    const effectiveTmp = `${effectivePath}.tmp.${process.pid}`;
    fs.writeFileSync(overridesTmp, `${JSON.stringify(nextOverrides, null, 2)}\n`);
    fs.writeFileSync(effectiveTmp, `${JSON.stringify(nextEffective, null, 2)}\n`);
    fs.renameSync(effectiveTmp, effectivePath);
    fs.renameSync(overridesTmp, overridesPath);
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

  if (reloadFlag) {
    const { spawnSync } = require('child_process');
    const cthru = path.join(path.dirname(effectivePath), 'tools', 'c-thru');
    const result = spawnSync(cthru, ['reload'], { stdio: 'inherit' });
    if (result.status !== 0) {
      process.stderr.write('model-map-edit: --reload: c-thru reload exited ' + (result.status ?? 'null') + '\n');
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  applyUpdates,
};
