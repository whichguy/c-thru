#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SERVER_NAME = 'llm-capabilities-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = Number(process.env.CLAUDE_LLM_PROXY_TIMEOUT_MS || 30000);
const STARTUP_TIMEOUT_MS = Number(process.env.CLAUDE_LLM_PROXY_STARTUP_TIMEOUT_MS || 5000);
const DEBUG = Number(process.env.CLAUDE_LLM_CAPABILITIES_DEBUG || '0');

const TOOL_DEFS = {
  ask_model: {
    description: 'Best when you already know the exact model you want. Use it to send a direct prompt to a named model through the proxy while still getting a normalized JSON result back.',
    category: 'direct',
    supportsPromptAlias: true,
    responseGuidance: 'Answer the prompt directly with the requested model. Keep the result useful and concise, and use dynamic_hints only for concrete next-step cues that would help a downstream LLM.',
    extraOutput: {},
  },
  list_models: {
    description: 'Best when you need the proxy-managed model catalog. Use it to fetch the current `/v1/models` view, including routed aliases and enriched model ids exposed by claude-proxy.',
    category: 'utility',
    extraOutput: {
      model_count: { type: 'integer', minimum: 0 },
      models: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  },
  classify_intent: {
    description: 'Best first tool for a raw prompt. Use it when the request is ambiguous, underspecified, or needs routing. It takes a prompt and returns an intent classification, confidence, recommended next tool, and clarification questions.',
    category: 'classifier',
    supportsPromptAlias: true,
    responseGuidance: 'Classify the prompt, recommend the most appropriate next tool when one is clear, and ask only the minimum clarification questions needed to unblock progress.',
    extraOutput: {
      recommended_tool: { type: ['string', 'null'] },
      clarification_questions: { type: 'array', items: { type: 'string' } },
    },
  },
  explore_local: {
    description: 'Best for analyzing supplied local workspace context before deeper reasoning. Use it when the prompt or context already includes file excerpts, logs, screenshots, environment details, or repository notes and you want grounded synthesis.',
    category: 'explorer',
    supportsPromptAlias: true,
    supportsImage: true,
    responseGuidance: 'Synthesize only from the supplied local context. Call out what is grounded versus inferred, then suggest the most useful next local inspection or follow-up question.',
    extraOutput: {
      observations: { type: 'array', items: { type: 'string' } },
      next_steps: { type: 'array', items: { type: 'string' } },
    },
  },
  explore_web: {
    description: 'Best for synthesizing supplied external material. Use it when you already have web search results, copied docs, API traces, or external logs and want concise actionable synthesis.',
    category: 'explorer',
    supportsPromptAlias: true,
    supportsImage: true,
    responseGuidance: 'Focus on concise synthesis of the supplied external material, highlight the highest-signal observations, and propose the most useful next step only when it materially advances the task.',
    extraOutput: {
      observations: { type: 'array', items: { type: 'string' } },
      next_steps: { type: 'array', items: { type: 'string' } },
    },
  },
  review_quality: {
    description: 'Best for maintainability review. Use it when you want style, readability, refactoring, naming, structure, and long-term code health feedback rather than deep bug hunting.',
    category: 'review',
    supportsPromptAlias: true,
    responseGuidance: 'Prioritize maintainability and readability issues over correctness bugs. Keep findings concrete, scoped, and actionable for an engineer who may implement them next.',
    extraOutput: {
      overall_verdict: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } },
      followups: { type: 'array', items: { type: 'string' } },
    },
  },
  critique_plan: {
    description: 'Best for design and plan critique. Use it on plans, specs, migration outlines, or architecture notes when you want gaps, risky assumptions, sequencing flaws, and missing edge cases called out.',
    category: 'review',
    supportsPromptAlias: true,
    responseGuidance: 'Critique the plan rigorously: surface gaps, hidden assumptions, risky sequencing, and missing edge cases. Prefer the most consequential findings over exhaustive minor nitpicks.',
    extraOutput: {
      overall_verdict: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } },
      followups: { type: 'array', items: { type: 'string' } },
    },
  },
  detect_bugs: {
    description: 'Best for bug hunting. Use it when correctness matters more than style, especially for invariants, state transitions, security risks, race conditions, and edge-case failures.',
    category: 'review',
    supportsPromptAlias: true,
    responseGuidance: 'Treat this as correctness-first review. Focus on concrete failure modes, invariants, state transitions, and security-sensitive edge cases rather than style feedback.',
    extraOutput: {
      overall_verdict: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } },
      followups: { type: 'array', items: { type: 'string' } },
    },
  },
  navigate_codebase: {
    description: 'Best for multi-file orientation. Use it to map dependencies, follow control flow, identify impacted files, and explain where in the codebase a change should land.',
    category: 'navigator',
    supportsPromptAlias: true,
    responseGuidance: 'Orient the caller in the codebase: identify key files, likely entry points, dependencies, and impact areas. Prefer mapping and explanation over critique.',
    extraOutput: {
      key_files: { type: 'array', items: { type: 'string' } },
      entry_points: { type: 'array', items: { type: 'string' } },
      dependencies: { type: 'array', items: { type: 'string' } },
      impact_areas: { type: 'array', items: { type: 'string' } },
    },
  },
  generate_tests: {
    description: 'Best for test generation. Use it when you want concrete unit or integration tests, strong edge coverage, and suggested assertions for risky behavior.',
    category: 'coder',
    supportsPromptAlias: true,
    responseGuidance: 'Produce concrete test artifacts when possible: test bodies, candidate file targets, and high-value assertions. Prefer runnable structure over abstract testing advice.',
    extraOutput: {
      proposed_tests: { type: 'array', items: { type: 'string' } },
      test_files: { type: 'array', items: { type: 'string' } },
      test_ideas: { type: 'array', items: { type: 'string' } },
    },
  },
  deep_review: {
    description: 'Best all-around review tool. Use it when you want one comprehensive pass that combines plan critique, bug finding, maintainability review, and likely testing gaps.',
    category: 'review',
    supportsPromptAlias: true,
    responseGuidance: 'Give a balanced comprehensive review. Synthesize the highest-value plan, bug, quality, and testing issues into one coherent response without duplicating the same concern in multiple forms.',
    extraOutput: {
      overall_verdict: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } },
      followups: { type: 'array', items: { type: 'string' } },
    },
  },
  heavy_coder: {
    description: 'Best for the hardest coding work. Use it for deep refactors, complex implementation strategy, tricky verification, and high-effort code generation when lighter tools should recuse.',
    category: 'coder',
    supportsPromptAlias: true,
    responseGuidance: 'Return concrete implementation guidance and artifacts for difficult coding work. Favor executable change plans, code-level outputs, and verification steps over high-level brainstorming.',
    extraOutput: {
      implementation_plan: { type: 'array', items: { type: 'string' } },
      proposed_changes: { type: 'array', items: { type: 'string' } },
      verification_steps: { type: 'array', items: { type: 'string' } },
    },
  },
};

