#!/usr/bin/env node
'use strict';
// Resolution matrix test: for (capability × mode × tier) triples, verify
// resolveProfileModel() returns the expected concrete model from the shipped
// config/model-map.json. Exercises the new schema (capability-outer
// llm_profiles[cap][mode] = string | {tier: model}).
//
// Run with: node test/llm-mode-resolution-matrix.test.js

const fs   = require('fs');
const path = require('path');
const {
  resolveProfileModel,
  isChineseOrigin,
  LLM_MODE_ENUM,
} = require('../tools/model-map-resolve.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else           { console.error(`  FAIL  ${message}`); failed++; }
}

const shippedPath = path.join(__dirname, '..', 'config', 'model-map.json');
const shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
const profiles = shipped.llm_profiles || {};
const MODES = Array.from(LLM_MODE_ENUM);
const TIERS = ['16gb', '32gb', '48gb', '64gb', '128gb'];

console.log('llm-mode resolution matrix tests\n');

// ── 1. best-cloud: planner resolves to claude-* at 64gb and 128gb ─────────────
console.log('1. best-cloud: planner resolves to claude-* at 64gb+ tiers');
{
  for (const tier of ['64gb', '128gb']) {
    const entry = profiles.planner;
    const model = resolveProfileModel(entry, tier, 'best-cloud');
    assert(typeof model === 'string' && /^claude-/.test(model),
      `planner best-cloud ${tier} → claude-* (got ${model})`);
  }
}

// ── 2. best-local-oss: capabilities resolve to local (non-cloud) models ────────
console.log('\n2. best-local-oss: all capabilities resolve to non-cloud models');
{
  const cloudSuffixes = /^claude-|:cloud$/;
  for (const [cap, entry] of Object.entries(profiles)) {
    const model = resolveProfileModel(entry, '64gb', 'best-local-oss');
    if (!model) continue;
    assert(!cloudSuffixes.test(model),
      `${cap} best-local-oss/64gb is not a cloud model (got ${model})`);
  }
}

// ── 3. gov modes: no Chinese-origin models ────────────────────────────────────
console.log('\n3. gov modes: resolved models are not Chinese-origin');
{
  for (const mode of ['best-cloud-gov', 'best-local-gov']) {
    for (const [cap, entry] of Object.entries(profiles)) {
      const model = resolveProfileModel(entry, '64gb', mode);
      if (!model) continue;
      assert(!isChineseOrigin(model),
        `${cap} ${mode}/64gb is not Chinese-origin (got ${model})`);
    }
  }
}

// ── 4. All capabilities return string or null for all modes × tiers ───────────
console.log('\n4. Cartesian product: all capability × mode × tier → string or null');
{
  let combos = 0;
  for (const [cap, entry] of Object.entries(profiles)) {
    for (const mode of MODES) {
      for (const tier of TIERS) {
        const result = resolveProfileModel(entry, tier, mode);
        assert(result === null || (typeof result === 'string' && result.length > 0),
          `${cap} @ ${tier} mode=${mode} → string or null (got ${JSON.stringify(result)})`);
        combos++;
      }
    }
  }
  console.log(`  (${combos} combos checked)`);
}

// ── 5. Null guard: resolveProfileModel(null/undefined, ...) returns null ───────
console.log('\n5. Null guard: null/undefined entry returns null for all modes');
{
  for (const mode of MODES) {
    assert(resolveProfileModel(null,      '64gb', mode) === null, `null entry mode=${mode} → null`);
    assert(resolveProfileModel(undefined, '64gb', mode) === null, `undefined entry mode=${mode} → null`);
  }
}

// ── 6. Unknown mode falls back to best-cloud ──────────────────────────────────
console.log('\n6. Unknown mode falls back to best-cloud value');
{
  // Use a synthetic entry with only best-cloud defined
  const entry = { 'best-cloud': { '64gb': 'fallback-model' } };
  const result = resolveProfileModel(entry, '64gb', 'nonexistent-mode');
  assert(result === 'fallback-model',
    `unknown mode falls back to best-cloud (got ${result})`);
}

// ── 7. Flat string form: tier-agnostic model ───────────────────────────────────
console.log('\n7. Flat string per mode: same model regardless of tier');
{
  // planner-hard best-cloud resolves the same at 16gb and 128gb
  const entry = profiles['planner-hard'];
  const cloudMode = 'best-cloud';
  const m16 = resolveProfileModel(entry, '16gb', cloudMode);
  const m128 = resolveProfileModel(entry, '128gb', cloudMode);
  if (m16 !== null && m128 !== null) {
    // planner-hard best-cloud is a string (not tier-keyed in shipped config)
    // so 16gb and 128gb should give the same model
    const bcEntry = entry[cloudMode];
    if (typeof bcEntry === 'string') {
      assert(m16 === m128, `planner-hard best-cloud: same model at 16gb and 128gb (${m16})`);
    } else {
      // tier-keyed — just verify both are non-null strings
      assert(typeof m16 === 'string', `planner-hard best-cloud 16gb is a string (got ${m16})`);
      assert(typeof m128 === 'string', `planner-hard best-cloud 128gb is a string (got ${m128})`);
    }
  } else {
    assert(false, `planner-hard best-cloud at 16gb/128gb should both resolve (got ${m16}, ${m128})`);
  }
}

