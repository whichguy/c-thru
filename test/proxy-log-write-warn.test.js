#!/usr/bin/env node
'use strict';
// Smoke: when CLAUDE_PROXY_LOG_FILE points at an unwritable path, the proxy
// still starts and emits a one-shot stderr warning (not silent success).
// Exercises the real shipped tools/claude-proxy entrypoint.
//
// Run: node test/proxy-log-write-warn.test.js

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
  console.log('proxy-log-write-warn\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-logwarn-'));
  const badLog = path.join(tmpDir, 'not-a-file-dir');
  fs.mkdirSync(badLog); // appendFile to a directory → EISDIR
  const cfgPath = path.join(tmpDir, 'map.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    endpoints: {},
    model_routes: {},
    llm_profiles: {},
    llm_mode: 'best-cloud',
  }));

  const port = await freePort();
  let stderr = '';
  const child = spawn(process.execPath, [PROXY, '--port', String(port), '--config', cfgPath], {
    env: {
      ...process.env,
      CLAUDE_PROXY_LOG_FILE: badLog,
      CLAUDE_PROXY_SKIP_VALIDATOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });

  try {
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        http.get(`http://127.0.0.1:${port}/ping`, (res) => {
          res.resume();
          resolve();
        }).on('error', () => {
          if (Date.now() - t0 > 8000) reject(new Error('proxy start fail\n' + stderr + stdout));
          else setTimeout(tick, 50);
        });
      };
      tick();
    });

    // Trigger at least one proxyLog (unhandled or request path)
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 2 },
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write('{}');
      req.end();
    });
    await new Promise((r) => setTimeout(r, 100));

    ok(/proxy log write failed/i.test(stderr),
      'stderr warns about log write failure (got: ' + stderr.slice(0, 300).replace(/\n/g, ' ') + ')');
    ok(stderr.includes(badLog) || /EISDIR|ENOTDIR|EACCES|EISDIR/i.test(stderr),
      'warning mentions path or errno');
    // Proxy still answered (not crashed on log failure)
    const ping = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/ping`, (res) => {
        resolve(res.statusCode);
        res.resume();
      }).on('error', reject);
    });
    ok(ping === 200, 'proxy still serves /ping after log write failure');
  } finally {
    child.kill('SIGTERM');
    try { await new Promise((r) => child.on('close', r)); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(failed ? `\nFAILED (${failed})` : '\nAll proxy-log-write-warn tests passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
