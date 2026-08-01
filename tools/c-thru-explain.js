#!/usr/bin/env node
'use strict';
// c-thru explain — print the resolution chain for a hypothetical request.
// Pure JS (no proxy spawn). Reads model-map.json + benchmark.json.
//
// Usage:
//   c-thru-explain --capability <cap> [--mode <m>] [--tier <t>]
//   c-thru-explain --agent <name>      [--mode <m>] [--tier <t>]
//
// All four flags accept --foo=value or --foo value forms.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  resolveProfileModel,
  resolveCapabilityAlias,
  resolveAdvisorPanel,
  resolveModelRoute,
  baseModeFor,
  validModes,
  applyModeFilter,
  pickBenchmarkBest,
  isClaude, isCloud, isOpenSource, isChineseOrigin, isGovMode,
  MODEL_PIN_PREFIX,
  LLM_MODE_ENUM,
} = require('./model-map-resolve.js');

// ── Arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a.includes('=')) {
      const [k, v] = a.split('=', 2);
      out[k.slice(2)] = v;
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(`Usage: c-thru explain [--capability <cap>] [--agent <name>] [--model <name>] [--mode <m>] [--tier <t>]
         c-thru explain --panel <role> [--mode <m>] [--tier <t>] [--format json|text]
         c-thru explain --all [--mode <m>] [--tier <t>] [--format json|text]

Prints the model resolution chain for a hypothetical request, without sending one.

  --capability <cap>   capability alias (e.g. workhorse, judge, deep-coder)
  --agent <name>       agent name (resolved through agent_to_capability)
  --model <name>       raw model name (resolved through model_routes)
  --panel <role>       advisor panel role (advisor_panels; falls back to "default" for same mode)
  --all                resolve every capability in llm_profiles
  --mode <m>           connectivity / routing mode (default: \$CLAUDE_LLM_MODE or 'best-cloud')
  --tier <t>           hardware tier (default: detected from RAM)
  --format <f>         output format: text (default) or json (with --all or --panel)

Examples:
  c-thru explain --capability coder --mode best-cloud-oss
  c-thru explain --agent tester --mode best-local-oss --tier 64gb
  c-thru explain --model gemini-latest
  c-thru explain --panel default --mode best-cloud-oss --tier 64gb --format json
  c-thru explain --all --format json --mode best-local-oss --tier 64gb
`);
  process.exit(0);
}

