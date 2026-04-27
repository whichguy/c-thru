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
  const defaultsPath = fs.existsSync(systemPath) ? systemPath : repoDefaultsPath(baseDir);
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
