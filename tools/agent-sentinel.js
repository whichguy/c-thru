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
// Marker shape: [[c-thru-agent:<name>]] or, when the per-user HMAC key exists,
// [[c-thru-agent:<name>:<hex>]] where <hex> is a 16-char HMAC tag the proxy
// verifies (C19 anti-spoof). The tag group is optional so this stays a pure
// parser — the trust decision (HMAC verify / fail-open) lives in the proxy.
// Name charset includes :cloud suffixes, dotted names, provider/name namespaces,
// and @backend sigils (advisor:<model-id> pins need these).
const SENTINEL_RE = /\[\[c-thru-agent:([A-Za-z0-9_.:/@-]+)(?::([0-9a-fA-F]+))?\]\]/;
const NAME_RE = /^[A-Za-z0-9_.:/@-]+$/;
// Widened from 50 → 80 to fit a name plus the optional ':<hex16>' tag.
const READ_WINDOW = 80; // bytes read after locating the prefix; bounds the extract

// parseAgentSentinel(bodyText, headerValue) -> { name, tag } | null
//   name: candidate agent name (string)
//   tag:  optional HMAC hex tag (string) or null when the marker is unsigned
// Returns null when no marker/header is present. Stays pure + config-free (no
// fs/crypto): the caller verifies the tag against the per-user key.
function parseAgentSentinel(bodyText, headerValue) {
  // Tier 1 — well-known identifier in a header (O(1)). Header path carries no tag.
  if (typeof headerValue === 'string' && NAME_RE.test(headerValue)) return { name: headerValue, tag: null };
  // Tier 2 — locate via a single byte-scan, then read a fixed window.
  if (typeof bodyText !== 'string') return null;
  const i = bodyText.indexOf(SENTINEL_PREFIX);
  if (i < 0) return null;
  const m = bodyText.slice(i, i + READ_WINDOW).match(SENTINEL_RE);
  if (!m) return null;
  // atFirstMessageStart — true when the marker sits at the very start of the
  // first user message's content (where the hook stamps it). A cheap position
  // pre-filter the proxy can use; position alone is NOT trust when a key exists.
  return { name: m[1], tag: m[2] || null, index: i };
}

module.exports = { parseAgentSentinel, SENTINEL_PREFIX, SENTINEL_RE, READ_WINDOW };
