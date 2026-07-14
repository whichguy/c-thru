'use strict';
// Extract the c-thru per-agent routing marker from a request — the proxy side of the
// hook handshake (docs/planning/agent-delegation-findings.md).
//
// The PreToolUse hook prepends `[[c-thru-agent:<name>]]` to a delegated subagent's
// task prompt, so the marker rides in the request body; a future channel may also set
// an `x-c-thru-agent` header. This returns the candidate routing NAME the request is
// tagged with, or null. The name is an opaque string fed into resolveBackend
// (agent → capability → model, concrete tags, advisor: pins, etc.) — not limited to
// agent_to_capability keys. Trust is loopback-client-only in claude-proxy (no HMAC).
//
// Detection is cheapest-first and does NOT parse the JSON structure:
//   1. O(1) header check — non-empty trimmed string that passes
//      isValidAgentRoutingName (empty today; future OOB channel).
//   2. Walk body markers last→first (last *valid* match wins). Names can be
//      agent ids, OpenRouter slugs, advisor:org/model, etc., but not shell
//      source leaks like ${lookup_key}.
//
// After routing, stripAgentSentinelFromBody() removes all markers from the structured
// body so upstream LLMs never see routing metadata. Strip walks nested tool_result
// content arrays and thinking fields so multi-turn history cannot retain markers.

const SENTINEL_PREFIX = '[[c-thru-agent:';
// Optional trailing HMAC: exactly 16 hex chars after the final colon of the interior.
const HMAC_SUFFIX_RE = /:([0-9a-fA-F]{16})$/;
// Strip any marker regardless of interior charset (same close-at-]] grammar as parse).
const SENTINEL_GLOBAL_RE = /\[\[c-thru-agent:(?:(?!\]\]).)*\]\]\n?/g;
// Sanity cap on interior length (name + optional :hmac) — not a tight READ_WINDOW.
const MAX_INTERIOR_LEN = 512;
// Kept for tests that still import READ_WINDOW as the old bound concept.
const READ_WINDOW = MAX_INTERIOR_LEN;

// Routing names must look like agent ids / model tags / advisor pins — NOT source
// code or unexpanded shell. Observed poison: agents reading c-thru-agent-router-hook.sh
// put the literal `[[c-thru-agent:${lookup_key}]]` into tool_result history; lastIndexOf
// then routed the next request to model "${lookup_key}" → Ollama 400 "invalid model name".
// Allow: explore, reviewer-security, kimi-k2.7-code:cloud, advisor:org/model, thudm/glm-4-plus
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
  // Tier 1 — header: validated routing key (future OOB channel).
  if (typeof headerValue === 'string') {
    const h = headerValue.trim();
    if (h && isValidAgentRoutingName(h)) {
      return { name: h, tag: null };
    }
  }
  // Tier 2 — last *valid* match wins. Skip poison markers that appear when agents
  // read c-thru source (hook/sentinel docs contain the prefix literally).
  if (typeof bodyText !== 'string') return null;
  let searchFrom = bodyText.length;
  while (searchFrom > 0) {
    const i = bodyText.lastIndexOf(SENTINEL_PREFIX, searchFrom - 1);
    if (i < 0) break;
    const start = i + SENTINEL_PREFIX.length;
    const close = bodyText.indexOf(']]', start);
    if (close < 0) {
      searchFrom = i;
      continue;
    }
    const interior = bodyText.slice(start, close);
    const split = splitNameAndTag(interior);
    if (split && isValidAgentRoutingName(split.name)) {
      return { name: split.name, tag: split.tag, index: i };
    }
    searchFrom = i;
  }
  return null;
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
    let next = block;
    let local = false;
    if (typeof next.text === 'string' && next.text.indexOf(SENTINEL_PREFIX) >= 0) {
      local = true;
      next = Object.assign({}, next, { text: stripSentinelFromString(next.text) });
    }
    if (typeof next.thinking === 'string' && next.thinking.indexOf(SENTINEL_PREFIX) >= 0) {
      local = true;
      next = Object.assign({}, next, { thinking: stripSentinelFromString(next.thinking) });
    }
    if (typeof next.content === 'string' && next.content.indexOf(SENTINEL_PREFIX) >= 0) {
      local = true;
      next = Object.assign({}, next, { content: stripSentinelFromString(next.content) });
    } else if (Array.isArray(next.content)) {
      const nested = stripSentinelFromContent(next.content);
      if (nested !== next.content) {
        local = true;
        next = Object.assign({}, next, { content: nested });
      }
    }
    if (local) changed = true;
    return next;
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
  isValidAgentRoutingName,
  SENTINEL_PREFIX,
  SENTINEL_GLOBAL_RE,
  HMAC_SUFFIX_RE,
  READ_WINDOW,
  MAX_INTERIOR_LEN,
};