let spawnedProxy = null;
let spawnedProxyConfigPath = null;
let spawnedProxyBaseUrl = null;

function debugLog(event, fields = {}) {
  if (!DEBUG) return;
  process.stderr.write(`llm-capabilities-mcp debug ${JSON.stringify({
    event,
    pid: process.pid,
    ...fields,
  })}\n`);
}

function canonicalizeDir(dir) {
  if (!dir || typeof dir !== 'string' || !dir.startsWith('/')) return null;
  try {
    const stat = fs.statSync(dir);
    return stat.isDirectory() ? fs.realpathSync(dir) : null;
  } catch {
    return null;
  }
}

function canonicalizeFile(file) {
  if (!file || typeof file !== 'string' || !file.startsWith('/')) return null;
  try {
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

function repoDefaultsPath() {
  return canonicalizeFile(path.join(__dirname, '..', 'config', 'model-map.json'));
}

function maybeSyncLayeredProfileModelMap() {
  const defaultsPath = repoDefaultsPath();
  const claudeDir = canonicalizeDir(process.env.CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'));
  if (!defaultsPath || !claudeDir) return;
  const overridesPath = path.join(claudeDir, 'model-map.overrides.json');
  if (!fs.existsSync(overridesPath)) return;
  const effectivePath = path.join(claudeDir, 'model-map.json');
  const syncTool = path.join(__dirname, 'model-map-sync.js');
  if (!fs.existsSync(syncTool)) return;
  const result = require('child_process').spawnSync(process.execPath, [syncTool, defaultsPath, overridesPath, effectivePath, effectivePath], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) {
    debugLog('layered_model_map_sync_failed', { stderr: String(result.stderr || '').trim() });
  }
}

function resolveConfigPath() {
  maybeSyncLayeredProfileModelMap();
  const override = canonicalizeFile(process.env.CLAUDE_MODEL_MAP_PATH || '');
  if (override) return { path: override, source: 'override' };

  const launchCwd = process.env.CLAUDE_MODEL_MAP_LAUNCH_CWD || process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const project = canonicalizeFile(path.join(projectDir, '.claude', 'model-map.json'));
    if (project) return { path: project, source: 'project' };
  }

  const walked = findParentModelMap(launchCwd);
  const profile = canonicalizeFile(path.join(process.env.HOME || '', '.claude', 'model-map.json'));
  if (walked && walked !== profile) return { path: walked, source: 'project' };
  if (profile) return { path: profile, source: 'profile' };
  throw new Error('No model-map.json found');
}

function loadConfig() {
  const resolved = resolveConfigPath();
  const config = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
  return { config, configPath: resolved.path, source: resolved.source };
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateToolArgs(toolName, args) {
  const tool = TOOL_DEFS[toolName];
  const params = args && typeof args === 'object' ? args : {};
  if (toolName === 'list_models') {
    return {};
  }
  const promptValue = params.prompt != null ? params.prompt : params.query;
  const prompt = requireString(promptValue, `${toolName}.prompt`);
  const model = toolName === 'ask_model' ? requireString(params.model, `${toolName}.model`) : null;
  const context = params.context == null ? null : requireString(String(params.context), `${toolName}.context`);
  if (params.image_base64 != null && !tool.supportsImage) {
    throw new Error(`${toolName}.image_base64 is not supported by this tool`);
  }
  if (params.audio_base64 != null && !tool.supportsAudio) {
    throw new Error(`${toolName}.audio_base64 is not supported by this tool`);
  }
  const imageBase64 = params.image_base64 == null ? null : requireString(String(params.image_base64), `${toolName}.image_base64`);
  const audioBase64 = params.audio_base64 == null ? null : requireString(String(params.audio_base64), `${toolName}.audio_base64`);
  return { model, prompt, context, image_base64: imageBase64, audio_base64: audioBase64 };
}

function buildInputSchema(toolName) {
  const tool = TOOL_DEFS[toolName];
  if (toolName === 'list_models') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {},
    };
  }
  const queryDescription = toolName === 'classify_intent'
    ? 'Required raw prompt to classify. Pass the user request you want routed or clarified; the tool returns the classification result.'
    : toolName === 'ask_model'
      ? 'Required task input for the named model. Pass the exact prompt you want the requested model to answer.'
    : 'Required task input: prompt, code snippet, plan, log excerpt, or other material the tool should analyze.';
  const properties = {
    prompt: { type: 'string', description: queryDescription },
    context: { type: ['string', 'null'], description: 'Optional surrounding context such as prior conversation or file excerpts.' },
  };
  const required = ['prompt'];
  if (toolName === 'ask_model') {
    properties.model = { type: 'string', description: 'Required model identifier to send through claude-proxy, for example glm-5.1:cloud or qwen3-coder:30b.' };
    required.unshift('model');
  }
  if (tool.supportsImage) {
    properties.image_base64 = { type: ['string', 'null'], description: 'Optional base64-encoded image supporting the prompt context for this tool.' };
  }
  if (tool.supportsAudio) {
    properties.audio_base64 = { type: ['string', 'null'], description: 'Optional base64-encoded audio supporting the prompt context for this tool.' };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

function buildOutputSchema(toolName) {
  const tool = TOOL_DEFS[toolName];
  return {
    type: 'object',
    additionalProperties: false,
    required: ['result', 'confidence', 'recuse_reason', 'dynamic_hints'],
    properties: {
      result: { type: 'string' },
      confidence: { type: 'integer', minimum: 0, maximum: 100 },
      recuse_reason: { type: ['string', 'null'] },
      dynamic_hints: { type: 'array', items: { type: 'string' } },
      ...tool.extraOutput,
    },
  };
}

function listTools() {
  return Object.entries(TOOL_DEFS).map(([name, tool]) => ({
    name,
    description: tool.description,
    annotations: {
      title: name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: buildInputSchema(name),
  }));
}

function resolveCapabilityModel(config, toolName) {
  if (toolName === 'ask_model') return null;
  const capabilities = config.llm_capabilities || {};
  const entry = capabilities[toolName] || capabilities.default;
  if (!entry || typeof entry.model !== 'string' || !entry.model.trim()) {
    throw new Error(`No llm_capabilities model configured for ${toolName}`);
  }
  return entry.model.trim();
}

function buildPrompt(toolName, args, modelName) {
  const tool = TOOL_DEFS[toolName];
  const outputSchema = JSON.stringify(buildOutputSchema(toolName), null, 2);
  const extraContext = [];
  if (args.context) extraContext.push(`Context:\n${args.context}`);
  if (args.image_base64) extraContext.push('Image provided as base64. Incorporate it if the model can reason about visual context.');
  if (args.audio_base64) extraContext.push('Audio provided as base64. Incorporate it if the model can reason about audio context.');
  const dynamicHints = [
    tool.responseGuidance,
    tool.category === 'direct'
      ? 'Do not turn this into a routing exercise. Answer the prompt itself, and use dynamic_hints only when a small follow-up cue would materially help the caller.'
      : null,
    tool.category === 'classifier'
      ? 'Set dynamic_hints to concise routing cues for the next LLM turn, for example which tool to call next or what missing input would unblock progress.'
      : 'Set dynamic_hints to short downstream orchestration cues only when useful, such as the best next tool, the most valuable missing context, or the highest-priority follow-up.',
    tool.category === 'coder'
      ? 'When possible, make the primary value concrete and code-oriented instead of advisory-only.'
      : null,
    tool.category === 'navigator'
      ? 'Favor orientation and impact mapping over verdict language.'
      : null,
  ].filter(Boolean);

  const system = [
    `You are executing the logical MCP tool "${toolName}".`,
    tool.description,
    `The requested model identifier for this call is "${modelName}".`,
    'Return strict JSON only. The first character of your response must be "{". Do not wrap it in markdown.',
    'If you cannot answer reliably, set recuse_reason and keep result minimal.',
    'Always include dynamic_hints as a JSON array. Use an empty array when there are no useful downstream hints.',
    'Tool-specific response guidance:',
    ...dynamicHints.map(hint => `- ${hint}`),
    'Use this exact JSON schema:',
    outputSchema,
  ].join('\n\n');

  const user = [
    `Prompt:\n${args.prompt}`,
    ...extraContext,
  ].join('\n\n');

  return { system, user };
}

function normalizeModelList(body) {
  const models = Array.isArray(body?.data) ? body.data.filter(entry => entry && typeof entry === 'object') : [];
  return {
    result: `Listed ${models.length} model${models.length === 1 ? '' : 's'} from claude-proxy.`,
    confidence: 100,
    recuse_reason: null,
    dynamic_hints: [],
    model_count: models.length,
    models,
  };
}

function parseTextResponse(body) {
  const textBlocks = Array.isArray(body?.content)
    ? body.content.filter(part => part && part.type === 'text').map(part => part.text || '')
    : [];
  return textBlocks.join('\n').trim();
}

function tryParseJsonText(text) {
  if (typeof text !== 'string') return { parsed: null, kind: 'not_string' };
  const trimmed = text.trim();
  if (!trimmed) return { parsed: null, kind: 'empty' };

  try {
    return { parsed: JSON.parse(trimmed), kind: 'strict_json' };
  } catch {}

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    try {
      return { parsed: JSON.parse(fencedMatch[1].trim()), kind: 'fenced_json' };
    } catch {}
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return { parsed: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)), kind: 'embedded_json' };
    } catch {}
  }

  return { parsed: null, kind: 'unparsed_text' };
}