// ── Load configs ───────────────────────────────────────────────────────────
const home = process.env.HOME || os.homedir();
const profileDir = process.env.CLAUDE_PROFILE_DIR || path.join(home, '.claude');
const candidatePaths = [
  process.env.CLAUDE_MODEL_MAP_PATH,
  path.join(process.cwd(), '.claude', 'model-map.json'),
  path.join(profileDir, 'model-map.json'),
  path.join(__dirname, '..', 'config', 'model-map.json'),
].filter(Boolean);
let configPath = null;
for (const p of candidatePaths) {
  try { if (fs.existsSync(p)) { configPath = p; break; } } catch {}
}
if (!configPath) {
  console.error('explain: cannot find model-map.json');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// benchmark.json is optional (only needed for ranking modes)
let benchmark = null;
try {
  const benchPath = path.join(__dirname, '..', 'docs', 'benchmark.json');
  if (fs.existsSync(benchPath)) benchmark = JSON.parse(fs.readFileSync(benchPath, 'utf8'));
} catch {}

// ── Resolve inputs ─────────────────────────────────────────────────────────
let capability = args.capability;
let agent = args.agent;
const modelName = args.model;

// --panel branch: resolve advisor_panels seats → concrete models (no dispatch)
if (args.panel) {
  const panelRole = args.panel === true ? 'default' : String(args.panel);
  const theMode = args.mode || process.env.CLAUDE_LLM_MODE || 'best-cloud';
  const theValidModes = validModes(config);
  if (!theValidModes.has(theMode)) {
    console.error(`explain: unknown mode '${theMode}' (valid: ${[...theValidModes].join(', ')})`);
    process.exit(1);
  }
  let theTier = args.tier || process.env.CLAUDE_LLM_PROFILE;
  if (!theTier) {
    try {
      const { tierForGb } = require('./hw-profile.js');
      const gb = process.env.CLAUDE_LLM_MEMORY_GB
        ? Number(process.env.CLAUDE_LLM_MEMORY_GB)
        : Math.ceil(os.totalmem() / (1024 ** 3));
      theTier = tierForGb(gb);
    } catch {
      theTier = '64gb';
    }
  }
  const resolved = resolveAdvisorPanel(config, { role: panelRole, mode: theMode, tier: theTier });
  if (!resolved) {
    console.error(`explain: panel '${panelRole}' not defined in advisor_panels (and no default)`);
    const roles = Object.keys(config.advisor_panels || {});
    if (roles.length) console.error(`         panels: ${roles.join(', ')}`);
    process.exit(1);
  }
  if (args.format === 'json') {
    console.log(JSON.stringify(resolved, null, 2));
  } else {
    const cyan  = process.stdout.isTTY ? '\x1b[36m' : '';
    const bold  = process.stdout.isTTY ? '\x1b[1m'  : '';
    const reset = process.stdout.isTTY ? '\x1b[0m'  : '';
    console.log(`${bold}Advisor panel — role=${resolved.role} mode=${resolved.mode} tier=${resolved.tier}${reset}`);
    if (resolved.requestedRole && resolved.requestedRole !== resolved.role) {
      console.log(`  requested_role  ${resolved.requestedRole} → fell back to ${resolved.role}`);
    }
    if (resolved.description) console.log(`  description     ${resolved.description}`);
    console.log('');
    for (const s of resolved.seats) {
      const model = s.model || '(unresolved)';
      const cap = s.capability || '—';
      const pin = s.pin ? ' [pin]' : '';
      console.log(`  seat ${cyan}${s.name}${reset}  →  ${model}${pin}  (via ${cap})`);
    }
    if (resolved.errors && resolved.errors.length) {
      console.log('');
      for (const e of resolved.errors) console.error(`  error: ${e}`);
    }
  }
  if (resolved.errors && resolved.errors.length) process.exit(1);
  process.exit(0);
}

// --all branch: resolve every capability for the given tier × mode
if (args.all) {
  const theMode = args.mode || process.env.CLAUDE_LLM_MODE || 'best-cloud';
  const theValidModes = validModes(config);
  if (!theValidModes.has(theMode)) {
    console.error(`explain: unknown mode '${theMode}' (valid: ${[...theValidModes].join(', ')})`);
    process.exit(1);
  }
  let theTier = args.tier || process.env.CLAUDE_LLM_PROFILE;
  if (!theTier) {
    try {
      const { tierForGb } = require('./hw-profile.js');
      const gb = process.env.CLAUDE_LLM_MEMORY_GB
        ? Number(process.env.CLAUDE_LLM_MEMORY_GB)
        : Math.ceil(os.totalmem() / (1024 ** 3));
      theTier = tierForGb(gb);
    } catch { theTier = '64gb'; }
  }

  const epMap  = config.endpoints || config.backends || {};
  const LOCAL_RE = /localhost|127\.0\.0\.1|0\.0\.0\.0/;

  const theBaseMode = baseModeFor(theMode, config);
  const results = [];
  for (const [cap, entry] of Object.entries(config.llm_profiles || {})) {
    let model = resolveProfileModel(entry, theTier, theMode, theBaseMode);
    if (!model) continue;
    // gov filter — engages for gov-built-in AND gov-based custom modes.
    // Mirror the proxy: when the primary is gov-blocked, walk
    // fallback_chains[tier][cap] via applyModeFilter for a compliant model
    // instead of dropping the capability outright. Drop only if none compliant.
    if (isGovMode(theMode, config)) {
      const chainModels = (config.fallback_chains?.[theTier]?.[cap] || [])
        .map(c => (typeof c === 'string' ? c : c && c.model)).filter(Boolean);
      const filtered = applyModeFilter(
        theMode, model, chainModels,
        config.model_routes || {}, config.endpoints || config.backends || {}, config
      );
      if (filtered === null) continue;
      model = filtered;
    }

    // Strip @sigil
    const sig    = model.match(/^(.+)@([A-Za-z0-9_-]+)$/);
    const base   = sig ? sig[1] : model;
    const sigilEp = sig ? sig[2] : null;

    // Backend lookup via model_routes
    let epId = sigilEp;
    if (!epId) {
      const resolvedRoute = resolveModelRoute(base, { routes: config.model_routes || {}, endpoints: epMap, mode: theMode });
      epId = resolvedRoute?.endpointId ?? null;
    }

    const ep      = epId ? epMap[epId] : null;
    const epUrl   = ep?.url ?? null;
    const epFmt   = ep?.format ?? 'anthropic';
    const isLocal = ep ? LOCAL_RE.test(ep.url || '') : false;
    const isOllama = isLocal && (epFmt === 'anthropic' || epFmt === 'ollama-legacy');

    // Strip path to scheme://host:port for CLI host
    let cliHost = null;
    if (isLocal && epUrl) {
      try { cliHost = new URL(epUrl).origin; } catch { cliHost = epUrl; }
    }

    results.push({
      capability:        cap,
      model:             base,
      endpoint_id:       epId ?? null,
      endpoint_url:      epUrl,
      endpoint_cli_host: cliHost,
      endpoint_format:   epFmt,
      local:             isLocal,
      ollama:            isOllama,
      is_recommended:    false, // recommended-mappings feature retired; kept for output-schema stability
    });
  }

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    for (const r of results) {
      const tag = r.local ? '[local]' : '[cloud]';
      const recStr = r.is_recommended ? '  (rec)' : '';
      console.log(`  ${r.capability.padEnd(22)} ${r.model.padEnd(40)} ${tag}${recStr}`);
    }
  }
  process.exit(0);
}

