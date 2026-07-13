#!/usr/bin/env node
'use strict';

// Shared capability resolution utilities.
// Extracted from claude-proxy for reuse by c-thru-config skill and the c-thru-resolve CLI.
// Stdlib-only — no external deps. Requires ./hw-profile.js for hardware-tier detection.

const os = require('os');

const { execSync } = require('child_process');

const MODEL_PIN_PREFIX = 'model:';

// 5 semantically clear routing modes replacing the old 17-mode enum.
// Schema: llm_profiles[capability][mode][tier] = concrete model string.
const LLM_MODE_ENUM = new Set([
  'best-cloud',       // Anthropic (Opus/Sonnet) primary; OSS cloud-local fallback
  'best-cloud-oss',   // OSS cloud-hosted primary (OpenRouter); Anthropic fallback
  'best-local-oss',   // Fully local OSS; no cloud egress
  'best-cloud-gov',   // USGov: Anthropic + non-Chinese OSS only; Chinese-origin models blocked
  'best-local-gov',   // USGov local: non-Chinese local models only
]);

// Default: cloud-hosted open-source models (DeepSeek/Kimi/GLM via *:cloud).
// Use --mode best-cloud or CLAUDE_LLM_MODE=best-cloud for Anthropic primary.
const DEFAULT_MODE = 'best-cloud-oss';

// validModes — the set of selectable mode names: the 5 built-ins (LLM_MODE_ENUM)
// PLUS any user-declared custom modes (config.custom_modes keys). A custom mode is
// a label that maps capabilities → models via a `base` built-in mode plus per-
// capability llm_profiles overrides. Derived at runtime so LLM_MODE_ENUM stays the
// authoritative builtin constant (c-thru-contract-check Check 11 compares it).
function validModes(config) {
  const custom = config && config.custom_modes && typeof config.custom_modes === 'object'
    ? Object.keys(config.custom_modes) : [];
  return new Set([...LLM_MODE_ENUM, ...custom]);
}

// baseModeFor — the built-in mode a (possibly custom) mode resolves under for
// capabilities it doesn't explicitly override. Built-in modes are their own base.
function baseModeFor(mode, config) {
  const cm = config && config.custom_modes && config.custom_modes[mode];
  if (cm && typeof cm === 'object' && typeof cm.base === 'string') return cm.base;
  return null;
}

// isGovMode — true if `mode` is a built-in gov mode OR a custom mode whose `base`
// is a gov mode. The runtime Chinese-origin filter (filterFor/resolveLocalFallback)
// must engage for gov-BASED custom modes too — not just modes literally named
// best-*-gov — or a gov-labelled custom mode would bypass the gov filter at request
// time (validation alone is not a runtime backstop). Pass `config` to catch custom modes.
const GOV_MODES = new Set(['best-cloud-gov', 'best-local-gov']);
function isGovMode(mode, config) {
  if (GOV_MODES.has(mode)) return true;
  const base = baseModeFor(mode, config);
  return base != null && GOV_MODES.has(base);
}

// Translate a requested mode (canonical, custom, or legacy vocabulary) to a
// selectable mode name. Mirrors the legacy branches in resolveLlmMode, but returns
// null for anything unrecognized — callers that take explicit user input (e.g. the
// proxy's POST /c-thru/mode) must reject garbage rather than silently degrade.
// Pass `config` to accept user-declared custom modes; without it only built-ins resolve.
function normalizeLlmMode(mode, config) {
  if (validModes(config).has(mode)) return mode;
  return {
    offline: 'best-local-oss',
    disconnect: 'best-local-oss',
    connected: DEFAULT_MODE,
  }[mode] ?? null;
}

