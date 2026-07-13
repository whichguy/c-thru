#!/usr/bin/env node
'use strict';
// Enum aliases (sonnet/opus/haiku/fable) must be mode-conditional so best-cloud-oss
// does not send them to Anthropic (Claude Code credits).
//
// Run: node test/model-routes-alias-mode.test.js

const fs = require('fs');
const path = require('path');
const {
  pickModeTarget,
  matchModelRoute,
  resolveRouteTarget,
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
  const hit = matchModelRoute(routes, alias);
  assert(hit, `model_routes has ${alias}`);
  const picked = pickModeTarget(hit.target, mode);
  const resolved = resolveRouteTarget(picked, alias, {
    routes,
    endpoints,
    mode,
  });
  return resolved;
}

for (const alias of ['sonnet', 'opus', 'haiku', 'fable']) {
  console.log(`\n${alias}:`);
  {
    const r = resolveAlias(alias, 'best-cloud');
    assert(r && r.endpointId, `${alias}@best-cloud resolves`);
    // fable may resolve to a model name string that walks further
    const ep = r.endpointId;
    if (alias !== 'fable') {
      assertEq(ep, 'anthropic', `${alias}@best-cloud → anthropic (got ${ep})`);
    } else {
      // fable → claude-fable-5 may not have endpoint anthropic if missing route
      assert(r, `${alias}@best-cloud resolves something`);
    }
  }
  {
    const r = resolveAlias(alias, 'best-cloud-oss');
    assert(r && r.endpointId, `${alias}@best-cloud-oss resolves`);
    assert(
      r.endpointId !== 'anthropic' && r.endpointId !== 'anthropic_subscription',
      `${alias}@best-cloud-oss is not Anthropic (got endpoint ${r.endpointId}, model ${r.servedBy})`
    );
    assert(
      /cloud|ollama/i.test(r.endpointId) || /:cloud|deepseek|kimi|glm|qwen/i.test(String(r.servedBy)),
      `${alias}@best-cloud-oss looks like cloud OSS (endpoint=${r.endpointId}, servedBy=${r.servedBy})`
    );
  }
}

process.exit(summary() === 0 ? 0 : 1);