if (!capability && !agent && !modelName) {
  console.error('explain: --capability, --agent, --model, or --panel required (try --help)');
  process.exit(1);
}

// --model branch: full logical resolve (mirror proxy resolveBackend order):
//   overrides → latest_models → a2c/capability profile → model_routes → fallthrough
if (modelName && !capability && !agent) {
  const cyan   = process.stdout.isTTY ? '\x1b[36m' : '';
  const gray   = process.stdout.isTTY ? '\x1b[90m' : '';
  const bold   = process.stdout.isTTY ? '\x1b[1m'  : '';
  const reset  = process.stdout.isTTY ? '\x1b[0m'  : '';
  const routes = config.model_routes || {};
  const endpointsMap = config.endpoints || config.backends || {};
  const overrides = config.model_overrides || {};
  const modeForModel = args.mode || process.env.CLAUDE_LLM_MODE || 'best-cloud';
  let tierForModel = args.tier;
  if (!tierForModel) {
    if (process.env.CLAUDE_LLM_PROFILE) tierForModel = process.env.CLAUDE_LLM_PROFILE;
    else {
      try {
        const { tierForGb } = require('./hw-profile.js');
        const gb = process.env.CLAUDE_LLM_MEMORY_GB
          ? Number(process.env.CLAUDE_LLM_MEMORY_GB)
          : Math.ceil(os.totalmem() / (1024 ** 3));
        tierForModel = tierForGb(gb);
      } catch { tierForModel = '64gb'; }
    }
  }

  let working = overrides[modelName] || modelName;
  console.log(`${bold}Resolution chain — model=${modelName} mode=${modeForModel} tier=${tierForModel}${reset}\n`);
  if (overrides[modelName]) {
    console.log(`  model_overrides   ${cyan}${modelName}${reset} → ${cyan}${working}${reset}`);
  }

  let step = 1;
  // Logical name → a2c: brand model: pin OR pipeline capability (coder/tester/…).
  // Use the original name (before latest) so role agents and brand shorthands both hit.
  const capAlias = resolveCapabilityAlias(working, config);
  if (capAlias && typeof capAlias === 'string' && capAlias.startsWith(MODEL_PIN_PREFIX)) {
    const pinned = capAlias.slice(MODEL_PIN_PREFIX.length);
    console.log(`  ${String(step++).padEnd(2)} model pin         ${cyan}${working}${reset} → ${cyan}${pinned}${reset}  ${gray}(${capAlias})${reset}`);
    working = pinned;
  } else if (capAlias && (config.llm_profiles || {})[capAlias]) {
    const entry = config.llm_profiles[capAlias];
    const baseMode = baseModeFor(modeForModel, config);
    const profileModel = resolveProfileModel(entry, tierForModel, modeForModel, baseMode);
    if (profileModel) {
      console.log(`  ${String(step++).padEnd(2)} capability        ${cyan}${working}${reset} → ${cyan}${capAlias}${reset} → ${cyan}${profileModel}${reset}  ${gray}(llm_profiles ${modeForModel}/${tierForModel})${reset}`);
      working = profileModel;
    } else {
      console.log(`  ${String(step++).padEnd(2)} capability        ${cyan}${capAlias}${reset}  ${gray}(no model for ${modeForModel}/${tierForModel})${reset}`);
    }
  }

  // latest_models: brand/family shorthands → current concrete id
  const latestTo = (config.latest_models || {})[working];
  if (typeof latestTo === 'string' && latestTo && latestTo !== working) {
    console.log(`  ${String(step++).padEnd(2)} latest_models     ${cyan}${working}${reset} → ${cyan}${latestTo}${reset}`);
    working = latestTo;
  }

  let endpoint = null;
  let nameSwap = working;
  let matchedKey = null;
  let matchType = null;

  const routeResolution = resolveModelRoute(working, {
    routes,
    endpoints: endpointsMap,
    mode: modeForModel,
    latest_models: config.latest_models,
  });
  if (routeResolution) {
    endpoint = routeResolution.endpointId;
    nameSwap = routeResolution.servedBy || working;
    matchedKey = routeResolution.matchedKey;
    matchType = routeResolution.matchType;
    if (routeResolution.expandedFromLatest && routeResolution.expandedFromLatest !== working) {
      // already printed if we expanded earlier; only show if resolve did an extra hop
      console.log(`  ${String(step++).padEnd(2)} latest_models     ${cyan}${working}${reset} → ${cyan}${routeResolution.expandedFromLatest}${reset}`);
    }
  }

  if (!matchedKey) {
    console.log(`  ${String(step++).padEnd(2)} model_routes      ${gray}(no match — model passed through verbatim)${reset}`);
  } else {
    console.log(`  ${String(step++).padEnd(2)} model_routes      matched ${cyan}${matchedKey}${reset} ${gray}(${matchType})${reset}`);
    if (nameSwap !== working) {
      console.log(`     name swap         ${cyan}${working}${reset} → ${cyan}${nameSwap}${reset}`);
    }
  }

  console.log('');
  console.log(`${bold}Final routing${reset}`);
  console.log(`  endpoint          ${cyan}${endpoint || '(none — fallthrough)'}${reset}`);
  console.log(`  served_by         ${cyan}${nameSwap}${reset}`);
  if (endpoint && endpointsMap[endpoint]) {
    const ep = endpointsMap[endpoint];
    if (ep.url)    console.log(`  endpoint.url      ${cyan}${ep.url}${reset}`);
    if (ep.format) console.log(`  endpoint.format   ${cyan}${ep.format}${reset}`);
    if (ep.vertex) console.log(`  endpoint.vertex   ${cyan}true${reset}`);
  }
  console.log('');
  console.log(`${gray}Tip: logical names (coder, deepseek, fable, …) map to a final concrete model in the proxy the same way.${reset}`);
  process.exit(0);
}

