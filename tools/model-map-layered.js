#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { validateConfig, isObject } = require('./model-map-validate.js');

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonOrEmpty(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const parsed = readJson(filePath);
  if (!isObject(parsed)) {
    throw new Error(`expected object JSON in '${filePath}'`);
  }
  return parsed;
}

function mergeConfigLayers(base, ...overrides) {
  let effective = deepClone(base);
  for (const override of overrides) {
    if (override === undefined || override === null) continue;
    effective = mergeTwoLayers(effective, override);
  }
  return effective;
}

function mergeTwoLayers(base, override) {
  if (override === undefined) return deepClone(base);
  if (override === null) return undefined;
  if (Array.isArray(base) || Array.isArray(override)) return deepClone(override);
  if (isObject(base) && isObject(override)) {
    const merged = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
    for (const key of keys) {
      const nextValue = mergeTwoLayers(base[key], override[key]);
      if (nextValue !== undefined) merged[key] = nextValue;
    }
    return merged;
  }
  return deepClone(override);
}

function computeOverrideDiff(base, effective) {
  if (effective === undefined) {
    return base === undefined ? undefined : null;
  }
  if (base === undefined) {
    return deepClone(effective);
  }
  if (Array.isArray(base) || Array.isArray(effective)) {
    return deepEqual(base, effective) ? undefined : deepClone(effective);
  }
  if (isObject(base) && isObject(effective)) {
    const diff = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(effective)]);
    for (const key of keys) {
      const child = computeOverrideDiff(base[key], effective[key]);
      if (child !== undefined) diff[key] = child;
    }
    return Object.keys(diff).length ? diff : undefined;
  }
  return deepEqual(base, effective) ? undefined : deepClone(effective);
}

// Module-scope guard so the legacy-shape warning fires at most once per process.
let _v12WarnedOnce = false;

// Synthesize v1.2 schema keys from legacy fallback_strategies shape.
// Only fires when fallback_strategies is present and tool_capability_to_profile is absent.
// Does NOT modify fallback_strategies — legacy proxy code continues reading it unchanged.
// This is config-shape transformation only; it never modifies request-time model fields.
//
// agent_to_capability synthesis is intentionally NOT done here — the proxy resolves
// agent name → capability alias → concrete model via 2-hop graph traversal at request
// time (resolveCapabilityAlias). No data duplication into llm_profiles is needed.
function maybeSynthesizeV12Keys(effective) {
  if (!effective.fallback_strategies || effective.tool_capability_to_profile) return effective;

  if (!_v12WarnedOnce) {
    _v12WarnedOnce = true;
    process.stderr.write('claude-proxy: model-map uses legacy fallback_strategies shape; synthesizing v1.2 keys in-memory. Migrate overrides to v1.2 to silence this.\n');
  }

  const v12 = {};

  if (effective.llm_capabilities) {
    v12.tool_capability_to_profile = {};
    for (const [cap, entry] of Object.entries(effective.llm_capabilities)) {
      if (entry && typeof entry.model === 'string') {
        v12.tool_capability_to_profile[cap] = entry.model;
      }
    }
  }

  // Build a set of (tier, capability) keys already covered by fallback_chains
  // so we don't synthesize redundant legacy equivalents for those pairs.
  const fallbackChainsCovered = new Set();
  if (effective.fallback_chains && typeof effective.fallback_chains === 'object') {
    for (const [tier, capMap] of Object.entries(effective.fallback_chains)) {
      if (capMap && typeof capMap === 'object') {
        for (const cap of Object.keys(capMap)) {
          fallbackChainsCovered.add(`${tier}:${cap}`);
        }
      }
    }
  }

  const modelsArray = [];
  for (const [modelName, strategy] of Object.entries(effective.fallback_strategies)) {
    // Skip synthesis for models covered by capability-layer fallback_chains
    // (determined by checking if any tier covers the capability resolving to this model)
    let coveredByChain = false;
    if (fallbackChainsCovered.size > 0 && effective.llm_profiles) {
      for (const [tier, profile] of Object.entries(effective.llm_profiles)) {
        if (!profile || typeof profile !== 'object') continue;
        for (const [cap, entry] of Object.entries(profile)) {
          if (entry && (entry.connected_model === modelName || entry.disconnect_model === modelName)) {
            if (fallbackChainsCovered.has(`${tier}:${cap}`)) {
              coveredByChain = true;
              break;
            }
          }
        }
        if (coveredByChain) break;
      }
    }
    if (coveredByChain) continue;

    const seen = new Set();
    if (strategy.event) {
      for (const candidates of Object.values(strategy.event)) {
        for (const c of candidates) seen.add(c);
      }
    }
    if (seen.size > 0) {
      modelsArray.push({ name: modelName, equivalents: [...seen] });
    }
  }
  if (modelsArray.length > 0) v12.models = modelsArray;

  return Object.assign({}, effective, v12);
}

function loadLayeredConfig(defaultsPath, globalOverridesPath, projectOverridesPath = null) {
  const defaults = readJson(defaultsPath);
  const globalOverrides = readJsonOrEmpty(globalOverridesPath);
  const projectOverrides = readJsonOrEmpty(projectOverridesPath);
  let effective = mergeConfigLayers(defaults, globalOverrides, projectOverrides);
  effective = maybeSynthesizeV12Keys(effective);
  validateConfig(effective);
  return { defaults, globalOverrides, projectOverrides, effective };
}

function syncLayeredConfig(defaultsPath, globalOverridesPath, projectOverridesPath, effectivePath, bootstrapEffectivePath = null) {
  const defaults = readJson(defaultsPath);
  let globalOverrides = readJsonOrEmpty(globalOverridesPath);
  let projectOverrides = readJsonOrEmpty(projectOverridesPath);

  if (bootstrapEffectivePath && fs.existsSync(bootstrapEffectivePath)) {
    const bootstrapEffective = readJson(bootstrapEffectivePath);
    validateConfig(bootstrapEffective);
    if (projectOverridesPath) {
      // Diff against (defaults + global) and save to project
      const base = mergeConfigLayers(defaults, globalOverrides);
      projectOverrides = computeOverrideDiff(base, bootstrapEffective) || {};
    } else {
      // Diff against defaults and save to global
      globalOverrides = computeOverrideDiff(defaults, bootstrapEffective) || {};
    }
  }

  const effective = mergeConfigLayers(defaults, globalOverrides, projectOverrides);
  validateConfig(effective);

  function writeIfChanged(filePath, content) {
    if (!filePath) return;
    try {
      const current = fs.readFileSync(filePath, 'utf8');
      if (current === content) return;
    } catch {}
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  writeIfChanged(globalOverridesPath, `${JSON.stringify(globalOverrides, null, 2)}\n`);
  writeIfChanged(projectOverridesPath, `${JSON.stringify(projectOverrides, null, 2)}\n`);
  writeIfChanged(effectivePath, `${JSON.stringify(effective, null, 2)}\n`);

  return { defaults, globalOverrides, projectOverrides, effective };
}

module.exports = {
  mergeConfigLayers,
  computeOverrideDiff,
  loadLayeredConfig,
  syncLayeredConfig,
};
