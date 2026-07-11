#!/usr/bin/env node
'use strict';
// check-diagram-sync.js — verify the shared launch-flow diagram embedded in
// README.md and CLAUDE.md stays byte-identical between both copies.
//
// The diagram is authored once (conceptually, in docs/architecture-diagrams.md)
// but embedded twice — once in README.md (public-facing quickstart) and once in
// CLAUDE.md (agent-facing project instructions) — between matching sentinel
// comments. Nothing enforces that a hand-edit to one copy gets mirrored into the
// other, so this validator catches drift the same way `sync-plugin-bundle.sh
// --check` catches bundle drift and `gen-routing-doc.js --check` catches a stale
// README table.
//
//   node tools/check-diagram-sync.js
//
// Exit code is the sole pass/fail signal (no output parsing) — see
// docs/test-authoring.md's exit-code contract.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const README = path.join(REPO_ROOT, 'README.md');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');

const BEGIN = '<!-- BEGIN shared-diagram:launch-flow -->';
const END = '<!-- END shared-diagram:launch-flow -->';

// Extracts the sentinel-delimited block (inclusive of the sentinel lines
// themselves) from `content`. Returns { block, lineIndex } on success, or
// { error } naming which sentinel is missing/malformed.
function extractBlock(content, label) {
  const b = content.indexOf(BEGIN);
  const e = content.indexOf(END);
  if (b === -1 && e === -1) {
    return { error: `${label}: missing both BEGIN and END sentinels ("${BEGIN}" / "${END}")` };
  }
  if (b === -1) {
    return { error: `${label}: missing BEGIN sentinel ("${BEGIN}")` };
  }
  if (e === -1) {
    return { error: `${label}: missing END sentinel ("${END}")` };
  }
  if (e < b) {
    return { error: `${label}: END sentinel appears before BEGIN sentinel` };
  }
  const block = content.slice(b, e + END.length);
  const lineIndex = content.slice(0, b).split('\n').length; // 1-based line of BEGIN
  return { block, lineIndex };
}

function main() {
  let readme, claudeMd;
  try {
    readme = fs.readFileSync(README, 'utf8');
  } catch (err) {
    console.error(`check-diagram-sync: could not read ${README}: ${err.message}`);
    process.exit(1);
  }
  try {
    claudeMd = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch (err) {
    console.error(`check-diagram-sync: could not read ${CLAUDE_MD}: ${err.message}`);
    process.exit(1);
  }

  const a = extractBlock(readme, 'README.md');
  const b = extractBlock(claudeMd, 'CLAUDE.md');

  const errors = [];
  if (a.error) errors.push(a.error);
  if (b.error) errors.push(b.error);
  if (errors.length > 0) {
    console.error('check-diagram-sync: sentinel block not found.');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (a.block === b.block) {
    console.log('✓ shared-diagram:launch-flow blocks match (README.md ↔ CLAUDE.md)');
    return;
  }

  console.error('check-diagram-sync: shared-diagram:launch-flow blocks DIFFER.');
  console.error(`  README.md (${README}): ${a.block.length} chars starting at line ${a.lineIndex}`);
  console.error(`  CLAUDE.md (${CLAUDE_MD}): ${b.block.length} chars starting at line ${b.lineIndex}`);

  const aLines = a.block.split('\n');
  const bLines = b.block.split('\n');
  console.error(`  README.md block: ${aLines.length} lines; CLAUDE.md block: ${bLines.length} lines`);

  const maxLines = Math.max(aLines.length, bLines.length);
  let firstDivergence = -1;
  for (let i = 0; i < maxLines; i++) {
    if (aLines[i] !== bLines[i]) {
      firstDivergence = i;
      break;
    }
  }
  if (firstDivergence !== -1) {
    console.error(`  First divergence at block line ${firstDivergence + 1}:`);
    console.error(`    README.md: ${JSON.stringify(aLines[firstDivergence] ?? '<no line>')}`);
    console.error(`    CLAUDE.md: ${JSON.stringify(bLines[firstDivergence] ?? '<no line>')}`);
  }

  console.error('');
  console.error('  The diagram should be authored once (see docs/architecture-diagrams.md) and');
  console.error('  copied identically into both files\' shared-diagram:launch-flow sentinel blocks.');
  process.exit(1);
}

main();
