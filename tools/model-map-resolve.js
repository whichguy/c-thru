#!/usr/bin/env node
'use strict';

// Shared capability resolution utilities.
// Extracted from claude-proxy for reuse by c-thru-config skill and the c-thru-resolve CLI.
// Stdlib-only — no external deps. Requires ./hw-profile.js for hardware-tier detection.

const os = require('os');

const { execSync } = require('child_process');

const LLM_MODE_ENUM = new Set(['connected', 'semi-offload', 'cloud-judge-only', 'offline', 'cloud-best-quality', 'local-best-quality']);

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
  if (mode === 'offline') return entry.disconnect_model;
  if (mode === 'connected') return entry.connected_model;
  // semi-offload and cloud-judge-only default to local unless modes[] overrides
  if (mode === 'semi-offload' || mode === 'cloud-judge-only') return entry.disconnect_model;
  if (mode === 'cloud-best-quality') return entry.cloud_best_model ?? entry.connected_model;
  if (mode === 'local-best-quality') return entry.local_best_model ?? entry.disconnect_model;
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

module.exports = {
  resolveProfileModel,
  resolveLlmMode,
  resolveActiveTier,
  resolveCapabilityAlias,
  resolveTerminalTarget,
  LLM_MODE_ENUM,
  LLM_PROFILE_ALIASES,
};
