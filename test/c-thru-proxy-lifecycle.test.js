#!/usr/bin/env node
'use strict';

// Hermetic lifecycle regression tests for the real tools/c-thru entrypoint.
//
// The proxy and Claude executables are deterministic stubs installed under a
// temporary HOME.  The launcher itself is not sourced or mocked: each case
// drives its normal config selection, ephemeral-session setup, FIFO readiness
// handshake, child launch, signal traps, and cleanup.
//
// Run: node test/c-thru-proxy-lifecycle.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_DIR = path.join(__dirname, '..');
const CTHRU = path.join(REPO_DIR, 'tools', 'c-thru');

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function readPid(file) {
  const value = Number(readText(file));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function pidIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

async function waitForPidGone(pid, timeoutMs = 1500) {
  return waitUntil(() => !pidIsAlive(pid), timeoutMs);
}

function lifecycleArtifacts(root) {
  const found = [];
  const visit = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (
        entry.name.startsWith('c-thru-session.') ||
        /^proxy\.ready\..*\.pipe$/.test(entry.name) ||
        /^proxy\.stderr\..*\.tmp$/.test(entry.name)
      ) {
        found.push(full);
      }
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return found;
}

function killFixtureProcesses(fixture) {
  for (const file of [fixture.claudePidFile, fixture.proxyPidFile]) {
    const pid = readPid(file);
    if (!pid || !pidIsAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function removeFixture(fixture) {
  killFixtureProcesses(fixture);
  try { fs.rmSync(fixture.root, { recursive: true, force: true }); } catch {}
}

function makeFixture({ proxyMode = 'ready', claudeMode = 'exit37', backend = 'anthropic' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-proxy-lifecycle-'));
  const home = path.join(root, 'home');
  const profile = path.join(home, '.claude');
  const profileTools = path.join(profile, 'tools');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(profileTools, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });

  const proxyPidFile = path.join(root, 'proxy.pid');
  const proxyEventsFile = path.join(root, 'proxy.events');
  const claudePidFile = path.join(root, 'claude.pid');
  const claudeEventsFile = path.join(root, 'claude.events');
  const claudeConfigDirFile = path.join(root, 'claude.config-dir');

  const proxyStub = path.join(profileTools, 'claude-proxy');
  fs.writeFileSync(proxyStub, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const http = require('http');
const mode = process.env.LIFECYCLE_PROXY_MODE || 'ready';
const pidFile = process.env.LIFECYCLE_PROXY_PID_FILE;
const eventsFile = process.env.LIFECYCLE_PROXY_EVENTS_FILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
function event(value) {
  if (!eventsFile) return;
  try { fs.appendFileSync(eventsFile, value + '\\n'); } catch {}
}
let server = null;
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  event('signal:' + signal);
  const finish = () => process.exit(0);
  if (server) {
    server.close(finish);
    setTimeout(finish, 250).unref();
  } else {
    finish();
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal));
}
process.on('exit', code => event('exit:' + code));
if (mode === 'ready_failed') {
  process.stdout.write('READY_FAILED EADDRINUSE lifecycle-test\\n');
  setInterval(() => {}, 1000);
} else if (mode === 'malformed') {
  process.stdout.write('NOT_READY lifecycle-test\\n');
  setInterval(() => {}, 1000);
} else {
  server = http.createServer((req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, active_tier: '16gb', active_mode: 'best-cloud' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(0, '127.0.0.1', () => {
    event('ready:' + server.address().port);
    process.stdout.write('READY ' + server.address().port + '\\n');
  });
}
`);
  fs.chmodSync(proxyStub, 0o755);

  const claudeStub = path.join(root, 'claude-stub');
  fs.writeFileSync(claudeStub, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const mode = process.env.LIFECYCLE_CLAUDE_MODE || 'exit37';
const pidFile = process.env.LIFECYCLE_CLAUDE_PID_FILE;
const eventsFile = process.env.LIFECYCLE_CLAUDE_EVENTS_FILE;
const configDirFile = process.env.LIFECYCLE_CLAUDE_CONFIG_DIR_FILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
if (configDirFile) fs.writeFileSync(configDirFile, process.env.CLAUDE_CONFIG_DIR || '');
function event(value) {
  if (!eventsFile) return;
  try { fs.appendFileSync(eventsFile, value + '\\n'); } catch {}
}
event('invoked');
if (mode === 'exit37') {
  process.exit(37);
}
let stopping = false;
function stop(signal) {
  if (mode === 'ignore-term' && signal === 'SIGTERM') {
    event('ignored:' + signal);
    return;
  }
  if (stopping) return;
  stopping = true;
  event('signal:' + signal);
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal));
}
setInterval(() => {}, 1000);
`);
  fs.chmodSync(claudeStub, 0o755);

  const configPath = path.join(root, 'model-map.json');
  const endpoint = backend === 'ollama'
    ? { kind: 'ollama', url: 'http://127.0.0.1:1' }
    : { kind: 'anthropic', url: 'https://anthropic.example' };
  const model = backend === 'ollama' ? 'lifecycle-local-model' : 'claude-sonnet-5';
  fs.writeFileSync(configPath, JSON.stringify({
    endpoints: { lifecycle: endpoint },
    routes: { default: model },
    model_routes: {
      [model]: 'lifecycle',
      ...(backend === 'anthropic' ? { 're:^claude-.*$': 'lifecycle' } : {}),
    },
  }));

  const env = { ...process.env };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_DIR',
    'CLAUDE_PROFILE_DIR',
    'CLAUDE_PROXY_LOG_DIR',
    'CLAUDE_PROXY_LOG_FILE',
    'CLAUDE_PROXY_PORT',
    'CLAUDE_PROXY_USE_OLLAMA_PORT',
    'C_THRU_KEEP_PROXY',
    'GOOGLE_API_KEY',
    'OPENAI_API_KEY',
    'PROXY_PORT',
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    TMPDIR: tmp,
    CLAUDE_BIN: claudeStub,
    CLAUDE_MODEL_MAP_PATH: configPath,
    CLAUDE_LLM_MODE: 'best-cloud',
    CLAUDE_LLM_PROFILE: '16gb',
    CLAUDE_PROXY_READY_TIMEOUT_SECONDS: '2',
    CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
    CLAUDE_PROXY_STARTUP_PROBE: '0',
    C_THRU_NO_BENCHMARK_UPDATE: '1',
    C_THRU_NO_MARKETPLACE_UPDATE: '1',
    C_THRU_NO_OAUTH_INJECT: '1',
    C_THRU_NO_UPDATE: '1',
    C_THRU_PROXY_ALWAYS: '1',
    C_THRU_SKIP_INFO_INJECTION: '1',
    C_THRU_SKIP_PREFLIGHT: '1',
    C_THRU_SKIP_PREPULL: '1',
    LIFECYCLE_CLAUDE_CONFIG_DIR_FILE: claudeConfigDirFile,
    LIFECYCLE_CLAUDE_EVENTS_FILE: claudeEventsFile,
    LIFECYCLE_CLAUDE_MODE: claudeMode,
    LIFECYCLE_CLAUDE_PID_FILE: claudePidFile,
    LIFECYCLE_PROXY_EVENTS_FILE: proxyEventsFile,
    LIFECYCLE_PROXY_MODE: proxyMode,
    LIFECYCLE_PROXY_PID_FILE: proxyPidFile,
    NO_AGENTS: '1',
    NO_COLOR: '1',
    OLLAMA_URL: 'http://127.0.0.1:1',
    TERM: 'dumb',
  });

  return {
    root,
    home,
    tmp,
    env,
    model,
    proxyPidFile,
    proxyEventsFile,
    claudePidFile,
    claudeEventsFile,
    claudeConfigDirFile,
  };
}

function runSync(fixture) {
  return spawnSync(CTHRU, ['--model', fixture.model, '--no-agents'], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

async function testChildExitAndCleanup() {
  console.log('1. Claude nonzero exit is preserved and launcher-owned state is cleaned');
  const fixture = makeFixture();
  try {
    const result = runSync(fixture);
    const proxyPid = readPid(fixture.proxyPidFile);
    const configDir = readText(fixture.claudeConfigDirFile);

    assert(!result.error, `launcher completed without spawn timeout (${result.error || 'ok'})`);
    assert(result.status === 37, `Claude exit 37 is preserved (got ${result.status})`);
    assert(readText(fixture.claudeEventsFile).includes('invoked'), 'Claude stub was invoked');
    assert(proxyPid !== null, `launcher spawned the proxy stub (pid ${proxyPid || 'missing'})`);
    assert(await waitForPidGone(proxyPid), `launcher reaped proxy pid ${proxyPid || 'missing'}`);
    assert(configDir.startsWith(fixture.tmp), `Claude received an ephemeral config dir (${configDir || 'missing'})`);
    assert(configDir.length > 0 && !fs.existsSync(configDir), 'ephemeral session directory was removed');
    const artifacts = lifecycleArtifacts(fixture.root);
    assert(artifacts.length === 0, `no readiness FIFO/session/startup-log artifacts remain (${artifacts.join(', ') || 'none'})`);
  } finally {
    removeFixture(fixture);
  }
}

async function testReadinessFailure(proxyMode, expected) {
  const label = proxyMode === 'ready_failed' ? 'READY_FAILED' : 'malformed readiness';
  console.log(`\n${proxyMode === 'ready_failed' ? '2' : '3'}. ${label} fails before Claude launch and cleans startup state`);
  const fixture = makeFixture({ proxyMode, backend: 'ollama' });
  try {
    const result = runSync(fixture);
    const proxyPid = readPid(fixture.proxyPidFile);
    const stderr = result.stderr || '';

    assert(!result.error, `launcher completed without spawn timeout (${result.error || 'ok'})`);
    assert(result.status !== 0, `launcher exits nonzero (got ${result.status})`);
    assert(expected.test(stderr), `stderr explains ${label} (${JSON.stringify(stderr.slice(-300))})`);
    assert(!fs.existsSync(fixture.claudeEventsFile), 'Claude stub was not invoked');
    assert(proxyPid !== null, `launcher spawned the proxy stub (pid ${proxyPid || 'missing'})`);
    assert(await waitForPidGone(proxyPid), `launcher reaped failed proxy pid ${proxyPid || 'missing'}`);
    const artifacts = lifecycleArtifacts(fixture.root);
    assert(artifacts.length === 0, `no readiness FIFO/session/startup-log artifacts remain (${artifacts.join(', ') || 'none'})`);
  } finally {
    removeFixture(fixture);
  }
}

async function testSigtermCleanup() {
  console.log('\n4. SIGTERM maps to 143 and escalates cleanup of a TERM-resistant Claude child');
  const fixture = makeFixture({ claudeMode: 'ignore-term' });
  let launcher = null;
  try {
    let stdout = '';
    let stderr = '';
    let exitResult = null;
    launcher = spawn(CTHRU, ['--model', fixture.model, '--no-agents'], {
      cwd: fixture.root,
      env: fixture.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    launcher.stdout.on('data', chunk => { stdout += chunk; });
    launcher.stderr.on('data', chunk => { stderr += chunk; });
    launcher.once('exit', (code, signal) => { exitResult = { code, signal }; });

    const launched = await waitUntil(
      () => readPid(fixture.proxyPidFile) !== null &&
        readPid(fixture.claudePidFile) !== null &&
        readText(fixture.claudeEventsFile).includes('invoked'),
      6000,
    );
    const proxyPid = readPid(fixture.proxyPidFile);
    const claudePid = readPid(fixture.claudePidFile);
    assert(launched, `proxy and Claude children started (proxy=${proxyPid || 'missing'}, claude=${claudePid || 'missing'})`);

    if (launched) launcher.kill('SIGTERM');
    const exited = launched && await waitUntil(() => exitResult !== null, 3000);
    assert(exited, `launcher exits promptly after SIGTERM (stderr: ${JSON.stringify(stderr.slice(-200))})`);
    assert(exitResult?.code === 143 && exitResult?.signal === null,
      `launcher maps SIGTERM to exit 143 (code=${exitResult?.code ?? 'none'}, signal=${exitResult?.signal ?? 'none'})`);

    const proxyGone = await waitForPidGone(proxyPid);
    const claudeGone = await waitForPidGone(claudePid);
    assert(proxyGone, `launcher reaped proxy pid ${proxyPid || 'missing'}`);
    assert(readText(fixture.claudeEventsFile).includes('ignored:SIGTERM'),
      'Claude fixture proved that graceful TERM was ignored');
    assert(claudeGone, `launcher escalated and reaped Claude pid ${claudePid || 'missing'}`);

    const configDir = readText(fixture.claudeConfigDirFile);
    assert(configDir.length > 0 && !fs.existsSync(configDir), 'SIGTERM removed the ephemeral session directory');
    const artifacts = lifecycleArtifacts(fixture.root);
    assert(artifacts.length === 0, `SIGTERM leaves no readiness FIFO/session/startup-log artifacts (${artifacts.join(', ') || 'none'})`);
    void stdout;
  } finally {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
      try { launcher.kill('SIGKILL'); } catch {}
    }
    removeFixture(fixture);
  }
}

async function main() {
  console.log('c-thru proxy lifecycle tests\n');
  await testChildExitAndCleanup();
  await testReadinessFailure('ready_failed', /claude-proxy failed to bind: EADDRINUSE lifecycle-test/);
  await testReadinessFailure('malformed', /malformed claude-proxy readiness line 'NOT_READY lifecycle-test'/);
  await testSigtermCleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