if (agent && !capability) {
  const a2c = config.agent_to_capability || {};
  capability = a2c[agent];
  if (!capability) {
    console.error(`explain: agent '${agent}' has no entry in agent_to_capability`);
    process.exit(1);
  }
}

const mode = args.mode || process.env.CLAUDE_LLM_MODE || 'best-cloud';
const validModesForReq = validModes(config);
if (!validModesForReq.has(mode)) {
  console.error(`explain: unknown mode '${mode}' (valid: ${[...validModesForReq].join(', ')})`);
  process.exit(1);
}

let tier = args.tier;
if (!tier) {
  // Try detect from CLAUDE_LLM_PROFILE or RAM
  if (process.env.CLAUDE_LLM_PROFILE) tier = process.env.CLAUDE_LLM_PROFILE;
  else {
    try {
      const { tierForGb } = require('./hw-profile.js');
      const gb = process.env.CLAUDE_LLM_MEMORY_GB
        ? Number(process.env.CLAUDE_LLM_MEMORY_GB)
        : Math.ceil(os.totalmem() / (1024 ** 3));
      tier = tierForGb(gb);
    } catch { tier = '64gb'; }
  }
}

// Brand agents bypass llm_profiles via agent_to_capability model:<id> pins.
// Explain that direct path explicitly, including the same gov backstop the
// proxy applies, instead of treating "model:<id>" as a capability name.
if (agent && typeof capability === 'string' && capability.startsWith(MODEL_PIN_PREFIX)) {
  const pinnedModel = capability.slice(MODEL_PIN_PREFIX.length);
  if (!pinnedModel.trim()) {
    console.error(`explain: agent '${agent}' resolves to an empty model pin`);
    process.exit(1);
  }

  const cyan   = process.stdout.isTTY ? '\x1b[36m' : '';
  const gray   = process.stdout.isTTY ? '\x1b[90m' : '';
  const bold   = process.stdout.isTTY ? '\x1b[1m'  : '';
  const reset  = process.stdout.isTTY ? '\x1b[0m'  : '';
  const endpointsMap = config.endpoints || config.backends || {};

  console.log(`${bold}Resolution chain — agent=${agent} model=${pinnedModel} mode=${mode} tier=${tier}${reset}\n`);
  console.log(`  ${'1. Model pin'.padEnd(20)} ${cyan}${pinnedModel}${reset}  ${gray}(agent_to_capability['${agent}'])${reset}`);

  let final = pinnedModel;
  if (isGovMode(mode, config) && isChineseOrigin(pinnedModel)) {
    const filtered = applyModeFilter(
      mode,
      pinnedModel,
      [],
      config.model_routes || {},
      endpointsMap,
      config,
    );
    if (filtered === null) {
      console.log(`  ${'2. Gov filter'.padEnd(20)} ${cyan}BLOCKED: ${pinnedModel}${reset}  ${gray}(direct Chinese-origin model pin; no substitute)${reset}`);
      final = null;
    } else {
      final = filtered;
    }
  }

  const routeResolution = final ? resolveModelRoute(final, {
    routes: config.model_routes || {},
    endpoints: endpointsMap,
    mode,
    latest_models: config.latest_models,
  }) : null;
  if (routeResolution?.expandedFromLatest) {
    console.log(`  ${'2. latest_models'.padEnd(20)} ${cyan}${final}${reset} → ${cyan}${routeResolution.expandedFromLatest}${reset}`);
  }
  const servedBy = final ? (routeResolution?.servedBy || final) : null;
  const endpointId = routeResolution?.endpointId || null;
  const backend = endpointId ? endpointsMap[endpointId] : null;

  console.log('');
  console.log(`${bold}Final routing${reset}`);
  console.log(`  ${'served_by'.padEnd(20)} ${cyan}${servedBy || '(null)'}${reset}`);
  if (endpointId) console.log(`  ${'endpoint'.padEnd(20)} ${cyan}${endpointId}${reset}`);
  if (backend?.url) console.log(`  ${'endpoint.url'.padEnd(20)} ${cyan}${backend.url}${reset}`);
  if (backend?.format) console.log(`  ${'endpoint.format'.padEnd(20)} ${cyan}${backend.format}${reset}`);
  console.log('');
  console.log(`${gray}Tip: x-c-thru-served-by and x-c-thru-resolved-via confirm this route at request time.${reset}`);
  process.exit(0);
}

