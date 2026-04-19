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

function mergeConfigLayers(base, override) {
  if (override === undefined) return deepClone(base);
  if (override === null) return undefined;
  if (Array.isArray(base) || Array.isArray(override)) return deepClone(override);
  if (isObject(base) && isObject(override)) {
    const merged = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
    for (const key of keys) {
      const nextValue = mergeConfigLayers(base[key], override[key]);
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
// Fires when fallback_strategies is present but tool_capability_to_profile is absent.
// Does NOT modify fallback_strategies — legacy proxy code continues reading it unchanged.
// This is config-shape transformation only; it never modifies request-time model fields.
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

  const modelsArray = [];
  for (const [modelName, strategy] of Object.entries(effective.fallback_strategies)) {
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

function loadLayeredConfig(defaultsPath, overridesPath) {
  const defaults = readJson(defaultsPath);
  const overrides = readJsonOrEmpty(overridesPath);
  let effective = mergeConfigLayers(defaults, overrides);
  effective = maybeSynthesizeV12Keys(effective);
  validateConfig(effective);
  return { defaults, overrides, effective };
}

function syncLayeredConfig(defaultsPath, overridesPath, effectivePath, bootstrapEffectivePath = null) {
  const defaults = readJson(defaultsPath);
  let overrides;

  if (overridesPath && fs.existsSync(overridesPath)) {
    overrides = readJsonOrEmpty(overridesPath);
  } else if (bootstrapEffectivePath && fs.existsSync(bootstrapEffectivePath)) {
    const bootstrapEffective = readJson(bootstrapEffectivePath);
    validateConfig(bootstrapEffective);
    overrides = computeOverrideDiff(defaults, bootstrapEffective) || {};
  } else {
    overrides = {};
  }

  const effective = mergeConfigLayers(defaults, overrides);
  validateConfig(effective);
  const normalizedOverrides = computeOverrideDiff(defaults, effective) || {};

  if (overridesPath) {
    fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
    fs.writeFileSync(overridesPath, `${JSON.stringify(normalizedOverrides, null, 2)}\n`);
  }
  if (effectivePath) {
    fs.mkdirSync(path.dirname(effectivePath), { recursive: true });
    fs.writeFileSync(effectivePath, `${JSON.stringify(effective, null, 2)}\n`);
  }

  return { defaults, overrides: normalizedOverrides, effective };
}

module.exports = {
  deepClone,
  deepEqual,
  readJson,
  readJsonOrEmpty,
  mergeConfigLayers,
  computeOverrideDiff,
  loadLayeredConfig,
  syncLayeredConfig,
};
