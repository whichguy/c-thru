#!/usr/bin/env node
'use strict';
/**
 * Quality Review Test Suite for c-thru Proxy
 * 
 * Focuses on:
 * 1. Anthropic-to-Ollama high-fidelity mapping (Ollama 0.4+ /v1/messages)
 * 2. Fallback cascade correctness
 * 3. Header scrubbing and security
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, withProxy,
} = require('./helpers');

console.log('c-thru quality review: mapping & fallback tests\n');

// ── Configuration Builders ─────────────────────────────────────────────────

function buildMappingConfig(ollamaPort, anthropicPort) {
  return {
    endpoints: {
      ollama: {
        kind: 'ollama',
        url: `http://127.0.0.1:${ollamaPort}`,
        format: 'anthropic',
        auth: 'none'
      },
      anthropic_cloud: {
        kind: 'anthropic',
        url: `http://127.0.0.1:${anthropicPort}`,
        format: 'anthropic',
        auth_env: 'ANTHROPIC_API_KEY'
      },
      passthrough: {
        kind: 'custom',
        url: `http://127.0.0.1:${anthropicPort}`,
        format: 'anthropic'
      }
    },
    model_routes: {
      'ollama-model': 'ollama',
      'claude-3-sonnet': 'anthropic_cloud',
      'pass-model': 'passthrough'
    },
    llm_profiles: {
      '16gb': {
        workhorse: {
          connected_model: 'claude-3-sonnet@anthropic_cloud',
          disconnect_model: 'ollama-model@ollama'
        }
      }
    }
  };
}

function buildFallbackConfig(primaryPort, secondaryPort, tertiaryPort) {
  return {
    endpoints: {
      primary:   { kind: 'anthropic', url: `http://127.0.0.1:${primaryPort}`, fallback_to: 'secondary-model' },
      secondary: { kind: 'anthropic', url: `http://127.0.0.1:${secondaryPort}`, fallback_to: 'tertiary-model' },
      tertiary:  { kind: 'anthropic', url: `http://127.0.0.1:${tertiaryPort}` }
    },
    model_routes: {
      'primary-model':   'primary',
      'secondary-model': 'secondary',
      'tertiary-model':  'tertiary'
    },
    llm_profiles: {
      '16gb': {
        workhorse: {
          connected_model: 'primary-model@primary',
          on_failure: 'cascade'
        },
        hard_fail_cap: {
          connected_model: 'primary-model@primary',
          on_failure: 'hard_fail'
        }
      }
    }
  };
}

// ── Test Cases ─────────────────────────────────────────────────────────────

async function runMappingTests() {
  console.log('--- Phase 1: Mapping & Header Integrity ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-map-test-'));
  let ollamaStub, cloudStub;

  try {
    ollamaStub = await stubBackend();
    cloudStub = await stubBackend();
    const config = buildMappingConfig(ollamaStub.port, cloudStub.port);
    const configPath = writeConfig(tmpDir, config);

    const api_key = 'sk-test-' + crypto.randomBytes(8).toString('hex');

    await withProxy({ configPath, profile: '16gb', env: { ANTHROPIC_API_KEY: api_key } }, async ({ port }) => {
      
      // 1.1 Local Ollama (v1/messages) should have dummy Bearer ollama AND preserve client headers
      console.log('1.1 Local Ollama (v1/messages) header passthrough & dummy auth');
      const bodyLocal = { model: 'ollama-model', messages: [{ role: 'user', content: 'hi' }] };
      await httpJson(port, 'POST', '/v1/messages', bodyLocal, { 'x-api-key': 'client-key' });
      
      const reqLocal = ollamaStub.lastRequest();
      assert(reqLocal !== null, 'Ollama received request');
      assertEq(reqLocal.headers['x-api-key'], 'client-key', 'x-api-key preserved (maximum passthrough)');
      assertEq(reqLocal.headers['authorization'], 'Bearer ollama', 'Authorization: Bearer ollama added as default for Ollama');

      // 1.2 Cloud Anthropic should use incoming Bearer if present
      console.log('1.2 Cloud Anthropic prioritization of incoming Bearer');
      const bodyCloud = { model: 'claude-3-sonnet', messages: [{ role: 'user', content: 'hi' }] };
      await httpJson(port, 'POST', '/v1/messages', bodyCloud, { 'authorization': 'Bearer incoming-token' });
      
      const reqCloud1 = cloudStub.lastRequest();
      assertEq(reqCloud1.headers['authorization'], 'Bearer incoming-token', 'Incoming Bearer prioritized over config key');
      assertEq(reqCloud1.headers['x-api-key'], undefined, 'x-api-key not set when Bearer is present');

      // 1.3 Cloud Anthropic should fall back to x-api-key if no Bearer
      console.log('1.3 Cloud Anthropic fallback to x-api-key');
      await httpJson(port, 'POST', '/v1/messages', bodyCloud);
      const reqCloud2 = cloudStub.lastRequest();
      assertEq(reqCloud2.headers['x-api-key'], api_key, 'x-api-key used when no incoming Bearer present');

      // 1.4 Passthrough for unknown backends
      console.log('1.4 Header passthrough for custom backends');
      const bodyPass = { model: 'pass-model', messages: [{ role: 'user', content: 'hi' }] };
      await httpJson(port, 'POST', '/v1/messages', bodyPass, { 'x-api-key': 'custom-key' });
      const reqPass = cloudStub.lastRequest();
      assertEq(reqPass.headers['x-api-key'], 'custom-key', 'Incoming x-api-key passed through verbatim');

      // 1.5 Thinking blocks should pass through verbatim to Ollama
      console.log('1.5 Thinking block passthrough to Ollama');
      const bodyThinking = { 
        model: 'ollama-model', 
        messages: [{ role: 'user', content: 'think about it' }],
        thinking: { type: 'enabled', budget_tokens: 1024 }
      };
      await httpJson(port, 'POST', '/v1/messages', bodyThinking);
      const reqThinking = ollamaStub.lastRequest();
      assert(reqThinking.body.thinking !== undefined, 'Thinking block preserved in body');
      assertEq(reqThinking.body.thinking.budget_tokens, 1024, 'Thinking budget preserved');
    });

  } finally {
    if (ollamaStub) await ollamaStub.close();
    if (cloudStub) await cloudStub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runFallbackTests() {
  console.log('\n--- Phase 2: Fallback Cascade & Cooldown ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-fallback-test-'));
  let s1, s2, s3;

  try {
    // S1 fails (502), S2 fails (429), S3 succeeds (200)
    s1 = await stubBackend({ failWith: 502 });
    s2 = await stubBackend({ failWith: 429 });
    s3 = await stubBackend();
    
    const config = buildFallbackConfig(s1.port, s2.port, s3.port);
    const configPath = writeConfig(tmpDir, config);

    await withProxy({ configPath, profile: '16gb' }, async ({ port }) => {
      
      // 2.1 Cascade from primary -> secondary -> tertiary
      console.log('2.1 Cascade primary -> secondary -> tertiary');
      const body = { model: 'workhorse', messages: [{ role: 'user', content: 'test cascade' }] };
      const r = await httpJson(port, 'POST', '/v1/messages', body);
      
      assertEq(r.status, 200, 'Request eventually succeeded');
      assertEq(s1.requests.length, 1, 'S1 tried once');
      assertEq(s2.requests.length, 1, 'S2 tried once');
      assertEq(s3.requests.length, 1, 'S3 tried once');
      assertEq(r.headers['x-c-thru-fallback-from'], 'primary', 'Fallback header indicates origin');

      // 2.2 Cooldown: Subsequent request should skip S1 and S2 immediately
      console.log('2.2 Cooldown: skipping failed backends');
      s3.requests.length = 0; // reset counter
      s1.requests.length = 0;
      s2.requests.length = 0;
      
      const r2 = await httpJson(port, 'POST', '/v1/messages', body);
      assertEq(r2.status, 200, 'Second request succeeded');
      assertEq(s1.requests.length, 0, 'S1 skipped due to cooldown');
      assertEq(s2.requests.length, 0, 'S2 skipped due to cooldown');
      assertEq(s3.requests.length, 1, 'S3 hit directly');

      // 2.3 hard_fail: should NOT cascade
      console.log('2.3 hard_fail: cascade prevented');
      const bodyHard = { model: 'hard_fail_cap', messages: [{ role: 'user', content: 'test hard fail' }] };
      const rHard = await httpJson(port, 'POST', '/v1/messages', bodyHard);
      assertEq(rHard.status, 502, 'Request failed with 502 (no cascade)');
    });

  } finally {
    if (s1) await s1.close();
    if (s2) await s2.close();
    if (s3) await s3.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    await runMappingTests();
    await runFallbackTests();
  } catch (err) {
    console.error('Test Suite Failed:', err);
    process.exit(1);
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main();
