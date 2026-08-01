#!/usr/bin/env node
'use strict';
// Agent description-quality lint.
//
// Claude Code's Agent tool selects a subagent by matching the task against each
// agent's `description` (injected via --agents JSON in tools/c-thru). A weak
// description = an agent that never gets picked. This lint makes "attract usage"
// ENFORCEABLE rather than aspirational: every agents/*.md description must follow
// the house convention documented in docs/agent-authoring.md.
//
// For every agents/*.md the description must:
//   1. exist and be a single non-empty line;
//   2. be ≥ MIN_LEN chars (enough room for trigger + example + disambiguation);
//   3. contain a recognized TRIGGER phrase (the "when to pick me" signal)
//      — and it must START within the first TRIGGER_WINDOW chars. Official
//      guidance: "Good descriptions start with WHEN to use the subagent, not
//      what it is." A trigger buried behind a model-name or role-blurb preamble
//      wastes the highest-signal characters the selector reads first;
//   4. contain a SPECIFICITY signal — at least one of:
//        (a) a quoted example query  ("…"),
//        (b) a disambiguation clause ("Not for …", "use X instead/first",
//            "prefer …", "does not", "rather than"), or
//        (c) a "MUST BE USED for <enumerated scope>" mandate (≥3 comma-separated
//            terms) — a strong mandate with concrete scope is itself a
//            discoverability+scoping signal (the gold-standard reviewer-security
//            pattern, which carries no quoted examples by design);
//   5. every agent NAMED in a disambiguation clause ("use X instead/first",
//      "prefer X") must be a real agents/*.md or an allowlisted built-in —
//      a rename must not silently orphan the guidance (the
//      <role>-<noun>→<noun>-<role> rename already orphaned one once).
//   6. omit selector-visible routing tails. Model choice belongs in the generated
//      routing reference and model map; prose such as "Routes to Opus ..." drifts
//      independently and can bias selection toward a model name instead of a job.
//
// Fail-closed: a new agent that skips the convention fails this suite.
//
// TODO (out of scope): full semantic overlap detection between descriptions
// (two agents claiming the same task) needs an LLM judge, not a regex.
//
// Run: node test/agent-description-quality.test.js

const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.error(`  FAIL  ${message}`); failed++; }
}

const REPO = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO, 'agents');
const RESERVED_AGENT_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);
const AGENT_FILES = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith('.md') && !RESERVED_AGENT_FILES.has(f)).sort();

const MIN_LEN = 120;

// Trigger vocabulary — the "when to pick me" verb phrases (see docs/agent-authoring.md).
const TRIGGER_RE = /\b(MUST BE USED|Use PROACTIVELY|Use when|Use for|Use after|Use to|Use in)\b/i;

// The trigger must start within this many chars of the description start.
// Tolerates a short leading clause; kills model-name preambles.
const TRIGGER_WINDOW = 60;

// Specificity signals.
const QUOTED_EXAMPLE_RE = /"[^"]{3,}"/;                       // a quoted example query
const DISAMBIG_RES = [
  /\bnot for\b/i,
  /\buse\s+[a-z][\w-]*\s+(instead|first)\b/i,
  /\bprefer\b/i,
  /\bdoes not\b/i,
  /\brather than\b/i,
];
const MANDATE_RE = /MUST BE USED/i;

// Parse the single-line `description:` value from frontmatter.
function parseDescription(body) {
  const m = body.match(/^description:[ \t]*(.+?)[ \t]*$/m);
  return m ? m[1] : null;
}

function hasDisambig(desc) {
  return DISAMBIG_RES.some(re => re.test(desc));
}

// ── Disambiguation-target validation ──────────────────────────────────────────
// Extract agent names from disambiguation clauses ("use X instead/first",
// "prefer X") and require each to resolve to a real agents/*.md or an
// allowlisted built-in. Capture is constrained to avoid matching ordinary
// English ("use caution first"): the token must be hyphenated (claimed agent
// reference) or exactly match a known agent/built-in name.
const BUILTIN_AGENTS = new Set([
  'general-purpose', // Claude Code's default subagent type
]);
const AGENT_NAMES = new Set(AGENT_FILES.map(f => f.replace(/\.md$/, '')));
const DISAMBIG_MARKER_RE = /\bnot for\b|\binstead\b|\bfirst\b|\bprefer\b|\bfor those\b/i;
const TARGET_TOKEN_RE = /\b(?:[Uu]se|[Pp]refer)(?:\s+over)?\s+([a-z][a-z0-9-]*)\b/g;