// New schema: llm_profiles[capability] (capability-outer, not tier-outer)
const entry = config.llm_profiles?.[capability];
if (!entry) {
  console.error(`explain: capability '${capability}' not defined in llm_profiles`);
  console.error(`         capabilities: ${Object.keys(config.llm_profiles || {}).join(', ')}`);
  process.exit(1);
}

// ── Print resolution chain ─────────────────────────────────────────────────
const cyan   = process.stdout.isTTY ? '\x1b[36m' : '';
const green  = process.stdout.isTTY ? '\x1b[32m' : '';
const gray   = process.stdout.isTTY ? '\x1b[90m' : '';
const bold   = process.stdout.isTTY ? '\x1b[1m'  : '';
const reset  = process.stdout.isTTY ? '\x1b[0m'  : '';

function header(title) {
  console.log(`${bold}${title}${reset}`);
}
function line(label, value, note = '') {
  const padded = label.padEnd(20);
  const noteStr = note ? `  ${gray}(${note})${reset}` : '';
  console.log(`  ${padded} ${cyan}${value}${reset}${noteStr}`);
}

header(`Resolution chain — capability=${capability} mode=${mode} tier=${tier}`);
console.log('');

// 1. Slot resolution (the resolver's job) — custom modes resolve un-overridden
// capabilities under their `base` built-in mode.
const slotPick = resolveProfileModel(entry, tier, mode, baseModeFor(mode, config));
const slotSource = explainSlotSource(entry, tier, mode);
line('1. Slot pick', slotPick || '(null)', slotSource);