function normalizeResult(toolName, parsed, rawText) {
  const tool = TOOL_DEFS[toolName];
  const parsedConfidence = Number.isInteger(parsed?.confidence) ? parsed.confidence : 0;
  const base = {
    result: typeof parsed?.result === 'string' ? parsed.result : rawText || '',
    confidence: Math.max(0, Math.min(100, parsedConfidence)),
    recuse_reason: typeof parsed?.recuse_reason === 'string' ? parsed.recuse_reason : null,
    dynamic_hints: Array.isArray(parsed?.dynamic_hints) ? parsed.dynamic_hints.map(String) : [],
  };

  if (toolName === 'classify_intent') {
    return {
      ...base,
      recommended_tool: typeof parsed?.recommended_tool === 'string' ? parsed.recommended_tool : null,
      clarification_questions: Array.isArray(parsed?.clarification_questions) ? parsed.clarification_questions.map(String) : [],
    };
  }

  if (tool.category === 'review') {
    return {
      ...base,
      overall_verdict: typeof parsed?.overall_verdict === 'string' ? parsed.overall_verdict : 'needs_review',
      findings: Array.isArray(parsed?.findings) ? parsed.findings.map(String) : [],
      followups: Array.isArray(parsed?.followups) ? parsed.followups.map(String) : [],
    };
  }

  if (tool.category === 'explorer') {
    return {
      ...base,
      observations: Array.isArray(parsed?.observations) ? parsed.observations.map(String) : [],
      next_steps: Array.isArray(parsed?.next_steps) ? parsed.next_steps.map(String) : [],
    };
  }

  if (tool.category === 'navigator') {
    return {
      ...base,
      key_files: Array.isArray(parsed?.key_files) ? parsed.key_files.map(String) : [],
      entry_points: Array.isArray(parsed?.entry_points) ? parsed.entry_points.map(String) : [],
      dependencies: Array.isArray(parsed?.dependencies) ? parsed.dependencies.map(String) : [],
      impact_areas: Array.isArray(parsed?.impact_areas) ? parsed.impact_areas.map(String) : [],
    };
  }

  if (toolName === 'generate_tests') {
    return {
      ...base,
      proposed_tests: Array.isArray(parsed?.proposed_tests) ? parsed.proposed_tests.map(String) : [],
      test_files: Array.isArray(parsed?.test_files) ? parsed.test_files.map(String) : [],
      test_ideas: Array.isArray(parsed?.test_ideas) ? parsed.test_ideas.map(String) : [],
    };
  }

  if (tool.category === 'direct') {
    return base;
  }

  return {
    ...base,
    implementation_plan: Array.isArray(parsed?.implementation_plan) ? parsed.implementation_plan.map(String) : [],
    proposed_changes: Array.isArray(parsed?.proposed_changes) ? parsed.proposed_changes.map(String) : [],
    verification_steps: Array.isArray(parsed?.verification_steps) ? parsed.verification_steps.map(String) : [],
  };
}

