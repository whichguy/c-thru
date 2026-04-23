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
  const { baseDir = __dirname, onSyncFailure = null } = options;
  const claudeDir = profileClaudeDir();
  if (!claudeDir) return;

  const systemPath = path.join(claudeDir, 'model-map.system.json');
  const defaultsPath = fs.existsSync(systemPath) ? systemPath : repoDefaultsPath(baseDir);
  if (!defaultsPath) return;

  const overridesPath = path.join(claudeDir, 'model-map.overrides.json');
  if (!fs.existsSync(overridesPath)) return;

  const effectivePath = path.join(claudeDir, 'model-map.json');
  const syncTool = path.join(baseDir, 'model-map-sync.js');
  if (!fs.existsSync(syncTool)) return;

  try {
    const result = spawnSync(process.execPath, [syncTool, defaultsPath, overridesPath, effectivePath, effectivePath], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status !== 0 && typeof onSyncFailure === 'function') {
      onSyncFailure(result);
    }
  } catch (error) {
    if (typeof onSyncFailure === 'function') onSyncFailure(error);
  }
}

function resolveSelectedConfigPath(options = {}) {
  const { baseDir = __dirname, cwd = process.env.CLAUDE_MODEL_MAP_LAUNCH_CWD || process.cwd(), syncProfile = true, onSyncFailure = null } = options;

  if (syncProfile) maybeSyncLayeredProfileModelMap({ baseDir, onSyncFailure });

  const override = canonicalizeFile(process.env.CLAUDE_MODEL_MAP_PATH || '');
  if (override) return { path: override, source: 'override' };

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const project = canonicalizeFile(path.join(projectDir, '.claude', 'model-map.json'));
    if (project) return { path: project, source: 'project' };
  }

  const walked = findParentModelMap(cwd);
  const profileDir = profileClaudeDir();
  const profile = profileDir ? canonicalizeFile(path.join(profileDir, 'model-map.json')) : null;
  const homeProfile = canonicalizeFile(path.join(process.env.HOME || os.homedir(), '.claude', 'model-map.json'));
  if (walked && walked !== profile && walked !== homeProfile) return { path: walked, source: 'project' };
  if (profile) return { path: profile, source: 'profile' };
  return null;
}

function loadSelectedConfig(options = {}) {
  const resolved = resolveSelectedConfigPath(options);
  if (!resolved) throw new Error('No model-map.json found');
  const config = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
  return { config, path: resolved.path, source: resolved.source };
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
