#!/usr/bin/env node
'use strict';
// When api.x.ai (or any anthropic-forward backend) returns 400, the proxy must
// log anthropic.upstream.error with a safe message + body_preview so production
// forensics are not limited to statusCode alone (see proxy.log 2026-07-13/14).
//
// Run: node test/proxy-xai-upstream-error-log.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'tools', 'claude-proxy');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { console.error('  FAIL ' + msg); failed++; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function main() {
  console.log('proxy-xai-upstream-error-log\n');

  const stubPort = await freePort();
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'xAI test rejection: Invalid message role for diagnostic fixture',
        },
      }));
    });
  });
  await new Promise(r => stub.listen(stubPort, '127.0.0.1', r));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-xai-errlog-'));
  const cfgPath = path.join(tmpDir, 'model-map.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    endpoints: {
      xai: {
        url: `http://127.0.0.1:${stubPort}`,
        format: 'anthropic',
        auth: { header: 'Authorization', scheme: 'Bearer', env: 'XAI_API_KEY' },
      },
    },
    model_routes: { grok: { endpoint: 'xai', name: 'grok-4.5' }, 'grok-4.5': 'xai' },
    agent_to_capability: { grok: 'model:grok-4.5' },
    llm_profiles: {},
    llm_mode: 'best-cloud',
  }));

  const proxyPort = await freePort();
  const logPath = path.join(tmpDir, 'proxy.log');
  const child = spawn(process.execPath, [PROXY, '--port', String(proxyPort), '--config', cfgPath], {
    env: {
      ...process.env,
      XAI_API_KEY: 'xai-test-key',
      CLAUDE_PROXY_LOG_FILE: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stderr.on('data', d => { boot += d.toString(); });
  child.stdout.on('data', d => { boot += d.toString(); });

  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http.get(`http://127.0.0.1:${proxyPort}/ping`, res => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - t0 > 8000) reject(new Error('proxy start fail\n' + boot));
          else setTimeout(tick, 50);
        });
    };
    tick();
  });

  try {
    const payload = JSON.stringify({
      model: 'grok',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        name: 'noop',
        description: 'n',
        input_schema: { type: 'object', properties: {} },
      }],
    });
    const resp = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-api-key': 'sk-ant-fake',
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    ok(resp.status === 400, 'client still sees 400 (got ' + resp.status + ')');
    ok(/Invalid message role|xAI test rejection/i.test(resp.body),
      'client body still carries upstream error text');

    // Give the async collectStreamBody log a moment to flush.
    await new Promise(r => setTimeout(r, 120));
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

    ok(/anthropic\.upstream\.error/.test(log),
      'logs anthropic.upstream.error event');
    ok(/xAI test rejection|Invalid message role/i.test(log),
      'error log includes safe upstream message');
    ok(/"tools_in"\s*:\s*1/.test(log) || /"tools_in":1/.test(log),
      'error log includes tools_in forensics');
    ok(/"xai"\s*:\s*true/.test(log) || /"xai":true/.test(log),
      'error log marks xai backend');
    ok(/"statusCode"\s*:\s*400/.test(log) || /"statusCode":400/.test(log),
      'error log includes statusCode 400');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => stub.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(failed ? `\nFAILED (${failed})` : '\nAll proxy-xai-upstream-error-log tests passed');
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