function readJsonRpcMessage(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const header = buffer.slice(0, headerEnd).toString('utf8');
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error('Missing Content-Length header');
  const length = Number(match[1]);
  const total = headerEnd + 4 + length;
  if (buffer.length < total) return null;
  const body = buffer.slice(headerEnd + 4, total).toString('utf8');
  return { message: JSON.parse(body), rest: buffer.slice(total) };
}

function sendMessage(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function pingJson(baseUrl) {
  return new Promise(resolve => {
    const req = http.get(`${baseUrl.replace(/\/$/, '')}/ping`, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForReadyLine(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };

    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const match = line.match(/^READY (\d+)$/);
        if (match) {
          finish(null, Number(match[1]));
          return;
        }
      }
    };

    const onExit = code => finish(new Error(`claude-proxy exited before becoming ready (code ${code})`));
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error('timed out waiting for claude-proxy readiness line')), timeoutMs);

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForProxy(baseUrl, configPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ping = await pingJson(baseUrl);
    if (ping && ping.ok && (!configPath || ping.config_path === configPath)) return ping;
    await wait(100);
  }
  return null;
}

function createRequestOptions(baseUrl, pathName, bodyStr) {
  const url = new URL(pathName, `${baseUrl.replace(/\/$/, '')}/`);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bodyStr),
      'x-api-key': process.env.ANTHROPIC_API_KEY || 'proxied-placeholder',
      'anthropic-version': '2023-06-01',
    },
  };
}

