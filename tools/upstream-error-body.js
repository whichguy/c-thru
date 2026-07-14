'use strict';
// Decode / sanitize upstream HTTP error bodies for user-visible proxy messages.
//
// Claude Code renders error.error.message in the TUI (and retry banners). If the
// proxy embeds raw gzip/br bytes as UTF-8, the TUI fills with mojibake and looks
// like "garbled keystrokes". This module is the single place that turns an
// upstream error payload into a safe, printable string.
//
// Stdlib-only; pure helpers (no server / no fs).

const zlib = require('zlib');

const DEFAULT_MESSAGE_CAP = 400;

/** Default cap for upstream error-body collection (forensics + client forward). */
const DEFAULT_COLLECT_MAX_BYTES = 1024 * 1024; // 1 MiB
/** Default idle/total wait for error-body collection before resolving what we have. */
const DEFAULT_COLLECT_TIMEOUT_MS = 30000;

/**
 * Collect a readable stream into a single Buffer with optional bounds.
 * Bounds matter on ≥400 paths that buffer the full body before responding —
 * an unbounded hung/huge upstream would hang the client or OOM the proxy.
 *
 * @param {NodeJS.ReadableStream} stream
 * @param {{ maxBytes?: number, timeoutMs?: number }} [opts]
 *   maxBytes — stop after this many bytes (default 1 MiB). Pass Infinity to disable.
 *   timeoutMs — resolve with what we have after this many ms (default 30s). 0 disables.
 * @returns {Promise<{ buffer: Buffer, truncated: boolean, timedOut: boolean }>}
 */
function collectStreamBody(stream, opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes != null ? o.maxBytes : DEFAULT_COLLECT_MAX_BYTES;
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : DEFAULT_COLLECT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      // Detach listeners so a late 'error' after resolve is not unhandled.
      try { stream.removeListener('data', onData); } catch {}
      try { stream.removeListener('end', onEnd); } catch {}
      try { stream.removeListener('error', onError); } catch {}
      resolve({
        buffer: Buffer.concat(chunks),
        truncated,
        timedOut,
      });
    };

    const onData = (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      if (total >= maxBytes) {
        truncated = true;
        // Stop reading further — destroy if available so the socket frees.
        try {
          if (typeof stream.destroy === 'function') stream.destroy();
          else if (typeof stream.pause === 'function') stream.pause();
        } catch {}
        finish();
        return;
      }
      const room = maxBytes - total;
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room));
        total += room;
        truncated = true;
        try {
          if (typeof stream.destroy === 'function') stream.destroy();
          else if (typeof stream.pause === 'function') stream.pause();
        } catch {}
        finish();
        return;
      }
      chunks.push(buf);
      total += buf.length;
    };

    const onEnd = () => finish();
    const onError = (err) => {
      if (settled) return;
      // If we already have bytes (e.g. destroy after truncate), finish successfully.
      if (chunks.length || truncated || timedOut) return finish();
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      reject(err);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);

    if (timeoutMs > 0) {
      // Keep timer ref'd: on a hung upstream with no further socket events, an
      // unref'd timer would let the event loop exit before we resolve, leaving
      // the client hanging forever (and unit tests would false-green via early
      // process exit). Proxy-server handles keep the process alive in production
      // either way; the ref costs nothing for a 30s error-body deadline.
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (typeof stream.destroy === 'function') stream.destroy();
          else if (typeof stream.pause === 'function') stream.pause();
        } catch {}
        finish();
      }, timeoutMs);
    }
  });
}

/**
 * Decompress (when content-encoding is set) and UTF-8 decode an upstream body.
 * On decompress failure, falls back to UTF-8 of the raw buffer.
 * @param {Buffer|string} raw
 * @param {string|string[]|undefined|null} contentEncoding
 * @returns {string}
 */
function decodeUpstreamText(raw, contentEncoding) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw == null ? '' : String(raw));
  if (buf.length === 0) return '';

  let encoding = '';
  if (Array.isArray(contentEncoding)) encoding = String(contentEncoding[0] || '');
  else if (contentEncoding != null) encoding = String(contentEncoding);
  encoding = encoding.split(',')[0].trim().toLowerCase();

  let decoded = buf;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      decoded = zlib.gunzipSync(buf);
    } else if (encoding === 'deflate') {
      // Some servers send raw deflate; others zlib-wrapped. Try both.
      try {
        decoded = zlib.inflateSync(buf);
      } catch {
        decoded = zlib.inflateRawSync(buf);
      }
    } else if (encoding === 'br') {
      decoded = zlib.brotliDecompressSync(buf);
    }
  } catch {
    decoded = buf;
  }

  return decoded.toString('utf8');
}