function disambigTargets(desc) {
  const targets = [];
  for (const sentence of desc.split(/(?<=[.!?])\s+/)) {
    if (!DISAMBIG_MARKER_RE.test(sentence)) continue;
    for (const m of sentence.matchAll(TARGET_TOKEN_RE)) {
      const token = m[1];
      if (token.includes('-') || AGENT_NAMES.has(token) || BUILTIN_AGENTS.has(token)) {
        targets.push({ token, sentence: sentence.trim() });
      }
    }
  }
  return targets;
}
function commaCount(desc) {
  return (desc.match(/,/g) || []).length;
}
function hasSpecificity(desc) {
  if (QUOTED_EXAMPLE_RE.test(desc)) return 'quoted-example';
  if (hasDisambig(desc)) return 'disambiguation';
  if (MANDATE_RE.test(desc) && commaCount(desc) >= 3) return 'mandate+scope';
  return null;
}

console.log(`agent-description-quality: ${AGENT_FILES.length} agent descriptions\n`);

for (const file of AGENT_FILES) {
  const name = file.replace(/\.md$/, '');
  const body = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
  const desc = parseDescription(body);

  if (!desc || desc.length === 0) {
    assert(false, `${name}: has a non-empty description`);
    continue;
  }
  assert(desc.length >= MIN_LEN,
    `${name}: description ≥ ${MIN_LEN} chars (got ${desc.length})`);
  const trig = TRIGGER_RE.exec(desc);
  assert(trig !== null,
    `${name}: has a recognized trigger phrase (MUST BE USED / Use PROACTIVELY / Use when|for|after|to|in)`);
  if (trig) {
    assert(trig.index < TRIGGER_WINDOW,
      `${name}: trigger starts within first ${TRIGGER_WINDOW} chars (found "${trig[1]}" at index ${trig.index})`);
  }
  const sig = hasSpecificity(desc);
  assert(sig !== null,
    `${name}: has a specificity signal (quoted example / disambiguation / mandate+scope)${sig ? ` [${sig}]` : ''}`);
  assert(!/\broutes? to\b/i.test(desc),
    `${name}: description omits hand-maintained routing prose (model map is source of truth)`);
  for (const { token, sentence } of disambigTargets(desc)) {
    assert(AGENT_NAMES.has(token) || BUILTIN_AGENTS.has(token),
      `${name}: disambiguation target "${token}" resolves to a real agent — offending sentence: "${sentence}"`);
  }
}

// ── Model-id staleness lint (frontmatter + body) ──────────────────────────────
// The description-quality lint above keeps routing claims structured — but the
// whole file carries routing claims, and they drifted (8 bodies found stale
// 2026-06-12, e.g. writer.md claiming mistral-small3.1:24b local and
// claude-opus-4-6). Descriptions are selector-visible and carry the same
// concrete model ids (vision.md "Routes to claude-sonnet-5 connected"), so
// the scan covers the FULL file — frontmatter included — not just the body.
// Every model-id token must be in THAT AGENT'S own resolution set: cap =
// agent_to_capability[agent] || agent, resolved over 5 modes × 5 tiers with the
// same resolveProfileModel chain the proxy runs. A model_routes-key check would
// be too loose (re:^claude-.*$ masks any claude-* id, current or not).
//
// Token regex is deliberately conservative: ollama families require a `:tag`,
// claude- requires the version digit, lowercase only — validated against the
// corpus (13 hits, all genuine model ids, no prose false positives).
const { resolveProfileModel, LLM_MODE_ENUM, MODEL_PIN_PREFIX } = require('../tools/model-map-resolve.js');
const MODEL_TOKEN_RE = /(?:claude-(?:opus|sonnet|haiku)-[0-9][\w.-]*|gemini-[\w.-]+|gpt-oss-[\w:.-]+|grok-[\w.-]+|(?:qwen[\w.-]*|gemma\d+|phi4[\w.-]*|devstral[\w.-]*|mistral[\w.-]*|deepseek[\w.-]*|kimi[\w.-]*|llama[\w.-]*):[\w.-]+)/g;

