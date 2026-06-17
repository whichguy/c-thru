#!/usr/bin/env node
'use strict';
// Unit tests for the Phase 2a provider-filter predicates exported from
// tools/model-map-resolve.js. Pure functions — no proxy spawn — runs in ms.
//
// Run: node test/model-map-filter.test.js

const {
  isClaude, isCloud, isOpenSource, filterFor, applyModeFilter, isGovMode,
} = require('../tools/model-map-resolve');

const { assert, assertEq, summary } = require('./helpers');

console.log('model-map filter predicates — unit tests\n');

// Common fixture: realistic shapes from the shipped config
const BACKENDS = {
  anthropic:    { id: 'anthropic',    kind: 'anthropic', url: 'https://api.anthropic.com' },
  openrouter:   { id: 'openrouter',   kind: 'anthropic', url: 'https://openrouter.ai/api' },
  ollama_local: { id: 'ollama_local', kind: 'ollama',    url: 'http://localhost:11434' },
  ollama_cloud: { id: 'ollama_cloud', kind: 'ollama',    url: 'https://ollama.com' },
  custom_be:    { id: 'custom_be',    kind: 'anthropic', url: 'http://127.0.0.1:9999' },
};

const MODEL_ROUTES = {
  'claude-opus-4-6':       'anthropic',
  'claude-sonnet-4-6':     'anthropic',
  're:^claude-.*$':        'anthropic',
  'deepseek/deepseek-v3':  'openrouter',
  'qwen3:1.7b':            'ollama_local',
  'qwen3.6:35b':           'ollama_local',
  'qwen3.6:35b-a3b':       'ollama_local',
  'glm-5.1:cloud':         'ollama_cloud',
  'qwen3-coder-next:cloud': 'ollama_cloud',
  'special-model':         'custom_be',
};

// ── isClaude ────────────────────────────────────────────────────────────────
console.log('1. isClaude');
assertEq(isClaude('claude-opus-4-6'),     true,  'claude-opus-4-6');
assertEq(isClaude('claude-sonnet-4-6'),   true,  'claude-sonnet-4-6');
assertEq(isClaude('claude-haiku-4-5-20251001'), true, 'claude-haiku with date suffix');
assertEq(isClaude('qwen3:1.7b'),          false, 'qwen3:1.7b is not claude');
assertEq(isClaude('Claude-opus'),         false, 'case-sensitive: Claude- (uppercase) does not match');
assertEq(isClaude(''),                    false, 'empty string');
assertEq(isClaude(null),                  false, 'null');
assertEq(isClaude(undefined),             false, 'undefined');
assertEq(isClaude(42),                    false, 'non-string');

// ── isCloud ─────────────────────────────────────────────────────────────────
console.log('\n2. isCloud');
// Anthropic backend → always cloud
assertEq(isCloud('claude-opus-4-6', MODEL_ROUTES, BACKENDS),     true,  'anthropic backend = cloud');
assertEq(isCloud('deepseek/deepseek-v3', MODEL_ROUTES, BACKENDS), true,  'openrouter backend = cloud (kind:anthropic)');
// Pattern route hit
assertEq(isCloud('claude-haiku-4-5-foo', MODEL_ROUTES, BACKENDS), true,  'pattern route re:^claude-.*$ matches');
// ollama_local route → not cloud
assertEq(isCloud('qwen3:1.7b', MODEL_ROUTES, BACKENDS),          false, 'ollama_local route');
assertEq(isCloud('qwen3.6:35b', MODEL_ROUTES, BACKENDS),         false, 'ollama_local: qwen3.6:35b');
// ollama_cloud route → cloud (the glm-5.1:cloud edge case)
assertEq(isCloud('glm-5.1:cloud', MODEL_ROUTES, BACKENDS),       true,  'ollama_cloud route: glm-5.1:cloud');
assertEq(isCloud('qwen3-coder-next:cloud', MODEL_ROUTES, BACKENDS), true, 'ollama_cloud route: coder-next');
// kind:anthropic is the authoritative cloud signal — overrides localhost URL.
// Rationale: an anthropic-kind backend means "uses Anthropic SDK protocol", which
// in production is always a cloud API (Anthropic, OpenRouter, etc.). A localhost
// stub with kind:anthropic exists only in test fixtures.
assertEq(isCloud('special-model', MODEL_ROUTES, BACKENDS),       true,  'kind:anthropic = cloud (definitive)');
// Unknown model — no route, no pattern match
assertEq(isCloud('totally-unknown-model', MODEL_ROUTES, BACKENDS), false, 'no route → not cloud');
// @sigil parsing
assertEq(isCloud('claude-opus-4-6@anthropic', MODEL_ROUTES, BACKENDS), true,  '@anthropic sigil');
assertEq(isCloud('qwen3:1.7b@ollama_local', MODEL_ROUTES, BACKENDS),   false, '@ollama_local sigil');
// Defensive: bad inputs
assertEq(isCloud(null, MODEL_ROUTES, BACKENDS),                  false, 'null model');
assertEq(isCloud('claude-opus-4-6', null, null),                 false, 'no routes/backends → false');

