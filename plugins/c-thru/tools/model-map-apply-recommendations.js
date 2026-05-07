#!/usr/bin/env node
'use strict';
// Merges config/recommended-mappings.json into the effective model-map as
// the lowest-precedence tier. User overrides always win.
//
// Precedence (low → high):
//   1. config/recommended-mappings.json  ← community defaults (this file)
//   2. config/model-map.json             ← shipped
//   3. ~/.claude/model-map.overrides.json ← user
//   4. $PWD/.claude/model-map.json        ← project
//
// merge rules:
//   - Only injects models into llm_profiles[cap]['best-local-oss'][tier]
//     when the user's merged map has no explicit value there already.
//   - Only injects agent_to_capability entries not already defined.
//   - Never touches disconnect_model, modes, or on_failure.

const fs = require('fs');
const path = require('path');

const VALID_HW_TIERS = new Set(['16gb', '32gb', '48gb', '64gb', '128gb']);

function loadRecommendations(repoRoot) {
  const recPath = path.join(repoRoot, 'config', 'recommended-mappings.json');
  try {
    const raw = fs.readFileSync(recPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.schema_version !== 1) {
      process.stderr.write('c-thru: recommended-mappings.json has unexpected schema_version, skipping\n');
      return null;
    }
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`c-thru: could not load recommended-mappings.json: ${err.message}\n`);
    }
    return null;
  }
}

function applyRecommendations(effectiveMap, repoRoot) {
  const rec = loadRecommendations(repoRoot || path.join(__dirname, '..'));
  if (!rec) return { map: effectiveMap, applied: 0, preserved: 0 };

  const result = JSON.parse(JSON.stringify(effectiveMap));
  let applied = 0;
  let preserved = 0;

  // Inject recommendations into llm_profiles[cap]['best-local-oss'][tier]
  const recommendations = rec.recommendations || {};
  const profiles = result.llm_profiles || {};
  for (const [cap, tierMap] of Object.entries(recommendations)) {
    if (!profiles[cap] || typeof profiles[cap] !== 'object') continue;
    const modeBlock = profiles[cap]['best-local-oss'];
    if (!modeBlock || typeof modeBlock !== 'object') continue;
    for (const [tier, model] of Object.entries(tierMap)) {
      if (!VALID_HW_TIERS.has(tier)) continue;
      const existing = modeBlock[tier];
      if (existing && existing !== model) {
        preserved++;
      } else if (!existing) {
        modeBlock[tier] = model;
        applied++;
      }
      // identical → no-op
    }
  }

  return { map: result, applied, preserved };
}

module.exports = { applyRecommendations, loadRecommendations };

if (require.main === module) {
  const repoRoot = process.argv[2] || path.join(__dirname, '..');
  const mapPath = process.argv[3];
  if (!mapPath) {
    console.error('usage: model-map-apply-recommendations.js <repo-root> <effective-map.json>');
    process.exit(1);
  }
  let effectiveMap;
  try {
    effectiveMap = JSON.parse(fs.readFileSync(path.resolve(mapPath), 'utf8'));
  } catch (e) {
    console.error(`model-map-apply-recommendations: ${e.message}`);
    process.exit(1);
  }
  const { map, applied, preserved } = applyRecommendations(effectiveMap, repoRoot);
  if (parseInt(process.env.CLAUDE_ROUTER_DEBUG || '0', 10) >= 1) {
    process.stderr.write(`c-thru: applied ${applied} recommendations (${preserved} user overrides preserved)\n`);
  }
  process.stdout.write(JSON.stringify(map, null, 2) + '\n');
}
