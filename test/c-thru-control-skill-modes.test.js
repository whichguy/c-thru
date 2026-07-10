#!/usr/bin/env node
'use strict';
// Guards skills/c-thru-control/SKILL.md's documented "Valid Modes" vocabulary against
// the runtime mode enum (tools/model-map-resolve.js). This drift went undetected once
// already: the skill listed ~16 mode names from c-thru's earlier design, most of which
// the proxy's POST /c-thru/mode handler rejects with HTTP 400 today. Run with:
//   node test/c-thru-control-skill-modes.test.js

const fs = require('fs');
const path = require('path');
const { LLM_MODE_ENUM, normalizeLlmMode } = require('../tools/model-map-resolve.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

const skillPath = path.join(__dirname, '..', 'skills', 'c-thru-control', 'SKILL.md');
const text = fs.readFileSync(skillPath, 'utf8');

// Isolate the "### Valid Modes:" section so we don't grab unrelated backtick tokens
// (file paths, code fragments, etc.) from the rest of the document.
const sectionMatch = text.match(/### Valid Modes:\n([\s\S]*?)\n---/);
assert(!!sectionMatch, 'SKILL.md has a "### Valid Modes:" section followed by a --- divider');
const section = sectionMatch ? sectionMatch[1] : '';

// Line 1 of the section: the 5 canonical modes.
const canonicalLine = section.split('\n').find(l => l.includes('canonical modes')) || '';
const canonicalModes = [...canonicalLine.matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1]);
assert(canonicalModes.length > 0, `extracted at least one canonical mode name (got ${canonicalModes.length})`);

// Second paragraph: legacy aliases, written as `alias` (→ `canonical`) or `a`/`b` (→ `canonical`),
// as the FIRST sentence. The following sentence ("Any name outside this set — including
// ...") deliberately cites stale/rejected names as counter-examples — exclude it.
const aliasLine = section.split('\n').find(l => l.includes('Legacy aliases')) || '';
const notAliasSentenceIdx = aliasLine.indexOf('Any name outside this set');
const aliasClause = notAliasSentenceIdx >= 0 ? aliasLine.slice(0, notAliasSentenceIdx) : aliasLine;
const aliasTokens = [...aliasClause.matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1]);
// Filter out any canonical mode names that got backtick-quoted inside the alias
// clause's own explanatory "(→ `best-cloud`)" asides — only keep tokens that are NOT
// already a canonical mode, since those parenthetical targets aren't aliases themselves.
const legacyAliases = aliasTokens.filter(t => !LLM_MODE_ENUM.has(t));
assert(legacyAliases.length > 0, `extracted at least one legacy alias (got ${legacyAliases.length}: ${legacyAliases.join(', ')})`);

console.log(`\ncanonical modes found in SKILL.md: ${canonicalModes.join(', ')}`);
for (const mode of canonicalModes) {
  assert(LLM_MODE_ENUM.has(mode), `canonical mode '${mode}' is a member of LLM_MODE_ENUM`);
}

console.log(`\nlegacy aliases found in SKILL.md: ${legacyAliases.join(', ')}`);
for (const alias of legacyAliases) {
  const resolved = normalizeLlmMode(alias, {});
  assert(resolved !== null, `legacy alias '${alias}' resolves via normalizeLlmMode (got null — SKILL.md documents an alias the runtime doesn't accept)`);
  if (resolved !== null) {
    assert(LLM_MODE_ENUM.has(resolved), `legacy alias '${alias}' resolves to a canonical mode ('${resolved}' is in LLM_MODE_ENUM)`);
  }
}

// Sanity check the extraction logic itself isn't vacuously trivial: a name from the
// OLD (buggy) 16-mode list must NOT resolve, proving this test would have caught it.
const staleNamesFromOldSkill = ['semi-offload', 'cloud-judge-only', 'fastest-possible', 'local-only'];
for (const stale of staleNamesFromOldSkill) {
  assert(normalizeLlmMode(stale, {}) === null, `stale pre-collapse mode name '${stale}' correctly does NOT resolve (regression check)`);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
