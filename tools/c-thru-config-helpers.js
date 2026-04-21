#!/usr/bin/env node
/**
 * c-thru-config-helpers.js — Shared config operations for /c-thru-config skill.
 *
 * Eliminates the ~30-line Node preamble duplicated across 12 subcommands in
 * skills/c-thru-config/SKILL.md. Each SKILL.md subcommand section becomes a
 * thin invocation:
 *   node tools/c-thru-config-helpers.js <subcommand> [--args ...]
 *
 * Subcommands (SKILL.md wiring status in parens):
 *   resolve           Resolve capability/agent → concrete model under current mode+tier  [wired]
 *   mode-read         Show active llm_mode and its source                                [wired]
 *   mode-write        Set llm_mode in overrides (persisted)                              [wired]
 *   remap             Rebind llm_profiles[tier][cap] connected_model + disconnect_model  [implemented; SKILL.md still uses inline block]
 *   set-cloud-best    Set cloud_best_model on a profile entry                            [implemented; SKILL.md still uses inline block]
 *   set-local-best    Set local_best_model on a profile entry                            [implemented; SKILL.md still uses inline block]
 *   route             Bind model name → backend in model_routes                          [implemented; SKILL.md still uses inline block]
 *   backend           Add/update a backend entry                                          [implemented; SKILL.md still uses inline block]
 *
 * All path construction uses path.join / path.resolve (no string concatenation).
 * Honors CLAUDE_PROFILE_DIR env override for ~/.claude location.
 * Reuses model-map-layered.js (3-tier lookup) and model-map-resolve.js.
 * No external npm dependencies — Node.js stdlib only.
 */

'use strict';

const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { execFileSync } = require('child_process');

// ── Shared preamble ────────────────────────────────────────────────────────────

const CLAUDE_DIR = process.env.CLAUDE_PROFILE_DIR
  ? path.resolve(process.env.CLAUDE_PROFILE_DIR)
  : path.join(os.homedir(), '.claude');

const MAP_PATH      = path.join(CLAUDE_DIR, 'model-map.json');
const SYSTEM_PATH   = path.join(CLAUDE_DIR, 'model-map.system.json');
const OVERRIDES_PATH = path.join(CLAUDE_DIR, 'model-map.overrides.json');
const TOOLS_DIR     = path.join(CLAUDE_DIR, 'tools');
const EDIT_SCRIPT   = path.join(TOOLS_DIR, 'model-map-edit');

/**
 * @description Read and parse the merged model-map.json. Exits on parse error.
 * @returns {object} parsed config
 */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  } catch (e) {
    die(`cannot read ${MAP_PATH}: ${e.message}`);
  }
}

/**
 * @description Load model-map-resolve.js from CLAUDE_DIR/tools.
 * @returns {object} resolve module exports
 */
function loadResolve() {
  const resolvePath = path.join(TOOLS_DIR, 'model-map-resolve.js');
  try {
    return require(resolvePath);
  } catch (e) {
    die(`model-map-resolve.js not found at ${resolvePath} — run ./install.sh first`);
  }
}

/**
 * @description Invoke model-map-edit with a JSON spec string.
 * @param {string} spec - JSON spec to merge into overrides
 */
function runEdit(spec) {
  if (!fs.existsSync(EDIT_SCRIPT)) {
    die(`model-map-edit not found at ${EDIT_SCRIPT} — run ./install.sh first`);
  }
  try {
    execFileSync(process.execPath, [EDIT_SCRIPT, SYSTEM_PATH, OVERRIDES_PATH, MAP_PATH, spec], {
      stdio: 'inherit',
    });
  } catch (e) {
    die(`model-map-edit failed: exit ${e.status}`);
  }
}

/**
 * @description Reload the running proxy via c-thru reload. Best-effort.
 */
function reloadProxy() {
  const cthru = path.join(TOOLS_DIR, 'c-thru');
  try {
    execFileSync(cthru, ['reload'], { stdio: 'inherit' });
  } catch {
    process.stdout.write('proxy not running — config saved, will apply on next spawn\n');
  }
}

function die(msg) { process.stderr.write(`c-thru-config-helpers: ${msg}\n`); process.exit(1); }
function arg(args, flagName) {
  const i = args.indexOf(flagName);
  if (i === -1) return null;
  const val = args[i + 1];
  if (val === undefined || val.startsWith('--')) return null;
  return val;
}
function hasFlag(args, flag) { return args.includes(flag); }

// ── Subcommand: resolve ────────────────────────────────────────────────────────

/**
 * @description Resolve capability/agent name → concrete model under current mode+tier.
 * Migrated from: skills/c-thru-config/SKILL.md § resolve
 * @param {string[]} args - remaining CLI args after 'resolve'
 */
