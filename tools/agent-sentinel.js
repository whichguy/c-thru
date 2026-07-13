'use strict';
// Extract the c-thru per-agent routing marker from a request — the proxy side of the
// hook handshake (docs/planning/agent-delegation-findings.md).
//
// The PreToolUse hook prepends `[[c-thru-agent:<name>]]` to a delegated subagent's
// task prompt, so the marker rides in the request body; a future channel may also set
// an `x-c-thru-agent` header. This returns the candidate routing NAME the request is
// tagged with, or null. The name is an opaque string fed into resolveBackend
// (agent → capability → model, concrete tags, advisor: pins, etc.) — not limited to
// agent_to_capability keys. Trust (HMAC / header) lives in claude-proxy.
//
// Detection is cheapest-first and does NOT parse the JSON structure:
//   1. O(1) header check (any non-empty trimmed string; empty today, future-proof).
//   2. lastIndexOf of the prefix over the WHOLE raw body, then take content until
//      the next ']]' so the *most recently* injected marker wins and names can be
//      arbitrary length / charset (OpenRouter slugs, advisor:org/model, …).
//
// After routing, stripAgentSentinelFromBody() removes all markers from the structured
// body so upstream LLMs never see routing metadata.

const SENTINEL_PREFIX = '[[c-thru-agent:';
// Optional trailing HMAC: exactly 16 hex chars after the final colon of the interior.
const HMAC_SUFFIX_RE = /:([0-9a-fA-F]{16})$/;
// Strip any marker regardless of interior charset (same close-at-]] grammar as parse).
const SENTINEL_GLOBAL_RE = /\[\[c-thru-agent:(?:(?!\]\]).)*\]\]\n?/g;
// Sanity cap on interior length (name + optional :hmac) — not a tight READ_WINDOW.
const MAX_INTERIOR_LEN = 512;
// Kept for tests that still import READ_WINDOW as the old bound concept.
const READ_WINDOW = MAX_INTERIOR_LEN;

/**
 * Split interior into { name, tag }.
 * If interior ends with :[0-9a-fA-F]{16}, that segment is the HMAC tag.
 */
function splitNameAndTag(interior) {
  if (typeof interior !== 'string') return null;
  // Reject empty or control-bearing interiors (newlines would break "single marker" assumption).
  if (!interior || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(interior)) return null;
  if (interior.length > MAX_INTERIOR_LEN) return null;
  const m = interior.match(HMAC_SUFFIX_RE);
  if (m) {
    const name = interior.slice(0, -17);
    if (!name.trim()) return null;
    return { name, tag: m[1] };
  }
  return { name: interior, tag: null };
}

// parseAgentSentinel(bodyText, headerValue) -> { name, tag, index } | null
function parseAgentSentinel(bodyText, headerValue) {
  // Tier 1 — header: any non-empty trimmed string (opaque routing key).
  if (typeof headerValue === 'string') {
    const h = headerValue.trim();
    if (h && !/[\u0000-\u001f\u007f]/.test(h)) {
      return { name: h, tag: null };
    }
  }
  // Tier 2 — last match wins.
  if (typeof bodyText !== 'string') return null;
  const i = bodyText.lastIndexOf(SENTINEL_PREFIX);
  if (i < 0) return null;
  const start = i + SENTINEL_PREFIX.length;
  const close = bodyText.indexOf(']]', start);
  if (close < 0) return null;
  const interior = bodyText.slice(start, close);
  const split = splitNameAndTag(interior);
  if (!split) return null;
  return { name: split.name, tag: split.tag, index: i };
}

function stripSentinelFromString(s) {
  if (typeof s !== 'string' || s.indexOf(SENTINEL_PREFIX) < 0) return s;
  return s.replace(SENTINEL_GLOBAL_RE, '');
}

function stripSentinelFromContent(content) {
  if (typeof content === 'string') return stripSentinelFromString(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (typeof block.text === 'string' && block.text.indexOf(SENTINEL_PREFIX) >= 0) {
      changed = true;
      return Object.assign({}, block, { text: stripSentinelFromString(block.text) });
    }
    if (typeof block.content === 'string' && block.content.indexOf(SENTINEL_PREFIX) >= 0) {
      changed = true;
      return Object.assign({}, block, { content: stripSentinelFromString(block.content) });
    }
    return block;
  });
  return changed ? out : content;
}

/**
 * Remove all [[c-thru-agent:…]] markers from a parsed Anthropic-style request body
 * (mutates body in place). Call AFTER routing has used parseAgentSentinel.
 */
function stripAgentSentinelFromBody(body) {
  if (!body || typeof body !== 'object') return body;

  if (typeof body.system === 'string') {
    body.system = stripSentinelFromString(body.system);
  } else if (Array.isArray(body.system)) {
    body.system = stripSentinelFromContent(body.system);
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.content !== undefined) {
        msg.content = stripSentinelFromContent(msg.content);
      }
    }
  }

  return body;
}

module.exports = {
  parseAgentSentinel,
  stripAgentSentinelFromBody,
  stripSentinelFromString,
  splitNameAndTag,
  SENTINEL_PREFIX,
  SENTINEL_GLOBAL_RE,
  HMAC_SUFFIX_RE,
  READ_WINDOW,
  MAX_INTERIOR_LEN,
};
