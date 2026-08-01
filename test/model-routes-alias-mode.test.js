#!/usr/bin/env node
'use strict';
// Claude brand aliases (sonnet/opus/haiku/fable) preserve Claude brand identity
// in every mode, including best-cloud-oss.
//
// Run: node test/model-routes-alias-mode.test.js

const fs = require('fs');
const path = require('path');
const {
  resolveModelRoute,
  DEFAULT_MODE,
} = require('../tools/model-map-resolve.js');
const { assert, assertEq, summary } = require('./helpers');

console.log('model_routes enum alias × mode\n');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'model-map.json'), 'utf8')
);
const routes = config.model_routes || {};
const endpoints = config.endpoints || config.backends || {};

assertEq(DEFAULT_MODE, 'best-cloud-oss', 'DEFAULT_MODE is best-cloud-oss');
assertEq(config.llm_mode, 'best-cloud-oss', 'shipped config llm_mode is best-cloud-oss');

function resolveAlias(alias, mode) {
  return resolveModelRoute(alias, {
    routes,
    endpoints,
    mode,
    latest_models: config.latest_models,
  });
}

for (const alias of ['sonnet', 'opus', 'haiku', 'fable']) {
  console.log(`\n${alias}:`);
  {
    const r = resolveAlias(alias, 'best-cloud');
    assert(r && r.endpointId, `${alias}@best-cloud resolves`);
    assert(['anthropic', 'anthropic_subscription'].includes(r.endpointId),
      `${alias}@best-cloud → Anthropic (got ${r.endpointId})`);
    assert(/claude/i.test(r.servedBy), `${alias}@best-cloud served by Claude (got ${r.servedBy})`);
    assertEq(r.expandedFromLatest, config.latest_models[alias],
      `${alias}@best-cloud expands via latest_models`);
  }
  {
    const r = resolveAlias(alias, 'best-cloud-oss');
    assert(r && r.endpointId, `${alias}@best-cloud-oss resolves`);
    assert(['anthropic', 'anthropic_subscription'].includes(r.endpointId),
      `${alias}@best-cloud-oss → Anthropic (got ${r.endpointId})`);
    assert(/claude/i.test(r.servedBy), `${alias}@best-cloud-oss served by Claude (got ${r.servedBy})`);
    assertEq(r.expandedFromLatest, config.latest_models[alias],
      `${alias}@best-cloud-oss expands via latest_models`);
  }
}

process.exit(summary() === 0 ? 0 : 1);
