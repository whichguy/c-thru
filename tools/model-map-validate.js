#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Single source of truth for the gov-mode Chinese-origin filter (custom_modes gov safety).
const { deriveAuthProfile, isChineseOrigin } = require('./model-map-resolve.js');

// Per-c-thru-session warning dedupe. When C_THRU_SESSION_ID is set (exported by
// tools/c-thru as $$), each warning string is fingerprinted and recorded in a
// stamp file at ${TMPDIR}/c-thru-warned.<sid>; subsequent matches in the same
// session are skipped. No session id → never dedupe (standalone CLI, tests,
// hooks all emit normally). The c-thru EXIT trap removes the stamp file.
function sessionStampPath() {
  const sid = process.env.C_THRU_SESSION_ID;
  if (!sid) return null;
  const tmp = process.env.TMPDIR || '/tmp';
  return path.join(tmp, `c-thru-warned.${sid}`);
}

function shouldEmitWarning(msg) {
  const stamp = sessionStampPath();
  if (!stamp) return true;
  const fp = crypto.createHash('sha1').update(msg).digest('hex').slice(0, 16);
  let seen = '';
  try { seen = fs.readFileSync(stamp, 'utf8'); } catch { /* first write */ }
  if (seen.includes(fp)) return false;
  try { fs.appendFileSync(stamp, fp + '\n'); } catch { /* best-effort */ }
  return true;
}

// New schema: llm_profiles is capability-outer, not tier-outer.
// 12 pipeline agents + 8 utility agents. Fallback for test fixtures.
const PROFILE_KEYS = [
  'planner', 'planner-hard', 'explore', 'coder', 'coder-fallback', 'tester',
  'docs', 'code-reviewer', 'reviewer-security',
  'debugger-hypothesis', 'debugger-investigate', 'debugger-hard',
  'vision', 'pdf', 'writer', 'edge', 'generalist', 'fast-generalist', 'fast-scout', 'long-context',
];

// Returns the set of capability keys from llm_profiles (outer keys in new schema).
// Falls back to hardcoded PROFILE_KEYS list when the config has no profiles (test fixtures).
function deriveCapabilityAliases(config) {
  const aliases = new Set();
  if (isObject(config.llm_profiles)) {
    for (const key of Object.keys(config.llm_profiles)) aliases.add(key);
  }
  return aliases.size > 0 ? aliases : new Set(PROFILE_KEYS);
}
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
// 5-mode enum — keep in sync with LLM_MODE_ENUM in model-map-resolve.js.
const LLM_MODES = new Set([
  'best-cloud', 'best-cloud-oss', 'best-local-oss', 'best-cloud-gov', 'best-local-gov',
]);
// Short aliases accepted in llm_mode (normalized by resolveLlmMode). Retired
// slot-era names (semi-offload, cloud-judge-only, fastest-possible, …) are NOT
// accepted — use a built-in mode or declare custom_modes.
const LEGACY_LLM_MODES = new Set([
  'connected', 'offline', 'disconnect', 'local-only',
  'best-opensource', 'best-opensource-cloud', 'best-opensource-local',
]);
const HARDWARE_TIERS = new Set(['16gb', '32gb', '48gb', '64gb', '128gb']);
const ON_FAILURE_VALUES = new Set(['cascade', 'hard_fail']);
const JS_WRAPPER_FLAG = 'C_THRU_ENABLE_TARGET_JS';
const TRUSTED_JS_FLAG = 'C_THRU_MODEL_MAP_TRUSTED_JS';

function fail(message) {
  console.error(`model-map-validate: ${message}`);
  process.exit(1);
}

// Resolve active mode + tier from env, mirroring tools/model-map-resolve.js logic.
function getActiveContext() {
  const mode = process.env.CLAUDE_LLM_MODE
            || process.env.CLAUDE_CONNECTIVITY_MODE
            || 'best-cloud';
  const tier = process.env.CLAUDE_LLM_PROFILE || null;
  return { mode, tier };
}

