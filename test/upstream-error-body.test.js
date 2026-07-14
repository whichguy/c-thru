#!/usr/bin/env node
'use strict';
// Unit tests for tools/upstream-error-body.js — decode / extract / sanitize
// of upstream error payloads so the Claude TUI never receives gzip mojibake.
//
// Run: node test/upstream-error-body.test.js

const zlib = require('zlib');
const { Readable } = require('stream');
const {
  collectStreamBody,
  decodeUpstreamText,
  extractErrorMessage,
  sanitizeErrorMessage,
  formatUpstreamErrorMessage,
  nonTextErrorFallback,
  DEFAULT_COLLECT_MAX_BYTES,
} = require('../tools/upstream-error-body.js');
const { assert, assertEq, summary } = require('./helpers');

console.log('upstream-error-body unit tests\n');

async function runCollectStreamBodyTests() {
  // ── collectStreamBody bounds (error-path forensics must not hang/OOM) ────
  console.log('collectStreamBody: full small body');
  {
    const s = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const r = await collectStreamBody(s, { maxBytes: 1024, timeoutMs: 2000 });
    assertEq(r.buffer.toString('utf8'), 'hello world', 'concatenates chunks');
    assertEq(r.truncated, false, 'not truncated');
    assertEq(r.timedOut, false, 'not timed out');
  }

  console.log('collectStreamBody: maxBytes truncates and settles');
  {
    const s = new Readable({
      read() {
        this.push(Buffer.alloc(600, 0x61)); // 'a' * 600
        this.push(Buffer.alloc(600, 0x62)); // would exceed 800
        this.push(null);
      },
    });
    const r = await collectStreamBody(s, { maxBytes: 800, timeoutMs: 2000 });
    assertEq(r.buffer.length, 800, 'stops at maxBytes (got ' + r.buffer.length + ')');
    assertEq(r.truncated, true, 'truncated flag set');
    assertEq(r.timedOut, false, 'not timed out on size cap');
  }

  console.log('collectStreamBody: timeoutMs resolves with what we have');
  {
    const s = new Readable({ read() { /* hang after first push */ } });
    s.push(Buffer.from('partial'));
    const r = await collectStreamBody(s, { maxBytes: 1024, timeoutMs: 50 });
    assertEq(r.buffer.toString('utf8'), 'partial', 'keeps partial bytes on timeout');
    assertEq(r.timedOut, true, 'timedOut flag set');
    assert(DEFAULT_COLLECT_MAX_BYTES >= 1024 * 1024, 'default collect cap is ≥ 1 MiB');
  }
}

// ── decodeUpstreamText ─────────────────────────────────────────────────────

{
  const json = '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}';
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
  const out = decodeUpstreamText(gz, 'gzip');
  assertEq(out, json, 'gzip body decompresses to original JSON');
}

{
  const json = '{"error":{"message":"deflated"}}';
  const deflated = zlib.deflateSync(Buffer.from(json, 'utf8'));
  const out = decodeUpstreamText(deflated, 'deflate');
  assertEq(out, json, 'deflate body decompresses');
}

{
  const json = '{"error":{"message":"brotli ok"}}';
  const br = zlib.brotliCompressSync(Buffer.from(json, 'utf8'));
  const out = decodeUpstreamText(br, 'br');
  assertEq(out, json, 'brotli body decompresses');
}

{
  const plain = 'already plain text';
  assertEq(decodeUpstreamText(Buffer.from(plain), undefined), plain, 'identity encoding is UTF-8');
  assertEq(decodeUpstreamText(Buffer.from(plain), 'identity'), plain, 'explicit identity encoding');
}

{
  // Corrupt gzip → fallback to raw UTF-8 (may be mojibake, but must not throw)
  let threw = false;
  let out = '';
  try {
    out = decodeUpstreamText(Buffer.from([0x1f, 0x8b, 0x00, 0xff]), 'gzip');
  } catch {
    threw = true;
  }
  assert(!threw, 'corrupt gzip does not throw');
  assert(typeof out === 'string', 'corrupt gzip still returns a string');
}

// ── extractErrorMessage ────────────────────────────────────────────────────

{
  const anthropic = JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'You have hit your rate limit' },
  });
  assertEq(
    extractErrorMessage(anthropic),
    'You have hit your rate limit',
    'extracts Anthropic error.message'
  );
}

{
  const gemini = JSON.stringify({
    error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' },
  });
  assertEq(
    extractErrorMessage(gemini),
    'RESOURCE_EXHAUSTED: Quota exceeded',
    'extracts Gemini status + message'
  );
}

{
  assertEq(extractErrorMessage('{"error":"model not found"}'), 'model not found', 'extracts Ollama string error');
  assertEq(extractErrorMessage('not json at all'), null, 'non-JSON returns null');
  assertEq(extractErrorMessage(''), null, 'empty returns null');
}

// ── sanitizeErrorMessage ───────────────────────────────────────────────────

{
  const dirty = 'Rate limit\x00\x01\x02 hit\x1f with controls';
  assertEq(
    sanitizeErrorMessage(dirty),
    'Rate limit hit with controls',
    'strips C0 controls'
  );
}

{
  const long = 'x'.repeat(500);
  const s = sanitizeErrorMessage(long, { cap: 50 });
  assert(s.length <= 51, 'caps length (got ' + s.length + ')'); // 50 + ellipsis
  assert(s.endsWith('…'), 'adds ellipsis when capped');
}

{
  assertEq(sanitizeErrorMessage('\x00\x01\x02'), '', 'all-control string becomes empty');
  assertEq(sanitizeErrorMessage(null), '', 'null becomes empty');
}

// ── formatUpstreamErrorMessage (full pipeline) ─────────────────────────────

{
  const payload = JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Rate limited — try again later' },
  });
  const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'));
  const { decoded, message } = formatUpstreamErrorMessage(gz, {
    contentEncoding: 'gzip',
    statusCode: 429,
  });
  assert(decoded.includes('rate_limit_error'), 'decoded still has JSON for type mapping');
  assertEq(message, 'Rate limited — try again later', 'gzip 429 → clean extracted message');
  assert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(message), 'message has no C0 controls');
}

{
  // Binary non-JSON body (random high bytes) with identity encoding
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x81, 0x82]);
  const { message } = formatUpstreamErrorMessage(binary, {
    contentEncoding: undefined,
    statusCode: 429,
  });
  assert(
    /upstream returned 429 \(non-text body/.test(message) || message.length > 0,
    'binary body yields fallback or sanitized text (got ' + JSON.stringify(message) + ')'
  );
  assert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(message), 'binary-derived message has no C0 controls');
}

{
  // Gzip of non-JSON binary-looking text still sanitizes
  const gz = zlib.gzipSync(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  const { message } = formatUpstreamErrorMessage(gz, {
    contentEncoding: 'gzip',
    statusCode: 502,
  });
  assert(typeof message === 'string' && message.length > 0, 'gzip binary → non-empty message');
  assert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(message), 'gzip binary message has no C0 controls');
}

{
  const fb = nonTextErrorFallback(429, Buffer.alloc(17), 'gzip');
  assertEq(fb, 'upstream returned 429 (non-text body, 17 bytes, encoding=gzip)', 'fallback format');
}

runCollectStreamBodyTests()
  .then(() => {
    process.exit(summary() === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
