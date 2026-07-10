#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { validateConfig, isObject } = require('./model-map-validate.js');
const { loadLayeredConfig, computeOverrideDiff, mergeConfigLayers } = require('./model-map-layered.js');

// The keys maybeSynthesizeV12Keys (model-map-layered.js) injects in-memory when a
// config uses the legacy fallback_strategies shape. They are derived, never
// user-authored — applyUpdates() has NO spec handler for either, so they cannot
// be edited through this tool. They must stay in-memory only and never reach
// model-map.overrides.json.
const SYNTHESIZED_V12_KEYS = ['models', 'tool_capability_to_profile'];

// True when loadLayeredConfig would have run the v1.2 synthesizer for this
// pre-synthesis merged config — mirrors the exact trigger in
// maybeSynthesizeV12Keys: fallback_strategies present AND
// tool_capability_to_profile absent.
function isLegacyShapeNeedingSynthesis(mergedPreSynthesis) {
  return !!(mergedPreSynthesis
    && mergedPreSynthesis.fallback_strategies
    && !mergedPreSynthesis.tool_capability_to_profile);
}

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
        for (const [tier, tierValue] of Object.entries(v)) {
          if (!HARDWARE_TIERS.has(tier)) fail(`llm_profiles['${cap}']['${k}']['${tier}'] is not a valid hardware tier; valid: ${[...HARDWARE_TIERS].join(', ')}`);
          // null is valid here — it means "delete this tier" (mirrors the
          // mode-level null-delete semantics below); anything else must be a
          // non-empty string.
          if (tierValue !== null && (typeof tierValue !== 'string' || !tierValue.trim())) {
            fail(`llm_profiles['${cap}']['${k}']['${tier}'] must be a non-empty string or null (to delete)`);
          }
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
        if (isObject(v)) {
          // Tier-object merge: a `null` tier value means "delete this tier"
          // (mirroring the mode-level null-delete handling above), not a
          // literal null to be stored — otherwise it would only be caught
          // later by validateConfig's generic "must be a non-empty string"
          // error, which is confusing given the tier-merge doc comment above
          // promises single-tier updates without clobbering others.
          const base = isObject(merged[k]) ? merged[k] : {};
          const mergedTiers = Object.assign({}, base);
          for (const [tier, tierValue] of Object.entries(v)) {
            if (tierValue === null) { delete mergedTiers[tier]; continue; }
            mergedTiers[tier] = tierValue;
          }
          merged[k] = mergedTiers;
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

  if (spec.entry_aliases != null) {
    if (!isObject(spec.entry_aliases)) fail("'entry_aliases' update payload must be an object");
    next.entry_aliases = isObject(next.entry_aliases) ? { ...next.entry_aliases } : {};
    for (const [pattern, capOrNull] of Object.entries(spec.entry_aliases)) {
      if (capOrNull === null) {
        delete next.entry_aliases[pattern];
      } else {
        if (typeof capOrNull !== 'string' || !capOrNull.trim()) fail(`entry_aliases['${pattern}'] must be a non-empty string or null`);
        next.entry_aliases[pattern] = capOrNull;
      }
    }
    if (Object.keys(next.entry_aliases).length === 0) delete next.entry_aliases;
  }

  if (spec.model_overrides != null) {
    if (!isObject(spec.model_overrides)) fail("'model_overrides' update payload must be an object");
    next.model_overrides = isObject(next.model_overrides) ? { ...next.model_overrides } : {};
    for (const [from, toOrNull] of Object.entries(spec.model_overrides)) {
      if (toOrNull === null) {
        delete next.model_overrides[from];
      } else {
        if (typeof toOrNull !== 'string' || !toOrNull.trim()) fail(`model_overrides['${from}'] must be a non-empty string or null`);
        next.model_overrides[from] = toOrNull;
      }
    }
    if (Object.keys(next.model_overrides).length === 0) delete next.model_overrides;
  }

  if (spec.model_extra_params != null) {
    if (!isObject(spec.model_extra_params)) fail("'model_extra_params' update payload must be an object");
    next.model_extra_params = isObject(next.model_extra_params) ? { ...next.model_extra_params } : {};
    for (const [model, paramsOrNull] of Object.entries(spec.model_extra_params)) {
      if (paramsOrNull === null) {
        delete next.model_extra_params[model];
      } else {
        if (!isObject(paramsOrNull)) fail(`model_extra_params['${model}'] must be an object or null`);
        next.model_extra_params[model] = paramsOrNull;
      }
    }
    if (Object.keys(next.model_extra_params).length === 0) delete next.model_extra_params;
  }

  if (spec.capability_sampling_defaults != null) {
    if (!isObject(spec.capability_sampling_defaults)) fail("'capability_sampling_defaults' update payload must be an object");
    next.capability_sampling_defaults = isObject(next.capability_sampling_defaults) ? { ...next.capability_sampling_defaults } : {};
    for (const [cap, paramsOrNull] of Object.entries(spec.capability_sampling_defaults)) {
      if (paramsOrNull === null) {
        delete next.capability_sampling_defaults[cap];
      } else {
        if (!isObject(paramsOrNull)) fail(`capability_sampling_defaults['${cap}'] must be an object or null`);
        next.capability_sampling_defaults[cap] = paramsOrNull;
      }
    }
    if (Object.keys(next.capability_sampling_defaults).length === 0) delete next.capability_sampling_defaults;
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
    const { defaults, globalOverrides, effective } = loadLayeredConfig(defaultsPath, overridesPath);
    const nextEffective = applyUpdates(effective, spec, defaults);

    // C20: `effective` is post-synthesis (loadLayeredConfig runs maybeSynthesizeV12Keys),
    // so when the source config is legacy-shape, nextEffective carries auto-synthesized
    // `models` / `tool_capability_to_profile`. `defaults` is NOT synthesized, so diffing
    // them straight would record those derived keys as user additions and leak them into
    // model-map.overrides.json. Strip the auto-synthesized values (which the user cannot
    // edit via this tool) from the diff input so only genuine edits are written. Detect
    // synthesis by replicating its trigger on the pre-synthesis merged config.
    let diffInput = nextEffective;
    const mergedPreSynthesis = mergeConfigLayers(defaults, globalOverrides);
    if (isLegacyShapeNeedingSynthesis(mergedPreSynthesis)) {
      diffInput = { ...nextEffective };
      for (const key of SYNTHESIZED_V12_KEYS) {
        if (mergedPreSynthesis[key] === undefined) delete diffInput[key];
      }
    }
    const nextOverrides = computeOverrideDiff(defaults, diffInput) || {};
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