// USGov filter: models of Chinese origin are blocked in gov modes.
// Matching must catch provider-prefixed slugs (OpenRouter/Ollama-cloud name Qwen as
// 'qwen/qwen3-...', GLM 4.5+ as 'z-ai/glm-4.6'), not only bare 'qwen3' — a start-anchored
// regex let those bypass the gov block entirely. We over-block by design: in a gov context
// a false positive (refusing a model) is far safer than a false negative (serving a banned one).
// Family tokens are matched at string start OR right after a '/' or ':' separator, bounded so
// they don't match mid-word (e.g. 'gemini' must not match 'yi').
const CHINESE_FAMILY_TOKENS = [
  'qwen', 'qwq', 'deepseek', 'kimi', 'moonshot', 'glm', 'chatglm', 'minimax',
  'baichuan', 'internlm', 'ernie', 'hunyuan', 'doubao', 'yi', 'telechat',
  'skywork', 'step', 'xverse', 'orion', 'cogvlm', 'cogagent',
];
// Vendor/org slugs that denote Chinese origin regardless of the family token.
const CHINESE_VENDOR_TOKENS = [
  'moonshotai', 'thudm', 'zhipu', 'z-ai', '01-ai', 'alibaba', 'dashscope',
  'baidu', 'bytedance', 'stepfun', 'minimaxai', 'deepseek-ai', 'qwen', 'tencent',
];
const CHINESE_FAMILY_RE = new RegExp('(^|[/:])(' + CHINESE_FAMILY_TOKENS.join('|') + ')($|[-_.:/0-9])');
function isChineseOrigin(model) {
  if (!model || typeof model !== 'string') return false;
  const lower = model.toLowerCase();
  for (const v of CHINESE_VENDOR_TOKENS) {
    if (lower === v || lower.startsWith(v + '/') || lower.includes('/' + v + '/') || lower.includes('/' + v + ':') || lower.startsWith(v + ':')) return true;
  }
  return CHINESE_FAMILY_RE.test(lower);
}

// Auto-auth: derive default auth shape from endpoint URL host. First match wins.
// Each profile encodes both the outbound header shape and (for bearer_priority)
// the incoming-Bearer-promotion semantics. Endpoints with explicit `auth*` fields
// still win — this is the default when no explicit declaration is present.
//   bearer_priority — Anthropic-family. Incoming Bearer wins; otherwise fill from env (x-api-key).
//   header_env      — fixed header from env var; no incoming-Bearer promotion (third-party).
//                     Incoming Anthropic auth is stripped to prevent key leakage.
//   none            — strip all auth (local/dummy backends; Ollama gets Bearer ollama injected later).
const KNOWN_HOSTS = [
  { match: /(^|\.)anthropic\.com$/,
    profile: 'bearer_priority', header: 'x-api-key', env: 'ANTHROPIC_API_KEY' },
  { match: /(^|\.)openrouter\.ai$/,
    profile: 'header_env', header: 'Authorization', scheme: 'Bearer', env: 'OPENROUTER_API_KEY' },
  { match: /(^|\.)generativelanguage\.googleapis\.com$/,
    profile: 'header_env', header: 'x-goog-api-key', env: 'GOOGLE_API_KEY' },
  { match: /(^|\.)aiplatform\.googleapis\.com$/,
    profile: 'header_env', header: 'Authorization', scheme: 'Bearer', env: 'GOOGLE_CLOUD_TOKEN' },
  { match: /^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/,
    profile: 'none' },
  { match: /(^|\.)ollama\.ai$/,
    profile: 'none' },
];

// Resolve the host of a backend URL, expanding ${VAR} placeholders if present so
// templated URLs (e.g. Vertex with ${GOOGLE_CLOUD_REGION}) can still be matched
// against the host table.
function backendHost(backend) {
  if (!backend || !backend.url) return null;
  let url = backend.url.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] || '');
  try { return new URL(url).host; } catch (_) { return null; }
}

function deriveAuthProfile(backend) {
  // TEST-ONLY override (inert in production): the integration harness binds every
  // stub on 127.0.0.1, which KNOWN_HOSTS maps to profile 'none' (always-forward),
  // so a spawned proxy can never structurally reach the unknown-host 'passthrough'
  // (auth-STRIP) branch in applyOutboundAuth. When — and ONLY when — the env var
  // CLAUDE_PROXY_TEST_UNKNOWN_HOST_BACKENDS is set, the listed backend ids
  // (comma-separated) are forced to the unknown-host classification (return null),
  // exactly as a genuine non-KNOWN_HOSTS host would derive. The env var is set
  // NOWHERE in any real launch/config path, so this short-circuit is a no-op
  // outside tests. The env is read inline (not a module-scope const) so the
  // string-extraction harness in test/proxy-quality.test.js can eval this
  // function standalone. See test/proxy-auth-strip-e2e.test.js (C12 coverage).
  const _testUnknown = process.env.CLAUDE_PROXY_TEST_UNKNOWN_HOST_BACKENDS;
  if (_testUnknown && backend && backend.id &&
      _testUnknown.split(',').map(s => s.trim()).includes(backend.id)) {
    return null;
  }
  const host = backendHost(backend);
  if (!host) return null;
  for (const entry of KNOWN_HOSTS) if (entry.match.test(host)) return entry;
  return null;
}

