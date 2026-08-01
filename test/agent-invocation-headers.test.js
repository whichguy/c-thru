#!/usr/bin/env node
'use strict';
// B1 — per-agent proxy-resolution suite (deterministic, primary gate).
//
// For EVERY agents/*.md agent, POST { model: "<agent>" } through a live proxy
// backed by a hermetic stub and assert the proxy actually invoked the right
// capability/model — i.e. "the prompt picked agent X" is observable on the wire:
//
//   x-c-thru-resolved-via.capability === <agent>'s resolved capability
//   x-c-thru-served-by              === the model c-thru-explain predicts
//   journal JSONL line              records capability + served_by
//
// Anti-drift: the EXPECTED served_by is derived by running c-thru-explain
// against the SAME fixture model-map the proxy is given — never hardcoded — so
// the test and the tracer resolve through identical config and cannot diverge.
//
// The fixture points every capability at a unique `served-<cap>` model routed to
// the local stub, so the suite is fully hermetic (no real backend, no network).
// The real production agent_to_capability is copied verbatim so the two non-1:1
// remaps (reviewer-plan→code-reviewer, plan-scheduler→fast-generalist) are
// exercised exactly as they route in production.
//
// Run: node test/agent-invocation-headers.test.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { assert, assertEq, summary, withProxy, httpJson, stubBackend } = require('./helpers');

const REPO       = path.resolve(__dirname, '..');
const PROD       = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'model-map.json'), 'utf8'));
const EXPLAIN    = path.join(REPO, 'tools', 'c-thru-explain.js');
const MODE       = 'best-cloud';
const TIER       = '64gb';

// Agents are the source of truth (one POST per agents/*.md).
const RESERVED_AGENT_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);
const AGENTS = fs.readdirSync(path.join(REPO, 'agents'))
  .filter(f => f.endsWith('.md') && !RESERVED_AGENT_FILES.has(f))
  .map(f => f.replace(/\.md$/, ''))
  .sort();

// Build a hermetic fixture model-map: real agent→capability mapping, but every
// capability resolves to a unique `served-<cap>` model routed to the stub.
function buildFixture(stubPort) {
  const a2c = {};
  for (const agent of AGENTS) {
    const cap = PROD.agent_to_capability[agent];
    if (!cap) throw new Error(`fixture: agent '${agent}' missing from production agent_to_capability`);
    a2c[agent] = cap;
  }
  const caps = [...new Set(Object.values(a2c))];
  const llm_profiles = {};
  const model_routes = {};
  for (const cap of caps) {
    // Brand leaves use agent_to_capability → "model:<concrete>". resolveBackend
    // pin-branches to the concrete name (capability recorded as the request
    // model / agent name). Route the concrete pin to the hermetic stub.
    if (typeof cap === 'string' && cap.startsWith('model:')) {
      const pin = cap.slice('model:'.length);
      model_routes[pin] = 'stub';
      continue;
    }
    const model = `served-${cap}`;
    // Same model across all tiers/modes — the agent→capability seam is what's
    // under test here, not tier/mode resolution (covered by other suites).
    llm_profiles[cap] = { 'best-cloud': { '64gb': model, '16gb': model, '32gb': model, '48gb': model, '128gb': model } };
    model_routes[model] = 'stub';
  }
  return {
    agent_to_capability: a2c,
    llm_profiles,
    model_routes,
    endpoints: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` } },
  };
}

// Derive expected served_by per capability by running the tracer over the
// fixture — returns { [capability]: model }.
function explainByCapability(fixturePath) {
  const out = execFileSync(process.execPath,
    [EXPLAIN, '--all', '--mode', MODE, '--tier', TIER, '--format', 'json'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_MODEL_MAP_PATH: fixturePath }) });
  const arr = JSON.parse(out);
  const byCap = {};
  for (const r of arr) byCap[r.capability] = r.model;
  return byCap;
}

function readJournal(dir, capability) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const day of fs.readdirSync(dir)) {
    const file = path.join(dir, day, `${capability}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { entries.push(JSON.parse(line)); } catch {}
    }
  }
  return entries;
}

async function main() {
  console.log(`agent-invocation-headers: ${AGENTS.length} agents @ ${MODE}/${TIER}\n`);

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-agent-inv-'));
  const journalDir = path.join(tmpDir, 'journal');
  const stub = await stubBackend();

  try {
    const fixture = buildFixture(stub.port);
    const fixturePath = path.join(tmpDir, 'model-map.json');
    fs.writeFileSync(fixturePath, JSON.stringify(fixture));

    // EXPECTED served_by, derived from the tracer over the same fixture.
    const expectByCap = explainByCapability(fixturePath);
    assert(Object.keys(expectByCap).length > 0, 'c-thru-explain produced a capability→model map for the fixture');

    await withProxy({
      configPath: fixturePath, profile: TIER, mode: MODE,
      env: { CLAUDE_PROXY_JOURNAL: '1', CLAUDE_PROXY_JOURNAL_DIR: journalDir },
    }, async ({ port }) => {
      for (const agent of AGENTS) {
        const a2cTarget = PROD.agent_to_capability[agent];
        // model: pins record capability as the request model (agent name) and
        // serve the concrete pin; identity-mapped agents keep a2c → llm_profiles.
        const isModelPin = typeof a2cTarget === 'string' && a2cTarget.startsWith('model:');
        const expectedCap = isModelPin ? agent : a2cTarget;
        const expectedModel = isModelPin
          ? a2cTarget.slice('model:'.length)
          : expectByCap[expectedCap];

        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: agent,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        });
        assertEq(r.status, 200, `${agent}: request succeeded`);

        // The resolved-via header is ABSENT on bare-model requests — assert it
        // is present before parsing, so an agent unexpectedly resolving as a
        // direct model (no capability) fails with a clear message rather than a
        // JSON.parse crash.
        const rawVia = r.headers['x-c-thru-resolved-via'];
        if (rawVia === undefined) {
          assert(false, `${agent}: x-c-thru-resolved-via present (agent did NOT resolve as a capability)`);
          continue;
        }
        let via = null;
        try { via = JSON.parse(rawVia); } catch {}
        assert(via && typeof via === 'object', `${agent}: x-c-thru-resolved-via is valid JSON`);
        assertEq(via && via.capability, expectedCap,
          `${agent}: resolved-via.capability === '${expectedCap}'`);

        assertEq(r.headers['x-c-thru-served-by'], expectedModel,
          `${agent}: x-c-thru-served-by === '${expectedModel}'`);
      }
    });

    // Journal: every agent request records under its resolved capability key
    // (agent name for model: pins; a2c capability for identity-mapped agents).
    console.log('\nJournal records (capability + served_by per request):');
    for (const agent of AGENTS) {
      const a2cTarget = PROD.agent_to_capability[agent];
      const isModelPin = typeof a2cTarget === 'string' && a2cTarget.startsWith('model:');
      const journalCap = isModelPin ? agent : a2cTarget;
      const expectedModel = isModelPin
        ? a2cTarget.slice('model:'.length)
        : expectByCap[a2cTarget];
      const entries = readJournal(journalDir, journalCap);
      assert(entries.length >= 1, `journal: '${journalCap}.jsonl' has ≥1 entry (got ${entries.length})`);
      if (entries.length) {
        const e = entries[entries.length - 1];
        assertEq(e.capability, journalCap, `journal[${journalCap}].capability === '${journalCap}'`);
        assertEq(e.served_by, expectedModel, `journal[${journalCap}].served_by === '${expectedModel}'`);
      }
    }
  } finally {
    await stub.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
