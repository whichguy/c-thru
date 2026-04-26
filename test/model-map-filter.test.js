#!/usr/bin/env node
'use strict';
// Unit tests for the Phase 2a provider-filter predicates exported from
// tools/model-map-resolve.js. Pure functions — no proxy spawn — runs in ms.
//
// Run: node test/model-map-filter.test.js

const {
  isClaude, isCloud, isOpenSource, filterFor, applyModeFilter,
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
console.log('\n4. filterFor');
assert(typeof filterFor('cloud-only')      === 'function', 'cloud-only → predicate fn');
assert(typeof filterFor('claude-only')     === 'function', 'claude-only → predicate fn');
assert(typeof filterFor('opensource-only') === 'function', 'opensource-only → predicate fn');
assertEq(filterFor('connected'),     null, 'connected → null (no filter)');
assertEq(filterFor('offline'),       null, 'offline → null');
assertEq(filterFor('cloud-thinking'), null, 'cloud-thinking → null (slot-based, not filter)');
assertEq(filterFor('totally-bogus'), null, 'unknown mode → null');

// ── applyModeFilter ─────────────────────────────────────────────────────────
console.log('\n5. applyModeFilter');

// Non-filter mode → returns primary unchanged
assertEq(
  applyModeFilter('connected', 'qwen3:1.7b', [], MODEL_ROUTES, BACKENDS),
  'qwen3:1.7b',
  'non-filter mode returns primary unchanged'
);

// cloud-only with cloud primary → primary returned
assertEq(
  applyModeFilter('cloud-only', 'claude-opus-4-6', [], MODEL_ROUTES, BACKENDS),
  'claude-opus-4-6',
  'cloud-only: cloud primary passes filter'
);

// cloud-only with local primary + cloud in chain → chain hit
assertEq(
  applyModeFilter(
    'cloud-only', 'qwen3:1.7b',
    [{ model: 'claude-opus-4-6' }],
    MODEL_ROUTES, BACKENDS
  ),
  'claude-opus-4-6',
  'cloud-only: local primary rejected, cloud chain candidate selected'
);

// cloud-only with all-local chain → null
assertEq(
  applyModeFilter(
    'cloud-only', 'qwen3:1.7b',
    [{ model: 'qwen3.6:35b' }, { model: 'qwen3.6:35b-a3b' }],
    MODEL_ROUTES, BACKENDS
  ),
  null,
  'cloud-only: all-local chain → null'
);

// claude-only with non-Claude primary + Claude in chain → claude picked
assertEq(
  applyModeFilter(
    'claude-only', 'glm-5.1:cloud',
    [{ model: 'qwen3:1.7b' }, { model: 'claude-sonnet-4-6' }],
    MODEL_ROUTES, BACKENDS
  ),
  'claude-sonnet-4-6',
  'claude-only: skips non-Claude until Claude found'
);

// claude-only with no Claude anywhere → null
assertEq(
  applyModeFilter(
    'claude-only', 'qwen3:1.7b',
    [{ model: 'glm-5.1:cloud' }, { model: 'qwen3.6:35b' }],
    MODEL_ROUTES, BACKENDS
  ),
  null,
  'claude-only: no Claude in chain → null'
);

// opensource-only with Claude primary + OS in chain → OS picked
assertEq(
  applyModeFilter(
    'opensource-only', 'claude-opus-4-6',
    [{ model: 'qwen3.6:35b' }],
    MODEL_ROUTES, BACKENDS
  ),
  'qwen3.6:35b',
  'opensource-only: Claude primary skipped, OS picked'
);

// Empty chain
assertEq(
  applyModeFilter('cloud-only', 'qwen3:1.7b', [], MODEL_ROUTES, BACKENDS),
  null,
  'empty chain + non-compliant primary → null'
);

// Chain with string entries (not {model: ...})
assertEq(
  applyModeFilter(
    'cloud-only', 'qwen3:1.7b',
    ['claude-opus-4-6', 'qwen3:1.7b'],
    MODEL_ROUTES, BACKENDS
  ),
  'claude-opus-4-6',
  'chain accepts plain strings'
);

// Null chain → only primary checked
assertEq(
  applyModeFilter('cloud-only', 'claude-opus-4-6', null, MODEL_ROUTES, BACKENDS),
  'claude-opus-4-6',
  'null chain handled (primary passes)'
);
assertEq(
  applyModeFilter('cloud-only', 'qwen3:1.7b', null, MODEL_ROUTES, BACKENDS),
  null,
  'null chain handled (primary fails → null)'
);

const failed = summary();
process.exit(failed ? 1 : 0);