function detectConnectivity() {
  try {
    execSync('curl -Is --connect-timeout 2 http://www.google.com', { stdio: 'ignore' });
    return true;
  } catch (e) {
    try {
      execSync('ping -c 1 -W 2 8.8.8.8', { stdio: 'ignore' });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

// ARCH: resolveProfileModel — mode+tier → concrete model, new 3-argument form.
// New schema: llm_profiles[capability][mode] is either:
//   (a) a string — same model for all tiers in that mode
//   (b) a tier-keyed object — {16gb: "...", 32gb: "...", ...}
// Null-return contract: when null is returned, the caller must surface a 503 error.
// The caller is responsible for looking up llm_profiles[capability] and passing that entry.
// `baseMode` (optional) is a custom mode's `base` built-in: a capability the custom
// mode doesn't explicitly override resolves under `base`, then 'best-cloud'. Omitting
// it preserves the original 3-arg semantics exactly (mode → 'best-cloud').
function resolveProfileModel(entry, tier, mode, baseMode) {
  if (!entry) return null;
  let modeValue = entry[mode];
  if (!modeValue && baseMode) modeValue = entry[baseMode]; // custom-mode base fallback
  if (!modeValue) {
    // Graceful fallback to best-cloud if the requested mode has no entry
    const fallback = entry['best-cloud'];
    if (!fallback) return null;
    if (typeof fallback === 'string') return fallback;
    return fallback[tier] ?? null;
  }
  if (typeof modeValue === 'string') return modeValue;
  if (typeof modeValue === 'object') return modeValue[tier] ?? null;
  return null;
}

// resolveLocalFallback — walks local modes to find any available local model for this entry.
// Used by tryLocalTerminalFallback in claude-proxy (replaces disconnect_model lookup).
// activeMode is passed so gov sessions only return non-Chinese-origin models.
// Pass `config` so a gov-BASED custom mode is treated as gov (via isGovMode).
function resolveLocalFallback(entry, tier, activeMode, config) {
  if (!entry) return null;
  const isGov = activeMode != null && isGovMode(activeMode, config);
  const localModes = isGov
    ? ['best-local-gov', 'best-cloud-gov', 'best-cloud']
    : ['best-local-oss', 'best-local-gov', 'best-cloud'];
  for (const mode of localModes) {
    const m = resolveProfileModel(entry, tier, mode);
    if (m && (!isGov || !isChineseOrigin(m))) return m;
  }
  return null;
}

// Resolve the active connectivity mode.
// Precedence: CLAUDE_LLM_MODE → CLAUDE_CONNECTIVITY_MODE (legacy) → config.llm_mode → auto → DEFAULT_MODE
// Legacy vocabulary (offline/disconnect/connected) is normalized via normalizeLlmMode so
// `c-thru --mode offline` (exports CLAUDE_LLM_MODE=offline) is not treated as unknown.
function resolveLlmMode(config) {
  const envMode = process.env.CLAUDE_LLM_MODE;
  if (envMode) {
    const normalized = normalizeLlmMode(envMode, config);
    if (normalized) return normalized;
    process.stderr.write(`model-map-resolve: unknown CLAUDE_LLM_MODE '${envMode}', falling back to ${DEFAULT_MODE}\n`);
  }
  // Legacy env aliases: treat 'connected' as best-cloud, 'offline'/'disconnect' as best-local-oss
  const legacyEnvName = process.env.CLAUDE_CONNECTIVITY_MODE ? 'CLAUDE_CONNECTIVITY_MODE' : (process.env.CLAUDE_LLM_CONNECTIVITY_MODE ? 'CLAUDE_LLM_CONNECTIVITY_MODE' : null);
  const legacyEnv = legacyEnvName ? process.env[legacyEnvName] : null;
  if (legacyEnv) {
    process.stderr.write(`model-map-resolve: ${legacyEnvName} is deprecated, use CLAUDE_LLM_MODE instead\n`);
    const normalized = normalizeLlmMode(legacyEnv, config);
    if (normalized) return normalized;
    return DEFAULT_MODE; // 'connected' or anything else → best-cloud
  }

  let configMode = DEFAULT_MODE;
  if (config && config.llm_mode) {
    const normalized = normalizeLlmMode(config.llm_mode, config);
    if (normalized) {
      configMode = normalized;
    }
    // Other old mode names fall through to DEFAULT_MODE
  } else if (config && config.llm_connectivity_mode) {
    configMode = config.llm_connectivity_mode === 'disconnect' ? 'best-local-oss' : DEFAULT_MODE;
  }

  // Auto-detect connectivity only for the cloud-default mode
  if (configMode === DEFAULT_MODE) {
    if (!detectConnectivity()) return 'best-local-oss';
    return DEFAULT_MODE;
  }

  return configMode;
}

// Resolve the active hardware tier string (e.g. '64gb').
// Precedence: CLAUDE_LLM_PROFILE → config.llm_active_profile → hw detection via CLAUDE_LLM_MEMORY_GB / os.totalmem()
function resolveActiveTier(config) {
  if (process.env.CLAUDE_LLM_PROFILE) return process.env.CLAUDE_LLM_PROFILE;
  const configured = (config && config.llm_active_profile) || 'auto';
  if (configured !== 'auto') return configured;
  const override = process.env.CLAUDE_LLM_MEMORY_GB;
  const totalGb = override && /^\d+$/.test(override)
    ? Number(override)
    : Math.ceil(os.totalmem() / (1024 ** 3));
  const { tierForGb } = require('./hw-profile.js');
  return tierForGb(totalGb);
}

// Resolve a capability alias via 2-hop graph traversal.
// agent name  → agent_to_capability → capability alias  (e.g. coder → coder)
// alias name  → identity                                 (e.g. coder → coder)
// unknown     → null                                     (passthrough, not a profile alias)
function resolveCapabilityAlias(model, config) {
  if (typeof model === 'string' && model.startsWith('advisor:')) {
    const pinnedModel = model.slice('advisor:'.length);
    if (pinnedModel.trim()) return MODEL_PIN_PREFIX + pinnedModel;
  }
  const a2c = config && config.agent_to_capability;
  if (a2c && Object.prototype.hasOwnProperty.call(a2c, model)) return a2c[model];
  // New schema: llm_profiles is capability-outer (not tier-outer).
  // Check if model is a direct capability key.
  const profiles = (config && config.llm_profiles) || {};
  if (Object.prototype.hasOwnProperty.call(profiles, model)) return model;
  return null;
}

function resolveTerminalTarget(config, terminalLabel) {
  if (typeof terminalLabel !== 'string' || !terminalLabel.trim()) return null;
  const targets = (config && config.targets) || null;
  if (!targets || typeof targets !== 'object') return null;

  const explicit = Object.prototype.hasOwnProperty.call(targets, terminalLabel)
    ? targets[terminalLabel]
    : null;
  if (explicit && typeof explicit === 'object') {
    return {
      targetId: terminalLabel,
      backendId: explicit.backend,
      providerModel: explicit.model || terminalLabel,
      requestDefaults: explicit.request_defaults || {},
      target: explicit,
      explicitMatch: true,
      isDefaultTarget: terminalLabel === 'default',
    };
  }

  const defaultTarget = targets.default;
  if (!defaultTarget || typeof defaultTarget !== 'object') return null;
  return {
    targetId: 'default',
    backendId: defaultTarget.backend,
    providerModel: terminalLabel,
    requestDefaults: defaultTarget.request_defaults || {},
    target: defaultTarget,
    explicitMatch: false,
    isDefaultTarget: true,
  };
}

function matchModelRoute(routes, model, opts = {}) {
  const routeMap = routes && typeof routes === 'object' ? routes : {};
  if (Object.prototype.hasOwnProperty.call(routeMap, model)) {
    return { key: model, target: routeMap[model], matchType: 'direct' };
  }
  for (const [key, target] of Object.entries(routeMap)) {
    if (typeof key !== 'string' || !key.startsWith('re:')) continue;
    try {
      if (new RegExp(key.slice(3)).test(model)) return { key, target, matchType: 'regex' };
    } catch (err) {
      if (opts && typeof opts.onBadPattern === 'function') opts.onBadPattern(key, err);
    }
  }
  return null;
}

function pickModeTarget(target, mode) {
  if (target && typeof target === 'object' && !Array.isArray(target) &&
      !Object.prototype.hasOwnProperty.call(target, 'endpoint')) {
    return target[mode] || target.connected || target.default || Object.values(target)[0];
  }
  return target;
}

const BACKEND_SIGIL_RE = /^(.*)@([a-zA-Z0-9_-]+)$/;

function parseBackendSigil(name) {
  if (typeof name !== 'string') return null;
  const match = name.match(BACKEND_SIGIL_RE);
  if (!match || !match[1].trim()) return null;
  return { base: match[1], backendId: match[2] };
}

function routeTargetRepr(target) {
  if (typeof target === 'string') return target;
  try { return JSON.stringify(target); } catch { return String(target); }
}

function resolveRouteTarget(target, model, { routes, endpoints, mode, maxDepth = 8, steps } = {}) {
  const routeMap = routes && typeof routes === 'object' ? routes : {};
  const endpointsMap = endpoints && typeof endpoints === 'object' ? endpoints : {};
  const stepList = steps || [];
  const seen = new Set();

  function walk(currentTarget, currentModel, depthLeft) {
    if (seen.has(currentModel) || depthLeft <= 0) {
      stepList.push({ kind: 'depth-guard', from: currentModel, to: null });
      return null;
    }
    seen.add(currentModel);

    if (currentTarget && typeof currentTarget === 'object' && !Array.isArray(currentTarget) &&
        typeof currentTarget.endpoint === 'string') {
      stepList.push({
        kind: 'alias',
        from: currentModel,
        to: { endpointId: currentTarget.endpoint, servedBy: typeof currentTarget.name === 'string' ? currentTarget.name : currentModel },
      });
      return {
        endpointId: currentTarget.endpoint,
        servedBy: typeof currentTarget.name === 'string' ? currentTarget.name : currentModel,
        steps: stepList,
      };
    }

    const picked = pickModeTarget(currentTarget, mode);
    if (picked !== currentTarget) {
      stepList.push({ kind: 'mode-pick', from: routeTargetRepr(currentTarget), to: routeTargetRepr(picked) });
    }
    currentTarget = picked;

    if (typeof currentTarget !== 'string' || !currentTarget) return null;
    if (endpointsMap[currentTarget]) {
      return { endpointId: currentTarget, servedBy: currentModel, steps: stepList };
    }

    const sigil = parseBackendSigil(currentTarget);
    if (sigil && endpointsMap[sigil.backendId]) {
      stepList.push({ kind: 'sigil', from: currentTarget, to: sigil });
      return { endpointId: sigil.backendId, servedBy: sigil.base, steps: stepList };
    }

    const nested = matchModelRoute(routeMap, currentTarget);
    if (!nested) return null;
    stepList.push({ kind: 'nested', from: currentTarget, to: routeTargetRepr(nested.target) });
    return walk(nested.target, currentTarget, depthLeft - 1);
  }

  return walk(target, model, maxDepth);
}

function resolveModelRoute(model, { routes, endpoints, mode } = {}) {
  const steps = [];
  const match = matchModelRoute(routes, model);
  if (!match) return null;
  steps.push({ kind: 'route', from: model, to: routeTargetRepr(match.target) });
  const resolved = resolveRouteTarget(match.target, model, { routes, endpoints, mode, steps });
  return resolved ? {
    endpointId: resolved.endpointId,
    servedBy: resolved.servedBy,
    matchedKey: match.key,
    matchType: match.matchType,
    steps,
  } : null;
}

// ── Provider-filter predicates ──────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function isClaude(model) {
  return typeof model === 'string' && /^claude-/.test(model);
}

// isCloud — backend-kind authority first, then route literal, then hostname.
function isCloud(model, modelRoutes, backends) {
  if (!model || !modelRoutes || !backends) return false;
  const sigilMatch = model.match(/^(.+)@([A-Za-z0-9_-]+)$/);
  const lookup = sigilMatch ? sigilMatch[1] : model;
  let resolvedBackendId = sigilMatch ? sigilMatch[2] : modelRoutes[lookup];
  if (!resolvedBackendId) {
    for (const [key, val] of Object.entries(modelRoutes)) {
      if (key.startsWith('re:')) {
        try {
          if (new RegExp(key.slice(3)).test(lookup)) { resolvedBackendId = val; break; }
        } catch {}
      }
    }
  }
  if (!resolvedBackendId) return false;
  if (resolvedBackendId === 'ollama_cloud') return true;
  if (resolvedBackendId === 'ollama_local') return false;
  const backend = backends[resolvedBackendId];
  if (backend && backend.kind === 'anthropic') return true;
  if (backend && backend.url) {
    try {
      const host = new URL(backend.url).hostname;
      return !LOCAL_HOSTS.has(host);
    } catch {}
  }
  return lookup.endsWith(':cloud');
}

function isOpenSource(model) {
  return typeof model === 'string' && !isClaude(model);
}

// filterFor — maps mode name to predicate. Returns null for non-filter modes.
// Gov modes apply the Chinese-origin filter as a hard block.
// `config` lets a gov-BASED custom mode engage the Chinese-origin filter (isGovMode).
function filterFor(mode, config) {
  if (isGovMode(mode, config)) return (m) => !isChineseOrigin(m);
  return null;
}

// applyModeFilter — for gov modes, walk primary + fallback chain, return first non-blocked model.
// For non-gov modes, returns primary unchanged.
function applyModeFilter(mode, primary, chain, modelRoutes, backends, config) {
  const predicate = filterFor(mode, config);
  if (!predicate) return primary;
  if (primary && predicate(primary, modelRoutes, backends)) return primary;
  for (const candidate of (chain || [])) {
    const m = typeof candidate === 'string' ? candidate : (candidate && candidate.model);
    if (m && predicate(m, modelRoutes, backends)) return m;
  }
  return null;
}

// ── Benchmark-driven ranking ────────────────────────────────────────────────

function rankableScore(criterion, model, bench, role, minQuality) {
  if (!bench || !bench.models) return null;
  const meta = bench.models[model];
  if (!meta) return null;
  const q = meta.quality_per_role && meta.quality_per_role[role];
  if (q == null) return null;
  if (typeof minQuality === 'number' && q < minQuality) return null;
  switch (criterion) {
    case 'fastest':
      return typeof meta.tokens_per_sec === 'number' && meta.tokens_per_sec > 0
        ? meta.tokens_per_sec : null;
    case 'smallest':
      return typeof meta.ram_gb === 'number' && meta.ram_gb > 0
        ? -meta.ram_gb : null;
    default:
      return q;
  }
}

function pickBenchmarkBest(criterion, candidates, bench, role, modelRoutes, backends) {
  if (!candidates || candidates.length === 0) return null;
  const minQ = bench && bench.role_minimums ? bench.role_minimums[role] : null;
  let best = null;
  let bestKey = null;

  for (const m of candidates) {
    const score = rankableScore(criterion, m, bench, role, minQ);
    if (score == null) continue;
    const meta = bench.models[m] || {};
    const tps  = typeof meta.tokens_per_sec === 'number' ? meta.tokens_per_sec : -1;
    const ram  = typeof meta.ram_gb === 'number' ? -meta.ram_gb : 0;
    const key  = [score, tps, ram, m];

    if (!bestKey || compareKey(key, bestKey) > 0) {
      best = m;
      bestKey = key;
    }
  }
  return best;
}

function compareKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    if (typeof av === 'string' && typeof bv === 'string') {
      if (av < bv) return 1;
      if (av > bv) return -1;
      continue;
    }
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

module.exports = {
  MODEL_PIN_PREFIX,
  resolveProfileModel,
  resolveLocalFallback,
  resolveLlmMode,
  normalizeLlmMode,
  validModes,
  baseModeFor,
  resolveActiveTier,
  resolveCapabilityAlias,
  resolveTerminalTarget,
  matchModelRoute,
  pickModeTarget,
  parseBackendSigil,
  resolveRouteTarget,
  resolveModelRoute,
  LLM_MODE_ENUM,
  DEFAULT_MODE,
  // Auth profile derivation
  KNOWN_HOSTS,
  backendHost,
  deriveAuthProfile,
  // Gov filter
  isChineseOrigin,
  isGovMode,
  filterFor,
  applyModeFilter,
  // Cloud/local/provider predicates (retained for proxy use)
  isClaude,
  isCloud,
  isOpenSource,
  // Benchmark-driven ranking library
  rankableScore,
  pickBenchmarkBest,
};