/**
 * Prefer structured error strings from common provider JSON shapes.
 * Returns null when nothing useful can be extracted.
 * @param {string} text
 * @returns {string|null}
 */
function extractErrorMessage(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed == null) return null;

    // Anthropic: { type, error: { type, message } }
    // Google / Gemini: { error: { message, status, code } }
    if (parsed.error && typeof parsed.error === 'object') {
      const em = typeof parsed.error.message === 'string' ? parsed.error.message.trim() : '';
      // Prefer "STATUS: message" when Google-style gRPC status is present.
      if (typeof parsed.error.status === 'string' && parsed.error.status && em) {
        return `${parsed.error.status}: ${em}`;
      }
      if (em) return em;
    }
    // Ollama / simple: { error: "..." }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Strip C0 controls (except tab/newline) and cap length for TUI safety.
 * @param {unknown} message
 * @param {{ cap?: number }} [opts]
 * @returns {string}
 */
function sanitizeErrorMessage(message, opts) {
  const cap = (opts && opts.cap) || DEFAULT_MESSAGE_CAP;
  let s = message == null ? '' : String(message);
  // Drop C0 controls except \t (0x09) and \n (0x0a). Also drop DEL and C1.
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  // Collapse runs of replacement chars from bad UTF-8
  s = s.replace(/\uFFFD+/g, '�');
  s = s.trim();
  if (!s) return '';
  if (s.length > cap) s = s.slice(0, cap) + '…';
  return s;
}

/**
 * Fallback when body is empty or non-text after decode.
 * @param {number} statusCode
 * @param {Buffer} raw
 * @param {string|undefined|null} contentEncoding
 * @returns {string}
 */
function nonTextErrorFallback(statusCode, raw, contentEncoding) {
  const n = Buffer.isBuffer(raw) ? raw.length : 0;
  let enc = contentEncoding == null ? '' : String(contentEncoding).split(',')[0].trim();
  if (!enc) enc = 'identity';
  return `upstream returned ${statusCode} (non-text body, ${n} bytes, encoding=${enc})`;
}

/**
 * Full pipeline: raw buffer + content-encoding → safe user-facing message.
 * @param {Buffer|string} raw
 * @param {object} [opts]
 * @param {string|string[]|null} [opts.contentEncoding]
 * @param {number} [opts.statusCode]
 * @param {number} [opts.cap]
 * @returns {{ decoded: string, message: string }}
 */
function formatUpstreamErrorMessage(raw, opts) {
  const o = opts || {};
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw == null ? '' : String(raw));
  const decoded = decodeUpstreamText(buf, o.contentEncoding);
  const extracted = extractErrorMessage(decoded);
  let message = sanitizeErrorMessage(extracted != null ? extracted : decoded, { cap: o.cap });
  // Pure replacement chars / empty after sanitize → treat as non-text.
  if (!message || /^[�\s.]*$/.test(message)) {
    message = nonTextErrorFallback(
      o.statusCode != null ? o.statusCode : 0,
      buf,
      o.contentEncoding
    );
  }
  return { decoded, message };
}

/**
 * True when Content-Encoding means the body is compressed (not plain UTF-8).
 * Used by response tees that parse SSE/JSON for stats — they must skip when
 * the body is still compressed (client still receives a correct pipe).
 * @param {string|string[]|undefined|null} contentEncoding
 * @returns {boolean}
 */
function isCompressedEncoding(contentEncoding) {
  let encoding = '';
  if (Array.isArray(contentEncoding)) encoding = String(contentEncoding[0] || '');
  else if (contentEncoding != null) encoding = String(contentEncoding);
  encoding = encoding.split(',')[0].trim().toLowerCase();
  if (!encoding || encoding === 'identity') return false;
  return encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'deflate' || encoding === 'br';
}

module.exports = {
  collectStreamBody,
  decodeUpstreamText,
  extractErrorMessage,
  sanitizeErrorMessage,
  nonTextErrorFallback,
  formatUpstreamErrorMessage,
  isCompressedEncoding,
  DEFAULT_MESSAGE_CAP,
  DEFAULT_COLLECT_MAX_BYTES,
  DEFAULT_COLLECT_TIMEOUT_MS,
};