// ── isOpenSource ────────────────────────────────────────────────────────────
console.log('\n3. isOpenSource');
assertEq(isOpenSource('qwen3:1.7b'),               true,  'qwen3:1.7b is OS');
assertEq(isOpenSource('glm-5.1:cloud'),            true,  'glm-5.1:cloud is OS (despite cloud)');
assertEq(isOpenSource('qwen3-coder-next:cloud'),   true,  'cloud-relayed OS still OS');
assertEq(isOpenSource('claude-opus-4-6'),          false, 'Claude is not OS');
assertEq(isOpenSource('claude-haiku-4-5-20251001'), false, 'Claude haiku not OS');
assertEq(isOpenSource('deepseek/deepseek-v3'),     true,  'deepseek/deepseek-v3 (openrouter) IS OS — not Claude');
assertEq(isOpenSource(null),                       false, 'null');

// ── filterFor ───────────────────────────────────────────────────────────────
// filterFor only returns a predicate for gov modes (Chinese-origin filter).
// All other modes return null (no filter applied).
console.log('\n4. filterFor');
assert(typeof filterFor('best-cloud-gov') === 'function', 'best-cloud-gov → predicate fn');
assert(typeof filterFor('best-local-gov') === 'function', 'best-local-gov → predicate fn');
assertEq(filterFor('best-cloud'),     null, 'best-cloud → null (no filter)');
assertEq(filterFor('best-cloud-oss'), null, 'best-cloud-oss → null (no filter)');
assertEq(filterFor('best-local-oss'), null, 'best-local-oss → null (no filter)');
assertEq(filterFor('totally-bogus'),  null, 'unknown mode → null');
// Legacy mode strings also return null
assertEq(filterFor('connected'),  null, 'legacy connected → null');
assertEq(filterFor('offline'),    null, 'legacy offline → null');
assertEq(filterFor('cloud-only'), null, 'removed cloud-only mode → null');

// Gov predicate: blocks Chinese-origin models (qwen, deepseek, glm, etc.)
const govPred = filterFor('best-cloud-gov');
assert(govPred('claude-opus-4-6'),     'gov predicate: claude passes (not Chinese-origin)');
assert(govPred('phi4-mini'),           'gov predicate: phi4-mini passes');
assert(!govPred('qwen3:1.7b'),         'gov predicate: qwen3 blocked (Chinese-origin)');
assert(!govPred('deepseek/deepseek-v3'), 'gov predicate: deepseek blocked');
assert(!govPred('glm-5.1:cloud'),      'gov predicate: glm blocked');
assert(!govPred('moonshotai/kimi-k2'), 'gov predicate: moonshotai blocked');

// ── applyModeFilter ─────────────────────────────────────────────────────────
// For non-gov modes: returns primary unchanged (no filter).
// For gov modes: walks primary + chain, returns first non-Chinese-origin model.
console.log('\n5. applyModeFilter');

// Non-gov modes → primary returned unchanged, chain ignored
assertEq(
  applyModeFilter('best-cloud', 'qwen3:1.7b', [], MODEL_ROUTES, BACKENDS),
  'qwen3:1.7b',
  'best-cloud: primary returned unchanged (no filter)'
);
assertEq(
  applyModeFilter('best-local-oss', 'deepseek/deepseek-v3', [{ model: 'claude-opus-4-6' }], MODEL_ROUTES, BACKENDS),
  'deepseek/deepseek-v3',
  'best-local-oss: primary returned unchanged even if Chinese-origin (no filter in non-gov)'
);
assertEq(
  applyModeFilter('best-cloud-oss', 'claude-opus-4-6', [], MODEL_ROUTES, BACKENDS),
  'claude-opus-4-6',
  'best-cloud-oss: primary returned unchanged'
);

// best-cloud-gov: non-Chinese primary passes
assertEq(
  applyModeFilter('best-cloud-gov', 'claude-opus-4-6', [], MODEL_ROUTES, BACKENDS),
  'claude-opus-4-6',
  'best-cloud-gov: non-Chinese primary passes filter'
);

