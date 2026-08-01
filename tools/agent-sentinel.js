'use strict';
const crypto = require('crypto');
// Extract the c-thru per-agent routing marker from a request — the proxy side of the
// hook handshake (docs/planning/agent-delegation-findings.md).
//
// The PreToolUse hook prepends
// `[[c-thru-agent:<name>:<hmac-sha256>]]` to a delegated subagent's task prompt,
// so the marker rides in the request body; an out-of-band channel may also set
// `x-c-thru-agent` plus `x-c-thru-agent-signature`. This parser returns the
// candidate routing name and tag, or null. The name is an opaque string fed into
// resolveBackend
// (agent → capability → model, concrete tags, advisor: pins, etc.) — not limited to
// agent_to_capability keys. claude-proxy separately requires a valid shared
// agent-token HMAC, a spawned-agent correlation header, and a loopback peer.
// First-level agents carry x-claude-code-agent-id without a parent ID; nested
// agents additionally carry x-claude-code-parent-agent-id.
//
// Detection is intentionally structure-aware:
//   1. O(1) header check — non-empty trimmed string that passes
//      isValidAgentRoutingName.
//   2. Parse the request JSON and inspect only direct user-message strings and
//      user content blocks whose type is "text". Never recurse into assistant
//      tool_use input, user tool_result content, system text, or arbitrary JSON.
//      This prevents a signed marker retained in a parent transcript's Agent
//      tool input from replaying as a later main-thread routing instruction.
//
// After routing, stripAgentSentinelFromBody() recursively removes all markers
// from the structured body so upstream LLMs never see replayable routing metadata.

const SENTINEL_PREFIX = '[[c-thru-agent:';
// Current tags are full HMAC-SHA256 (64 hex). The 16-hex branch only lets the
// parser identify and strip markers written by the retired per-user-key format;
// verifyAgentSentinelTag intentionally rejects those truncated legacy tags.
const HMAC_SUFFIX_RE = /:([0-9a-fA-F]{16}|[0-9a-fA-F]{64})$/;
const SIGNED_TAG_RE = /^[0-9a-fA-F]{64}$/;
const HMAC_DOMAIN = 'c-thru-agent-v1:';
// Strip any marker regardless of interior charset (same close-at-]] grammar as parse).
const SENTINEL_GLOBAL_RE = /\[\[c-thru-agent:(?:(?!\]\]).)*\]\]\n?/g;
// Sanity cap on interior length (name + optional :hmac).
const MAX_INTERIOR_LEN = 512;
// Kept for tests that still import READ_WINDOW as the old bound concept.
const READ_WINDOW = MAX_INTERIOR_LEN;

// Routing names must look like agent ids / model tags / advisor pins — NOT source
// code or unexpanded shell. Observed poison: agents reading c-thru-agent-router-hook.sh
// put the literal `[[c-thru-agent:${lookup_key}]]` into tool_result history; lastIndexOf
// then routed the next request to model "${lookup_key}" → Ollama 400 "invalid model name".
// Allow: explore, reviewer-security, kimi-k3:cloud, advisor:org/model, thudm/glm-4-plus
const ROUTING_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}$/;

/**
 * True if `name` is a plausible agent/model routing key (not shell/source leakage).
 */
function isValidAgentRoutingName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n.length > 200) return false;
  if (!ROUTING_NAME_RE.test(n)) return false;
  // Reject common source-leak patterns even if they somehow pass the charset set.
  if (n.includes('${') || n.includes('//') || n.includes('`')) return false;
  return true;
}

function isUsableSentinelSecret(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32;
}

/**
 * Full HMAC-SHA256 tag shared by the launcher, PreToolUse hook, and proxy.
 * Domain separation prevents reuse of this tag for any other keyed operation.
 */
function computeAgentSentinelTag(name, secret) {
  const normalized = typeof name === 'string' ? name.trim() : '';
  if (!isValidAgentRoutingName(normalized) || !isUsableSentinelSecret(secret)) return null;
  return crypto.createHmac('sha256', secret)
    .update(HMAC_DOMAIN + normalized, 'utf8')
    .digest('hex');
}

function verifyAgentSentinelTag(name, tag, secret) {
  if (typeof tag !== 'string' || !SIGNED_TAG_RE.test(tag)) return false;
  const expected = computeAgentSentinelTag(name, secret);
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(tag, 'hex');
  if (expectedBytes.length !== actualBytes.length) return false;
  try { return crypto.timingSafeEqual(expectedBytes, actualBytes); } catch { return false; }
}

function formatAgentSentinel(name, secret) {
  const normalized = typeof name === 'string' ? name.trim() : '';
  const tag = computeAgentSentinelTag(normalized, secret);
  return tag ? `${SENTINEL_PREFIX}${normalized}:${tag}]]` : null;
}

/**
 * Split interior into { name, tag }.
 * If interior ends with a current 64-hex or legacy 16-hex suffix, that segment
 * is returned as the tag. Verification is deliberately separate.
 */
