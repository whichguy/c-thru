#!/usr/bin/env node
'use strict';

// Minimal child used to exercise helpers.js readiness and failed-startup
// cleanup without starting the real proxy or contacting a provider.
const fs = require('fs');
const http = require('http');

const port = Number(process.env.FAKE_READY_PORT || 1);
const delayMs = Number(process.env.FAKE_READY_DELAY_MS || 0);
const pidFile = process.env.FAKE_READY_PID_FILE;
const pingMarker = process.env.FAKE_READY_PING_MARKER;

if (pidFile) fs.writeFileSync(pidFile, String(process.pid));

let readyTimer;
let server = null;

function announceReady() {
  readyTimer = setTimeout(() => {
    process.stdout.write(`READY ${port}\n`);
  }, delayMs);
}

if (process.env.FAKE_READY_STALL_PING === '1') {
  server = http.createServer(() => {
    if (pingMarker && !fs.existsSync(pingMarker)) fs.writeFileSync(pingMarker, 'accepted\n');
    // Intentionally accept the request without writing headers or a body.
  });
  server.listen(port, '127.0.0.1', announceReady);
} else {
  announceReady();
}

const keepAlive = setInterval(() => {}, 1000);

function stop() {
  clearTimeout(readyTimer);
  clearInterval(keepAlive);
  if (server) server.close();
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
