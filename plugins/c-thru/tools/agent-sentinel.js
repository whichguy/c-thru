'use strict';
// Extract the c-thru per-agent routing marker from a request — the proxy side of the
// hook handshake (docs/planning/agent-delegation-findings.md).
//
// The PreToolUse hook prepends `[[c-thru-agent:<name>]]` to a delegated subagent's
// task prompt, so the marker rides in the request body; a future channel may also set
// an `x-c-thru-agent` header. This returns the candidate agent NAME the request is
// tagged with, or null. The caller must still verify the name resolves to a known
// agent before routing (this stays pure + config-free so it's hermetically testable —
// claude-proxy itself can't be required without starting its server).
//
// Detection is cheapest-first and does NOT parse the payload:
//   1. O(1) header check (well-known identifier; empty today, future-proof).
//   2. one `indexOf` byte-scan over the WHOLE raw body string (not a JSON walk, not a
//      bounded prefix — so a long system prompt can't hide the marker) to LOCATE it,
//      then a fixed-width window read (agent names are short) to extract the name.

const SENTINEL_PREFIX = '[[c-thru-agent:';
const SENTINEL_RE = /\[\[c-thru-agent:([A-Za-z0-9_-]+)\]\]/;
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const READ_WINDOW = 50; // bytes read after locating the prefix; bounds the extract

// parseAgentSentinel(bodyText, headerValue) -> agentName | null
function parseAgentSentinel(bodyText, headerValue) {
  // Tier 1 — well-known identifier in a header (O(1)).
  if (typeof headerValue === 'string' && NAME_RE.test(headerValue)) return headerValue;
  // Tier 2 — locate via a single byte-scan, then read a fixed window.
  if (typeof bodyText !== 'string') return null;
  const i = bodyText.indexOf(SENTINEL_PREFIX);
  if (i < 0) return null;
  const m = bodyText.slice(i, i + READ_WINDOW).match(SENTINEL_RE);
  return m ? m[1] : null;
}

module.exports = { parseAgentSentinel, SENTINEL_PREFIX, SENTINEL_RE, READ_WINDOW };
