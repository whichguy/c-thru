#!/usr/bin/env node
'use strict';
// Integration tests for proxy config hot-reload and config-path re-selection.
// Run with: node test/proxy-config-reload.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assert,
  summary,
  httpJson,
  withProxy,
  assertLogContains,
  collectStderr,
  stubBackend,
} = require('./helpers');

console.log('proxy-config-reload integration tests\n');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MSG = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 8, model: 'workhorse' };

function mkConfig(stubPort, model) {
  return {
    backends: {
      stub: { kind: 'anthropic', url: `http://127.0.0.1:${stubPort}` },
    },
    model_routes: {
      [model]: 'stub',
    },
    llm_profiles: {
      '16gb': {
        workhorse: { connected_model: model, disconnect_model: model },
      },
    },
  };
}

async function assertResolvedModel(port, stub, expected, message) {
  const r = await httpJson(port, 'POST', '/v1/messages', MSG);
  assert(r.status === 200, `${message}: /v1/messages returns 200 (got ${r.status})`);
  assert(stub.lastRequest()?.model_used === expected,
    `${message}: forwarded model ${expected} (got ${JSON.stringify(stub.lastRequest()?.model_used)})`);
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-reload-'));
  let stub;

  try {
    stub = await stubBackend();

    console.log('1. Writing the selected config still hot-reloads via fs.watch');
    {
      const configPath = path.join(tmpRoot, 'watch-config.json');
      fs.writeFileSync(configPath, JSON.stringify(mkConfig(stub.port, 'watch-before')));

      await withProxy({ configPath, profile: '16gb', env: { CLAUDE_LLM_MODE: 'connected' } }, async ({ port, child }) => {
        const stderr = collectStderr(child);

        await assertResolvedModel(port, stub, 'watch-before', 'before fs.watch write');

        fs.writeFileSync(configPath, JSON.stringify(mkConfig(stub.port, 'watch-after')));
        await sleep(300);

        const ping = await httpJson(port, 'GET', '/ping');
        assert(ping.status === 200, '/ping still 200 after selected-config write');
        await assertResolvedModel(port, stub, 'watch-after', 'after fs.watch write');
        assertLogContains(stderr.get(), /reloaded config/, 'stderr contains "reloaded config" after selected-config write');
      });
    }

    console.log('\n2. Writing invalid JSON to the selected config keeps the old graph');
    {
      const configPath = path.join(tmpRoot, 'invalid-selected.json');
      fs.writeFileSync(configPath, JSON.stringify(mkConfig(stub.port, 'selected-still-good')));

      await withProxy({ configPath, profile: '16gb', env: { CLAUDE_LLM_MODE: 'connected' } }, async ({ port, child }) => {
        const stderr = collectStderr(child);

        await assertResolvedModel(port, stub, 'selected-still-good', 'before invalid selected-config write');

        fs.writeFileSync(configPath, '{ not valid json }}}');
        await sleep(300);

        const ping = await httpJson(port, 'GET', '/ping');
        assert(ping.status === 200, '/ping still 200 after bad selected-config write');
        await assertResolvedModel(port, stub, 'selected-still-good', 'after invalid selected-config write');
        assertLogContains(stderr.get(), /reload failed|invalid|parse/i, 'stderr contains reload-failure message for selected-config write');
      });
    }

    console.log('\n3. SIGHUP re-selects from profile graph to project graph');
    {
      const projectDir = path.join(tmpRoot, 'profile-to-project');
      const profileHome = path.join(tmpRoot, 'profile-to-project-home');
      const profileClaude = path.join(profileHome, '.claude');
      const projectClaude = path.join(projectDir, '.claude');
      fs.mkdirSync(profileClaude, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });

      fs.writeFileSync(path.join(profileClaude, 'model-map.json'), JSON.stringify(mkConfig(stub.port, 'profile-model')));

      await withProxy({
        profile: '16gb',
        cwd: projectDir,
        env: {
          CLAUDE_LLM_MODE: 'connected',
          CLAUDE_PROFILE_DIR: profileClaude,
        },
      }, async ({ port, child }) => {
        const stderr = collectStderr(child);

        await assertResolvedModel(port, stub, 'profile-model', 'before profile->project reload');

        fs.mkdirSync(projectClaude, { recursive: true });
        fs.writeFileSync(path.join(projectClaude, 'model-map.json'), JSON.stringify(mkConfig(stub.port, 'project-model')));

        child.kill('SIGHUP');
        await sleep(250);

        const ping = await httpJson(port, 'GET', '/ping');
        assert(ping.status === 200, '/ping still 200 after profile->project SIGHUP');
        await assertResolvedModel(port, stub, 'project-model', 'after profile->project reload');
        assertLogContains(stderr.get(), /reloaded|SIGHUP/i, 'stderr contains reload message after profile->project SIGHUP');
      });
    }

    console.log('\n4. SIGHUP re-selects from project graph to override graph');
    {
      const projectDir = path.join(tmpRoot, 'project-to-override');
      const profileHome = path.join(tmpRoot, 'project-to-override-home');
      const profileClaude = path.join(profileHome, '.claude');
      const projectClaude = path.join(projectDir, '.claude');
      const overridePath = path.join(tmpRoot, 'override-graph.json');
      fs.mkdirSync(profileClaude, { recursive: true });
      fs.mkdirSync(projectClaude, { recursive: true });

      fs.writeFileSync(path.join(profileClaude, 'model-map.json'), JSON.stringify(mkConfig(stub.port, 'profile-fallback')));
      fs.writeFileSync(path.join(projectClaude, 'model-map.json'), JSON.stringify(mkConfig(stub.port, 'project-model')));

      await withProxy({
        profile: '16gb',
        cwd: projectDir,
        env: {
          CLAUDE_LLM_MODE: 'connected',
          CLAUDE_PROFILE_DIR: profileClaude,
          CLAUDE_MODEL_MAP_PATH: overridePath,
        },
      }, async ({ port, child }) => {
        const stderr = collectStderr(child);

        await assertResolvedModel(port, stub, 'project-model', 'before project->override reload');

        fs.writeFileSync(overridePath, JSON.stringify(mkConfig(stub.port, 'override-model')));
        child.kill('SIGHUP');
        await sleep(250);

        const ping = await httpJson(port, 'GET', '/ping');
        assert(ping.status === 200, '/ping still 200 after project->override SIGHUP');
        await assertResolvedModel(port, stub, 'override-model', 'after project->override reload');
        assertLogContains(stderr.get(), /reloaded|SIGHUP/i, 'stderr contains reload message after project->override SIGHUP');
      });
    }

    console.log('\n5. Watcher re-binds when the selected config path changes');
    {
      const projectDir = path.join(tmpRoot, 'watcher-rebind');
      const profileHome = path.join(tmpRoot, 'watcher-rebind-home');
      const profileClaude = path.join(profileHome, '.claude');
      const projectClaude = path.join(projectDir, '.claude');
      const overridePath = path.join(tmpRoot, 'watcher-rebind-override.json');
      fs.mkdirSync(profileClaude, { recursive: true });
      fs.mkdirSync(projectClaude, { recursive: true });

      fs.writeFileSync(path.join(profileClaude, 'model-map.json'), JSON.stringify(mkConfig(stub.port, 'profile-fallback')));
      fs.writeFileSync(path.join(projectClaude, 'model-map.json'), JSON.stringify(mkConfig(stub.port, 'project-before-rebind')));

      await withProxy({
        profile: '16gb',
        cwd: projectDir,
        env: {
          CLAUDE_LLM_MODE: 'connected',
          CLAUDE_PROFILE_DIR: profileClaude,
          CLAUDE_MODEL_MAP_PATH: overridePath,
        },
      }, async ({ port, child }) => {
        const stderr = collectStderr(child);

        await assertResolvedModel(port, stub, 'project-before-rebind', 'before watcher rebind');

        fs.writeFileSync(overridePath, JSON.stringify(mkConfig(stub.port, 'override-after-rebind')));
        child.kill('SIGHUP');
        await sleep(250);
        await assertResolvedModel(port, stub, 'override-after-rebind', 'after watcher rebind SIGHUP');

        fs.writeFileSync(overridePath, JSON.stringify(mkConfig(stub.port, 'override-fs-watch')));
        await sleep(300);

        const ping = await httpJson(port, 'GET', '/ping');
        assert(ping.status === 200, '/ping still 200 after watcher rebind fs.watch reload');
        await assertResolvedModel(port, stub, 'override-fs-watch', 'after watcher rebind fs.watch reload');
        assertLogContains(stderr.get(), /reloaded config/, 'stderr contains "reloaded config" after watcher rebind fs.watch reload');
      });
    }

    console.log('\n6. Invalid newly-selected override keeps serving the old graph');
    {
      const projectDir = path.join(tmpRoot, 'invalid-new-selection');
      const profileHome = path.join(tmpRoot, 'invalid-new-selection-home');
      const profileClaude = path.join(profileHome, '.claude');
      const projectClaude = path.join(projectDir, '.claude');
      const overridePath = path.join(tmpRoot, 'invalid-new-selection-override.json');
      fs.mkdirSync(profileClaude, { recursive: true });
      fs.mkdirSync(projectClaude, { recursive: true });

      fs.writeFileSync(path.join(profileClaude, 'model-map.json'), JSON.stringify(mkConfig(stub.port, 'profile-fallback')));
      fs.writeFileSync(path.join(projectClaude, 'model-map.json'), JSON.stringify(mkConfig(stub.port, 'project-survives')));

      await withProxy({
        profile: '16gb',
        cwd: projectDir,
        env: {
          CLAUDE_LLM_MODE: 'connected',
          CLAUDE_PROFILE_DIR: profileClaude,
          CLAUDE_MODEL_MAP_PATH: overridePath,
        },
      }, async ({ port, child }) => {
        const stderr = collectStderr(child);

        await assertResolvedModel(port, stub, 'project-survives', 'before invalid newly-selected override');

        fs.writeFileSync(overridePath, '{ this is not valid json');
        child.kill('SIGHUP');
        await sleep(250);

        const ping = await httpJson(port, 'GET', '/ping');
        assert(ping.status === 200, '/ping still 200 after invalid newly-selected override');
        await assertResolvedModel(port, stub, 'project-survives', 'after invalid newly-selected override');
        assertLogContains(stderr.get(), /reload failed|invalid|parse/i, 'stderr contains reload-failure message for invalid newly-selected override');
      });
    }
  } finally {
    try { if (stub) await stub.close(); } catch {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
