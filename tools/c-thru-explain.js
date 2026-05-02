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
  applyModeFilter,
  pickBenchmarkBest,
  isClaude, isCloud, isOpenSource,
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
  console.log(`Usage: c-thru explain [--capability <cap>] [--agent <name>] [--mode <m>] [--tier <t>]

Prints the model resolution chain for a hypothetical request, without sending one.

  --capability <cap>   capability alias (e.g. workhorse, judge, deep-coder)
  --agent <name>       agent name (resolved through agent_to_capability)
  --mode <m>           connectivity / routing mode (default: \$CLAUDE_LLM_MODE or 'connected')
  --tier <t>           hardware tier (default: detected from RAM)

Examples:
  c-thru explain --capability coder --mode best-cloud-oss
  c-thru explain --agent tester --mode best-local-oss --tier 64gb
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

if (!capability && !agent) {
  console.error('explain: --capability or --agent required (try --help)');
  process.exit(1);
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
if (!LLM_MODE_ENUM.has(mode)) {
  console.error(`explain: unknown mode '${mode}' (valid: ${[...LLM_MODE_ENUM].join(', ')})`);
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

// 1. Slot resolution (the resolver's job) — new 3-argument form (entry, tier, mode)
const slotPick = resolveProfileModel(entry, tier, mode);
const slotSource = explainSlotSource(entry, tier, mode);
line('1. Slot pick', slotPick || '(null)', slotSource);

// 2. Gov filter (best-cloud-gov and best-local-gov block Chinese-origin models)
const GOV_MODES = new Set(['best-cloud-gov', 'best-local-gov']);
let final = slotPick;
if (GOV_MODES.has(mode) && slotPick) {
  const { isChineseOrigin } = require('./model-map-resolve.js');
  if (isChineseOrigin(slotPick)) {
    line('2. Gov filter', `BLOCKED: ${slotPick}`, 'Chinese-origin model blocked in gov mode');
    final = null;
  } else {
    line('2. Gov filter', slotPick, 'passes USGov filter (not Chinese-origin)');
  }
}

// 4. Backend
console.log('');
header('Final routing');
line('served_by', final || '(null)', 'concrete model the proxy will forward to');
const routeEntry = config.model_routes?.[final];
const endpointsMap = config.endpoints || config.backends || {};
let realBackendId, backend;
if (routeEntry && typeof routeEntry === 'object') {
  realBackendId = routeEntry.endpoint;
  backend = endpointsMap[realBackendId];
} else if (typeof routeEntry === 'string') {
  realBackendId = routeEntry;
  backend = endpointsMap[realBackendId];
}
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