// 2. Gov filter (gov modes — built-in or gov-based custom — block Chinese-origin models)
// Mirror the proxy: when the primary slot pick is gov-blocked, walk
// fallback_chains[tier][capability] via applyModeFilter to find a compliant
// model rather than reporting null outright.
let final = slotPick;
let govFallbackUsed = false;
if (isGovMode(mode, config) && slotPick) {
  const chainModels = (config.fallback_chains?.[tier]?.[capability] || [])
    .map(c => (typeof c === 'string' ? c : c && c.model)).filter(Boolean);
  const filtered = applyModeFilter(
    mode, slotPick, chainModels,
    config.model_routes || {}, config.endpoints || config.backends || {}, config
  );
  if (filtered === null) {
    line('2. Gov filter', `BLOCKED: ${slotPick}`, 'Chinese-origin model blocked in gov mode, no compliant fallback');
    final = null;
  } else if (filtered !== slotPick) {
    line('2. Gov filter', filtered, `primary ${slotPick} gov-blocked, served by compliant fallback`);
    final = filtered;
    govFallbackUsed = true;
  } else {
    line('2. Gov filter', slotPick, 'passes USGov filter (not Chinese-origin)');
  }
}

// 4. Backend
console.log('');
header('Final routing');
line('served_by', final || '(null)',
  final ? (govFallbackUsed ? 'concrete model the proxy will forward to (primary gov-blocked)'
                           : 'concrete model the proxy will forward to')
        : 'concrete model the proxy will forward to');
const endpointsMap = config.endpoints || config.backends || {};
const routeResolution = final ? resolveModelRoute(final, {
  routes: config.model_routes || {},
  endpoints: endpointsMap,
  mode,
}) : null;
let realBackendId = routeResolution?.endpointId;
let backend = realBackendId ? endpointsMap[realBackendId] : null;
if (realBackendId) line('backend_id', realBackendId);
if (backend) {
  line('backend.kind', backend.kind || '?');
  if (backend.url) line('backend.url', backend.url);
}
console.log('');
console.log(`${gray}Tip: x-c-thru-resolved-via header on actual responses confirms this routing at request time.${reset}`);

// ── Helpers ────────────────────────────────────────────────────────────────
// New schema: entry[mode] is a string or tier-keyed object
function explainSlotSource(entry, tier, mode) {
  const modeValue = entry[mode];
  if (modeValue) {
    if (typeof modeValue === 'string') return `entry['${mode}'] (same for all tiers: '${modeValue}')`;
    if (typeof modeValue === 'object' && modeValue[tier]) return `entry['${mode}']['${tier}']`;
    return `entry['${mode}'] (no entry for tier '${tier}', will use best-cloud fallback)`;
  }
  return `(mode '${mode}' not in entry; falling back to best-cloud)`;
}