console.log('\nModel-id staleness (frontmatter+body tokens must be in the agent\'s own resolution set)');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'model-map.json'), 'utf8'));
  const a2c = cfg.agent_to_capability || {};
  const profiles = cfg.llm_profiles || {};
  const TIERS = ['16gb', '32gb', '48gb', '64gb', '128gb'];
  const MODES = [...LLM_MODE_ENUM];

  // capability → set of models it resolves to in any mode × tier cell
  const capSets = {};
  for (const cap of Object.keys(profiles)) {
    const set = new Set();
    for (const mode of MODES) {
      for (const tier of TIERS) {
        const m = resolveProfileModel(profiles[cap], tier, mode);
        if (m) set.add(m.replace(/@[a-zA-Z0-9_-]+$/, '')); // strip backend sigil
      }
    }
    capSets[cap] = set;
  }

  for (const file of AGENT_FILES) {
    const name = file.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'); // full file — frontmatter too
    const cap = a2c[name] || name;
    // model: pins resolve to a single concrete model, not an llm_profiles key.
    let own;
    if (typeof cap === 'string' && cap.startsWith(MODEL_PIN_PREFIX)) {
      const pinned = cap.slice(MODEL_PIN_PREFIX.length).replace(/@[a-zA-Z0-9_-]+$/, '');
      own = new Set([pinned]);
      // Agent filename / frontmatter name is not a routing claim.
      own.add(name);
      // Claude-safe slug of the pin (gpt-oss:20b → gpt-oss-20b) used as alias agent ids.
      own.add(pinned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
      // Alias keys in model_routes that resolve to the pinned concrete model
      // (e.g. grok-build → grok-4.5) are also valid in that agent's prose.
      for (const [alias, aliasRoute] of Object.entries(cfg.model_routes || {})) {
        if (aliasRoute && typeof aliasRoute === 'object' && aliasRoute.name === pinned) {
          own.add(alias);
        }
      }
      // Preserve forward-alias support when the pin itself names an alias.
      const route = (cfg.model_routes || {})[pinned];
      if (route && typeof route === 'object' && route.name) own.add(route.name);
      // Mode-conditional routes (opus/sonnet/haiku/fable): pin is a shorthand key whose
      // values are concrete models per mode — allow every string target in the object.
      if (route && typeof route === 'object' && !route.endpoint) {
        for (const v of Object.values(route)) {
          if (typeof v === 'string' && v && !['endpoint', 'name'].includes(v)) own.add(v);
        }
      }
    } else {
      own = capSets[cap] || new Set();
    }
    const tokens = [...new Set(text.match(MODEL_TOKEN_RE) || [])];
    const stale = tokens.filter(t => !own.has(t));
    const detail = stale.map(t => {
      const currentFor = Object.keys(capSets).filter(c => capSets[c].has(t));
      return `"${t}" is ${currentFor.length ? `current for: ${currentFor.join(', ')}` : 'current for nothing'}, not ${cap}`;
    }).join('; ');
    assert(stale.length === 0,
      `${name}: model ids (frontmatter+body) all in own resolution set (cap=${cap})${stale.length ? ` — ${detail}` : ''}`);
  }

  // ── Capability-claim lint (frontmatter + body) ──────────────────────────────
  // "Routes to X capability" is the structured routing claim agent files make;
  // X must be a real llm_profiles key. pattern-coder/workhorse/orchestrator
  // were this class of staleness before the 2026-06 body rewrite fixed them by
  // hand — this keeps the structured subset from drifting again. Backticks
  // around X are optional: descriptions carry the same claim unbackticked
  // (fast-scout.md "Routes to fast-scout capability"), and descriptions are
  // the selector-visible text, so frontmatter is scanned too. By design, free
  // prose without the "capability" keyword stays out of scope — "Routes to
  // fast-generalist (terminal dispatch step)" and "code-reviewer model tier"
  // have no structure to anchor on.
  console.log('\nCapability claims, frontmatter+body (Routes to X capability → X ∈ llm_profiles)');
  const CAP_CLAIM_RE = /Routes to `?([a-z][\w-]*)`? capability/g;
  const validCaps = Object.keys(profiles);
  for (const file of AGENT_FILES) {
    const name = file.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'); // full file — frontmatter too
    const claims = [...text.matchAll(CAP_CLAIM_RE)].map(m => m[1]);
    if (claims.length === 0) continue;
    const bad = claims.filter(c => !validCaps.includes(c));
    assert(bad.length === 0,
      `${name}: capability claims (frontmatter+body) name real llm_profiles keys${bad.length ? ` — invalid: ${bad.join(', ')}; valid: ${validCaps.join(', ')}` : ` (${claims.join(', ')})`}`);
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
