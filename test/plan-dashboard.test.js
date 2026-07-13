#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
} = require('./helpers');

console.log('plan-dashboard tests\n');

function buildConfig(port) {
  return { backends: { stub: { kind: 'anthropic', url: `http://127.0.0.1:${port}` } }, model_routes: { 'plan-dashboard-test': 'stub' } };
}
function stop(child) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('exit', finish);
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(); }, 3000);
  });
}

function loadRealSelectRenderer() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tools', 'plan-dashboard.html'), 'utf8');
  const scriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('dashboard script extraction anchor is missing');
  const start = scriptMatch[1].indexOf("const $ =");
  const end = scriptMatch[1].indexOf('function activityPanel');
  if (start < 0 || end < start) throw new Error('dashboard select renderer extraction anchor is missing');

  const decodeAttribute = value => value
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  const select = {
    options: [], _value: '',
    set innerHTML(markup) {
      this.options = [...markup.matchAll(/<option value="([^"]*)" data-native-key="([^"]*)" data-wave-key="([^"]*)">/g)]
        .map(match => ({ value: decodeAttribute(match[1]), dataset: { nativeKey: decodeAttribute(match[2]), waveKey: decodeAttribute(match[3]) } }));
      this._value = this.options[0] ? this.options[0].value : '';
    },
    get value() { return this._value; },
    set value(value) { if (this.options.some(option => option.value === value)) this._value = value; },
    get selectedIndex() { return this.options.findIndex(option => option.value === this._value); },
    get selectedOptions() { const option = this.options[this.selectedIndex]; return option ? [option] : []; },
  };
  const context = { document: { getElementById: id => id === 'plan-select' ? select : null } };
  vm.runInNewContext(scriptMatch[1].slice(start, end), context, { filename: 'plan-dashboard-select.js' });
  if (typeof context.renderSelect !== 'function') throw new Error('dashboard renderSelect was not extracted');
  return { select, renderSelect: context.renderSelect };
}

function runSelectionRegression() {
  const { select, renderSelect } = loadRealSelectRenderer();
  const alpha = { repo: 'alpha', cwd: '/work/alpha', last_activity_ts: '2026-01-01T00:00:00.000Z', joined: true,
    native: { snapshot_path: '/spool/alpha.md' }, wave: { slug: 'alpha-wave' } };
  const beta = { repo: 'beta', cwd: '/work/beta', last_activity_ts: '2026-01-02T00:00:00.000Z', joined: false,
    native: { snapshot_path: '/spool/beta.md' }, wave: null };

  renderSelect([alpha, beta]);
  select.value = JSON.stringify(['native', 'alpha', 'alpha']);
  renderSelect([beta, alpha]);
  assertEq([beta, alpha][select.selectedIndex].native.snapshot_path, '/spool/alpha.md', 'reordered dashboard plans preserve native selection identity');

  const alphaUnjoined = { ...alpha, joined: false, wave: null };
  renderSelect([beta, alphaUnjoined]);
  assertEq([beta, alphaUnjoined][select.selectedIndex].native.snapshot_path, '/spool/alpha.md', 'joined flip preserves the selected native plan');

  const waveCollision = { repo: 'wave', cwd: null, last_activity_ts: '2026-01-03T00:00:00.000Z', joined: false,
    native: null, wave: { slug: 'shared-id' } };
  const nativeCollision = { repo: 'native', cwd: '/work/native', last_activity_ts: '2026-01-04T00:00:00.000Z', joined: false,
    native: { snapshot_path: '/spool/shared-id.md' }, wave: null };
  renderSelect([waveCollision, nativeCollision]);
  select.value = JSON.stringify(['native', 'native', 'shared-id']);
  renderSelect([nativeCollision, waveCollision]);
  assertEq([nativeCollision, waveCollision][select.selectedIndex].native.snapshot_path, '/spool/shared-id.md', 'namespaced native key does not cross-select a colliding wave slug');
  select.value = JSON.stringify(['wave', 'wave', 'shared-id']);
  renderSelect([nativeCollision, waveCollision]);
  assertEq([nativeCollision, waveCollision][select.selectedIndex].wave.slug, 'shared-id', 'namespaced wave key does not cross-select a colliding native id');

  const repoA = { repo: 'repo-a', cwd: '/work/repo-a', last_activity_ts: '2026-01-05T00:00:00.000Z', joined: false,
    native: null, wave: { slug: 'dup-slug' } };
  const repoB = { repo: 'repo-b', cwd: '/work/repo-b', last_activity_ts: '2026-01-06T00:00:00.000Z', joined: false,
    native: null, wave: { slug: 'dup-slug' } };
  const repoBKey = JSON.stringify(['wave', 'repo-b', 'dup-slug']);
  renderSelect([repoA, repoB]);
  select.value = repoBKey;
  assertEq(select.value, repoBKey, 'repo-scoped wave key selects the requested colliding repo');
  renderSelect([repoB, repoA]);
  assertEq([repoB, repoA][select.selectedIndex].repo, 'repo-b', 'cross-repo colliding wave slug preserves the selected repo after reordering');
}