// ── 8. Tier monotonicity: larger tiers don't resolve to smaller models ─────────
// (Qualitative check: we don't mandate a specific model, but the resolver should
// not crash and should return a model at 128gb when one is defined at 64gb.)
console.log('\n8. Tier monotonicity: 128gb resolves when 64gb resolves (best-cloud)');
{
  for (const [cap, entry] of Object.entries(profiles)) {
    const m64  = resolveProfileModel(entry, '64gb',  'best-cloud');
    const m128 = resolveProfileModel(entry, '128gb', 'best-cloud');
    if (m64 !== null) {
      assert(m128 !== null,
        `${cap}: 128gb resolves when 64gb resolves (64gb=${m64}, 128gb=${m128})`);
    }
  }
}

// ── 9. Local-oss models at low tiers ──────────────────────────────────────────
console.log('\n9. best-local-oss at 16gb resolves to a non-null model for key capabilities');
{
  for (const cap of ['planner', 'coder', 'generalist', 'fast-scout']) {
    const entry = profiles[cap];
    if (!entry) continue;
    const model = resolveProfileModel(entry, '16gb', 'best-local-oss');
    assert(typeof model === 'string' && model.length > 0,
      `${cap} best-local-oss/16gb resolves to non-null (got ${model})`);
  }
}

// ── 10. Gov mode: claude-* models pass gov filter ─────────────────────────────
console.log('\n10. Gov modes: claude-* and phi models pass gov filter (not Chinese-origin)');
{
  // planner/best-cloud-gov at 64gb should be a claude or gov-safe model
  const plannerGov = resolveProfileModel(profiles.planner, '64gb', 'best-cloud-gov');
  assert(plannerGov !== null, `planner best-cloud-gov/64gb resolves to non-null`);
  assert(!isChineseOrigin(plannerGov ?? ''), `planner best-cloud-gov/64gb is not Chinese-origin (got ${plannerGov})`);

  // explore/best-local-gov should be phi or similar
  const exploreGov = resolveProfileModel(profiles.explore, '64gb', 'best-local-gov');
  assert(exploreGov !== null, `explore best-local-gov/64gb resolves to non-null`);
  assert(!isChineseOrigin(exploreGov ?? ''), `explore best-local-gov/64gb is not Chinese-origin (got ${exploreGov})`);
}

// ── 11. best-cloud at 16gb: high-stakes caps use their configured model ────────
console.log('\n11. best-cloud at 16gb: planner-hard uses its configured model');
{
  const m = resolveProfileModel(profiles['planner-hard'], '16gb', 'best-cloud');
  assert(typeof m === 'string' && m.length > 0,
    `planner-hard best-cloud/16gb resolves to string (got ${m})`);
}

// ── 12. best-cloud-oss: non-Chinese-origin cloud models at 64gb ───────────────
console.log('\n12. best-cloud-oss at 64gb: resolves to OSS cloud model');
{
  for (const cap of ['planner', 'coder', 'generalist']) {
    const entry = profiles[cap];
    if (!entry) continue;
    const model = resolveProfileModel(entry, '64gb', 'best-cloud-oss');
    assert(typeof model === 'string' && model.length > 0,
      `${cap} best-cloud-oss/64gb resolves to string (got ${model})`);
    // best-cloud-oss is allowed to have Chinese-origin models (not gov mode)
  }
}

// ── 13. Per-capability: key capabilities present in shipped config ─────────────
console.log('\n13. Key capabilities present in shipped llm_profiles');
{
  const required = ['planner', 'planner-hard', 'coder', 'tester', 'code-reviewer',
    'reviewer-security', 'generalist', 'fast-scout', 'edge', 'explore'];
  for (const cap of required) {
    assert(cap in profiles, `capability '${cap}' present in llm_profiles`);
  }
}

// ── 14. Fast-scout and edge: always local (not cloud) in best-local-oss ────────
console.log('\n14. fast-scout and edge: local models in best-local-oss');
{
  for (const cap of ['fast-scout', 'edge']) {
    const model = resolveProfileModel(profiles[cap], '64gb', 'best-local-oss');
    assert(typeof model === 'string' && model.length > 0,
      `${cap} best-local-oss/64gb resolves (got ${model})`);
    assert(!/^claude-|:cloud$/.test(model ?? ''),
      `${cap} best-local-oss/64gb is not a cloud model (got ${model})`);
  }
}

// ── 15. isChineseOrigin: known models classified correctly ───────────────────
console.log('\n15. isChineseOrigin: known Chinese-origin and non-Chinese models classified correctly');
{
  const chinese = ['qwen3:7b', 'deepseek-v4-flash:cloud', 'kimi-k2:cloud', 'glm-4:cloud', 'qwen3.6:35b-a3b-nvfp4'];
  const notChinese = ['claude-sonnet-4-6', 'claude-opus-4-7', 'phi4-mini:3.8b', 'gemma4:e4b', 'gpt-oss-120b:TODO'];
  for (const m of chinese) {
    assert(isChineseOrigin(m), `isChineseOrigin('${m}') === true`);
  }
  for (const m of notChinese) {
    assert(!isChineseOrigin(m), `isChineseOrigin('${m}') === false`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
