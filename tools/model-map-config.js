#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

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
  const effectivePath = path.join(claudeDir, 'model-map.json');
  
  const syncTool = path.join(baseDir, 'model-map-sync.js');
  if (!fs.existsSync(syncTool)) return;

  // 3-Tier Sync: Defaults -> Global Overrides -> Project Overrides
  const syncArgs = [syncTool, defaultsPath, overridesPath, projectPath || '', effectivePath];
  
  try {
    const result = spawnSync(process.execPath, syncArgs, {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status !== 0 && typeof onSyncFailure === 'function') {
      onSyncFailure(result);
    }
    return result;
  } catch (error) {
    if (typeof onSyncFailure === 'function') onSyncFailure(error);
  }
}

function resolveSelectedConfigPath(options = {}) {
  const { baseDir = __dirname, cwd = process.env.CLAUDE_MODEL_MAP_LAUNCH_CWD || process.cwd(), syncProfile = true, onSyncFailure = null } = options;

  if (syncProfile) maybeSyncLayeredProfileModelMap({ baseDir, onSyncFailure, cwd });

  const override = canonicalizeFile(process.env.CLAUDE_MODEL_MAP_PATH || '');
  if (override) return { path: override, source: 'override' };

  // After 3-tier sync, the effective profile path contains all merged layers.
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
      // --shell-env: export variables for Bash eval
      const override = canonicalizeFile(process.env.CLAUDE_MODEL_MAP_PATH || '');
      const source = override ? 'override' : 'profile';
      const activePath = override || effective || '';

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