function cmdResolve(args) {
  const input = args[0];
  if (!input) { die('usage: c-thru-config-helpers resolve <capability>'); }

  const config = readConfig();
  const { resolveLlmMode, resolveActiveTier, resolveCapabilityAlias, resolveProfileModel, LLM_MODE_ENUM } = loadResolve();

  const mode     = resolveLlmMode(config);
  const tier     = resolveActiveTier(config);
  const capAlias = resolveCapabilityAlias(input, config, tier);

  if (!capAlias) {
    process.stderr.write(`c-thru-config-helpers: unknown capability or agent: ${JSON.stringify(input)}\n`);
    process.exit(2);
  }

  const profile  = (config.llm_profiles || {})[tier];
  if (!profile) { die(`no llm_profiles entry for tier ${tier}`); }

  const aliasKey = capAlias === 'general-default' ? 'default' : capAlias;
  const entry    = profile[aliasKey];
  if (!entry || typeof entry !== 'object') {
    process.stderr.write(`c-thru-config-helpers: no profile entry for ${JSON.stringify(capAlias)} in tier ${tier}\n`);
    process.exit(2);
  }

  const resolved = resolveProfileModel(entry, mode);
  if (!resolved) { die(`resolveProfileModel returned empty for ${JSON.stringify(capAlias)}`); }

  const envMode = process.env.CLAUDE_LLM_MODE;
  const modeSource = envMode
    ? 'CLAUDE_LLM_MODE env'
    : (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) ? MAP_PATH : 'default';

  process.stdout.write(resolved + '\n');
  process.stderr.write(`  capability:  ${capAlias}${input !== capAlias ? `  (via agent: ${input})` : ''}\n`);
  process.stderr.write(`  mode:        ${mode}  (${modeSource})\n`);
  process.stderr.write(`  hw tier:     ${tier}\n`);
  process.stderr.write(`  on_failure:  ${entry.on_failure || 'cascade'}\n`);
}

// ── Subcommand: mode-read ──────────────────────────────────────────────────────

/**
 * @description Show active llm_mode and source.
 * Migrated from: skills/c-thru-config/SKILL.md § mode (read path)
 * @param {string[]} _args
 */
