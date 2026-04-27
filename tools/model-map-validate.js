#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_KEYS = ['default', 'classifier', 'explorer', 'reviewer', 'workhorse', 'coder',
  'judge', 'judge-strict', 'orchestrator', 'code-analyst', 'pattern-coder', 'deep-coder',
  'local-planner', 'commit-message-generator',
  'deep-coder-cloud', 'code-analyst-cloud',
  'reasoner', 'fast-scout', 'code-analyst-light', 'deep-coder-precise', 'agentic-coder'];
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
const BACKEND_SIGIL_RE = /^(.+)@([A-Za-z0-9_-]+)$/;
const LLM_MODES = new Set([
  'connected', 'semi-offload', 'cloud-judge-only', 'offline',
  'cloud-best-quality', 'local-best-quality',
  // Phase 1 additions — keep in sync with LLM_MODE_ENUM in model-map-resolve.js (Check 11).
  'local-only', 'cloud-thinking', 'local-review',
  // Phase 2 additions — provider-filter modes
  'cloud-only', 'claude-only', 'opensource-only',
  // Phase 3 additions — benchmark-driven ranking modes
  'fastest-possible', 'smallest-possible', 'best-opensource', 'best-opensource-cloud', 'best-opensource-local',
]);
const ON_FAILURE_VALUES = new Set(['cascade', 'hard_fail']);
const JS_WRAPPER_FLAG = 'C_THRU_ENABLE_TARGET_JS';
const TRUSTED_JS_FLAG = 'C_THRU_MODEL_MAP_TRUSTED_JS';

function fail(message) {
  console.error(`model-map-validate: ${message}`);
  process.exit(1);
}

function checkNoDuplicateKeys(jsonText) {
  const stack = [];
  let i = 0;
  const len = jsonText.length;
  function skipWhitespace() { while (i < len && /\s/.test(jsonText[i])) i++; }
  function readString() {
    let result = '';
    i++; // skip opening "
    while (i < len) {
      const ch = jsonText[i++];
      if (ch === '\\') { i++; continue; }
      if (ch === '"') return result;
      result += ch;
    }
    throw new Error('unterminated string');
  }
  while (i < len) {
    skipWhitespace();
    if (i >= len) break;
    const ch = jsonText[i];
    if (ch === '{') { stack.push(new Set()); i++; }
    else if (ch === '}') { stack.pop(); i++; }
    else if (ch === '[' || ch === ']' || ch === ',' || ch === ':') { i++; }
    else if (ch === '"') {
      const start = i;
      const key = readString();
      skipWhitespace();
      if (i < len && jsonText[i] === ':' && stack.length > 0) {
        const currentObj = stack[stack.length - 1];
        if (currentObj.has(key)) {
          const lineNum = jsonText.slice(0, start).split('\n').length;
          throw new Error(`Duplicate key "${key}" at line ${lineNum}`);
        }
        currentObj.add(key);
      }
    } else {
      i++; // number, true, false, null
    }
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function inferEnvDefaultType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function coerceEnvValue(raw, defaultValue) {
  if (defaultValue === undefined) return raw;
  const defaultType = inferEnvDefaultType(defaultValue);
  if (defaultType === 'string') return raw;
  if (defaultType === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`could not coerce env value '${raw}' to number`);
    return n;
  }
  if (defaultType === 'boolean') {
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    throw new Error(`could not coerce env value '${raw}' to boolean`);
  }
  if (defaultType === 'object' || defaultType === 'array' || defaultType === 'null') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`could not parse env value as JSON: ${error.message}`);
    }
    const parsedType = inferEnvDefaultType(parsed);
    if (parsedType !== defaultType) {
      throw new Error(`expected env JSON type ${defaultType}, got ${parsedType}`);
    }
    return parsed;
  }
  return raw;
}

function isEnvWrapper(value) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, '$env');
}

function isJsWrapper(value) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, '$js');
}

