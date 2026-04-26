#!/usr/bin/env node
'use strict';

// Shared capability resolution utilities.
// Extracted from claude-proxy for reuse by c-thru-config skill and the c-thru-resolve CLI.
// Stdlib-only — no external deps. Requires ./hw-profile.js for hardware-tier detection.

const os = require('os');

const { execSync } = require('child_process');

const LLM_MODE_ENUM = new Set([
  'connected', 'semi-offload', 'cloud-judge-only', 'offline',
  'cloud-best-quality', 'local-best-quality',
  // Phase 1 additions: alias + slot-based modes
  'local-only', 'cloud-thinking', 'local-review',
  // Phase 2 additions: provider-filter modes (resolved as candidates,
  // then filtered post-resolution in the proxy dispatch via applyModeFilter)
  'cloud-only', 'claude-only', 'opensource-only',
  // Phase 3 additions: benchmark-driven ranking modes (slot default candidate,
  // then ranked-best swap in proxy dispatch via pickBenchmarkBest)
  'fastest-possible', 'smallest-possible', 'best-opensource', 'best-opensource-cloud', 'best-opensource-local',
]);

function detectConnectivity() {
  try {
    // Fast check for internet connectivity.
    // Use a small timeout to avoid hanging the process.
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

// Static set covers the original five aliases + general-default for backward compat.
// Dynamic profile-key lookup in resolveCapabilityAlias catches all other aliases.
const LLM_PROFILE_ALIASES = new Set([
  'classifier', 'explorer', 'reviewer', 'workhorse', 'coder', 'general-default',
]);

// ARCH: resolveProfileModel — mode→concrete model, see wiki/entities/capability-profile-model-layers.md
// Pure: select a concrete model from a profile entry given the active mode.
function resolveProfileModel(entry, mode) {
  if (!entry) return null;
  if (entry.modes && Object.prototype.hasOwnProperty.call(entry.modes, mode)) {
    return entry.modes[mode];
  }
  if (mode === 'offline' || mode === 'local-only') return entry.disconnect_model;
  if (mode === 'connected') return entry.connected_model;
  // semi-offload and cloud-judge-only default to local unless modes[] overrides
  if (mode === 'semi-offload' || mode === 'cloud-judge-only') return entry.disconnect_model;
  if (mode === 'cloud-best-quality') return entry.cloud_best_model ?? entry.connected_model;
  if (mode === 'local-best-quality') return entry.local_best_model ?? entry.disconnect_model;
  // Slot-based directional modes:
  //   cloud-thinking — cloud only for thinking-class capabilities; default local
  //   local-review   — local for review/validation; default cloud
  if (mode === 'cloud-thinking') return entry.modes?.['cloud-thinking'] ?? entry.disconnect_model;
  if (mode === 'local-review')   return entry.modes?.['local-review']   ?? entry.connected_model;
  // Phase 2 provider-filter modes — return CANDIDATE here; the proxy dispatch
  // calls applyModeFilter() afterward to walk fallback_chains for compliance.
  if (mode === 'cloud-only')      return entry.cloud_best_model ?? entry.connected_model;
  if (mode === 'claude-only')     return entry.modes?.['claude-only']     ?? entry.connected_model;
  if (mode === 'opensource-only') return entry.modes?.['opensource-only'] ?? entry.disconnect_model;
  // Phase 3 benchmark-ranking modes — return CANDIDATE; proxy dispatch calls
  // pickBenchmarkBest() afterward to swap to the ranked-best model from benchmark.json.
  if (mode === 'fastest-possible')  return entry.modes?.['fastest-possible']  ?? entry.connected_model;
  if (mode === 'smallest-possible') return entry.modes?.['smallest-possible'] ?? entry.disconnect_model;
  if (mode === 'best-opensource')   return entry.modes?.['best-opensource']   ?? entry.disconnect_model;
  if (mode === 'best-opensource-cloud') return entry.modes?.['best-opensource-cloud'] ?? entry.cloud_best_model ?? entry.connected_model;
  if (mode === 'best-opensource-local') return entry.modes?.['best-opensource-local'] ?? entry.local_best_model ?? entry.disconnect_model;
  return entry.connected_model; // conservative default for unknown modes
}

// Resolve the active connectivity mode.
// Precedence: CLAUDE_LLM_MODE → CLAUDE_CONNECTIVITY_MODE (legacy) → config.llm_mode → (auto detection) → 'connected'
function resolveLlmMode(config) {
  const envMode = process.env.CLAUDE_LLM_MODE;
  if (envMode) {
    if (!LLM_MODE_ENUM.has(envMode)) {
      process.stderr.write(`model-map-resolve: unknown CLAUDE_LLM_MODE '${envMode}', ignoring\n`);
    } else {
      return envMode;
    }
  }
  const legacyEnv = process.env.CLAUDE_CONNECTIVITY_MODE || process.env.CLAUDE_LLM_CONNECTIVITY_MODE;
  if (legacyEnv) return legacyEnv === 'disconnect' ? 'offline' : 'connected';

  let configMode = 'connected';
  if (config && config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) {
    configMode = config.llm_mode;
  } else if (config && config.llm_connectivity_mode) {
    configMode = config.llm_connectivity_mode === 'disconnect' ? 'offline' : 'connected';
  }

  if (configMode === 'connected' || configMode === 'auto') {
    if (!detectConnectivity()) {
      return 'offline';
    }
    return 'connected';
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
// agent name  → agent_to_capability → capability alias  (e.g. implementer → deep-coder)
// alias name  → identity                                 (e.g. deep-coder → deep-coder)
// unknown     → null                                     (passthrough, not a profile alias)
// tier must be pre-computed by the caller (use resolveActiveTier).
function resolveCapabilityAlias(model, config, tier) {
  // agent_to_capability takes priority over LLM_PROFILE_ALIASES so that
  // agent names that shadow profile keys (e.g. explorer → pattern-coder)
  // resolve through the 2-hop graph, not to the identity alias.
  const a2c = config && config.agent_to_capability;
  if (a2c && Object.prototype.hasOwnProperty.call(a2c, model)) return a2c[model];
  if (LLM_PROFILE_ALIASES.has(model)) return model;
  const profile = ((config && config.llm_profiles) || {})[tier];
  if (profile && Object.prototype.hasOwnProperty.call(profile, model)) return model;
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

// ── Provider-filter predicates (Phase 2a) ──────────────────────────────────
// Used by Phase 2 provider-filter modes (cloud-only, claude-only, opensource-only)
// to decide whether a resolved model is compliant with the active mode policy.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function isClaude(model) {
  return typeof model === 'string' && /^claude-/.test(model);
}

// isCloud — backend-kind authority first, then route literal, then hostname,
// then :cloud suffix as last-resort hint. Order chosen so glm-5.1:cloud
// (kind:"ollama" but route:"ollama_cloud") correctly classifies as cloud.
function isCloud(model, modelRoutes, backends) {
  if (!model || !modelRoutes || !backends) return false;
  // 1. Strip @sigil if present
  const sigilMatch = model.match(/^(.+)@([A-Za-z0-9_-]+)$/);
  const lookup = sigilMatch ? sigilMatch[1] : model;
  let resolvedBackendId = sigilMatch ? sigilMatch[2] : modelRoutes[lookup];
  // 2. Pattern-route fallback
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
  // 3. Route literals (definitive)
  if (resolvedBackendId === 'ollama_cloud') return true;
  if (resolvedBackendId === 'ollama_local') return false;
  // 4. Backend-kind authority: anthropic backends are cloud (Anthropic API,
  //    OpenRouter, etc. — all require network egress and credentials).
  const backend = backends[resolvedBackendId];
  if (backend && backend.kind === 'anthropic') return true;
  // 5. URL hostname fallback — non-localhost = cloud
  if (backend && backend.url) {
    try {
      const host = new URL(backend.url).hostname;
      return !LOCAL_HOSTS.has(host);
    } catch {}
  }
  // 6. :cloud suffix — last-resort hint when nothing else informs
  return lookup.endsWith(':cloud');
}

function isOpenSource(model /*, modelRoutes, backends */) {
  // Anything not Claude. Local Ollama, GLM cloud, qwen-coder-next:cloud, OpenRouter
  // non-Claude all qualify. (Future: tighten if a non-OS proprietary backend is added.)
  return typeof model === 'string' && !isClaude(model);
}

// filterFor — maps mode name to predicate. Returns null for non-filter modes.
function filterFor(mode) {
  if (mode === 'cloud-only')      return (m, r, b) => isCloud(m, r, b);
  if (mode === 'claude-only')     return (m /*, r, b */) => isClaude(m);
  if (mode === 'opensource-only') return (m /*, r, b */) => isOpenSource(m);
  return null;
}

// applyModeFilter — given a primary model and a fallback chain, return the first
// model satisfying the filter, or null if none. Walks chain left-to-right.
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

// ── Benchmark-driven ranking (Phase 3 — fastest-possible, smallest-possible, best-opensource) ──
// Pure functions that score and rank model candidates against benchmark.json data.
// Used by the proxy dispatch to swap a candidate model for a benchmark-best one.

// rankableScore — return a score for a model under a ranking criterion, OR null
// if the model is disqualified (no quality data, below threshold, missing metric).
//   Higher score = better. For 'smallest', RAM is negated so higher score = smaller model.
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
    case 'best-opensource':
    case 'best-opensource-cloud':
    case 'best-opensource-local':
      return q;  // higher q = better; tiebreaks applied in pickBenchmarkBest
    default:
      return null;
  }
}

// pickBenchmarkBest — walk candidate models, rank under criterion, return the best
// or null if none qualifies. Tiebreaks (in order): primary score, then tokens_per_sec,
// then -ram_gb (smaller first), then alphabetical (deterministic).
//   criterion: 'fastest' | 'smallest' | 'best-opensource' | 'best-opensource-cloud' | 'best-opensource-local'
//   candidates: array of model name strings
//   bench: parsed docs/benchmark.json
//   role: tournament role to score against (e.g. 'coder', 'generalist')
//   modelRoutes, backends: passed only for the best-opensource isOpenSource filter
function pickBenchmarkBest(criterion, candidates, bench, role, modelRoutes, backends) {
  if (!candidates || candidates.length === 0) return null;
  const minQ = bench && bench.role_minimums ? bench.role_minimums[role] : null;
  let best = null;
  let bestKey = null; // [score, t/s, -ram, alpha] for stable comparison

  for (const m of candidates) {
    if (criterion === 'best-opensource' && !isOpenSource(m, modelRoutes, backends)) continue;
    if (criterion === 'best-opensource-cloud' && (!isOpenSource(m, modelRoutes, backends) || !isCloud(m, modelRoutes, backends))) continue;
    if (criterion === 'best-opensource-local' && (!isOpenSource(m, modelRoutes, backends) || isCloud(m, modelRoutes, backends))) continue;
    const score = rankableScore(criterion, m, bench, role, minQ);
    if (score == null) continue;
    const meta = bench.models[m] || {};
    const tps  = typeof meta.tokens_per_sec === 'number' ? meta.tokens_per_sec : -1;
    const ram  = typeof meta.ram_gb === 'number' ? -meta.ram_gb : 0;  // smaller is better
    const key  = [score, tps, ram, m];

    if (!bestKey || compareKey(key, bestKey) > 0) {
      best = m;
      bestKey = key;
    }
  }
  return best;
}

// compareKey — tuple comparison; returns 1, -1, or 0. Strings compared
// reverse-alphabetically (smaller string = higher key, since alphabetical is
// the *last* tiebreak and we want deterministic reproducibility).
function compareKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    if (typeof av === 'string' && typeof bv === 'string') {
      // For alphabetical tiebreak, smaller string wins (higher in our score order)
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
  resolveProfileModel,
  resolveLlmMode,
  resolveActiveTier,
  resolveCapabilityAlias,
  resolveTerminalTarget,
  LLM_MODE_ENUM,
  LLM_PROFILE_ALIASES,
  // Phase 2a — provider-filter library
  isClaude,
  isCloud,
  isOpenSource,
  filterFor,
  applyModeFilter,
  // Phase 3 — benchmark-driven ranking library
  rankableScore,
  pickBenchmarkBest,
};