// best-cloud-gov: Chinese primary + non-Chinese in chain → chain hit
assertEq(
  applyModeFilter(
    'best-cloud-gov', 'qwen3:1.7b',
    [{ model: 'claude-opus-4-6' }],
    MODEL_ROUTES, BACKENDS
  ),
  'claude-opus-4-6',
  'best-cloud-gov: Chinese primary rejected, non-Chinese chain candidate selected'
);

// best-cloud-gov: Chinese primary + all-Chinese chain → null
assertEq(
  applyModeFilter(
    'best-cloud-gov', 'qwen3:1.7b',
    [{ model: 'deepseek/deepseek-v3' }, { model: 'glm-5.1:cloud' }],
    MODEL_ROUTES, BACKENDS
  ),
  null,
  'best-cloud-gov: all-Chinese chain → null'
);

// best-local-gov: same filter applies
assertEq(
  applyModeFilter(
    'best-local-gov', 'qwen3:1.7b',
    [{ model: 'phi4-mini' }],
    MODEL_ROUTES, BACKENDS
  ),
  'phi4-mini',
  'best-local-gov: Chinese primary rejected, non-Chinese phi picked'
);

// best-cloud-gov: empty chain, Chinese primary → null
assertEq(
  applyModeFilter('best-cloud-gov', 'qwen3:1.7b', [], MODEL_ROUTES, BACKENDS),
  null,
  'empty chain + Chinese primary → null'
);

// Chain with plain string entries (not {model: ...})
assertEq(
  applyModeFilter(
    'best-cloud-gov', 'qwen3:1.7b',
    ['claude-opus-4-6', 'qwen3.6:35b'],
    MODEL_ROUTES, BACKENDS
  ),
  'claude-opus-4-6',
  'gov filter: chain accepts plain strings'
);

// Null chain → only primary checked
assertEq(
  applyModeFilter('best-cloud-gov', 'claude-opus-4-6', null, MODEL_ROUTES, BACKENDS),
  'claude-opus-4-6',
  'null chain handled (non-Chinese primary passes)'
);
assertEq(
  applyModeFilter('best-cloud-gov', 'qwen3:1.7b', null, MODEL_ROUTES, BACKENDS),
  null,
  'null chain handled (Chinese primary → null)'
);

// ── Gov-based custom modes must engage the runtime Chinese-origin filter ──────
// Regression: the gov filter keyed on the literal mode name, so a custom mode
// whose `base` is a gov mode (e.g. "gov-hybrid") bypassed the runtime filter even
// though validation blocked Chinese overrides. isGovMode resolves through `base`.
console.log('\nGov-based custom modes — runtime filter engages via base');
{
  const cfg = { custom_modes: { 'gov-hybrid': { base: 'best-cloud-gov' } } };
  const ossCfg = { custom_modes: { 'deepseek-hybrid': { base: 'best-cloud-oss' } } };

  assertEq(isGovMode('best-cloud-gov'), true, 'built-in gov mode → gov');
  assertEq(isGovMode('best-local-gov'), true, 'built-in local gov mode → gov');
  assertEq(isGovMode('gov-hybrid', cfg), true, 'custom mode with gov base → gov');
  assertEq(isGovMode('deepseek-hybrid', ossCfg), false, 'custom mode with non-gov base → not gov');
  assertEq(isGovMode('best-cloud'), false, 'non-gov built-in → not gov');
  assertEq(isGovMode('gov-hybrid'), false, 'gov-named custom mode without config → not detected (name alone is not gov)');

  // filterFor: a gov-based custom mode yields a predicate ONLY when config is passed
  assertEq(typeof filterFor('gov-hybrid', cfg), 'function', 'filterFor(gov-hybrid, cfg) → predicate');
  assertEq(filterFor('gov-hybrid'), null, 'filterFor(gov-hybrid) without cfg → no predicate (would mis-serve)');

  // applyModeFilter drops a Chinese-origin primary under a gov-based custom mode
  assertEq(
    applyModeFilter('gov-hybrid', 'qwen3.6:35b', ['claude-opus-4-6'], MODEL_ROUTES, BACKENDS, cfg),
    'claude-opus-4-6',
    'gov-based custom mode drops Chinese primary, falls to Claude in chain'
  );
  assertEq(
    applyModeFilter('gov-hybrid', 'qwen3.6:35b', null, MODEL_ROUTES, BACKENDS, cfg),
    null,
    'gov-based custom mode with Chinese primary + no chain → null (blocked)'
  );
  // Non-gov custom mode does NOT filter
  assertEq(
    applyModeFilter('deepseek-hybrid', 'qwen3.6:35b', null, MODEL_ROUTES, BACKENDS, ossCfg),
    'qwen3.6:35b',
    'non-gov custom mode keeps the Chinese primary (no gov filter)'
  );
}

const failed = summary();
process.exit(failed ? 1 : 0);
