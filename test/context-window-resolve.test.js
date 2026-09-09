#!/usr/bin/env node
'use strict';
// resolveContextWindow unit tests: pure config lookup (model_overrides first,
// then context_windows), no hard-coded vendor table.
// Run: node test/context-window-resolve.test.js

const { resolveContextWindow } = require('../tools/model-map-resolve.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS  ${label} (got ${JSON.stringify(actual)})`);
    passed++;
  } else {
    console.error(`  FAIL  ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    failed++;
  }
}

const cfg = {
  context_windows: {
    'grok-4.6': 500000,
    'deepseek-v4-pro:cloud': 1048576,
    'qwen3:8b': 40960,
  },
  model_overrides: {
    'grok': 'grok-4.6',
  },
};

console.log('1. Static map lookup');
assertEq(resolveContextWindow('grok-4.6', cfg), 500000, 'concrete model hit');
assertEq(resolveContextWindow('deepseek-v4-pro:cloud', cfg), 1048576, 'cloud model hit');
assertEq(resolveContextWindow('qwen3:8b', cfg), 40960, 'local model hit');

console.log('2. model_overrides applied first');
assertEq(resolveContextWindow('grok', cfg), 500000, 'override key resolves to target window');

console.log('3. Unknown / non-concrete → null');
assertEq(resolveContextWindow('claude-sonnet-5', cfg), null, 'claude-native → null (launcher skips these)');
assertEq(resolveContextWindow('unknown-model', cfg), null, 'unknown → null');
assertEq(resolveContextWindow('', cfg), null, 'empty string → null');
assertEq(resolveContextWindow(null, cfg), null, 'null → null');
assertEq(resolveContextWindow(undefined, cfg), null, 'undefined → null');

console.log('4. Invalid map values → null (never return a bad window)');
assertEq(resolveContextWindow('grok-4.6', { context_windows: { 'grok-4.6': 0 } }), null, 'zero → null');
assertEq(resolveContextWindow('grok-4.6', { context_windows: { 'grok-4.6': -1 } }), null, 'negative → null');
assertEq(resolveContextWindow('grok-4.6', { context_windows: { 'grok-4.6': '500000' } }), null, 'string → null');
assertEq(resolveContextWindow('grok-4.6', { context_windows: { 'grok-4.6': 1.5 } }), null, 'float → null');

console.log('5. Missing config / empty map → null');
assertEq(resolveContextWindow('grok-4.6', null), null, 'null config → null');
assertEq(resolveContextWindow('grok-4.6', {}), null, 'empty config → null');
assertEq(resolveContextWindow('grok-4.6', { context_windows: {} }), null, 'empty map → null');

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
