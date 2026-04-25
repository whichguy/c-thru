/**
 * Test for Ollama warmup polling and retry logic.
 */
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROXY_PORT = 9991;
const STUB_PORT = 9992;
const PROXY_PATH = path.join(__dirname, '..', 'tools', 'claude-proxy');

// Mock model-map.json
const modelMap = {
  model_routes: {
    'ollama-retry-model': 'local-ollama'
  },
  backends: {
    'local-ollama': {
      kind: 'ollama',
      url: `http://localhost:${STUB_PORT}`
    }
  }
};

const modelMapPath = path.join(__dirname, 'model-map-warmup.json');
fs.writeFileSync(modelMapPath, JSON.stringify(modelMap));

let proxyProc;
let stubServer;

async function setup() {
  // 1. Start a stub "Ollama" server
  let psCallCount = 0;
  let chatCallCount = 0;

  stubServer = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'ollama-retry-model' }] }));
      return;
    }

    if (req.url === '/api/ps') {
      psCallCount++;
      // First 2 calls: model not loaded. 3rd call: model loaded.
      if (psCallCount < 3) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ name: 'ollama-retry-model' }]));
      }
      return;
    }

    if (req.url === '/api/chat' || req.url === '/v1/messages') {
      chatCallCount++;
      // First attempt: simulate connection reset/failure
      if (chatCallCount === 1) {
        req.destroy(); // Simulate connection error
        return;
      }
      
      // Second attempt (retry): succeed
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Retry successful!' }],
        model: 'ollama-retry-model',
        usage: { input_tokens: 10, output_tokens: 10 }
      }));
      return;
    }

    if (req.url === '/api/generate') {
      // Warmup call
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(r => stubServer.listen(STUB_PORT, r));

  // 2. Start the proxy
  proxyProc = spawn('node', [PROXY_PATH], {
    env: {
      ...process.env,
      CLAUDE_PROXY_PORT: PROXY_PORT,
      CLAUDE_MODEL_MAP_PATH: modelMapPath,
      CLAUDE_PROXY_ANNOTATE_MODEL: '1',
      CLAUDE_PROXY_FATAL_CALL_TIMEOUT_MS: '2000', // Short timeout for testing
      CLAUDE_PROFILE_DIR: path.join(__dirname, '.claude-test-profile'),
    }
  });

  if (!fs.existsSync(path.join(__dirname, '.claude-test-profile'))) {
    fs.mkdirSync(path.join(__dirname, '.claude-test-profile'));
  }

  proxyProc.stderr.on('data', d => console.error(`[proxy] ${d}`));
  
  // Wait for proxy to start
  await new Promise(r => setTimeout(r, 1000));
}

async function teardown() {
  if (proxyProc) proxyProc.kill();
  if (stubServer) stubServer.close();
  if (fs.existsSync(modelMapPath)) fs.unlinkSync(modelMapPath);
}

async function runTest() {
  console.log('Ollama Warmup Retry Test');

  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${PROXY_PORT}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, r => {
        let buf = '';
        r.on('data', c => buf += c);
        r.on('end', () => resolve({ statusCode: r.statusCode, headers: r.headers, body: JSON.parse(buf) }));
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'ollama-retry-model',
        messages: [{ role: 'user', content: 'hello' }]
      }));
      req.end();
    });

    assert.strictEqual(res.statusCode, 200, 'Should return 200 after retry');
    assert.strictEqual(res.body.content[0].text, 'Retry successful!', 'Should contain retry response');
    console.log('  PASS: retry logic worked');

  } catch (e) {
    console.error('  FAIL:', e.message);
    process.exit(1);
  }
}

(async () => {
  await setup();
  await runTest();
  await teardown();
  console.log('Test complete.');
})();