function getJson(baseUrl, pathName) {
  return new Promise((resolve, reject) => {
    const options = createRequestOptions(baseUrl, pathName, '');
    options.method = 'GET';
    delete options.headers['content-type'];
    delete options.headers['content-length'];
    debugLog('mcp.proxy.dispatch.before', {
      base_url: baseUrl,
      path: pathName,
      method: 'GET',
      model: null,
    });
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          debugLog('mcp.proxy.dispatch.after', {
            base_url: baseUrl,
            path: pathName,
            method: 'GET',
            status_code: res.statusCode,
            result: 'error',
          });
          reject(new Error(raw || `proxy returned ${res.statusCode}`));
          return;
        }
        try {
          debugLog('mcp.proxy.dispatch.after', {
            base_url: baseUrl,
            path: pathName,
            method: 'GET',
            status_code: res.statusCode,
            result: 'ok',
          });
          resolve(JSON.parse(raw));
        } catch (error) {
          debugLog('mcp.proxy.dispatch.after', {
            base_url: baseUrl,
            path: pathName,
            method: 'GET',
            status_code: res.statusCode,
            result: 'invalid_json',
            error: error.message,
          });
          reject(new Error(`invalid JSON from claude-proxy: ${error.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Capability request timed out waiting for claude-proxy after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

function postJson(baseUrl, pathName, payload) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const options = createRequestOptions(baseUrl, pathName, bodyStr);
    debugLog('mcp.proxy.dispatch.before', {
      base_url: baseUrl,
      path: pathName,
      model: payload.model || null,
      max_tokens: payload.max_tokens || null,
    });
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          debugLog('mcp.proxy.dispatch.after', {
            base_url: baseUrl,
            path: pathName,
            status_code: res.statusCode,
            result: 'error',
          });
          reject(new Error(raw || `proxy returned ${res.statusCode}`));
          return;
        }
        try {
          debugLog('mcp.proxy.dispatch.after', {
            base_url: baseUrl,
            path: pathName,
            status_code: res.statusCode,
            result: 'ok',
          });
          resolve(JSON.parse(raw));
        } catch (error) {
          debugLog('mcp.proxy.dispatch.after', {
            base_url: baseUrl,
            path: pathName,
            status_code: res.statusCode,
            result: 'invalid_json',
            error: error.message,
          });
          reject(new Error(`invalid JSON from claude-proxy: ${error.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Capability request timed out waiting for claude-proxy after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.write(bodyStr);
    req.end();
  });
}

async function stopOwnedProxy() {
  if (!spawnedProxy) return;
  const proc = spawnedProxy;
  spawnedProxy = null;
  spawnedProxyConfigPath = null;
  spawnedProxyBaseUrl = null;
  await new Promise(resolve => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 1500).unref();
  });
}

async function ensureProxy(configPath) {
  if (process.env.CLAUDE_LLM_PROXY_BASE_URL) {
    debugLog('mcp.proxy.ensure.external', {
      config_path: configPath,
      base_url: process.env.CLAUDE_LLM_PROXY_BASE_URL,
    });
    return process.env.CLAUDE_LLM_PROXY_BASE_URL;
  }

  if (spawnedProxy && spawnedProxy.exitCode == null && spawnedProxyConfigPath === configPath && spawnedProxyBaseUrl) {
    const existingPing = await pingJson(spawnedProxyBaseUrl);
    if (existingPing && existingPing.ok) {
      debugLog('mcp.proxy.ensure.reuse_owned', {
        config_path: configPath,
        base_url: spawnedProxyBaseUrl,
      });
      return spawnedProxyBaseUrl;
    }
  }

  const explicitPort = process.env.CLAUDE_PROXY_PORT ? Number(process.env.CLAUDE_PROXY_PORT) : null;
  if (explicitPort) {
    const explicitBaseUrl = `http://127.0.0.1:${explicitPort}`;
    const explicitPing = await pingJson(explicitBaseUrl);
    if (explicitPing && explicitPing.ok && explicitPing.config_path === configPath) {
      debugLog('mcp.proxy.ensure.reuse_explicit', {
        config_path: configPath,
        base_url: explicitBaseUrl,
      });
      return explicitBaseUrl;
    }
    if (explicitPing && explicitPing.ok && explicitPing.config_path !== configPath) {
      debugLog('mcp.proxy.ensure.explicit_conflict', {
        config_path: configPath,
        base_url: explicitBaseUrl,
        serving_config_path: explicitPing.config_path || null,
      });
      throw new Error(`claude-proxy on explicit port ${explicitPort} is already serving a different config`);
    }
  }

  if (spawnedProxy && spawnedProxyConfigPath !== configPath) {
    debugLog('mcp.proxy.ensure.stop_owned', {
      previous_config_path: spawnedProxyConfigPath,
      next_config_path: configPath,
    });
    await stopOwnedProxy();
  }

  const proxyPath = path.join(__dirname, 'claude-proxy');
  const env = {
    ...process.env,
    CLAUDE_MODEL_MAP_PATH: configPath,
    CLAUDE_MODEL_MAP_LAUNCH_CWD: process.cwd(),
  };
  if (explicitPort) env.CLAUDE_PROXY_PORT = String(explicitPort);
  debugLog('mcp.proxy.ensure.spawn.before', {
    config_path: configPath,
    explicit_port: explicitPort,
  });
  const child = spawn(process.execPath, [proxyPath], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupError = '';
  child.stderr.on('data', chunk => {
    startupError += chunk.toString('utf8');
  });
  let port = explicitPort;
  if (!port) {
    port = await waitForReadyLine(child, STARTUP_TIMEOUT_MS);
    debugLog('mcp.proxy.ensure.spawn.ready_line', {
      config_path: configPath,
      port,
    });
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const ready = await waitForProxy(baseUrl, configPath, STARTUP_TIMEOUT_MS);
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(startupError.trim() || `claude-proxy did not become ready on ${baseUrl}`);
  }
  spawnedProxy = child;
  spawnedProxyConfigPath = configPath;
  spawnedProxyBaseUrl = baseUrl;
  debugLog('mcp.proxy.ensure.spawn.after', {
    config_path: configPath,
    base_url: baseUrl,
    pid: child.pid,
  });
  return baseUrl;
}

async function callTool(toolName, rawArgs) {
  const { config, configPath } = loadConfig();
  const args = validateToolArgs(toolName, rawArgs);
  const modelName = toolName === 'ask_model'
    ? args.model
    : toolName === 'list_models'
      ? null
      : resolveCapabilityModel(config, toolName);
  debugLog('mcp.tool.call.before', {
    tool: toolName,
    config_path: configPath,
    model: modelName,
    has_context: Boolean(args.context),
    has_image: Boolean(args.image_base64),
    has_audio: Boolean(args.audio_base64),
  });
  const proxyBaseUrl = await ensureProxy(configPath);
  if (toolName === 'list_models') {
    const body = await getJson(proxyBaseUrl, '/v1/models');
    const normalized = normalizeModelList(body);
    debugLog('mcp.tool.call.after', {
      tool: toolName,
      proxy_base_url: proxyBaseUrl,
      model_count: normalized.model_count,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(normalized, null, 2) }],
      structuredContent: normalized,
    };
  }
  const prompt = buildPrompt(toolName, args, modelName);
  const body = await postJson(proxyBaseUrl, '/v1/messages', {
    model: modelName,
    max_tokens: 1200,
    stream: false,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  });
  const rawText = parseTextResponse(body);
  const parsedInfo = tryParseJsonText(rawText);
  const normalized = normalizeResult(toolName, parsedInfo.parsed, rawText);
  debugLog('mcp.tool.call.after', {
    tool: toolName,
    model: modelName,
    proxy_base_url: proxyBaseUrl,
    parse_kind: parsedInfo.kind,
    confidence: normalized.confidence,
    recused: Boolean(normalized.recuse_reason),
    dynamic_hint_count: Array.isArray(normalized.dynamic_hints) ? normalized.dynamic_hints.length : 0,
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(normalized, null, 2) }],
    structuredContent: normalized,
  };
}

async function handleMessage(message) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }

  if (message.method === 'notifications/initialized') return null;

  if (message.method === 'tools/list') {
    return { tools: listTools() };
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (!TOOL_DEFS[name]) throw new Error(`Unknown tool '${name}'`);
    return await callTool(name, message.params?.arguments || {});
  }

  throw new Error(`Unsupported method '${message.method}'`);
}

process.on('SIGINT', () => {
  stopOwnedProxy().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  stopOwnedProxy().finally(() => process.exit(0));
});

let inputBuffer = Buffer.alloc(0);
process.stdin.on('data', async chunk => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (true) {
    let parsed;
    try {
      parsed = readJsonRpcMessage(inputBuffer);
    } catch (error) {
      sendError(null, -32700, error.message);
      inputBuffer = Buffer.alloc(0);
      return;
    }
    if (!parsed) break;
    inputBuffer = parsed.rest;
    const message = parsed.message;
    try {
      const result = await handleMessage(message);
      if (message.id != null && result != null) sendResult(message.id, result);
    } catch (error) {
      if (message.id != null) sendError(message.id, -32000, error.message);
    }
  }
});