// Walk llm_profiles for models that resolveProfileModel would actually select
// under the active mode, then map each to its endpoint via model_routes.
//
// Mode resolution mirrors tools/model-map-resolve.js resolveProfileModel:
//   active mode → custom_modes[mode].base → best-cloud
// Only the winning mode cell is marked reachable — unused modes (including a
// best-cloud cell that is never fallen back to) must not drive env-var notes
// or template warnings (e.g. GOOGLE_API_KEY / ${GOOGLE_CLOUD_*} when Gemini is
// only mapped under best-cloud while the session runs best-cloud-oss).
function computeReachableSets(config, ctx) {
  const reachableCells = new Set();   // "<cap>.<mode>.<tier|*>"
  const reachableEndpoints = new Set();
  const profiles = (config && config.llm_profiles) || {};
  const routes = (config && config.model_routes) || {};
  const customModes = (config && config.custom_modes) || {};
  const activeMode = (ctx && ctx.mode) || 'best-cloud';
  const baseMode = (isObject(customModes[activeMode])
    && typeof customModes[activeMode].base === 'string')
    ? customModes[activeMode].base
    : null;

  function addEndpointForModel(model) {
    if (typeof model !== 'string' || !model) return;
    const route = routes[model];
    let endpoint = null;
    if (typeof route === 'string') {
      endpoint = route;
    } else if (route && typeof route === 'object') {
      if (typeof route.endpoint === 'string') {
        endpoint = route.endpoint;
      } else {
        // mode-conditional: collect any string-valued mode targets
        for (const v2 of Object.values(route)) {
          if (typeof v2 === 'string') reachableEndpoints.add(v2);
        }
      }
    }
    if (typeof endpoint === 'string') reachableEndpoints.add(endpoint);
  }

  for (const [cap, entry] of Object.entries(profiles)) {
    if (!entry || typeof entry !== 'object') continue;

    // Pick the mode cell that would win at request time (not a union of modes).
    let usedMode = activeMode;
    let modeValue = entry[activeMode];
    if (modeValue == null && baseMode) {
      usedMode = baseMode;
      modeValue = entry[baseMode];
    }
    if (modeValue == null) {
      usedMode = 'best-cloud';
      modeValue = entry['best-cloud'];
    }
    if (modeValue == null) continue;

    if (typeof modeValue === 'string') {
      reachableCells.add(`${cap}.${usedMode}.*`);
      addEndpointForModel(modeValue);
      continue;
    }
    if (typeof modeValue !== 'object' || Array.isArray(modeValue)) continue;

    for (const [tier, model] of Object.entries(modeValue)) {
      if (ctx.tier && tier !== ctx.tier) continue;
      if (typeof model !== 'string') continue;
      reachableCells.add(`${cap}.${usedMode}.${tier}`);
      addEndpointForModel(model);
    }
  }
  return { reachableCells, reachableEndpoints };
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

// New schema: llm_profiles[capability] is a mode-keyed object.
// Each mode key maps to either a string or a tier-keyed object.
function validateCapabilityEntry(capabilityName, entry, report, options) {
  const opts = options || {};
  const reachable = opts.reachable;
  const modelRoutes = opts.modelRoutes;
  const capabilityAliases = opts.capabilityAliases;
  const activeTier = opts.ctx && opts.ctx.tier;
  const warn = (msg) => { if (shouldEmitWarning(msg)) console.warn(msg); };
  // C37: scoped routability warning. Only fires for cells the active session can reach,
  // so a best-cloud session does not warn about best-local-oss orphans.
  const warnIfUnroutable = (model, cellKey, ctxLabel) => {
    if (typeof model !== 'string' || !model.trim()) return;
    if (reachable && !reachable.reachableCells.has(cellKey)) return;
    if (isRoutableModel(model, modelRoutes, capabilityAliases)) return;
    warn(`model-map-validate: warning: '${ctxLabel}' model '${model}' is not routable — not a model_routes key, re: pattern, @backend sigil, capability alias, model: pin, or claude-via-* alias; requests using this entry will fail at runtime`);
  };
  if (!isObject(entry)) {
    report(`'llm_profiles.${capabilityName}' must be an object`);
    return;
  }
  const RESERVED_KEYS = new Set(['on_failure', 'fallback_to', 'fallback_chains']);
  const customModes = opts.customModes || new Set();
  let hasModeKey = false;
  for (const [key, value] of Object.entries(entry)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (!LLM_MODES.has(key) && !customModes.has(key)) {
      const expected = [...LLM_MODES, ...customModes];
      report(`'llm_profiles.${capabilityName}.${key}' is not a valid mode (expected one of: ${expected.join(', ')}) and not a reserved key (${[...RESERVED_KEYS].join(', ')})`);
      continue;
    }
    hasModeKey = true;
    // Gov-safety (C6): a Chinese-origin model placed directly on a built-in gov key
    // (best-cloud-gov / best-local-gov) is invalid — gov modes block those models. The
    // custom_modes block only checks override keys; this covers the built-in gov keys
    // for every capability uniformly. The runtime filter backstops this, but config-time
    // rejection surfaces the mistake before deploy.
    if (key === 'best-cloud-gov' || key === 'best-local-gov') {
      const models = typeof value === 'string' ? [value]
        : isObject(value) ? Object.values(value).filter((v) => typeof v === 'string') : [];
      for (const m of models) {
        if (isChineseOrigin(m)) {
          report(`'llm_profiles.${capabilityName}.${key}' names Chinese-origin model '${m}' — blocked in gov modes`);
        }
      }
    }
    // Value must be a non-empty string (same model for all tiers) or a tier-keyed object
    if (typeof value === 'string') {
      if (!value.trim()) report(`'llm_profiles.${capabilityName}.${key}' must be a non-empty string`);
      if (value.endsWith(':TODO')) {
        if (!reachable || reachable.reachableCells.has(`${capabilityName}.${key}.*`)) {
          warn(`model-map-validate: warning: 'llm_profiles.${capabilityName}.${key}' is a placeholder (${value}) — requests using this entry will fail at runtime`);
        }
      } else {
        // C37: a :TODO placeholder is already covered by its own warning; only check
        // non-placeholder strings here to avoid double-warning the same cell.
        warnIfUnroutable(value, `${capabilityName}.${key}.*`, `llm_profiles.${capabilityName}.${key}`);
      }
    } else if (isObject(value)) {
      const definedTiers = [];
      for (const [tier, model] of Object.entries(value)) {
        if (!HARDWARE_TIERS.has(tier)) {
          report(`'llm_profiles.${capabilityName}.${key}.${tier}' uses unknown hardware tier (expected: ${[...HARDWARE_TIERS].join(', ')})`);
        } else {
          definedTiers.push(tier);
        }
        if (typeof model !== 'string' || !model.trim()) {
          report(`'llm_profiles.${capabilityName}.${key}.${tier}' must be a non-empty string`);
        } else if (model.endsWith(':TODO')) {
          if (!reachable || reachable.reachableCells.has(`${capabilityName}.${key}.${tier}`)) {
            warn(`model-map-validate: warning: 'llm_profiles.${capabilityName}.${key}.${tier}' is a placeholder (${model}) — requests using this entry will fail at runtime`);
          }
        } else {
          // C37: routability for non-placeholder tier-pinned models (reachable-scoped).
          warnIfUnroutable(model, `${capabilityName}.${key}.${tier}`, `llm_profiles.${capabilityName}.${key}.${tier}`);
        }
      }
      // C35(b): when the active tier is PINNED (CLAUDE_LLM_PROFILE) and this reachable
      // mode's tier-object omits that exact tier, resolveProfileModel returns null →
      // a guaranteed runtime 503 (no cross-TIER fallback). Surface it as a config-time
      // ERROR. Skipped when tier is unpinned (auto-detect → ctx.tier null).
      //
      // Scope by MODE-reachability, not the missing cell: computeReachableSets only
      // records cells for tiers that ARE defined, so the missing active-tier cell is
      // never in reachableCells. A mode is reachable when any of its defined-tier cells
      // is — or, defensively, when it is the active/best-cloud mode in ctx.
      if (activeTier && HARDWARE_TIERS.has(activeTier) && !definedTiers.includes(activeTier)) {
        const ctxMode = opts.ctx && opts.ctx.mode;
        const modeReachable = !reachable
          || key === ctxMode || key === 'best-cloud'
          || definedTiers.some(t => reachable.reachableCells.has(`${capabilityName}.${key}.${t}`));
        if (modeReachable) {
          report(`'llm_profiles.${capabilityName}.${key}' is missing the active tier '${activeTier}' (defined tiers: ${definedTiers.join(', ') || 'none'}) — resolveProfileModel returns null for the pinned tier with no cross-tier fallback, a guaranteed runtime 503`);
        }
      }
      // V4: warn when higher tiers exist but are not covered
      const TIER_ORDER = ['16gb', '32gb', '48gb', '64gb', '128gb'];
      if (definedTiers.length > 0) {
        const maxDefinedIdx = Math.max(...definedTiers.map(t => TIER_ORDER.indexOf(t)));
        const missingAbove = TIER_ORDER.slice(maxDefinedIdx + 1).filter(t => !definedTiers.includes(t));
        if (missingAbove.length > 0) {
          warn(`model-map-validate: warning: 'llm_profiles.${capabilityName}.${key}' defines up to '${TIER_ORDER[maxDefinedIdx]}' but is missing higher tiers: ${missingAbove.join(', ')} — requests from those tiers will get null resolution`);
        }
      }
    } else {
      report(`'llm_profiles.${capabilityName}.${key}' must be a string or tier-keyed object`);
    }
  }
  if (!hasModeKey) {
    report(`'llm_profiles.${capabilityName}' has no mode keys (expected at least one of: ${[...LLM_MODES].join(', ')})`);
  }
  if (entry.on_failure != null && !ON_FAILURE_VALUES.has(entry.on_failure)) {
    report(`'llm_profiles.${capabilityName}.on_failure' must be one of: ${[...ON_FAILURE_VALUES].join(', ')}`);
  }
  if (entry.fallback_to != null && typeof entry.fallback_to !== 'string') {
    report(`'llm_profiles.${capabilityName}.fallback_to' must be a string when present`);
  }
}

// C37: a model string is "routable" if the proxy can resolve it to a backend.
// Mirrors the membership/regex test in validateFallbackChains + the resolution-coverage
// Test 8 helper, extended with the alias forms resolveCapabilityAlias understands.
//   - direct model_routes key
//   - model_routes `re:` pattern key
//   - backend @sigil (self-routing)
//   - itself a known llm_profiles capability key (2-hop alias)
//   - a `model:` pin
//   - a `claude-via-*` alias
function isRoutableModel(model, modelRoutes, capabilityAliases) {
  if (typeof model !== 'string' || !model.trim()) return false;
  if (BACKEND_SIGIL_RE.test(model)) return true;
  if (model.startsWith('model:')) return true;
  if (model.startsWith('claude-via-')) return true;
  if (capabilityAliases && capabilityAliases.has(model)) return true;
  if (isObject(modelRoutes)) {
    if (Object.prototype.hasOwnProperty.call(modelRoutes, model)) return true;
    return Object.keys(modelRoutes).some(k => {
      if (!k.startsWith('re:')) return false;
      try { return new RegExp(k.slice(3)).test(model); } catch { return false; }
    });
  }
  return false;
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
          const isLocal = backend && (backend.kind === 'ollama' || (backend.format === 'anthropic' && /localhost|127\.0\.0\.1/.test(backend.url || ''))) && !last.model.endsWith(':cloud');
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

// deprecated_models: flat map of concrete model name -> advice string, or
// false/null to un-deprecate a built-in default (see GEMINI_DEPRECATED_DEFAULTS
// and getDeprecatedModelAdvice in tools/claude-proxy, which reads this exact
// shape at request time). Documented in CLAUDE.md but previously had zero
// shape validation anywhere in this file.
function validateDeprecatedModels(deprecatedModels, report) {
  if (!isObject(deprecatedModels)) { report("'deprecated_models' must be an object when present"); return; }
  for (const [model, advice] of Object.entries(deprecatedModels)) {
    if (advice === false || advice === null) continue; // explicit un-deprecate — always valid
    if (typeof advice !== 'string' || !advice.trim()) {
      report(`'deprecated_models.${model}' must be a non-empty string (advice text), or false/null to un-deprecate (got ${JSON.stringify(advice)})`);
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
  const warn = (msg) => { if (shouldEmitWarning(msg)) console.warn(msg); };
  const note = (msg) => console.error(`model-map-validate: note: ${msg}`);

  if (!isObject(config)) { report('top-level config must be an object'); return; }

  // custom_modes — user-declared named modes: a label mapping capabilities → models
  // via a `base` built-in mode plus per-capability overrides in llm_profiles. Validate
  // here (before llm_profiles) so capability entries may reference custom-mode keys.
  const customModeNames = new Set();
  if (config.custom_modes != null) {
    if (!isObject(config.custom_modes)) {
      report("'custom_modes' must be an object when present");
    } else {
      const GOV_BASES = new Set(['best-cloud-gov', 'best-local-gov']);
      const profilesForCheck = isObject(config.llm_profiles) ? config.llm_profiles : {};
      for (const [name, def] of Object.entries(config.custom_modes)) {
        if (LLM_MODES.has(name)) {
          report(`'custom_modes.${name}' shadows a built-in mode — choose a different name`);
          continue;
        }
        if (LEGACY_LLM_MODES.has(name)) {
          report(`'custom_modes.${name}' shadows a legacy mode alias — choose a different name`);
          continue;
        }
        if (!isObject(def)) { report(`'custom_modes.${name}' must be an object`); continue; }
        const base = def.base;
        if (typeof base !== 'string' || !base.trim()) {
          report(`'custom_modes.${name}.base' is required and must name a built-in mode (one of: ${[...LLM_MODES].join(', ')})`);
          continue;
        }
        if (!LLM_MODES.has(base)) {
          report(`'custom_modes.${name}.base' must be a built-in mode (got '${base}'; expected one of: ${[...LLM_MODES].join(', ')})`);
          continue;
        }
        if (def.description != null && typeof def.description !== 'string') {
          report(`'custom_modes.${name}.description' must be a string when present`);
        }
        customModeNames.add(name);
        // Gov safety: a gov-based custom mode must not be subverted by per-capability
        // overrides that name a Chinese-origin model under this mode's key.
        if (GOV_BASES.has(base)) {
          for (const [cap, entry] of Object.entries(profilesForCheck)) {
            if (!isObject(entry)) continue;
            const ov = entry[name];
            const models = typeof ov === 'string' ? [ov]
              : isObject(ov) ? Object.values(ov).filter(v => typeof v === 'string') : [];
            for (const m of models) {
              if (isChineseOrigin(m)) {
                report(`'llm_profiles.${cap}.${name}' names Chinese-origin model '${m}' but custom mode '${name}' has gov base '${base}' — blocked in gov modes`);
              }
            }
          }
        }
      }
    }
  }
  opts.customModes = customModeNames;

  if (!opts.reachable && isObject(config)) {
    const ctx = opts.ctx || getActiveContext();
    // Honor config-declared llm_mode when env doesn't pin a mode — otherwise
    // reachability filtering silently swallows warnings that target a mode
    // the config explicitly opts into (e.g. best-cloud-gov, best-local-oss).
    if (!process.env.CLAUDE_LLM_MODE && !process.env.CLAUDE_CONNECTIVITY_MODE
        && typeof config.llm_mode === 'string' && config.llm_mode) {
      ctx.mode = config.llm_mode;
    }
    opts.ctx = ctx;
    opts.reachable = computeReachableSets(config, ctx);
  }
  const reachable = opts.reachable;
  // C37: routability context for validateCapabilityEntry — model_routes membership +
  // the set of capability keys (model names may alias another capability via 2-hop lookup).
  opts.modelRoutes = isObject(config.model_routes) ? config.model_routes : {};
  opts.capabilityAliases = deriveCapabilityAliases(config);

  for (const key of ['backends', 'endpoints', 'model_routes', 'routes']) {
    if (config[key] != null && !isObject(config[key])) {
      report(`'${key}' must be an object when present`);
    }
  }

  const endpointsOrBackends = config.endpoints || config.backends;
  const endpointsKey = config.endpoints ? 'endpoints' : 'backends';
  const VALID_FORMATS = new Set(['anthropic', 'openai', 'ollama-legacy', 'gemini']);
  const VALID_CALL_STYLES = new Set(['anthropic', 'gemini', 'openai']);
  if (endpointsOrBackends != null && isObject(endpointsOrBackends)) {
    for (const [id, entry] of Object.entries(endpointsOrBackends)) {
      if (!isObject(entry)) { report(`'${endpointsKey}.${id}' must be an object`); continue; }
      if (entry.format != null && !VALID_FORMATS.has(entry.format)) {
        report(`'${endpointsKey}.${id}.format' must be one of: ${[...VALID_FORMATS].join(', ')}`);
      }
      
      if (Object.prototype.hasOwnProperty.call(entry, 'preserve_claude_code_correlation')
          && typeof entry.preserve_claude_code_correlation !== 'boolean') {
        report(`'endpoints.${id}.preserve_claude_code_correlation' must be a boolean when present`);
      }
if (entry.call_style != null) {
        if (!VALID_CALL_STYLES.has(entry.call_style)) {
          report(`'${endpointsKey}.${id}.call_style' must be one of: ${[...VALID_CALL_STYLES].join(', ')}`);
        } else {
          if (entry.format === 'gemini' && entry.call_style === 'anthropic') {
            warn(`model-map-validate: warning: endpoint '${id}' has format:"gemini" + call_style:"anthropic" — request will passthrough without Gemini translation`);
          }
          if (entry.format !== 'gemini' && entry.call_style === 'gemini') {
            warn(`model-map-validate: warning: endpoint '${id}' has call_style:"gemini" on a non-gemini format endpoint`);
          }
        }
      }
      if (entry.auth != null && entry.auth !== 'none' && entry.auth !== 'subscription') {
        if (typeof entry.auth !== 'object' || Array.isArray(entry.auth)) {
          report(`'${endpointsKey}.${id}.auth' must be "none", "subscription", or an object`);
        } else {
          if (entry.auth.env == null && entry.auth.literal == null) {
            report(`'${endpointsKey}.${id}.auth' object must have 'env' or 'literal' field`);
          }
          if (entry.auth.header != null && (typeof entry.auth.header !== 'string' || !entry.auth.header.trim())) {
            report(`'${endpointsKey}.${id}.auth.header' must be a non-empty string when present`);
          }
        }
      }
      if (entry.auth == null && entry.auth_env == null) {
        const url = entry.url || '';
        if (url && !/localhost|127\.0\.0\.1/.test(url)) {
          if (!reachable || reachable.reachableEndpoints.has(id)) {
            const derivedAuth = deriveAuthProfile(entry);
            if (derivedAuth && derivedAuth.profile !== 'none') {
              // bearer_priority (Anthropic): dual-mode by design (subscription Bearer preferred,
              // API key optional). Do NOT spam every c-thru launch with a note — docs cover it
              // (docs/subscription-auth.md). header_env / other profiles still note the env var.
              if (derivedAuth.profile === 'bearer_priority') {
                // silent — expected for api.anthropic.com; not a misconfiguration
              } else {
                note(`endpoint '${id}' auth auto-derived from host (${derivedAuth.profile}); ensure $${derivedAuth.env} is set`);
              }
            } else if (!derivedAuth) {
              // With the C12 hardening the proxy STRIPS incoming Anthropic auth for an
              // unknown, non-Anthropic host that has no auth config (unless kind:"anthropic"
              // or auth_passthrough:true). So this endpoint will receive NO credentials.
              const escapeHatch = entry.kind === 'anthropic' || entry.auth_passthrough === true;
              warn(escapeHatch
                ? `model-map-validate: warning: endpoint '${id}' has no auth config and url '${url}' is not localhost — incoming Anthropic auth will be forwarded verbatim (kind:"anthropic"/auth_passthrough)`
                : `model-map-validate: warning: endpoint '${id}' has no auth config and url '${url}' is not localhost — incoming auth will be STRIPPED (no credentials sent); set auth_env/auth, or auth_passthrough:true to forward`);
            }
          }
        }
      }
      // V3: warn on unresolved URL template variables (e.g. ${GOOGLE_CLOUD_REGION}).
      // Only for endpoints that a live request under the active mode can hit —
      // unused optional endpoints (shipped gemini_vertex with no mapping) must
      // not spam about GOOGLE_CLOUD_* when Gemini/Vertex is not in the mappings.
      if (entry.url && (!reachable || reachable.reachableEndpoints.has(id))) {
        const templateVarRe = /\$\{([^}]+)\}/g;
        const seenTemplateVars = new Set();
        let m;
        while ((m = templateVarRe.exec(entry.url)) !== null) {
          const varName = m[1];
          if (seenTemplateVars.has(varName)) continue;
          seenTemplateVars.add(varName);
          if (!process.env[varName]) {
            warn(`model-map-validate: warning: endpoint '${id}' url references \${${varName}} but ${varName} is not set in the environment — the URL will be malformed at runtime`);
          }
        }
      }
      // Vertex flag — boolean only; warn if used outside Gemini.
      if (entry.vertex !== undefined) {
        if (typeof entry.vertex !== 'boolean') {
          report(`'${endpointsKey}.${id}.vertex' must be boolean (got ${typeof entry.vertex})`);
        } else if (entry.vertex === true && entry.format !== 'gemini') {
          warn(`model-map-validate: warning: endpoint '${id}' has vertex:true but format is '${entry.format || 'anthropic'}' — vertex flag is only meaningful for format:'gemini'`);
        }
      }
    }
  }

  if (config.routes) {
    for (const routeName of Object.keys(config.routes)) {
      try { resolveRoute(config.routes, routeName); } catch (e) { report(e.message); }
    }
  }

  if (config.llm_mode != null && !LLM_MODES.has(config.llm_mode)
      && !LEGACY_LLM_MODES.has(config.llm_mode) && !customModeNames.has(config.llm_mode)) {
    const validList = [...LLM_MODES, ...customModeNames].join(', ');
    report(`'llm_mode' must be one of: ${validList} (or a legacy mode for backward compat)`);
  }

  if (config.llm_connectivity_mode != null) {
    if (!CONNECTIVITY_MODES.has(config.llm_connectivity_mode)) {
      report("'llm_connectivity_mode' must be 'connected' or 'disconnect'");
    } else if (config.llm_mode == null) {
      // Non-fatal migration hint: only warn when llm_mode is absent (both present = silent coexistence; llm_mode wins)
      warn("model-map-validate: warning: 'llm_connectivity_mode' is deprecated; migrate to 'llm_mode' (best-cloud|best-cloud-oss|best-local-oss|…; aliases: connected|offline)");
    }
    // else: both fields present — llm_mode takes precedence; no warning needed
  }

  if (config.llm_active_profile != null) {
    if (typeof config.llm_active_profile !== 'string' || !config.llm_active_profile.trim()) {
      report("'llm_active_profile' must be a non-empty string");
    }
  }

  // New schema: llm_profiles is capability-outer (not tier-outer).
  // llm_profiles[capability][mode] = string | {tier: string}
  let profiles = null;
  try { profiles = expectObject(config, 'llm_profiles', false); } catch (e) { report(e.message); }
  if (profiles) {
    for (const [capabilityName, capEntry] of Object.entries(profiles)) {
      if (capEntry != null) {
        validateCapabilityEntry(capabilityName, capEntry, report, opts);
      }
    }
    // Cross-reference: fallback_to must point to a known capability key
    for (const [capabilityName, capEntry] of Object.entries(profiles)) {
      if (capEntry != null && typeof capEntry.fallback_to === 'string') {
        if (!Object.prototype.hasOwnProperty.call(profiles, capEntry.fallback_to)) {
          report(`'llm_profiles.${capabilityName}.fallback_to' references unknown capability '${capEntry.fallback_to}'`);
        }
      }
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
      } else if (profiles && !entry.model.startsWith('model:') &&
                 !Object.prototype.hasOwnProperty.call(profiles, entry.model)) {
        report(`'llm_capabilities.${capabilityName}.model' references unknown capability '${entry.model}' (not in llm_profiles)`);
      }
    }
  }

  // V2: sampling bounds validation for capability_sampling_defaults
  if (config.capability_sampling_defaults != null) {
    if (!isObject(config.capability_sampling_defaults)) {
      report("'capability_sampling_defaults' must be an object when present");
    } else {
      for (const [cap, defaults] of Object.entries(config.capability_sampling_defaults)) {
        if (!isObject(defaults)) { report(`'capability_sampling_defaults.${cap}' must be an object`); continue; }
        if (defaults.temperature != null) {
          if (typeof defaults.temperature !== 'number' || defaults.temperature < 0 || defaults.temperature > 2) {
            report(`'capability_sampling_defaults.${cap}.temperature' must be a number in [0, 2] (got ${defaults.temperature})`);
          }
        }
        if (defaults.top_p != null) {
          if (typeof defaults.top_p !== 'number' || defaults.top_p < 0 || defaults.top_p > 1) {
            report(`'capability_sampling_defaults.${cap}.top_p' must be a number in [0, 1] (got ${defaults.top_p})`);
          }
        }
        if (defaults.top_k != null) {
          if (typeof defaults.top_k !== 'number' || !Number.isInteger(defaults.top_k) || defaults.top_k < 1) {
            report(`'capability_sampling_defaults.${cap}.top_k' must be a positive integer (got ${defaults.top_k})`);
          }
        }
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

  if (config.model_routes != null && isObject(config.model_routes) && isObject(endpointsOrBackends)) {
    // A target value may be either a backend id (validated against endpointsOrBackends), or a
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
      //   2. Else if target is itself a model_routes key → recursive hop (e.g.
      //      sonnet@best-cloud → claude-sonnet-5 → anthropic).
      //   3. Else if target looks like a model name (contains '@', '.', or ':')
      //      → recursive resolution will handle it; can't validate without
      //      simulating the full route graph, so we accept it here.
      //   4. Else → bare identifier that's neither a backend nor model-name-shaped.
      //      Almost certainly a typo (e.g. 'anthropi' for 'anthropic'). Report.
      if (endpointsOrBackends[target]) return;
      if (Object.prototype.hasOwnProperty.call(config.model_routes, target)) return;
      if (/[@.:]/.test(target)) return;
      report(`model_routes['${ctx}'] references unknown backend '${target}'`);
    };
    for (const [modelKey] of Object.entries(config.model_routes)) {
      const sigilMatch = modelKey.match(BACKEND_SIGIL_RE);
      if (sigilMatch) {
        const [, , backendId] = sigilMatch;
        if (!endpointsOrBackends[backendId]) {
          report(`model_routes key '${modelKey}' references @backend '${backendId}' which is not declared in backends`);
        }
      }
      const target = config.model_routes[modelKey];
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        if (typeof target.endpoint === 'string') {
          // v2 alias object form: { endpoint: "...", name: "..." }
          if (!endpointsOrBackends[target.endpoint]) {
            report(`model_routes['${modelKey}'].endpoint references unknown endpoint '${target.endpoint}'`);
          }
          if (typeof target.name !== 'string' || !target.name.trim()) {
            report(`model_routes['${modelKey}'].name must be a non-empty string`);
          }
        } else {
          // Mode-conditional targets, e.g. { connected: "anthropic", offline: "qwen3.6@ollama_local" }
          for (const [modeKey, modeTarget] of Object.entries(target)) {
            validateTarget(modelKey, modeTarget, modeKey);
          }
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

  // latest_models: public shorthand → current concrete model id (proxy expand).
  if (config.latest_models != null) {
    if (!isObject(config.latest_models)) {
      report("'latest_models' must be an object");
    } else {
      const routes = config.model_routes || {};
      for (const [from, to] of Object.entries(config.latest_models)) {
        if (typeof from !== 'string' || !from.trim()) {
          report("'latest_models' keys must be non-empty strings");
          continue;
        }
        if (typeof to !== 'string' || !to.trim()) {
          report(`'latest_models.${from}' must be a non-empty string`);
          continue;
        }
        if (from === to) {
          report(`'latest_models.${from}' maps to itself — remove or change`);
          continue;
        }
        // Concrete target should be routable (direct key or later regex — require direct for pinability).
        if (!Object.prototype.hasOwnProperty.call(routes, to) && !endpointsOrBackends[to]) {
          report(`'latest_models.${from}' target '${to}' is not a model_routes key or endpoint id`);
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
    validateFallbackChains(config.fallback_chains, report, config.model_routes, endpointsOrBackends);
  }

  if (config.deprecated_models != null) {
    validateDeprecatedModels(config.deprecated_models, report);
  }

  if (config.targets != null) {
    validateTargets(config.targets, config.routes, endpointsOrBackends, report, opts);
  }

  // agent_to_capability: flat map of agent-name → capability-alias, used for 2-hop resolution.
  // Values must be valid profile keys (i.e. a key in PROFILE_KEYS) so that
  // resolveCapabilityAlias can complete the 2-hop lookup without silently falling through
  // to a passthrough on a typo.
  if (config.agent_to_capability != null) {
    const validCapAliases = deriveCapabilityAliases(config);
    if (!isObject(config.agent_to_capability)) {
      report("'agent_to_capability' must be an object when present");
    } else {
      for (const [agentName, capAlias] of Object.entries(config.agent_to_capability)) {
        if (typeof capAlias !== 'string' || !capAlias.trim()) {
          report(`'agent_to_capability.${agentName}' must be a non-empty string`);
        } else if (capAlias.startsWith('model:')) {
          const direct = capAlias.slice('model:'.length);
          if (!direct.trim()) report(`agent_to_capability.${agentName}: model: prefix requires a non-empty model name`);
          // skip alias-existence check for direct pins
        } else if (!validCapAliases.has(capAlias)) {
          report(`'agent_to_capability.${agentName}' references unknown capability alias '${capAlias}' (expected one of: ${[...validCapAliases].join(', ')})`);
        }
      }
    }
  }

  // advisor_panels: role → mode → { seats: string[2..5], description? }
  // Seats are agent names (preferred), llm_profiles capabilities, or model: pins via agent_to_capability.
  if (config.advisor_panels != null) {
    const validModes = LLM_MODES || CONNECTIVITY_MODES || [];
    const modeSet = new Set(Array.isArray(validModes) ? validModes : [...validModes]);
    const a2c = isObject(config.agent_to_capability) ? config.agent_to_capability : {};
    const validCaps = deriveCapabilityAliases(config);
    if (!isObject(config.advisor_panels)) {
      report("'advisor_panels' must be an object when present");
    } else {
      if (!isObject(config.advisor_panels.default)) {
        report("'advisor_panels.default' is required when advisor_panels is present");
      }
      for (const [role, roleEntry] of Object.entries(config.advisor_panels)) {
        if (!isObject(roleEntry)) {
          report(`'advisor_panels.${role}' must be an object`);
          continue;
        }
        for (const [mode, modeEntry] of Object.entries(roleEntry)) {
          if (modeSet.size && !modeSet.has(mode)) {
            report(`'advisor_panels.${role}.${mode}' is not a valid connectivity mode`);
            continue;
          }
          if (!isObject(modeEntry)) {
            report(`'advisor_panels.${role}.${mode}' must be an object`);
            continue;
          }
          if (modeEntry.description != null && typeof modeEntry.description !== 'string') {
            report(`'advisor_panels.${role}.${mode}.description' must be a string when present`);
          }
          if (!Array.isArray(modeEntry.seats)) {
            report(`'advisor_panels.${role}.${mode}.seats' must be an array`);
            continue;
          }
          if (modeEntry.seats.length < 2 || modeEntry.seats.length > 5) {
            report(`'advisor_panels.${role}.${mode}.seats' must have 2–5 entries (got ${modeEntry.seats.length})`);
          }
          for (let i = 0; i < modeEntry.seats.length; i++) {
            const seat = modeEntry.seats[i];
            if (typeof seat !== 'string' || !seat.trim()) {
              report(`'advisor_panels.${role}.${mode}.seats[${i}]' must be a non-empty string`);
              continue;
            }
            const name = seat.trim();
            const mapped = Object.prototype.hasOwnProperty.call(a2c, name) ? a2c[name] : null;
            if (mapped) {
              if (typeof mapped === 'string' && mapped.startsWith('model:')) {
                if (!mapped.slice('model:'.length).trim()) {
                  report(`'advisor_panels.${role}.${mode}.seats[${i}]' agent '${name}' has empty model: pin`);
                }
              } else if (typeof mapped === 'string' && !validCaps.has(mapped)) {
                report(`'advisor_panels.${role}.${mode}.seats[${i}]' agent '${name}' maps to unknown capability '${mapped}'`);
              }
            } else if (!validCaps.has(name)) {
              report(`'advisor_panels.${role}.${mode}.seats[${i}]' '${name}' is not an agent_to_capability key or llm_profiles capability`);
            }
            // Gov modes: brand agent names that are Chinese-origin families must not be seated
            if (/gov$/.test(mode) || mode.includes('gov')) {
              if (/^(deepseek|qwen|kimi|glm)(-|$)/i.test(name) || /^(deepseek|qwen|kimi|glm)$/i.test(name)) {
                report(`'advisor_panels.${role}.${mode}.seats[${i}]' seats Chinese-origin brand agent '${name}' in a gov mode`);
              }
            }
          }
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

function main() {
  const filePath = process.argv[2];
  if (!filePath) fail('usage: model-map-validate.js <path-to-model-map.json>');
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
}

if (require.main === module) {
  main();
}

module.exports = {
  PROFILE_KEYS,
  CAPABILITY_KEYS,
  CONNECTIVITY_MODES,
  LLM_MODES,
  isObject,
  resolveRoute,
  validateConfig,
};