function cmdModeRead(_args) {
  const LLM_MODE_ENUM = new Set(['connected','semi-offload','cloud-judge-only','offline','cloud-best-quality','local-best-quality']);
  let config = {}, overrides = {};
  try { config    = JSON.parse(fs.readFileSync(MAP_PATH,       'utf8')); } catch {}
  try { overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')); } catch {}

  const envMode = process.env.CLAUDE_LLM_MODE;
  if (envMode && LLM_MODE_ENUM.has(envMode)) {
    process.stdout.write(`mode: ${envMode}  (source: CLAUDE_LLM_MODE env — transient, not persisted)\n`);
  } else if (overrides.llm_mode && LLM_MODE_ENUM.has(overrides.llm_mode)) {
    process.stdout.write(`mode: ${overrides.llm_mode}  (source: ${OVERRIDES_PATH})\n`);
  } else if (config.llm_mode && LLM_MODE_ENUM.has(config.llm_mode)) {
    process.stdout.write(`mode: ${config.llm_mode}  (source: ${MAP_PATH} — system default)\n`);
  } else {
    process.stdout.write('mode: connected  (source: built-in default)\n');
  }
}

// ── Subcommand: mode-write ─────────────────────────────────────────────────────

/**
 * @description Persistently set llm_mode in overrides.
 * Migrated from: skills/c-thru-config/SKILL.md § mode (write path)
 * @param {string[]} args - [<mode>] [--reload]
 */
function cmdModeWrite(args) {
  const VALID = new Set(['connected','semi-offload','cloud-judge-only','offline','cloud-best-quality','local-best-quality']);
  const mode = args[0];
  if (!mode || !VALID.has(mode)) {
    die(`invalid mode '${mode}' — valid: ${[...VALID].join(', ')}`);
  }
  runEdit(JSON.stringify({ llm_mode: mode }));
  if (hasFlag(args, '--reload')) {
    process.stdout.write(`mode set to ${mode}\n`);
    reloadProxy();
  } else {
    process.stdout.write(`mode set to ${mode} — run '/c-thru-config reload' to apply to running proxy\n`);
  }
}

// ── Subcommand: remap ──────────────────────────────────────────────────────────

/**
 * @description Rebind llm_profiles[tier][cap] connected_model + disconnect_model.
 * Migrated from: skills/c-thru-config/SKILL.md § remap
 * @param {string[]} args - <tier> <capability> <model> [--reload]
 */
function cmdRemap(args) {
  const [tier, cap, model] = args.filter(a => !a.startsWith('--'));
  if (!tier || !cap || !model) { die('usage: remap <tier> <capability> <model> [--reload]'); }

  const config   = readConfig();
  const existing = ((config.llm_profiles || {})[tier] || {})[cap] || {};
  const entry    = Object.assign({}, existing, { connected_model: model, disconnect_model: model });
  const spec     = JSON.stringify({ llm_profiles: { [tier]: { [cap]: entry } } });

  runEdit(spec);
  process.stdout.write(`remapped ${cap} → ${model}  (tier: ${tier})\n`);
  if (hasFlag(args, '--reload')) {
    reloadProxy();
  } else {
    process.stdout.write(`run '/c-thru-config reload' to apply to running proxy\n`);
  }
}

// ── Subcommand: set-cloud-best ─────────────────────────────────────────────────

/**
 * @description Set cloud_best_model on a profile entry.
 * Migrated from: skills/c-thru-config/SKILL.md § set-cloud-best-model
 * @param {string[]} args - <tier> <capability> <model> [--reload]
 */
function cmdSetCloudBest(args) {
  const [tier, cap, model] = args.filter(a => !a.startsWith('--'));
  if (!tier || !cap || !model) { die('usage: set-cloud-best <tier> <capability> <model> [--reload]'); }

  const config   = readConfig();
  const existing = ((config.llm_profiles || {})[tier] || {})[cap] || {};
  const entry    = Object.assign({}, existing, { cloud_best_model: model });
  const spec     = JSON.stringify({ llm_profiles: { [tier]: { [cap]: entry } } });

  runEdit(spec);
  process.stdout.write(`set cloud_best_model for ${cap} → ${model}  (tier: ${tier})\n`);
  if (hasFlag(args, '--reload')) reloadProxy();
}

// ── Subcommand: set-local-best ─────────────────────────────────────────────────

/**
 * @description Set local_best_model on a profile entry.
 * Migrated from: skills/c-thru-config/SKILL.md § set-local-best-model
 * @param {string[]} args - <tier> <capability> <model> [--reload]
 */
function cmdSetLocalBest(args) {
  const [tier, cap, model] = args.filter(a => !a.startsWith('--'));
  if (!tier || !cap || !model) { die('usage: set-local-best <tier> <capability> <model> [--reload]'); }

  const config   = readConfig();
  const existing = ((config.llm_profiles || {})[tier] || {})[cap] || {};
  const entry    = Object.assign({}, existing, { local_best_model: model });
  const spec     = JSON.stringify({ llm_profiles: { [tier]: { [cap]: entry } } });

  runEdit(spec);
  process.stdout.write(`set local_best_model for ${cap} → ${model}  (tier: ${tier})\n`);
  if (hasFlag(args, '--reload')) reloadProxy();
}

// ── Subcommand: route ──────────────────────────────────────────────────────────

/**
 * @description Bind model name → backend in model_routes.
 * Migrated from: skills/c-thru-config/SKILL.md § route
 * @param {string[]} args - <model> <backend> [--reload]
 */
function cmdRoute(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const [model, backend] = positional;
  if (!model || !backend) { die('usage: route <model> <backend> [--reload]'); }

  const spec = JSON.stringify({ model_routes: { [model]: backend } });
  runEdit(spec);
  process.stdout.write(`bound ${model} → backend '${backend}'\n`);
  if (hasFlag(args, '--reload')) {
    reloadProxy();
  } else {
    process.stdout.write(`run '/c-thru-config reload' to apply to running proxy\n`);
  }
}

// ── Subcommand: backend ────────────────────────────────────────────────────────

/**
 * @description Add or update a backend entry.
 * Migrated from: skills/c-thru-config/SKILL.md § backend
 * @param {string[]} args - <name> <url> [--kind <kind>] [--auth-env <VAR>] [--reload]
 */
function cmdBackend(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const [name, url] = positional;
  if (!name || !url) { die('usage: backend <name> <url> [--kind <kind>] [--auth-env <VAR>] [--reload]'); }

  const kind    = arg(args, '--kind')     || 'ollama';
  const authEnv = arg(args, '--auth-env') || null;
  const entry   = { url, kind };
  if (authEnv) entry.auth_env = authEnv;

  const spec = JSON.stringify({ backends: { [name]: entry } });
  runEdit(spec);
  process.stdout.write(`backend '${name}' set  (url: ${url}, kind: ${kind})\n`);
  if (hasFlag(args, '--reload')) {
    reloadProxy();
  } else {
    process.stdout.write(`run '/c-thru-config reload' to apply to running proxy\n`);
  }
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

const USAGE = `
c-thru-config-helpers — shared config operations for /c-thru-config skill

Subcommands:
  resolve   <capability>                         resolve capability/agent → model
  mode-read                                      show active mode + source
  mode-write <mode> [--reload]                   set llm_mode in overrides
  remap      <tier> <cap> <model> [--reload]     rebind connected+disconnect model
  set-cloud-best <tier> <cap> <model> [--reload] set cloud_best_model
  set-local-best <tier> <cap> <model> [--reload] set local_best_model
  route      <model> <backend> [--reload]        bind model → backend
  backend    <name> <url> [--kind k] [--auth-env VAR] [--reload]  add/update backend
`.trimStart();

const [,, subcmd, ...rest] = process.argv;

switch (subcmd) {
  case 'resolve':        cmdResolve(rest);      break;
  case 'mode-read':      cmdModeRead(rest);     break;
  case 'mode-write':     cmdModeWrite(rest);    break;
  case 'remap':          cmdRemap(rest);        break;
  case 'set-cloud-best': cmdSetCloudBest(rest); break;
  case 'set-local-best': cmdSetLocalBest(rest); break;
  case 'route':          cmdRoute(rest);        break;
  case 'backend':        cmdBackend(rest);      break;
  default:
    process.stdout.write(USAGE);
    process.exit(subcmd ? 1 : 0);
}
