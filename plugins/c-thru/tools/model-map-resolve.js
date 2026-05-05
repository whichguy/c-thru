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

const DEFAULT_MODE = 'best-cloud';

// USGov filter: models of Chinese origin are blocked in gov modes.
const CHINESE_ORIGIN_PATTERNS = [/^qwen/, /^deepseek/, /^kimi/, /^moonshot/, /moonshotai\//, /^glm/, /thudm\//];
function isChineseOrigin(model) {
  if (!model || typeof model !== 'string') return false;
  const lower = model.toLowerCase();
  return CHINESE_ORIGIN_PATTERNS.some(p => p.test(lower));
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
function resolveProfileModel(entry, tier, mode) {
  if (!entry) return null;
  const modeValue = entry[mode];
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
function resolveLocalFallback(entry, tier, activeMode) {
  if (!entry) return null;
  const govModes = new Set(['best-cloud-gov', 'best-local-gov']);
  const isGov = activeMode != null && govModes.has(activeMode);
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
function resolveLlmMode(config) {
  const envMode = process.env.CLAUDE_LLM_MODE;
  if (envMode) {
    if (!LLM_MODE_ENUM.has(envMode)) {
      process.stderr.write(`model-map-resolve: unknown CLAUDE_LLM_MODE '${envMode}', falling back to ${DEFAULT_MODE}\n`);
    } else {
      return envMode;
    }
  }
  // Legacy env aliases: treat 'connected' as best-cloud, 'offline'/'disconnect' as best-local-oss
  const legacyEnv = process.env.CLAUDE_CONNECTIVITY_MODE || process.env.CLAUDE_LLM_CONNECTIVITY_MODE;
  if (legacyEnv) {
    if (legacyEnv === 'disconnect' || legacyEnv === 'offline') return 'best-local-oss';
    return DEFAULT_MODE; // 'connected' or anything else → best-cloud
  }

  let configMode = DEFAULT_MODE;
  if (config && config.llm_mode) {
    if (LLM_MODE_ENUM.has(config.llm_mode)) {
      configMode = config.llm_mode;
    } else if (config.llm_mode === 'connected') {
      configMode = DEFAULT_MODE;
    } else if (config.llm_mode === 'offline') {
      configMode = 'best-local-oss';
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
// tier must be pre-computed by the caller (use resolveActiveTier).
function resolveCapabilityAlias(model, config, tier) {
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
function filterFor(mode) {
  if (mode === 'best-cloud-gov') return (m) => !isChineseOrigin(m);
  if (mode === 'best-local-gov') return (m) => !isChineseOrigin(m);
  return null;
}

// applyModeFilter — for gov modes, walk primary + fallback chain, return first non-blocked model.
// For non-gov modes, returns primary unchanged.
function applyModeFilter(mode, primary, chain, modelRoutes, backends) {
  const predicate = filterFor(mode);
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
  resolveActiveTier,
  resolveCapabilityAlias,
  resolveTerminalTarget,
  LLM_MODE_ENUM,
  DEFAULT_MODE,
  // Gov filter
  isChineseOrigin,
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
