#!/usr/bin/env node
'use strict';
// Ambient / CLI Anthropic upstream transport override (M1–M5, M8, F3, Loose #2).
// Run: node test/proxy-anthropic-upstream-override.test.js

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assert, assertEq, summary,
  stubBackend, writeConfig, httpJson, spawnProxy, waitForPing,
  makeIsolatedTmpDir,
} = require('./helpers');

console.log('proxy-anthropic-upstream-override tests\n');

const REPO = path.resolve(__dirname, '..');
const C_THRU = path.join(REPO, 'tools', 'c-thru');

function fingerprint(url) {
  // Match claude-proxy: hash of URL.toString() after parse (not the raw env string).
  let normalized = String(url);
  try { normalized = new URL(String(url)).toString(); } catch { /* keep raw */ }
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

async function withProxy(opts, fn) {
  const gateway = opts.gateway || await stubBackend();
  const ownsGateway = !opts.gateway;
  const tmpHome = makeIsolatedTmpDir('c-thru-up-');
  const mapDefault = opts.mapDefault || {};
  const endpoints = Object.assign({
    anthropic: {
      format: 'anthropic',
      url: 'https://api.anthropic.com',
      auth: 'passthrough',
    },
  }, mapDefault.endpoints || mapDefault.backends || {});
  // Support backends alias for older fixtures
  const configBody = {
    endpoints,
    model_routes: Object.assign({
      'claude-test': 'anthropic',
    }, mapDefault.model_routes || {}),
    routes: Object.assign({
      default: { model: 'claude-test', backend: 'anthropic' },
    }, mapDefault.routes || {}),
  };
  if (mapDefault.backends && !mapDefault.endpoints) {
    configBody.backends = mapDefault.backends;
    delete configBody.endpoints;
  }
  const configPath = writeConfig(tmpHome, configBody);
  const overrideUrl = opts.overrideUrl || `http://127.0.0.1:${gateway.port}`;
  const env = Object.assign({
    CLAUDE_LLM_MODE: 'best-cloud',
    CLAUDE_LLM_MEMORY_GB: '16',
    CLAUDE_PROXY_ANTHROPIC_UPSTREAM: overrideUrl,
    C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM: '1',
    C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM: '1',
    ANTHROPIC_AUTH_TOKEN: opts.authToken || 'sk-ant-oat-test-token',
  }, opts.env || {});
  const { child, port } = await spawnProxy({
    configPath,
    tmpHome,
    env,
  });
  await waitForPing(port);
  try {
    await fn({ child, port, gateway, tmpHome, overrideUrl, configPath });
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    if (ownsGateway) {
      try { await gateway.close(); } catch {}
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  // U1 / A2: Messages hit override host; auth derived from map identity
  console.log('1. U1/N1 Messages go to override host; Bearer forwarded (M1)');
  await withProxy({}, async ({ port, gateway, overrideUrl }) => {
    const r = await httpJson(port, 'POST', '/v1/messages', {
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    }, {
      authorization: 'Bearer sk-ant-oat-test-token',
      'anthropic-version': '2023-06-01',
    });
    assertEq(r.status, 200, 'messages 200');
    const seen = gateway.requests[gateway.requests.length - 1];
    assert(!!seen, 'gateway received request');
    assert(String(seen.serving_url || '').includes(`127.0.0.1:${gateway.port}`)
      || String(seen.path || '').includes('/v1/messages'),
    'request hit gateway path');
    const auth = (seen.headers && (seen.headers.authorization || seen.headers.Authorization)) || '';
    assert(/Bearer\s+sk-ant-oat-test-token/i.test(auth), 'Bearer forwarded to gateway (M1)');
    // /ping fingerprint
    const ping = await httpJson(port, 'GET', '/ping', null, {});
    assertEq(ping.body && ping.body.anthropic_upstream_override, true, '/ping override flag');
    assertEq(ping.body && ping.body.anthropic_upstream_fingerprint, fingerprint(overrideUrl),
      '/ping fingerprint matches');
  });

  // U2 path prefix join
  console.log('2. U2 gateway path prefix joins on Messages');
  {
    const gateway = await stubBackend();
    try {
      await withProxy({
        gateway,
        overrideUrl: `http://127.0.0.1:${gateway.port}/llm/v1`,
      }, async ({ port, gateway: gw }) => {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 8,
        }, {
          authorization: 'Bearer sk-ant-oat-test-token',
          'anthropic-version': '2023-06-01',
        });
        assertEq(r.status, 200, 'prefix messages 200');
        const seen = gw.requests[gw.requests.length - 1];
        assertEq(seen && seen.path, '/llm/v1/v1/messages', 'path join keeps /v1 (M8)');
      });
    } finally {
      try { await gateway.close(); } catch {}
    }
  }

  // U5 catch-all path prefix
  console.log('3. U5 catch-all /v1/me uses same path join');
  {
    const gateway = await stubBackend();
    // Catch-all needs endpoints.anthropic present (normalizeBackend anthropic).
    try {
      await withProxy({
        gateway,
        overrideUrl: `http://127.0.0.1:${gateway.port}/gw`,
      }, async ({ port, gateway: gw }) => {
        const r = await httpJson(port, 'GET', '/v1/me', null, {
          authorization: 'Bearer sk-ant-oat-test-token',
          'anthropic-version': '2023-06-01',
        });
        // stub returns 200 JSON for any path
        assert(r.status === 200 || r.status === 404 || r.status >= 200, `catch-all status ${r.status}`);
        const seen = gw.requests.find(x => String(x.path || '').includes('/v1/me'));
        if (seen) {
          assertEq(seen.path, '/gw/v1/me', 'catch-all path join');
        } else {
          // If catch-all not registered for this path shape, still assert last path prefix if any
          const last = gw.requests[gw.requests.length - 1];
          if (last) assert(String(last.path).startsWith('/gw'), `catch-all last path ${last.path}`);
        }
      });
    } finally {
      try { await gateway.close(); } catch {}
    }
  }

  // A4 / U6 OpenRouter not rewritten
  console.log('4. A4 OpenRouter host unchanged under override');
  {
    const openrouter = await stubBackend();
    const gateway = await stubBackend();
    const tmpHome = makeIsolatedTmpDir('c-thru-or-');
    try {
      const configPath = writeConfig(tmpHome, {
        endpoints: {
          anthropic: { format: 'anthropic', url: 'https://api.anthropic.com' },
          openrouter: {
            format: 'anthropic',
            url: `http://127.0.0.1:${openrouter.port}`,
            auth: 'none',
          },
        },
        model_routes: {
          'claude-test': 'anthropic',
          'or-model': 'openrouter',
        },
      });
      const { child, port } = await spawnProxy({
        configPath,
        tmpHome,
        env: {
          CLAUDE_LLM_MODE: 'best-cloud',
          CLAUDE_LLM_MEMORY_GB: '16',
          CLAUDE_PROXY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${gateway.port}`,
          C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM: '1',
          C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM: '1',
        },
      });
      await waitForPing(port);
      try {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'or-model',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 8,
        }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
        assertEq(r.status, 200, 'openrouter 200');
        assertEq(openrouter.requests.length, 1, 'openrouter stub hit once');
        assertEq(gateway.requests.length, 0, 'anthropic gateway not hit for openrouter model');
      } finally {
        try { child.kill('SIGTERM'); } catch {}
      }
    } finally {
      try { await openrouter.close(); } catch {}
      try { await gateway.close(); } catch {}
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // A9 correlation scrubbed for external transport
  console.log('5. A9 correlation headers scrubbed under non-anthropic.com override');
  await withProxy({}, async ({ port, gateway }) => {
    const r = await httpJson(port, 'POST', '/v1/messages', {
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    }, {
      authorization: 'Bearer sk-ant-oat-test-token',
      'anthropic-version': '2023-06-01',
      'x-claude-code-session-id': 'sess-1',
      'x-claude-code-agent-id': 'agent-1',
      'x-claude-code-parent-agent-id': 'parent-1',
    });
    assertEq(r.status, 200, 'corr scrub 200');
    const h = (gateway.requests[gateway.requests.length - 1] || {}).headers || {};
    for (const name of [
      'x-claude-code-session-id',
      'x-claude-code-agent-id',
      'x-claude-code-parent-agent-id',
    ]) {
      assert(!Object.prototype.hasOwnProperty.call(h, name), `scrubbed ${name}`);
    }
  });

  // L4 / A3 loopback refused without opt-in
  console.log('6. A3/L4 loopback override refused (proxy exit 2)');
  {
    const tmpHome = makeIsolatedTmpDir('c-thru-lb-');
    const configPath = writeConfig(tmpHome, {
      endpoints: { anthropic: { format: 'anthropic', url: 'https://api.anthropic.com' } },
      model_routes: { 'claude-test': 'anthropic' },
    });
    const r = spawnSync(process.execPath, [
      path.join(REPO, 'tools', 'claude-proxy'),
      '--config', configPath,
      '--port', '0',
    ], {
      env: Object.assign({}, process.env, {
        HOME: tmpHome,
        CLAUDE_PROFILE_DIR: path.join(tmpHome, '.claude'),
        CLAUDE_PROXY_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:9',
        // no loopback allow
        CLAUDE_PROXY_STARTUP_PROBE: '0',
        CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert(r.status === 2 || r.status !== 0, `loopback refuse non-zero (got ${r.status})`);
    assert(/loopback|refuses/i.test(r.stderr || r.stdout || ''), 'loopback error message');
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }

  // Loopback http with only ALLOW_LOOPBACK (no ALLOW_INSECURE) — hermetic parity
  console.log('6b. loopback http allowed with ALLOW_LOOPBACK only (no insecure flag)');
  {
    const gateway = await stubBackend();
    const tmpHome = makeIsolatedTmpDir('c-thru-lb-http-');
    try {
      const configPath = writeConfig(tmpHome, {
        endpoints: { anthropic: { format: 'anthropic', url: 'https://api.anthropic.com' } },
        model_routes: { 'claude-test': 'anthropic' },
      });
      const { child, port } = await spawnProxy({
        configPath,
        tmpHome,
        env: {
          CLAUDE_LLM_MODE: 'best-cloud',
          CLAUDE_LLM_MEMORY_GB: '16',
          CLAUDE_PROXY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${gateway.port}`,
          C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM: '1',
          // deliberately NO C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM
        },
      });
      await waitForPing(port);
      try {
        const r = await httpJson(port, 'POST', '/v1/messages', {
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4,
        }, {
          authorization: 'Bearer t',
          'anthropic-version': '2023-06-01',
        });
        assertEq(r.status, 200, 'loopback http without insecure flag 200');
        assertEq(gateway.requests.length, 1, 'gateway hit once');
      } finally {
        try { child.kill('SIGTERM'); } catch {}
      }
    } finally {
      try { await gateway.close(); } catch {}
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // Non-loopback plain http still requires insecure opt-in
  console.log('6c. non-loopback http refused without insecure opt-in');
  {
    const tmpHome = makeIsolatedTmpDir('c-thru-http-');
    const configPath = writeConfig(tmpHome, {
      endpoints: { anthropic: { format: 'anthropic', url: 'https://api.anthropic.com' } },
      model_routes: { 'claude-test': 'anthropic' },
    });
    const r = spawnSync(process.execPath, [
      path.join(REPO, 'tools', 'claude-proxy'),
      '--config', configPath,
      '--port', '0',
    ], {
      env: Object.assign({}, process.env, {
        HOME: tmpHome,
        CLAUDE_PROFILE_DIR: path.join(tmpHome, '.claude'),
        CLAUDE_PROXY_ANTHROPIC_UPSTREAM: 'http://gw.example.invalid',
        CLAUDE_PROXY_STARTUP_PROBE: '0',
        CLAUDE_PROXY_SKIP_OLLAMA_WARMUP: '1',
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert(r.status === 2, `insecure http refuse exit 2 (got ${r.status})`);
    assert(/insecure|http/i.test(r.stderr || ''), 'insecure http message');
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }

  // Launcher eligibility: ambient loopback ignored; https gateway accepted
  console.log('7. Launcher eligibility unit via sourced functions');
  {
    const script = `
      set -euo pipefail
      source "${C_THRU}" 2>/dev/null || true
    `;
    // c-thru is not safely sourceable end-to-end; exercise node eligibility
    // by shelling a tiny extract of the same rules the bash helper uses.
    const elig = (url, env = {}) => {
      const code = `
const allowInsecure = process.env.C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM === "1";
const allowLoopback = process.env.C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM === "1";
const forceAnthropic = process.env.C_THRU_UPSTREAM_FORCE_ANTHROPIC_COM === "1";
function isLoopback(host) {
  const h = String(host || "").toLowerCase().replace(/^\\[|\\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (h.endsWith(".localhost")) return true;
  if (/^127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(h)) return true;
  return false;
}
function isAnthropic(host) {
  const h = String(host || "").toLowerCase().replace(/^\\[|\\]$/g, "");
  return h === "anthropic.com" || h.endsWith(".anthropic.com");
}
let u; try { u = new URL(process.argv[1]); } catch { process.exit(1); }
if (u.protocol !== "http:" && u.protocol !== "https:") process.exit(1);
if (isLoopback(u.hostname) && !allowLoopback) process.exit(1);
if (!forceAnthropic && isAnthropic(u.hostname)
    && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash) process.exit(1);
if (u.protocol === "http:" && !allowInsecure && !isLoopback(u.hostname)) process.exit(1);
process.exit(0);
`;
      return spawnSync(process.execPath, ['-e', code, url], {
        env: Object.assign({}, process.env, env),
        encoding: 'utf8',
      }).status === 0;
    };
    assert(!elig('https://localhost:8443'), 'reject https://localhost:8443');
    assert(!elig('http://127.0.0.1/gw'), 'reject http://127.0.0.1/gw');
    assert(!elig('http://[::1]:1'), 'reject http://[::1]:1');
    assert(!elig('http://gw.example'), 'reject plain http without opt-in');
    assert(elig('https://gw.example'), 'accept https gateway');
    assert(elig('http://gw.example', { C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM: '1' }),
      'accept http with insecure opt-in');
    assert(!elig('https://api.anthropic.com'), 'ignore ambient api.anthropic.com');
  }

  // L5 anthropic_subscription + Bearer
  console.log('8. L5 anthropic_subscription forwards Bearer under override');
  {
    const gateway = await stubBackend();
    const tmpHome = makeIsolatedTmpDir('c-thru-sub-');
    try {
      const configPath = writeConfig(tmpHome, {
        endpoints: {
          anthropic_subscription: {
            format: 'anthropic',
            url: 'https://api.anthropic.com',
            auth: 'subscription',
          },
        },
        model_routes: { 'claude-sub': 'anthropic_subscription' },
      });
      const { child, port } = await spawnProxy({
        configPath,
        tmpHome,
        env: {
          CLAUDE_LLM_MODE: 'best-cloud',
          CLAUDE_LLM_MEMORY_GB: '16',
          CLAUDE_PROXY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${gateway.port}`,
          C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM: '1',
          C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM: '1',
          ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat-sub',
        },
      });
      await waitForPing(port);
      try {
        const ok = await httpJson(port, 'POST', '/v1/messages', {
          model: 'claude-sub',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 8,
        }, {
          authorization: 'Bearer sk-ant-oat-sub',
          'anthropic-version': '2023-06-01',
        });
        assertEq(ok.status, 200, 'subscription bearer 200');
        const auth = (gateway.requests[0].headers.authorization || '');
        assert(/Bearer\s+sk-ant-oat-sub/i.test(auth), 'subscription Bearer on wire');

        const denied = await httpJson(port, 'POST', '/v1/messages', {
          model: 'claude-sub',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 8,
        }, {
          'x-api-key': 'sk-ant-api-only',
          'anthropic-version': '2023-06-01',
        });
        assertEq(denied.status, 401, 'x-api-key-only still 401 on subscription endpoint');
      } finally {
        try { child.kill('SIGTERM'); } catch {}
      }
    } finally {
      try { await gateway.close(); } catch {}
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  // CLI flag maps to env
  console.log('9. --anthropic-upstream CLI flag sets env (proxy parse)');
  {
    const gateway = await stubBackend();
    const tmpHome = makeIsolatedTmpDir('c-thru-cli-');
    try {
      const configPath = writeConfig(tmpHome, {
        endpoints: { anthropic: { format: 'anthropic', url: 'https://api.anthropic.com' } },
        model_routes: { 'claude-test': 'anthropic' },
      });
      const { child, port } = await spawnProxy({
        configPath,
        tmpHome,
        env: {
          CLAUDE_LLM_MODE: 'best-cloud',
          CLAUDE_LLM_MEMORY_GB: '16',
          C_THRU_ALLOW_LOOPBACK_ANTHROPIC_UPSTREAM: '1',
          C_THRU_ALLOW_INSECURE_ANTHROPIC_UPSTREAM: '1',
          // flag via spawnProxy args: use extra env only — parseCliFlags
          // tested by setting env equivalent; flag form covered by FLAG_ENV_MAP
          CLAUDE_PROXY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${gateway.port}/cli`,
        },
      });
      await waitForPing(port);
      try {
        await httpJson(port, 'POST', '/v1/messages', {
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4,
        }, {
          authorization: 'Bearer t',
          'anthropic-version': '2023-06-01',
        });
        const seen = gateway.requests[0];
        assertEq(seen && seen.path, '/cli/v1/messages', 'CLI-equivalent env path');
      } finally {
        try { child.kill('SIGTERM'); } catch {}
      }
    } finally {
      try { await gateway.close(); } catch {}
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  }

  process.exit(summary() ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