function validateRequestDefaultValue(value, context, report, options) {
  const opts = options || {};
  if (Array.isArray(value)) {
    value.forEach((item, idx) => validateRequestDefaultValue(item, `${context}[${idx}]`, report, opts));
    return;
  }
  if (!isObject(value)) return;

  if (isEnvWrapper(value)) {
    const keys = Object.keys(value).sort();
    if (keys.some(k => k !== '$env' && k !== 'default')) {
      report(`'${context}' env wrapper only supports '$env' and optional 'default'`);
    }
    if (typeof value.$env !== 'string' || !value.$env.trim()) {
      report(`'${context}.$env' must be a non-empty string`);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'default')) {
      validateRequestDefaultValue(value.default, `${context}.default`, report, opts);
      if (typeof value.$env === 'string' && value.$env.trim()) {
        const raw = process.env[value.$env];
        if (raw != null) {
          try {
            coerceEnvValue(raw, value.default);
          } catch (error) {
            report(`'${context}' env '${value.$env}' is invalid: ${error.message}`);
          }
        }
      }
    }
    return;
  }

  if (isJsWrapper(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length !== 1 || keys[0] !== '$js') {
      report(`'${context}' JS wrapper only supports '$js'`);
    }
    if (typeof value.$js !== 'string' || !value.$js.trim()) {
      report(`'${context}.$js' must be a non-empty string`);
    }
    if (!opts.jsEnabled) {
      report(`'${context}' uses '$js' but ${JS_WRAPPER_FLAG}=1 is not set`);
    }
    if (!opts.trustedJs) {
      report(`'${context}' uses '$js' but executable targets are only allowed in trusted profile config`);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    validateRequestDefaultValue(child, `${context}.${key}`, report, opts);
  }
}