async function main() {
  runSelectionRegression();
  const stub = await stubBackend();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-plan-dash-'));
  let child = null;
  try {
    const spool = path.join(root, 'spool');
    fs.mkdirSync(spool, { recursive: true });
    fs.writeFileSync(path.join(spool, 'plan-session.md'), '# Fixture plan\n\nKeep state local.\n');
    fs.writeFileSync(path.join(spool, 'events.ndjson'), JSON.stringify({
      ts: String(Date.now()), event: 'plan_approved', repo: 'fixture-repo', cwd: '/work/fixture-repo',
      session_id: 'session-fixture', transcript_path: path.join(root, 'missing.jsonl'), snapshot: 'plan-session.md', title: 'Fixture plan',
    }) + '\n');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const configPath = writeConfig(home, buildConfig(stub.port));
    let port;
    ({ child, port } = await spawnProxy({ configPath, tmpHome: home, env: { C_THRU_PLAN_SPOOL: spool } }));
    await waitForPing(port, 5000);

    const page = await httpJson(port, 'GET', '/c-thru/plan/dashboard', null, {}, 3000);
    assertEq(page.status, 200, 'plan dashboard returns 200');
    assert((page.headers['content-type'] || '').startsWith('text/html'), 'plan dashboard is HTML');
    assertEq(page.headers['cache-control'], 'no-store', 'plan dashboard is not cached');
    assert(page.bodyText.includes("fetch('/c-thru/plan')"), 'dashboard polls its relative state endpoint');
    assert(page.bodyText.includes('setInterval(poll, 2000)'), 'dashboard uses a two-second poll');
    assert(!/src\s*=\s*["']https?:/i.test(page.bodyText), 'dashboard has no external resources');

    const pageSlash = await httpJson(port, 'GET', '/c-thru/plan/dashboard/', null, {}, 3000);
    assertEq(pageSlash.status, 200, 'trailing dashboard slash returns 200');
    const state = await httpJson(port, 'GET', '/c-thru/plan', null, {}, 3000);
    assertEq(state.status, 200, 'plan state endpoint returns 200');
    assert(state.json && state.json.ok === true && Array.isArray(state.json.plans), 'plan state has the documented JSON shape');
    assertEq(state.json.plans[0].native.title, 'Fixture plan', 'fixture event reaches the state endpoint');
    const ping = await httpJson(port, 'GET', '/ping', null, {}, 3000);
    assertEq(ping.json.plan_dashboard, `http://127.0.0.1:${port}/c-thru/plan/dashboard`, 'ping discovers the plan dashboard');
    await stop(child); child = null;

    const garbage = path.join(root, 'garbage-spool');
    fs.writeFileSync(garbage, 'this is not a spool directory');
    const secondHome = path.join(root, 'second-home');
    fs.mkdirSync(secondHome, { recursive: true });
    const secondConfig = writeConfig(secondHome, buildConfig(stub.port));
    let secondPort;
    ({ child, port: secondPort } = await spawnProxy({ configPath: secondConfig, tmpHome: secondHome, env: { C_THRU_PLAN_SPOOL: garbage } }));
    await waitForPing(secondPort, 5000);
    const degraded = await httpJson(secondPort, 'GET', '/c-thru/plan', null, {}, 3000);
    assert(degraded.status === 503 || (degraded.status === 200 && degraded.json && degraded.json.ok === true && Array.isArray(degraded.json.plans) && degraded.json.plans.length === 0),
      'garbage/unreadable spool never crashes the proxy');
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch (_) {} }
    try { await stub.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
