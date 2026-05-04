#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Session-scoped effective-config overlay. When a request runs from a cwd
// whose ancestor contains `.claude/model-map.json` (the project tier), we
// merge system+global+project into a temp file and point the proxy at it
// via CLAUDE_MODEL_MAP_PATH — keeping the SHARED profile path
// (~/.claude/model-map.json) free of any project-specific entries.
//
// Pre-fix bug: the merged result (including project tier) was written
// directly to the profile path, leaking project-local entries into the
// global config visible to ALL future sessions from ANY directory.
function sessionEffectivePath(projectPath) {
  if (!projectPath) return null;
  const profileDir = profileClaudeDir() || '';
  // Hash project path + profile dir so different projects don't collide
  // and the same project always gets the same temp file (avoids
  // accumulating one per session).
  const hash = crypto.createHash('md5').update(`${projectPath}:${profileDir}`).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `c-thru-effective-${hash}.json`);
}

function canonicalizeDir(dir) {
  try {
    if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return null;
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

function canonicalizeFile(file) {
  try {
    if (!file || typeof file !== 'string' || !path.isAbsolute(file)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const dir = canonicalizeDir(path.dirname(file));
    return dir ? path.join(dir, path.basename(file)) : null;
  } catch {
    return null;
  }
}

// ARCH: walks up from dir until it finds .claude/model-map.json. May return
//       the profile's own ~/.claude/model-map.json if cwd is under ~/ — callers
//       MUST filter that case out (resolveSelectedConfigPath does this via
//       profileClaudeDir() guard), otherwise project=profile causes pollution.
function findParentModelMap(dir) {
  const real = canonicalizeDir(dir);
  if (!real) return null;
  let cur = real;
  while (true) {
    const candidate = canonicalizeFile(path.join(cur, '.claude', 'model-map.json'));
    if (candidate) return candidate;
    if (cur === '/') break;
    cur = path.dirname(cur);
  }
  return null;
}

function profileClaudeDir() {
  const raw = process.env.CLAUDE_PROFILE_DIR
    || process.env.CLAUDE_DIR
    || process.env.CLAUDE_CONFIG_DIR
    || path.join(process.env.HOME || os.homedir(), '.claude');
  return canonicalizeDir(raw);
}

function repoDefaultsPath(baseDir = __dirname) {
  return canonicalizeFile(path.join(baseDir, '..', 'config', 'model-map.json'));
}

function maybeSyncLayeredProfileModelMap(options = {}) {
  const { baseDir = __dirname, onSyncFailure = null, cwd = process.env.CLAUDE_MODEL_MAP_LAUNCH_CWD || process.cwd() } = options;
  const claudeDir = profileClaudeDir();
  if (!claudeDir) return;

  const systemPath = path.join(claudeDir, 'model-map.system.json');
  // Refresh system.json from the shipped repo config when the shipped one is
  // newer (e.g. user pulled a config update without re-running install.sh).
  // Without this, edits to config/model-map.json never reach the active
  // routing table — `c-thru --list` and the proxy both read from the merged
  // model-map.json which is built from system.json + overrides. Mirror of
  // the proxy-side check in tools/claude-proxy:maybeRegenerateMergedConfig
  // — replicated here so non-proxy code paths (e.g. `c-thru --list` which
  // doesn't spawn the proxy) also pick up shipped-config updates.
  const shippedPath = repoDefaultsPath(baseDir);
  if (shippedPath) {
    try {
      const shippedMtime = fs.statSync(shippedPath).mtimeMs;
      let systemMtime = 0;
      try { systemMtime = fs.statSync(systemPath).mtimeMs; } catch {}
      if (shippedMtime > systemMtime) {
        // Validate before copying — never overwrite a working system.json
        // with a broken shipped config (would brick the proxy on reload).
        try {
          JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
          fs.copyFileSync(shippedPath, systemPath);
        } catch (e) {
          if (typeof onSyncFailure === 'function') {
            onSyncFailure({ stderr: `shipped config invalid: ${e.message}`, status: 1 });
          }
        }
      }
    } catch {}
  }
  const defaultsPath = fs.existsSync(systemPath) ? systemPath : shippedPath;
  if (!defaultsPath) return;

  const overridesPath = path.join(claudeDir, 'model-map.overrides.json');
  const projectPath = findParentModelMap(cwd);
  const profileEffectivePath = path.join(claudeDir, 'model-map.json');

  const syncTool = path.join(baseDir, 'model-map-sync.js');
  if (!fs.existsSync(syncTool)) return;

  // ── Pass 1: PROFILE — system + global only (NEVER project tier) ─────────
  // The profile file is shared across all sessions from all directories.
  // Mixing project-local config into it leaks one project's overrides into
  // every other project's config. Always sync only the persistent layers.
  const profileSyncArgs = [syncTool, defaultsPath, overridesPath, '', profileEffectivePath];
  let profileResult;
  try {
    profileResult = spawnSync(process.execPath, profileSyncArgs, { encoding: 'utf8', timeout: 5000 });
    if (profileResult.status !== 0 && typeof onSyncFailure === 'function') {
      onSyncFailure(profileResult);
    }
  } catch (error) {
    if (typeof onSyncFailure === 'function') onSyncFailure(error);
    return;
  }

  // ── Pass 2: PROJECT OVERLAY — session-scoped, only when project tier exists ─
  // Write merged (system + global + project) to a temp file keyed by the
  // project's path. The proxy is pointed at this overlay via
  // CLAUDE_MODEL_MAP_PATH; profile file stays untouched.
  let projectOverlayPath = null;
  if (projectPath) {
    projectOverlayPath = sessionEffectivePath(projectPath);
    const overlaySyncArgs = [syncTool, defaultsPath, overridesPath, projectPath, projectOverlayPath];
    try {
      const overlayResult = spawnSync(process.execPath, overlaySyncArgs, { encoding: 'utf8', timeout: 5000 });
      if (overlayResult.status !== 0) {
        if (typeof onSyncFailure === 'function') onSyncFailure(overlayResult);
        projectOverlayPath = null;  // overlay failed, fall back to clean profile
      }
    } catch (error) {
      if (typeof onSyncFailure === 'function') onSyncFailure(error);
      projectOverlayPath = null;
    }
  }

  return Object.assign({ projectOverlayPath, profileEffectivePath, projectPath }, profileResult);
}

// ARCH: resolveSelectedConfigPath — 3-tier config precedence:
//   (1) CLAUDE_MODEL_MAP_PATH env override → (2) session-scoped project-overlay (tmp file,
//   system+global+project merged) → (3) persistent profile (system+global only).
//   Calls maybeSyncLayeredProfileModelMap first to regenerate derived files so callers
//   always get a fresh view without needing to manually trigger a sync.
function resolveSelectedConfigPath(options = {}) {
  const { baseDir = __dirname, cwd = process.env.CLAUDE_MODEL_MAP_LAUNCH_CWD || process.cwd(), syncProfile = true, onSyncFailure = null } = options;

  let syncResult = null;
  if (syncProfile) syncResult = maybeSyncLayeredProfileModelMap({ baseDir, onSyncFailure, cwd });

  const override = canonicalizeFile(process.env.CLAUDE_MODEL_MAP_PATH || '');
  if (override) return { path: override, source: 'override' };

  // Prefer the project-scoped overlay when present (when running from a
  // cwd whose ancestor has .claude/model-map.json). It's a session-scoped
  // file in $TMPDIR containing system + global + project merged.
  if (syncResult && syncResult.projectOverlayPath) {
    const overlay = canonicalizeFile(syncResult.projectOverlayPath);
    if (overlay) return { path: overlay, source: 'project-overlay' };
  }

  // Fall through to the persistent profile (system + global, no project).
  const profileDir = profileClaudeDir();
  const profile = profileDir ? canonicalizeFile(path.join(profileDir, 'model-map.json')) : null;
  if (profile) return { path: profile, source: 'profile' };

  return null;
}

function loadSelectedConfig(options = {}) {
  const resolved = resolveSelectedConfigPath(options);
  if (!resolved) throw new Error('No model-map.json found');
  const config = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
  return { config, path: resolved.path, source: resolved.source };
}

function main() {
  const arg = process.argv[2];
  const claudeDir = profileClaudeDir();
  const cwd = process.env.CLAUDE_MODEL_MAP_LAUNCH_CWD || process.cwd();
  
  if (arg === '--print-paths' || arg === '--shell-env') {
    if (!claudeDir) return;

    const defaults = repoDefaultsPath();
    const global = path.join(claudeDir, 'model-map.overrides.json');
    let project = findParentModelMap(cwd);
    const effective = path.join(claudeDir, 'model-map.json');

    // If project config is actually the profile config, ignore it.
    if (project && (project === effective || project.startsWith(claudeDir))) {
      project = null;
    }

    if (arg === '--print-paths') {
      console.log(`DEFAULTS=${defaults || ''}`);
      console.log(`GLOBAL=${global || ''}`);
      console.log(`PROJECT=${project || ''}`);
      console.log(`EFFECTIVE=${effective || ''}`);
    } else {
      // --shell-env: export variables for Bash eval. Drive both the sync
      // (which writes profile + optional overlay) and the active-path
      // selection through resolveSelectedConfigPath so the bash side and
      // the proxy side end up pointing at the same file.
      const override = canonicalizeFile(process.env.CLAUDE_MODEL_MAP_PATH || '');
      let activePath, source;
      if (override) {
        activePath = override;
        source = 'override';
      } else {
        const resolved = resolveSelectedConfigPath({ baseDir: __dirname, cwd, syncProfile: true });
        if (resolved) {
          activePath = resolved.path;
          source = resolved.source;  // 'project-overlay' | 'profile'
        } else {
          activePath = effective || '';
          source = 'profile';
        }
      }

      console.log(`export MODEL_MAP_DEFAULTS_FILE="${defaults || ''}";`);
      console.log(`export MODEL_MAP_OVERRIDES_FILE="${global || ''}";`);
      console.log(`export CLAUDE_MODEL_MAP_PATH="${activePath}";`);
      console.log(`export CLAUDE_MODEL_MAP_SOURCE="${source}";`);
      if (project) {
        console.log(`export CLAUDE_PROJECT_DIR="${path.dirname(path.dirname(project))}";`);
        console.log(`export _discovered_project_config="${project}";`);
      } else {
        console.log(`unset CLAUDE_PROJECT_DIR;`);
        console.log(`unset _discovered_project_config;`);
      }
    }
  } else if (arg === '--sync') {
    const result = maybeSyncLayeredProfileModelMap();
    process.exit(result && result.status === 0 ? 0 : 1);
  } else if (arg === '--clean-pollution' || arg === '--detect-pollution') {
    // One-shot helper for users whose ~/.claude/model-map.json accumulated
    // project-tier entries from older c-thru versions (before commit 956d469
    // which kept project-local scoped to $TMPDIR). Detection walks every
    // top-level key in the profile and flags anything not present in EITHER
    // system or globalOverrides — so leaks in model_routes,
    // agent_to_capability, llm_profiles, backends, model_overrides, etc.
    // are all caught. --clean-pollution removes them via canonical re-sync;
    // --detect-pollution just reports. --detect-pollution --strict exits 1
    // when drift is found (CI fail gate).
    const dryRun = arg === '--detect-pollution';
    const strict = dryRun && process.argv.includes('--strict');
    if (!claudeDir) {
      console.error('c-thru: no profile dir found');
      process.exit(1);
    }
    const systemPath = path.join(claudeDir, 'model-map.system.json');
    const overridesPath = path.join(claudeDir, 'model-map.overrides.json');
    const profilePath = path.join(claudeDir, 'model-map.json');
    let system, overrides, profile;
    try {
      const defaultsPath = fs.existsSync(systemPath) ? systemPath : repoDefaultsPath();
      system = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
      overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, 'utf8')) : {};
      profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } catch (e) {
      console.error(`c-thru: failed to load configs for pollution scan: ${e.message}`);
      process.exit(1);
    }
    // Keys synthesized by the merge tool itself — these legitimately exist
    // in profile but not in system/overrides, so skip them. See
    // maybeSynthesizeV12Keys in tools/model-map-layered.js.
    const SYNTHESIZED_KEYS = new Set(['models', 'schema_version']);
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // sections: { sectionName: [ { key, value } ] } where `key` may be
    // dotted (e.g. "64gb.classifier") for leaks nested under per-tier maps
    // like llm_profiles. primitiveLeaks: [ { key, value } ] for scalar
    // drift on top-level primitives.
    const sections = {};
    const primitiveLeaks = [];
    let totalLeaks = 0;
    // Walk the profile object at `profObj`, comparing against `sysObj` /
    // `ovObj`. Any key missing from BOTH is a leak. If a key exists in
    // sys/ov AND its profile value is an object, recurse — that catches
    // grandchildren leaks (e.g. llm_profiles.64gb.someAlias) under stable
    // parent tiers. Returns flat list of { path, value } with dotted paths.
    function walk(profObj, sysObj, ovObj, prefix) {
      const out = [];
      const sysC = isObj(sysObj) ? sysObj : {};
      const ovC = isObj(ovObj) ? ovObj : {};
      for (const k of Object.keys(profObj)) {
        const pv = profObj[k];
        const sysHas = Object.prototype.hasOwnProperty.call(sysC, k);
        const ovHas = Object.prototype.hasOwnProperty.call(ovC, k);
        const dotted = prefix ? `${prefix}.${k}` : k;
        if (!sysHas && !ovHas) {
          out.push({ path: dotted, value: pv });
        } else if (isObj(pv) && (isObj(sysC[k]) || isObj(ovC[k]))) {
          // Recurse only when both sides have an object — value-level
          // primitive drift inside a known parent isn't pollution, just an
          // override (and this scanner can't tell the two apart since it
          // doesn't see the project-tier source).
          out.push(...walk(pv, sysC[k], ovC[k], dotted));
        }
      }
      return out;
    }
    for (const topKey of Object.keys(profile)) {
      if (SYNTHESIZED_KEYS.has(topKey)) continue;
      if (topKey.startsWith('_')) continue;
      const profVal = profile[topKey];
      const sysVal = system[topKey];
      const ovVal = overrides[topKey];
      if (isObj(profVal)) {
        const leaks = walk(profVal, sysVal, ovVal, '');
        if (leaks.length > 0) {
          sections[topKey] = leaks.map((l) => ({ key: l.path, value: l.value }));
          totalLeaks += leaks.length;
        }
      } else {
        // Primitive: drift if profile differs from BOTH system and overrides.
        // (Compare via JSON.stringify to handle arrays/null uniformly.)
        const sysHas = Object.prototype.hasOwnProperty.call(system, topKey);
        const ovHas = Object.prototype.hasOwnProperty.call(overrides, topKey);
        const matchesSys = sysHas && same(profVal, sysVal);
        const matchesOv = ovHas && same(profVal, ovVal);
        if (!matchesSys && !matchesOv) {
          primitiveLeaks.push({ key: topKey, value: profVal });
          totalLeaks += 1;
        }
      }
    }
    if (totalLeaks === 0) {
      console.log('c-thru: profile is clean — no leaked project-tier entries detected');
      process.exit(0);
    }
    const sectionCount = Object.keys(sections).length + (primitiveLeaks.length > 0 ? 1 : 0);
    const verb = dryRun ? 'detected' : 'cleaning';
    console.log(`c-thru: ${verb} ${totalLeaks} leaked profile entries across ${sectionCount} section${sectionCount === 1 ? '' : 's'}:`);
    for (const sectionName of Object.keys(sections)) {
      console.log(`  ${sectionName}:`);
      for (const { key, value } of sections[sectionName]) {
        console.log(`    ${key}: ${JSON.stringify(value).slice(0, 100)}`);
      }
    }
    if (primitiveLeaks.length > 0) {
      console.log('  <top-level primitives>:');
      for (const { key, value } of primitiveLeaks) {
        console.log(`    ${key}: ${JSON.stringify(value).slice(0, 100)}`);
      }
    }
    if (dryRun) {
      console.log('\nrun: model-map-config.js --clean-pollution to remove them');
      process.exit(strict ? 1 : 0);
    }
    // Remove + rewrite. Use a sync rebuild (system+global only, no project
    // tier) instead of patching profile in-place — that way we get back a
    // canonical, deterministic profile rather than a hand-edited one. The
    // rebuild covers the full profile, so widening detection automatically
    // widens cleanup.
    const result = maybeSyncLayeredProfileModelMap();
    if (!result || result.status !== 0) {
      console.error('c-thru: re-sync failed; profile may still be polluted');
      process.exit(1);
    }
    console.log(`\nc-thru: profile cleaned (re-synced from ${path.basename(systemPath)} + ${path.basename(overridesPath)})`);
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  canonicalizeDir,
  canonicalizeFile,
  findParentModelMap,
  repoDefaultsPath,
  maybeSyncLayeredProfileModelMap,
  resolveSelectedConfigPath,
  loadSelectedConfig,
};