function validateTargets(targets, routes, backends, report, options) {
  const opts = options || {};
  if (!isObject(targets)) {
    report("'targets' must be an object when present");
    return;
  }
  if (!targets.default || !isObject(targets.default)) {
    report("'targets.default' must be present and must be an object");
  }
  for (const targetId of Object.keys(targets)) {
    if (isObject(routes) && Object.prototype.hasOwnProperty.call(routes, targetId)) {
      report(`target id '${targetId}' conflicts with routes key '${targetId}'`);
    }
  }
  for (const [targetId, target] of Object.entries(targets)) {
    if (!isObject(target)) {
      report(`'targets.${targetId}' must be an object`);
      continue;
    }
    if (typeof target.backend !== 'string' || !target.backend.trim()) {
      report(`'targets.${targetId}.backend' must be a non-empty string`);
    } else if (isObject(backends) && !Object.prototype.hasOwnProperty.call(backends, target.backend)) {
      report(`'targets.${targetId}.backend' references unknown backend '${target.backend}'`);
    }
    if (target.model != null) {
      if (typeof target.model !== 'string' || !target.model.trim()) {
        report(`'targets.${targetId}.model' must be a non-empty string when present`);
      }
    } else if (targetId !== 'default') {
      report(`'targets.${targetId}.model' is required for named targets`);
    }
    if (target.request_defaults != null) {
      if (!isObject(target.request_defaults)) {
        report(`'targets.${targetId}.request_defaults' must be an object when present`);
      } else {
        for (const reservedKey of ['backend', 'model']) {
          if (Object.prototype.hasOwnProperty.call(target.request_defaults, reservedKey)) {
            report(`'targets.${targetId}.request_defaults.${reservedKey}' is reserved and may not be set`);
          }
        }
        validateRequestDefaultValue(target.request_defaults, `targets.${targetId}.request_defaults`, report, opts);
      }
    }
  }
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

function validateQualityScore(value, context) {
  if (value == null) return;
  if (typeof value !== 'number' || value < 0 || value > 100) {
    throw new Error(`'${context}' must be a number in 0..100`);
  }
}

function validateFallbackChains(chains, report, modelRoutes, backends) {
  if (!isObject(chains)) { report("'fallback_chains' must be an object when present"); return; }
  for (const [tier, capMap] of Object.entries(chains)) {
    if (!isObject(capMap)) { report(`'fallback_chains.${tier}' must be an object`); continue; }
    for (const [cap, candidates] of Object.entries(capMap)) {
      if (!Array.isArray(candidates)) {
        report(`'fallback_chains.${tier}.${cap}' must be an array`);
        continue;
      }
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const ctx = `fallback_chains.${tier}.${cap}[${i}]`;
        if (!isObject(c)) { report(`'${ctx}' must be an object`); continue; }
        if (typeof c.model !== 'string' || !c.model.trim()) {
          report(`'${ctx}.model' must be a non-empty string`);
        } else if (isObject(modelRoutes)) {
          const sigilMatch = c.model.match(BACKEND_SIGIL_RE);
          if (sigilMatch) {
            // @backend sigil is self-routing — no model_routes entry needed
          } else {
            const directMatch = modelRoutes[c.model] !== undefined;
            const patternMatch = !directMatch && Object.keys(modelRoutes).some(k => {
              if (!k.startsWith('re:')) return false;
              try { return new RegExp(k.slice(3)).test(c.model); } catch { return false; }
            });
            if (!directMatch && !patternMatch) {
              report(`'${ctx}.model' value '${c.model}' is not in model_routes — add a route entry or fix the model name`);
            }
          }
        }
        try { validateQualityScore(c.quality_score, `${ctx}.quality_score`); } catch (e) { report(e.message); }
        try { validateQualityScore(c.speed_score, `${ctx}.speed_score`); } catch (e) { report(e.message); }
      }
      // Quality must be monotonically non-increasing (+1 tolerance for speed-for-quality trades)
      for (let i = 0; i < candidates.length - 1; i++) {
        const curr = candidates[i], next = candidates[i + 1];
        if (curr.quality_score != null && next.quality_score != null) {
          if (next.quality_score > curr.quality_score + 1) {
            report(
              `fallback_chains.${tier}.${cap}[${i}→${i+1}]: quality inversion — ` +
              `'${curr.model}'(q=${curr.quality_score}) followed by ` +
              `'${next.model}'(q=${next.quality_score})`
            );
          }
        }
      }
      // Last entry must be a local (ollama) model — chains must terminate locally
      if (candidates.length > 0 && isObject(modelRoutes) && isObject(backends)) {
        const last = candidates[candidates.length - 1];
        if (typeof last.model === 'string') {
          const sigil = last.model.match(BACKEND_SIGIL_RE);
          const backendId = sigil ? sigil[1] : modelRoutes[last.model];
          const backend = backendId && backends[backendId];
          const isLocal = backend && backend.kind === 'ollama' && !last.model.endsWith(':cloud');
          if (!isLocal) {
            report(
              `fallback_chains.${tier}.${cap}: terminal entry '${last.model}' must be a local ` +
              `(ollama) model — chains must not terminate on a cloud endpoint`
            );
          }
        }
      }
    }
  }
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

function validateConfig(config, _errors, options) {
  const report = _errors
    ? (msg) => _errors.push(msg)
    : (msg) => fail(msg);
  const opts = Object.assign({
    jsEnabled: process.env[JS_WRAPPER_FLAG] === '1',
    trustedJs: process.env[TRUSTED_JS_FLAG] === '1',
  }, options || {});

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

  if (config.llm_mode != null && !LLM_MODES.has(config.llm_mode)) {
    report(`'llm_mode' must be one of: ${[...LLM_MODES].join(', ')}`);
  }

  if (config.llm_connectivity_mode != null) {
    if (!CONNECTIVITY_MODES.has(config.llm_connectivity_mode)) {
      report("'llm_connectivity_mode' must be 'connected' or 'disconnect'");
    } else if (config.llm_mode == null) {
      // Non-fatal migration hint: only warn when llm_mode is absent (both present = silent coexistence; llm_mode wins)
      console.warn("model-map-validate: warning: 'llm_connectivity_mode' is deprecated; migrate to 'llm_mode' (connected|semi-offload|cloud-judge-only|offline)");
    }
    // else: both fields present — llm_mode takes precedence; no warning needed
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
            if (profileValue[aliasName].on_failure != null && !ON_FAILURE_VALUES.has(profileValue[aliasName].on_failure)) {
              report(`'llm_profiles.${profileName}.${aliasName}.on_failure' must be one of: ${[...ON_FAILURE_VALUES].join(', ')}`);
            }
            const modesEntry = profileValue[aliasName].modes;
            if (modesEntry != null) {
              if (!isObject(modesEntry)) {
                report(`'llm_profiles.${profileName}.${aliasName}.modes' must be an object`);
              } else {
                for (const modeKey of Object.keys(modesEntry)) {
                  if (!LLM_MODES.has(modeKey)) {
                    report(`'llm_profiles.${profileName}.${aliasName}.modes.${modeKey}' is not a valid llm_mode (expected one of: ${[...LLM_MODES].join(', ')})`);
                  }
                  if (typeof modesEntry[modeKey] !== 'string' || !modesEntry[modeKey].trim()) {
                    report(`'llm_profiles.${profileName}.${aliasName}.modes.${modeKey}' must be a non-empty string`);
                  }
                }
              }
            }
            for (const optKey of ['cloud_best_model', 'local_best_model']) {
              const v = profileValue[aliasName][optKey];
              if (v != null && (typeof v !== 'string' || !v.trim())) {
                report(`'llm_profiles.${profileName}.${aliasName}.${optKey}' must be a non-empty string when present`);
              }
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

  if (config.model_routes != null && isObject(config.model_routes) && isObject(config.backends)) {
    // A target value may be either a backend id (validated against config.backends), or a
    // model name (forwarded by resolveBackend — model_routes lookup, sigil parse, or fallback).
    // Since we don't have a closed list of valid model names, we only validate backend-id strings.
    const validateTarget = (modelKey, target, modeLabel = '') => {
      const ctx = modeLabel ? `${modelKey} (mode='${modeLabel}')` : modelKey;
      if (typeof target !== 'string' || !target.trim()) {
        report(`model_routes['${ctx}'] must be a non-empty string (backend id or model name)`);
        return;
      }
      // Resolution rule (matches resolveBackend in claude-proxy):
      //   1. If target matches a declared backend id → terminal, valid.
      //   2. Else if target looks like a model name (contains '@', '.', or ':')
      //      → recursive resolution will handle it; can't validate without
      //      simulating the full route graph, so we accept it here.
      //   3. Else → bare identifier that's neither a backend nor model-name-shaped.
      //      Almost certainly a typo (e.g. 'anthropi' for 'anthropic'). Report.
      // The order matters: future backend ids could legitimately contain '.' or
      // '_' (e.g. "ollama.local", "bedrock_us-east-1"), and checking backends
      // first means a typo won't silently pass on those configs.
      if (config.backends[target]) return;
      if (/[@.:]/.test(target)) return;
      report(`model_routes['${ctx}'] references unknown backend '${target}'`);
    };
    for (const [modelKey] of Object.entries(config.model_routes)) {
      const sigilMatch = modelKey.match(BACKEND_SIGIL_RE);
      if (sigilMatch) {
        const [, , backendId] = sigilMatch;
        if (!config.backends[backendId]) {
          report(`model_routes key '${modelKey}' references @backend '${backendId}' which is not declared in backends`);
        }
      }
      const target = config.model_routes[modelKey];
      // Object form: mode-conditional targets, e.g. { connected: "anthropic", offline: "qwen3.6@ollama_local" }
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        for (const [modeKey, modeTarget] of Object.entries(target)) {
          validateTarget(modelKey, modeTarget, modeKey);
        }
      } else {
        validateTarget(modelKey, target);
      }
    }
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

  if (config.quality_tolerance_pct != null) {
    if (typeof config.quality_tolerance_pct !== 'number' || config.quality_tolerance_pct < 0 || config.quality_tolerance_pct > 100) {
      report("'quality_tolerance_pct' must be a number in 0..100 when present");
    }
  }

  if (config.fallback_chains != null) {
    validateFallbackChains(config.fallback_chains, report, config.model_routes, config.backends);
  }

  if (config.targets != null) {
    validateTargets(config.targets, config.routes, config.backends, report, opts);
  }

  // agent_to_capability: flat map of agent-name → capability-alias, used for 2-hop resolution.
  // Values must be valid profile keys (i.e. a key in PROFILE_KEYS) so that
  // resolveCapabilityAlias can complete the 2-hop lookup without silently falling through
  // to a passthrough on a typo.
  if (config.agent_to_capability != null) {
    const validCapAliases = new Set(PROFILE_KEYS);
    if (!isObject(config.agent_to_capability)) {
      report("'agent_to_capability' must be an object when present");
    } else {
      for (const [agentName, capAlias] of Object.entries(config.agent_to_capability)) {
        if (typeof capAlias !== 'string' || !capAlias.trim()) {
          report(`'agent_to_capability.${agentName}' must be a non-empty string`);
        } else if (!validCapAliases.has(capAlias)) {
          report(`'agent_to_capability.${agentName}' references unknown capability alias '${capAlias}' (expected one of: ${PROFILE_KEYS.join(', ')})`);
        }
      }
    }
  }

  // v1.2 schema keys — optional, accepted when present
  if (config.tool_capability_to_profile != null) {
    if (!isObject(config.tool_capability_to_profile)) {
      report("'tool_capability_to_profile' must be an object when present");
    }
  }
  if (config.models != null) {
    if (!Array.isArray(config.models)) {
      report("'models' must be an array when present");
    } else {
      for (let i = 0; i < config.models.length; i++) {
        const m = config.models[i];
        if (!isObject(m)) { report(`'models[${i}]' must be an object`); continue; }
        if (typeof m.name !== 'string' || !m.name) report(`'models[${i}].name' must be a non-empty string`);
        if (m.equivalents != null && !Array.isArray(m.equivalents)) {
          report(`'models[${i}].equivalents' must be an array when present`);
        }
      }
    }
  }
}

const VALID_HW_TIERS = new Set(['16gb', '32gb', '48gb', '64gb', '128gb']);

function validateRecommendedMappings(config, _errors) {
  const report = _errors
    ? (msg) => _errors.push(msg)
    : (msg) => fail(msg);

  if (!isObject(config)) { report('top-level recommended-mappings must be an object'); return; }
  if (config.schema_version !== 1) {
    report(`'schema_version' must be 1, got ${JSON.stringify(config.schema_version)}`);
  }
  if (typeof config.updated_at !== 'string' || !config.updated_at.trim()) {
    report("'updated_at' must be a non-empty string");
  }

  const validCaps = new Set(PROFILE_KEYS);
  const recs = config.recommendations;
  if (recs != null) {
    if (!isObject(recs)) {
      report("'recommendations' must be an object");
    } else {
      for (const [cap, tierMap] of Object.entries(recs)) {
        if (!validCaps.has(cap)) {
          report(`'recommendations.${cap}' is not a known capability alias (expected one of: ${PROFILE_KEYS.join(', ')})`);
          continue;
        }
        if (!isObject(tierMap)) { report(`'recommendations.${cap}' must be an object`); continue; }
        for (const [tier, model] of Object.entries(tierMap)) {
          if (!VALID_HW_TIERS.has(tier)) {
            report(`'recommendations.${cap}.${tier}' is not a valid hw tier (expected one of: ${[...VALID_HW_TIERS].join(', ')})`);
          }
          if (typeof model !== 'string' || !model.trim()) {
            report(`'recommendations.${cap}.${tier}' must be a non-empty string`);
          }
        }
      }
    }
  }

  const a2cDefaults = config.agent_to_capability_defaults;
  if (a2cDefaults != null) {
    if (!isObject(a2cDefaults)) {
      report("'agent_to_capability_defaults' must be an object");
    } else {
      for (const [agent, cap] of Object.entries(a2cDefaults)) {
        if (typeof cap !== 'string' || !cap.trim()) {
          report(`'agent_to_capability_defaults.${agent}' must be a non-empty string`);
        } else if (!validCaps.has(cap)) {
          report(`'agent_to_capability_defaults.${agent}' references unknown capability '${cap}'`);
        }
      }
    }
  }
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) fail('usage: model-map-validate.js <path-to-model-map.json> [--rec config/recommended-mappings.json]');
  const absolutePath = path.resolve(filePath);
  const rawText = fs.readFileSync(absolutePath, 'utf8');
  try { checkNoDuplicateKeys(rawText); } catch (e) { fail(e.message); }
  let parsed;
  try { parsed = JSON.parse(rawText); } catch (error) { fail(`JSON parse error: ${error.message}`); }
  const errors = [];
  const profileDir = process.env.CLAUDE_PROFILE_DIR || path.join(process.env.HOME || '', '.claude');
  const trustedProfilePath = path.resolve(profileDir, 'model-map.json');
  const options = {
    jsEnabled: process.env[JS_WRAPPER_FLAG] === '1',
    trustedJs: process.env[TRUSTED_JS_FLAG] === '1' || absolutePath === trustedProfilePath,
  };
  validateConfig(parsed, errors, options);
  if (errors.length > 0) {
    for (const e of errors) console.error(`model-map-validate: ${e}`);
    process.exit(1);
  }

  // Optionally validate recommended-mappings.json when passed as second arg
  const recFlag = process.argv.indexOf('--rec');
  if (recFlag !== -1 && process.argv[recFlag + 1]) {
    const recPath = path.resolve(process.argv[recFlag + 1]);
    let recParsed;
    try {
      recParsed = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    } catch (e) {
      fail(`failed to read '${recPath}': ${e.message}`);
    }
    const recErrors = [];
    validateRecommendedMappings(recParsed, recErrors);
    if (recErrors.length > 0) {
      for (const e of recErrors) console.error(`model-map-validate (rec): ${e}`);
      process.exit(1);
    }
    console.log('recommended-mappings: OK');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PROFILE_KEYS,
  CAPABILITY_KEYS,
  CONNECTIVITY_MODES,
  LLM_MODES,
  VALID_HW_TIERS,
  isObject,
  resolveRoute,
  validateConfig,
  validateRecommendedMappings,
};