function splitNameAndTag(interior) {
  if (typeof interior !== 'string') return null;
  // Reject empty or control-bearing interiors (newlines would break "single marker" assumption).
  if (!interior || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(interior)) return null;
  if (interior.length > MAX_INTERIOR_LEN) return null;
  const m = interior.match(HMAC_SUFFIX_RE);
  if (m) {
    const name = interior.slice(0, -(m[1].length + 1));
    if (!name.trim()) return null;
    return { name, tag: m[1] };
  }
  return { name: interior, tag: null };
}

function parseLastSentinelFromText(text) {
  if (typeof text !== 'string') return null;
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const i = text.lastIndexOf(SENTINEL_PREFIX, searchFrom - 1);
    if (i < 0) break;
    const start = i + SENTINEL_PREFIX.length;
    const close = text.indexOf(']]', start);
    if (close < 0) {
      searchFrom = i;
      continue;
    }
    const interior = text.slice(start, close);
    const split = splitNameAndTag(interior);
    if (split && isValidAgentRoutingName(split.name)) {
      return { name: split.name, tag: split.tag, index: i, source: 'sentinel' };
    }
    searchFrom = i;
  }
  return null;
}

// parseAgentSentinel(bodyOrText, headerValue, headerTag)
//   -> { name, tag, index?, source } | null
function parseAgentSentinel(bodyOrText, headerValue, headerTag) {
  // Tier 1 — header: validated routing key. The proxy still verifies headerTag.
  if (typeof headerValue === 'string') {
    const h = headerValue.trim();
    if (h && isValidAgentRoutingName(h)) {
      const tag = typeof headerTag === 'string' ? headerTag.trim() : null;
      return { name: h, tag: tag || null, source: 'header' };
    }
  }
  // Tier 2 — only direct user prompt text is eligible. A proxy call reaches this
  // after successful JSON parsing, so malformed/non-object input fails closed.
  let parsedBody;
  if (typeof bodyOrText === 'string') {
    try { parsedBody = JSON.parse(bodyOrText); } catch { return null; }
  } else {
    parsedBody = bodyOrText;
  }
  if (!parsedBody || typeof parsedBody !== 'object' || !Array.isArray(parsedBody.messages)) {
    return null;
  }

  let latest = null;
  for (const message of parsedBody.messages) {
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      const candidate = parseLastSentinelFromText(message.content);
      if (candidate) latest = candidate;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
      const candidate = parseLastSentinelFromText(block.text);
      if (candidate) latest = candidate;
    }
  }
  return latest;
}

function stripSentinelFromString(s) {
  if (typeof s !== 'string' || s.indexOf(SENTINEL_PREFIX) < 0) return s;
  return s.replace(SENTINEL_GLOBAL_RE, '');
}

function stripSentinelDeep(value) {
  if (typeof value === 'string') return stripSentinelFromString(value);
  if (!value || typeof value !== 'object') return value;

  const makeFrame = (original, parentKey) => {
    if (Array.isArray(original)) {
      return {
        original,
        parentKey,
        index: 0,
        length: original.length,
        out: new Array(original.length),
        changed: false,
        isArray: true,
      };
    }
    // Object spread creates own data properties (including a literal
    // "__proto__" key) instead of invoking Object.prototype's legacy setter.
    return {
      original,
      parentKey,
      entries: Object.entries(original),
      index: 0,
      out: { ...original },
      changed: false,
      isArray: false,
    };
  };

  const stack = [makeFrame(value, null)];
  let result = value;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    let key;
    let item;

    if (frame.isArray) {
      while (frame.index < frame.length && !(frame.index in frame.original)) {
        frame.index++;
      }
      if (frame.index < frame.length) {
        key = frame.index++;
        item = frame.original[key];
      }
    } else if (frame.index < frame.entries.length) {
      [key, item] = frame.entries[frame.index++];
    }

    if (key !== undefined) {
      if (typeof item === 'string') {
        const next = stripSentinelFromString(item);
        if (next !== item) frame.changed = true;
        frame.out[key] = next;
      } else if (item && typeof item === 'object') {
        stack.push(makeFrame(item, key));
      } else {
        frame.out[key] = item;
      }
      continue;
    }

    const next = frame.changed ? frame.out : frame.original;
    stack.pop();
    if (stack.length === 0) {
      result = next;
      continue;
    }
    const parent = stack[stack.length - 1];
    if (next !== frame.original) parent.changed = true;
    parent.out[frame.parentKey] = next;
  }

  return result;
}

function stripSentinelFromContent(content) {
  return stripSentinelDeep(content);
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
  stripSentinelDeep,
  splitNameAndTag,
  isValidAgentRoutingName,
  SENTINEL_PREFIX,
  SENTINEL_GLOBAL_RE,
  HMAC_SUFFIX_RE,
  SIGNED_TAG_RE,
  HMAC_DOMAIN,
  READ_WINDOW,
  MAX_INTERIOR_LEN,
  isUsableSentinelSecret,
  computeAgentSentinelTag,
  verifyAgentSentinelTag,
  formatAgentSentinel,
};
