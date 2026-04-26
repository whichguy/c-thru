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
  c-thru explain --capability workhorse --mode best-opensource
  c-thru explain --agent test-writer --mode local-best-quality --tier 64gb
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

const mode = args.mode || process.env.CLAUDE_LLM_MODE || 'connected';
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

const entry = config.llm_profiles?.[tier]?.[capability];
if (!entry) {
  console.error(`explain: capability '${capability}' not defined in tier '${tier}'`);
  console.error(`         tiers: ${Object.keys(config.llm_profiles || {}).join(', ')}`);
  console.error(`         capabilities at ${tier}: ${Object.keys(config.llm_profiles?.[tier] || {}).join(', ')}`);
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

// 1. Slot resolution (the resolver's job)
const slotPick = resolveProfileModel(entry, mode);
const slotSource = explainSlotSource(entry, mode);
line('1. Slot pick', slotPick || '(null)', slotSource);

// 2. Filter (Phase 2 modes)
const FILTER_MODES = new Set(['cloud-only', 'claude-only', 'opensource-only']);
let final = slotPick;
let filterNote = '';
if (FILTER_MODES.has(mode)) {
  const chain = config.fallback_chains?.[tier]?.[capability] || [];
  const filtered = applyModeFilter(mode, slotPick, chain, config.model_routes || {}, config.backends || {});
  if (filtered === null) {
    line('2. Filter result', '(null — no compliant)', `${mode} hard_fails`);
    final = null;
  } else if (filtered !== slotPick) {
    line('2. Filter swap', `${slotPick} → ${filtered}`, `${mode} skipped non-compliant primary`);
    final = filtered;
    if (chain.length > 0) {
      const skipped = chain.filter(c => {
        const m = typeof c === 'string' ? c : c.model;
        if (mode === 'cloud-only')      return m && !isCloud(m, config.model_routes || {}, config.backends || {});
        if (mode === 'claude-only')     return m && !isClaude(m);
        if (mode === 'opensource-only') return m && !isOpenSource(m);
        return false;
      }).map(c => typeof c === 'string' ? c : c.model);
      if (skipped.length > 0) line('  skipped', skipped.join(', '), 'failed filter predicate');
    }
  } else {
    line('2. Filter result', slotPick, `passes ${mode} predicate`);
  }
}

// 3. Ranking (Phase 3 modes)
const RANK_MODES = { 'fastest-possible': 'fastest', 'smallest-possible': 'smallest', 'best-opensource': 'best-opensource' };
const criterion = RANK_MODES[mode];
if (criterion) {
  if (!benchmark) {
    line('2. Ranking', '(skipped — no benchmark.json)', `using slot default ${slotPick}`);
  } else {
    const role = benchmark.capability_to_role?.[capability];
    if (!role) {
      line('2. Ranking', '(skipped — no role mapping)', `${capability} not in capability_to_role`);
    } else {
      const candidates = Object.keys(config.model_routes || {}).filter(k => !k.startsWith('re:'));
      const minQ = benchmark.role_minimums?.[role];
      const eligible = [];
      for (const m of candidates) {
        if (criterion === 'best-opensource' && !isOpenSource(m, config.model_routes || {}, config.backends || {})) continue;
        const meta = benchmark.models?.[m];
        if (!meta) continue;
        const q = meta.quality_per_role?.[role];
        if (q == null) continue;
        if (typeof minQ === 'number' && q < minQ) continue;
        eligible.push({ model: m, quality: q, tps: meta.tokens_per_sec, ram: meta.ram_gb });
      }
      line('2. Ranking', `${criterion} for role=${role} (min q=${minQ})`);
      const ranked = pickBenchmarkBest(criterion, candidates, benchmark, role, config.model_routes || {}, config.backends || {});
      if (eligible.length > 0) {
        console.log(`  ${gray}eligible (${eligible.length}):${reset}`);
        eligible.slice(0, 8).forEach(c => {
          const marker = c.model === ranked ? `${green}→${reset}` : ' ';
          console.log(`  ${marker} ${c.model.padEnd(36)} q=${c.quality}  ${(c.tps || '?').toString().padStart(4)} t/s  ${(c.ram || '?').toString().padStart(3)}GB`);
        });
        if (eligible.length > 8) console.log(`    ${gray}... and ${eligible.length - 8} more${reset}`);
      } else {
        console.log(`  ${gray}(no eligible candidates — falling back to slot default)${reset}`);
      }
      if (ranked && ranked !== slotPick) {
        final = ranked;
      } else if (ranked) {
        final = ranked;
      }
    }
  }
}

// 4. Backend
console.log('');
header('Final routing');
line('served_by', final || '(null)', 'concrete model the proxy will forward to');
const backendId = config.model_routes?.[final];
const backend = backendId && config.backends?.[backendId];
if (backendId) line('backend_id', backendId);
if (backend) {
  line('backend.kind', backend.kind || '?');
  if (backend.url) line('backend.url', backend.url);
}
console.log('');
console.log(`${gray}Tip: x-c-thru-resolved-via header on actual responses confirms this routing at request time.${reset}`);

// ── Helpers ────────────────────────────────────────────────────────────────
function explainSlotSource(entry, mode) {
  if (entry.modes && Object.prototype.hasOwnProperty.call(entry.modes, mode)) {
    return `entry.modes['${mode}']`;
  }
  if (mode === 'connected')                                return 'entry.connected_model';
  if (mode === 'offline' || mode === 'local-only')         return 'entry.disconnect_model';
  if (mode === 'semi-offload' || mode === 'cloud-judge-only') return 'entry.disconnect_model (no override)';
  if (mode === 'cloud-thinking')                           return 'entry.disconnect_model (default; no cloud-thinking override)';
  if (mode === 'local-review')                             return 'entry.connected_model (default; no local-review override)';
  if (mode === 'cloud-best-quality')                       return 'entry.cloud_best_model ?? entry.connected_model';
  if (mode === 'local-best-quality')                       return 'entry.local_best_model ?? entry.disconnect_model';
  if (mode === 'cloud-only')                               return 'entry.cloud_best_model ?? entry.connected_model';
  if (mode === 'claude-only')                              return 'entry.connected_model';
  if (mode === 'opensource-only')                          return 'entry.disconnect_model';
  if (mode === 'fastest-possible')                         return 'entry.connected_model (pre-rank)';
  if (mode === 'smallest-possible')                        return 'entry.disconnect_model (pre-rank)';
  if (mode === 'best-opensource')                          return 'entry.disconnect_model (pre-rank)';
  return '(default fallback)';
}
