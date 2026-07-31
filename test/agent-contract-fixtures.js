'use strict';

// Shared, hermetic source of truth for the two opt-in agent contract suites.
// Agent capabilities are read from model-map.json during preflight; test cases
// must not duplicate routing expectations.

const fs = require('fs');
const path = require('path');
const { boundedDiagnosticSnippet } = require('./helpers');

const STRUCTURED_AGENTS = Object.freeze([
  'planner',
  'planner-hard',
  'explore',
  'coder',
  'coder-fallback',
  'tester',
  'code-reviewer',
  'reviewer-security',
  'reviewer-plan',
  'plan-scheduler',
  'debugger-hypothesis',
  'debugger-investigate',
  'debugger-hard',
  'docs',
]);

const INTENTIONALLY_UNSTRUCTURED_AGENTS = Object.freeze([
  'vision',
  'pdf',
  'writer',
  'edge',
  'generalist',
  'fast-generalist',
  'fast-scout',
  'long-context',
  'advisors',
  'opus',
  'claude-opus-5',
  'sonnet',
  'claude-sonnet-5',
  'haiku',
  'claude-haiku-4-5-20251001',
  'fable',
  'grok',
  'grok-4-5',
  'deepseek',
  'deepseek-v4-pro-cloud',
  'deepseek-flash',
  'deepseek-v4-flash-cloud',
  'qwen',
  'qwen3-6-35b',
  'qwen3-6-35b-a3b-coding-nvfp4',
  'qwen3-6-35b-a3b-q8-0',
  'qwen3-6-35b-a3b-coding-mxfp8',
  'qwen3-6-35b-a3b-nvfp4',
  'qwen3-6-27b',
  'qwen3-6-27b-nvfp4',
  'qwen3-6-27b-coding-nvfp4',
  'qwen3-6-27b-coding-mxfp8',
  'qwen3-1-7b',
  'qwen3-4b',
  'qwen3-coder-next-q8-0',
  'qwen3-coder-next-q4-k-m',
  'qwen3-coder-480b-cloud',
  'qwen3-vl-8b',
  'kimi',
  'kimi-k3-cloud',
  'kimi-k2-7-code-cloud',
  'gemini',
  'gemini-pro',
  'gemini-pro-latest',
  'gemini-flash',
  'gemini-3-flash-preview-cloud',
  'devstral',
  'devstral-2-latest',
  'devstral-2',
  'devstral-small-2-24b',
  'devstral-small-2-24b-cloud',
  'glm',
  'glm-5-2-cloud',
  'gemma',
  'gemma4-26b',
  'gemma4-e4b',
  'gemma4-26b-mxfp8',
  'gemma4-31b',
  'gemma4-31b-mxfp8',
  'phi',
  'phi4-reasoning-plus',
  'phi4-mini-3-8b',
  'gpt-oss',
  'gpt-oss-20b',
  'gpt-oss-120b',
  'gpt-oss-120b-cloud',
  'nemotron',
  'nemotron-3-super-cloud',
  'minimax',
  'minimax-m3-cloud',
  'hermes',
  'hermes3-70b',
  'mistral',
  'mistral-small3-2-24b',
  'terra',
  'gpt-5-6-terra',
  'codex-terra',
  'sol',
  'gpt-5-6-sol',
  'codex-sol',
  'luna',
  'gpt-5-6-luna',
  'codex-luna',
  'codex',
]);



const ROUTING_ONLY_AGENTS = Object.freeze(['WebSearch', 'WebFetch', 'Monitor']);
const CURRENT_TASK_STATUS_DECLARATION =
  /^TASK_STATUS:\s*COMPLETE\s*\|\s*PARTIAL\s*\|\s*FAILED\s*$/m;
const FINAL_BLOCK_RULE_AGENTS = STRUCTURED_AGENTS;
const NORMAL_FINAL_BLOCK_RULE =
  /Every normal response MUST end with the complete `TASK_STATUS` block below\./;
const RECUSAL_BLOCK_RESERVATION_RULE =
  /`STATUS` is reserved exclusively for a recusal block beginning with `STATUS: RECUSE` and ending with a non-empty `REASON:` line; never use `STATUS` for a normal outcome\./;
const RECUSAL_REASON_DECLARATION = /^(?:RECUSAL_REASON|REASON):\s*\S+/m;
const SECURITY_SEVERITY_EVIDENCE_PATTERN =
  /\b(high|critical)\b.{0,40}\b(severity|risk)\b|\b(severity|risk)\b.{0,40}\b(high|critical)\b|\b(?:high|critical)\s+(?:command\s+injection|vulnerability|finding|issue|risk)\b|\((?:high|critical)\)|^\s{0,3}#{1,6}\s+(?:high|critical)(?:\s+(?:severity|risk|finding))?\s*$|^\s*(?:[-*]\s+)?(?:\*\*)?(?:high|critical)(?:\*\*)?\s*:|^\s*(?:severity|risk)\s*:\s*(?:high|critical)\b/ims;
const FAILURE_RESPONSE_TAIL_CHARS = 600;
const AGENT_CONTRACT_MAX_TOKENS = 5000;

const AGENT_CONTRACT_CASES = Object.freeze([
  {
    caseId: 'planner-cli-plan',
    agent: 'planner',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Plan a two-file Node.js CLI that prints "hello" and has one focused test.',
    behaviorPatterns: [
      /\b(files? (?:to )?(?:change|create|modify)|src\/)\b/i,
      /\b(steps?|implementation|sequence)\b/i,
      /\b(test|verification|verify)\b/i,
    ],
  },
  {
    caseId: 'planner-hard-auth-migration',
    agent: 'planner-hard',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Plan a high-risk authentication migration spanning an API, database, and CI deployment. Include alternatives, rollback, and verification.',
    behaviorPatterns: [
      /rollback.{0,120}(deploy|migration|database|schema)|(deploy|migration|database|schema).{0,120}rollback/is,
      /alternative.{0,120}(trade.?off|option)|(trade.?off|option).{0,120}alternative/is,
      /verification|canary|monitor/i,
    ],
  },
  {
    caseId: 'explore-callsite-map',
    agent: 'explore',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Read-only reconnaissance: map where `loadConfig` is defined and used. Fixture: src/config.js exports loadConfig; src/server.js imports and calls it.',
    behaviorPatterns: [
      /loadConfig.{0,80}(defined|export|src\/config)|(defined|export|src\/config).{0,80}loadConfig/is,
      /loadConfig.{0,80}(called|used|import|src\/server)|(called|used|import|src\/server).{0,80}loadConfig/is,
      /\b(?:dependency|relationship|dependents?|depends|call\s*sites?|caller)\b|(?:src\/server\.js\s*(?:→|->)\s*src\/config\.js)/i,
    ],
  },
  {
    caseId: 'coder-clamp-function',
    agent: 'coder',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Unambiguous one-file task: implement `function clamp(value, min, max)` in src/clamp.js and export it. Return the proposed code and your task result.',
    behaviorPatterns: [
      /(function|const)\s+clamp/,
      /\b(?:value|v)\s*<\s*min\b|Math\.max[\s\S]{0,80}\bmin\b|\bmin\b[\s\S]{0,80}Math\.max/i,
      /\b(?:value|v)\s*>\s*max\b|Math\.min[\s\S]{0,80}\bmax\b|\bmax\b[\s\S]{0,80}Math\.min/i,
      /module\.exports|exports\.clamp|export\s+(default\s+)?(function|const|\{)/,
    ],
  },
  {
    caseId: 'coder-fallback-retry',
    agent: 'coder-fallback',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'The primary coder tried `Math.max(value, min, max)` and failed. Retry the one-file clamp implementation with a different correct approach.',
    behaviorPatterns: [
      /(function|const)\s+clamp/,
      /\b(?:value|v)\s*<\s*min\b|Math\.max[\s\S]{0,80}\bmin\b|\bmin\b[\s\S]{0,80}Math\.max/i,
      /\b(?:value|v)\s*>\s*max\b|Math\.min[\s\S]{0,80}\bmax\b|\bmax\b[\s\S]{0,80}Math\.min/i,
      /module\.exports|exports\.clamp|export\s+(default\s+)?(function|const|\{)/,
    ],
  },
  {
    caseId: 'tester-clamp-edges',
    agent: 'tester',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Verify `const clamp = (v, min, max) => Math.min(max, Math.max(min, v));`. Propose focused tests for below-min, in-range, above-max, and boundary values.',
    behaviorPatterns: [
      /below.{0,40}min|min.{0,40}below/is,
      /above.{0,40}max|max.{0,40}above/is,
      /in.?range/i,
      /boundar|equal.{0,30}(min|max)|(min|max).{0,30}equal/is,
      /\b(?:assert|expect)(?:\.\w+)?\s*\(|\b(?:it|test)\s*\(|clamp\.test\.js|runnable.{0,40}tests?/i,
    ],
  },
  {
    caseId: 'code-reviewer-off-by-one',
    agent: 'code-reviewer',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Review this changed loop for correctness and test gaps: `for (let i = 0; i <= items.length; i++) total += items[i].price;`.',
    behaviorPatterns: [
      /off.by.one|<=\s*items\.length/i,
      /items\[items\.length\]|undefined|out.of.bounds/i,
      /i\s*<\s*items\.length|items\.length\s*-\s*1/i,
    ],
  },
  {
    caseId: 'reviewer-security-command-injection',
    agent: 'reviewer-security',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Security-review this external-input path: `exec("git show " + req.query.ref)`. Identify the attack surface, severity, and mitigation.',
    behaviorPatterns: [
      /command injection|shell injection/i,
      SECURITY_SEVERITY_EVIDENCE_PATTERN,
      /spawn.{0,100}(args|argument|shell)|allowlist|validate/is,
    ],
  },
  {
    caseId: 'reviewer-plan-dependency-gap',
    agent: 'reviewer-plan',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Review this plan: item-001 changes the schema; item-002 deploys the API and depends_on []; verification only says "check it works". Return a structural verdict and findings.',
    behaviorPatterns: [
      /^VERDICT:\s*NEEDS_REVISION\s*$/mi,
      /item-002.{0,120}(depend|item-001)|(depend|item-001).{0,120}item-002/is,
      /verification.{0,120}(specific|command|test|insufficient|vague)|(specific|command|test|insufficient|vague).{0,120}verification/is,
    ],
  },
  {
    caseId: 'plan-scheduler-ready-items',
    agent: 'plan-scheduler',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: [
      'plan_dir: /tmp/current-plan',
      'current.md: present',
      'wave_dir: /tmp/current-plan/wave-001',
      'READY_ITEMS: [item-001, item-002]',
      'schedule-plan-tasks result:',
      '- item-001 -> task-101 (coder)',
      '- item-002 -> task-102 (tester)',
      'The scheduling operation completed. Report the created task IDs and normal task result.',
    ].join('\n'),
    behaviorPatterns: [
      /^ATTEMPTED:\s*.*\b(?:dispatched|scheduled)\b.*\b2\b.*\bitems?\b/mi,
      /^COMPLETED:\s*$/mi,
      /item-001.{0,80}task-101|task-101.{0,80}item-001/is,
      /item-002.{0,80}task-102|task-102.{0,80}item-002/is,
    ],
  },
  {
    caseId: 'debugger-hypothesis-timeout',
    agent: 'debugger-hypothesis',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'An HTTP test intermittently times out only under parallel execution. Evidence: serial runs pass; no stack trace; shared server port. Rank hypotheses and the first diagnostic.',
    behaviorPatterns: [
      /shared.{0,80}port|port.{0,80}(collision|contention|race)/is,
      /parallel.{0,100}(race|collision|contention)|(race|collision|contention).{0,100}parallel/is,
      /diagnostic|unique port|serialize|instrument/i,
      /\b(?:100|[1-9]?\d)%/,
    ],
  },
  {
    caseId: 'debugger-investigate-cache',
    agent: 'debugger-investigate',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Investigate the hypothesis that a stale module cache causes config reloads to return old values. Fixture: loadConfig calls require(configPath); logs show the second call returns the first object.',
    behaviorPatterns: [
      /require\.cache|module cache/i,
      /delete\s+require\.cache|cache.?bust|invalidate|dynamic\s+import/i,
    ],
  },
  {
    caseId: 'debugger-hard-race',
    agent: 'debugger-hard',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Hard-debug an intermittent proxy race: two concurrent requests share mutable retry state, and adding logging makes the failure disappear. Build a system model and propose a minimal reproducer.',
    behaviorPatterns: [
      /shared.{0,120}(state|retry)|(state|retry).{0,120}shared/is,
      /interleav|concurr|race/i,
      /repro|barrier|synchron|determin/i,
    ],
  },
  {
    caseId: 'docs-cli-flag',
    agent: 'docs',
    scenario: 'normal',
    expectedContract: 'task-status',
    userMessage: 'Document a new `--dry-run` CLI flag that validates configuration without starting the proxy. Identify README/help updates, state success and failure exit behavior, and provide concise copy.',
    behaviorPatterns: [
      /--dry-run/,
      /validat(e|es|ion).{0,80}(config|configuration)|(config|configuration).{0,80}validat(e|es|ion)/is,
      /without.{0,80}(start|launch).{0,30}proxy|proxy.{0,80}(not|without)/is,
      /README|--help|help text/i,
      /exit\s+codes?|success.{0,40}fail|zero.{0,40}non.?zero/i,
      /(?:^|\n)\s*(?:#{1,6}\s+.*dry.?run|--dry-run\s{2,}|(?:Usage|Examples?):)/im,
    ],
  },
  {
    caseId: 'planner-existing-plan',
    agent: 'planner',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'A complete plan already exists in this conversation for this exact task. Do not create another plan; apply the documented existing-plan recusal boundary.',
    recusalReasonPattern: /(?:already|existing).{0,40}plan|plan.{0,40}(?:already|exists)/i,
  },
  {
    caseId: 'planner-hard-approved-plan',
    agent: 'planner-hard',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'An approved plan already exists in this conversation. Apply the documented approved-plan recusal boundary instead of replanning.',
    recusalReasonPattern: /approved.{0,30}plan|plan.{0,30}(?:approved|already exists)/i,
  },
  {
    caseId: 'explore-write-required',
    agent: 'explore',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'This task requires writing and editing src/config.js. Apply the documented write-required recusal boundary; do not perform read-only reconnaissance.',
    recusalReasonPattern: /writ|edit|read.?only/i,
  },
  {
    caseId: 'coder-missing-credentials',
    agent: 'coder',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'This implementation requires privileged production database credentials that are not present in context. Apply the documented missing-credentials recusal boundary.',
    recusalReasonPattern: /credential|password|privileged|access/i,
  },
  {
    caseId: 'coder-fallback-primary-succeeded',
    agent: 'coder-fallback',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'The primary coder already succeeded with TASK_STATUS: COMPLETE. Apply the documented primary-success recusal boundary; do not retry the work.',
    recusalReasonPattern: /primary coder|already succeeded|complete/i,
  },
  {
    caseId: 'tester-no-implementation',
    agent: 'tester',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'There is no implementation, diff, or concrete code sample to test. Apply the documented no-implementation recusal boundary.',
    recusalReasonPattern: /implementation|diff|code sample|nothing.{0,20}test/i,
  },
  {
    caseId: 'code-reviewer-no-changes',
    agent: 'code-reviewer',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'No code changes or diff exist to review. Apply the documented no-code-changes recusal boundary.',
    recusalReasonPattern: /no (?:code|changes|diff)|(?:code|changes|diff).{0,30}(?:absent|missing|not provided)/i,
  },
  {
    caseId: 'reviewer-security-zero-surface',
    agent: 'reviewer-security',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'The change only renames a private internal constant and has no external input or authentication surface. Apply the documented zero-security-surface recusal boundary.',
    recusalReasonPattern: /zero security|no security|internal|external input|auth/i,
  },
  {
    caseId: 'reviewer-plan-no-plan',
    agent: 'reviewer-plan',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'Neither current.md nor any inline plan content was provided. Apply the documented missing-plan recusal boundary.',
    recusalReasonPattern: /current\.md|plan (?:file|content)|no plan|missing plan/i,
  },
  {
    caseId: 'plan-scheduler-missing-plan-dir',
    agent: 'plan-scheduler',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'No plan_dir was provided. Apply the documented missing-plan boundary and return the recusal result without attempting dispatch.',
    recusalReasonPattern: /plan[_ -]?dir|current\.md/i,
  },
  {
    caseId: 'plan-scheduler-missing-skill',
    agent: 'plan-scheduler',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: [
      'plan_dir/current.md is present and READY_ITEMS contains item-001.',
      'The schedule-plan-tasks skill lookup returned "skill not found" because planning-suite is not installed.',
      'Apply the documented missing-skill recusal boundary and include its installation instruction.',
    ].join('\n'),
    recusalReasonPattern: /planning-suite|schedule-plan-tasks|skill.{0,20}not found/i,
    recusalResponsePatterns: [
      /^INSTALL:\s*\/plugin install planning-suite@claude-craft\s*$/mi,
    ],
  },
  {
    caseId: 'debugger-hypothesis-root-cause-known',
    agent: 'debugger-hypothesis',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'The root cause is already established and confirmed by a reproducer. Apply the documented known-root-cause recusal boundary instead of generating hypotheses.',
    recusalReasonPattern: /root cause|already established|confirmed/i,
  },
  {
    caseId: 'debugger-investigate-already-fixed',
    agent: 'debugger-investigate',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'The issue is already fixed and the regression test passes. Apply the documented already-fixed recusal boundary instead of investigating.',
    recusalReasonPattern: /already fixed|issue.{0,30}fixed|regression.{0,30}pass/i,
  },
  {
    caseId: 'debugger-hard-root-cause-confirmed',
    agent: 'debugger-hard',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'Another debugger agent already confirmed the root cause. Apply the documented confirmed-root-cause recusal boundary; do not hard-debug it again.',
    recusalReasonPattern: /root cause|confirmed|another debugger/i,
  },
  {
    caseId: 'docs-already-current',
    agent: 'docs',
    scenario: 'recusal',
    expectedContract: 'recusal',
    userMessage: 'Documentation for this exact change is already up to date. Apply the documented already-current recusal boundary; do not rewrite it.',
    recusalReasonPattern: /already.{0,30}up.?to.?date|documentation.{0,40}(?:current|up.?to.?date)/i,
  },
].map(entry => Object.freeze({
  ...entry,
  behaviorPatterns: entry.behaviorPatterns
    ? Object.freeze([...entry.behaviorPatterns])
    : undefined,
  recusalResponsePatterns: entry.recusalResponsePatterns
    ? Object.freeze([...entry.recusalResponsePatterns])
    : undefined,
})));

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^([\w-]+):\s*(.*)$/);
    if (pair) fields[pair[1]] = pair[2].trim();
  }
  return fields;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function patternMatches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function hasMandatoryFinalBlockRule(content) {
  return NORMAL_FINAL_BLOCK_RULE.test(content) &&
    RECUSAL_BLOCK_RESERVATION_RULE.test(content);
}

function boundedResponseTail(value, maxChars = FAILURE_RESPONSE_TAIL_CHARS) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error('maxChars must be a positive safe integer');
  }
  const raw = String(value ?? '');
  const normalized = boundedDiagnosticSnippet(raw, Math.max(maxChars, raw.length || 1));
  if (normalized.length <= maxChars) return normalized;
  if (maxChars === 1) return '…';
  return `…${normalized.slice(-(maxChars - 1))}`;
}

function formatContractFailureDiagnostics(response, responseText) {
  const stopReason = response?.json?.stop_reason ?? '(missing)';
  const tail = boundedResponseTail(responseText) || '(empty)';
  return [
    `stop_reason=${JSON.stringify(String(stopReason))}`,
    `response_tail=${JSON.stringify(tail)}`,
  ].join('; ');
}

function validateContractResponseIntegrity(response) {
  if (response?.json?.stop_reason === 'max_tokens') {
    return [
      `model response was truncated at max_tokens=${AGENT_CONTRACT_MAX_TOKENS}`,
    ];
  }
  return [];
}

function preflightAgentContracts(options) {
  const {
    agentsDir,
    modelMapPath,
    cases = AGENT_CONTRACT_CASES,
    requiredCaseAgents = STRUCTURED_AGENTS,
    requiredRecusalCaseAgents = [],
    suiteName = 'agent-contract',
    expectedStructuredCount = STRUCTURED_AGENTS.length,
    classifications = {
      structured: STRUCTURED_AGENTS,
      intentionallyUnstructured: INTENTIONALLY_UNSTRUCTURED_AGENTS,
      routingOnly: ROUTING_ONLY_AGENTS,
    },
  } = options;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(modelMapPath, 'utf8'));
  } catch (error) {
    throw new Error(`${suiteName} preflight failed: cannot read model map: ${error.message}`);
  }

  let agentFiles;
  try {
    agentFiles = fs.readdirSync(agentsDir)
      .filter(file => file.endsWith('.md'))
      .map(file => file.replace(/\.md$/, ''))
      .sort();
  } catch (error) {
    throw new Error(`${suiteName} preflight failed: cannot read agents directory: ${error.message}`);
  }

  const structured = [...classifications.structured];
  const intentionallyUnstructured = [...classifications.intentionallyUnstructured];
  const routingOnly = [...classifications.routingOnly];
  const fileBackedClassifications = [...structured, ...intentionallyUnstructured];
  const allClassifications = [...fileBackedClassifications, ...routingOnly];
  const classificationSet = new Set(allClassifications);
  const fileSet = new Set(agentFiles);
  const mapping = config.agent_to_capability;
  const profiles = config.llm_profiles || {};
  const errors = [];
  const contentsByAgent = new Map();

  if (structured.length !== expectedStructuredCount) {
    errors.push(
      `structured roster has ${structured.length} agents; expected exactly ${expectedStructuredCount}`,
    );
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    errors.push('model map has no agent_to_capability object');
  }
  for (const duplicate of duplicateValues(allClassifications)) {
    errors.push(`agent "${duplicate}" has duplicate/overlapping classifications`);
  }
  for (const agent of agentFiles) {
    if (!classificationSet.has(agent)) {
      errors.push(`agents/${agent}.md has no explicit contract classification`);
    }
    try {
      contentsByAgent.set(
        agent,
        fs.readFileSync(path.join(agentsDir, `${agent}.md`), 'utf8'),
      );
    } catch (error) {
      errors.push(`cannot read agents/${agent}.md: ${error.message}`);
    }
  }
  for (const agent of fileBackedClassifications) {
    if (!fileSet.has(agent)) errors.push(`classified agent file missing: agents/${agent}.md`);
  }
  for (const agent of routingOnly) {
    if (fileSet.has(agent)) {
      errors.push(`routing-only agent "${agent}" must not have an agents/${agent}.md file`);
    }
  }

  const safeMapping = mapping && typeof mapping === 'object' && !Array.isArray(mapping)
    ? mapping
    : {};
  for (const agent of Object.keys(safeMapping)) {
    if (!classificationSet.has(agent)) {
      errors.push(`agent_to_capability["${agent}"] has no explicit contract classification`);
    }
  }
  for (const agent of allClassifications) {
    const capability = safeMapping[agent];
    if (typeof capability !== 'string' || capability.length === 0) {
      errors.push(`agent_to_capability["${agent}"] is missing or empty`);
      continue;
    }
    if (capability.startsWith('model:')) {
      if (capability === 'model:') {
        errors.push(`agent_to_capability["${agent}"] has an empty model pin`);
      }
    } else if (!Object.prototype.hasOwnProperty.call(profiles, capability)) {
      errors.push(
        `agent_to_capability["${agent}"] targets unknown llm_profiles capability "${capability}"`,
      );
    }
  }

  const derivedStructured = [];
  for (const agent of agentFiles) {
    const content = contentsByAgent.get(agent);
    if (!content) continue;
    const frontmatter = parseFrontmatter(content);
    if (frontmatter.name !== agent) {
      errors.push(
        `agents/${agent}.md frontmatter name "${frontmatter.name || '(missing)'}" does not match filename`,
      );
    }
    if (frontmatter.model !== agent) {
      errors.push(
        `agents/${agent}.md frontmatter model "${frontmatter.model || '(missing)'}" does not match filename`,
      );
    }
    if (CURRENT_TASK_STATUS_DECLARATION.test(content)) derivedStructured.push(agent);
  }

  const derivedStructuredSet = new Set(derivedStructured);
  for (const agent of structured) {
    const content = contentsByAgent.get(agent) || '';
    if (!derivedStructuredSet.has(agent)) {
      errors.push(
        `structured agent "${agent}" does not declare TASK_STATUS: COMPLETE | PARTIAL | FAILED`,
      );
    }
    if (!content.includes('STATUS: RECUSE')) {
      errors.push(`structured agent "${agent}" does not declare the separate STATUS: RECUSE path`);
    }
    if (!RECUSAL_REASON_DECLARATION.test(content)) {
      errors.push(
        `structured agent "${agent}" does not require a non-empty REASON or RECUSAL_REASON`,
      );
    }
    if (FINAL_BLOCK_RULE_AGENTS.includes(agent) &&
        !hasMandatoryFinalBlockRule(content)) {
      errors.push(
        `structured agent "${agent}" does not make the normal TASK_STATUS final-block rule explicit`,
      );
    }
  }
  for (const agent of derivedStructured) {
    if (!structured.includes(agent)) {
      errors.push(`agents/${agent}.md declares TASK_STATUS but is not classified as structured`);
    }
  }
  for (const agent of intentionallyUnstructured) {
    const content = contentsByAgent.get(agent);
    if (content && /^TASK_STATUS:/m.test(content)) {
      errors.push(`intentionally-unstructured agent "${agent}" unexpectedly declares TASK_STATUS`);
    }
  }

  const caseIds = [];
  const normalCoveredAgents = new Set();
  const recusalCoveredAgents = new Set();
  for (const entry of cases) {
    if (!entry.caseId || typeof entry.caseId !== 'string') {
      errors.push(`case for "${entry.agent || '(missing agent)'}" has no string caseId`);
    } else {
      caseIds.push(entry.caseId);
    }
    if (!structured.includes(entry.agent)) {
      errors.push(`case "${entry.caseId || '(missing caseId)'}" targets non-structured agent "${entry.agent}"`);
    }
    if (!['normal', 'recusal'].includes(entry.scenario)) {
      errors.push(`case "${entry.caseId || '(missing caseId)'}" has invalid scenario "${entry.scenario}"`);
    }
    if (entry.scenario === 'normal') {
      normalCoveredAgents.add(entry.agent);
      if (entry.expectedContract !== 'task-status') {
        errors.push(
          `actionable normal case "${entry.caseId || '(missing caseId)'}" must require TASK_STATUS`,
        );
      }
      if (!Array.isArray(entry.behaviorPatterns) ||
          entry.behaviorPatterns.length < 2 ||
          entry.behaviorPatterns.some(pattern => !(pattern instanceof RegExp))) {
        errors.push(
          `actionable normal case "${entry.caseId || '(missing caseId)'}" must require at least two behavioral evidence patterns`,
        );
      } else if (!entry.behaviorPatterns.some(
        pattern => !patternMatches(pattern, entry.userMessage || ''),
      )) {
        errors.push(
          `actionable normal case "${entry.caseId || '(missing caseId)'}" must require ` +
          'at least one behavioral signal not already present in its userMessage',
        );
      }
    }
    if (entry.scenario === 'recusal') {
      recusalCoveredAgents.add(entry.agent);
      if (entry.expectedContract !== 'recusal') {
        errors.push(
          `recusal case "${entry.caseId || '(missing caseId)'}" must require STATUS: RECUSE`,
        );
      }
      if (!(entry.recusalReasonPattern instanceof RegExp)) {
        errors.push(
          `recusal case "${entry.caseId || '(missing caseId)'}" must assert its documented reason`,
        );
      }
      if (entry.recusalResponsePatterns !== undefined &&
          (!Array.isArray(entry.recusalResponsePatterns) ||
           entry.recusalResponsePatterns.length === 0 ||
           entry.recusalResponsePatterns.some(pattern => !(pattern instanceof RegExp)))) {
        errors.push(
          `recusal case "${entry.caseId || '(missing caseId)'}" has invalid recusalResponsePatterns`,
        );
      }
    }
    if (typeof entry.userMessage !== 'string' || entry.userMessage.trim() === '') {
      errors.push(`case "${entry.caseId || '(missing caseId)'}" has no userMessage`);
    }
  }
  for (const duplicate of duplicateValues(caseIds)) {
    errors.push(`duplicate caseId "${duplicate}"`);
  }
  for (const agent of requiredCaseAgents) {
    if (!structured.includes(agent)) {
      errors.push(`required case agent "${agent}" is not classified as structured`);
    } else if (!normalCoveredAgents.has(agent)) {
      errors.push(`structured agent "${agent}" has no actionable TASK_STATUS case coverage`);
    }
  }
  for (const agent of requiredRecusalCaseAgents) {
    if (!structured.includes(agent)) {
      errors.push(`required recusal case agent "${agent}" is not classified as structured`);
    } else if (!recusalCoveredAgents.has(agent)) {
      errors.push(`structured agent "${agent}" has no documented recusal case coverage`);
    }
  }

  if (errors.length) {
    throw new Error(`${suiteName} preflight failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    structuredAgents: Object.freeze([...structured]),
    capabilityByAgent: Object.freeze(
      Object.fromEntries(structured.map(agent => [agent, safeMapping[agent]])),
    ),
    cases: cases.map(entry => Object.freeze({
      ...entry,
      expectedCapability: safeMapping[entry.agent],
    })),
  };
}

function validateContractCase(entry, result, responseText = '', options = {}) {
  const errors = [];
  const checkBehavior = options.checkBehavior !== false;
  if (!result || !result.valid) {
    errors.push(result?.reason || 'invalid result contract');
    return errors;
  }
  if (entry.expectedContract === 'task-status' && result.kind !== 'task') {
    errors.push(`expected TASK_STATUS result, got ${result.kind}`);
    return errors;
  }
  if (entry.expectedContract === 'task-status' &&
      !['COMPLETE', 'PARTIAL'].includes(result.status)) {
    errors.push(
      `expected actionable TASK_STATUS: COMPLETE or PARTIAL, got TASK_STATUS: ${result.status}`,
    );
  }
  if (entry.expectedContract === 'recusal' && result.kind !== 'recusal') {
    errors.push(`expected STATUS: RECUSE result, got ${result.kind}`);
    return errors;
  }
  if (checkBehavior && Array.isArray(entry.behaviorPatterns)) {
    const missing = entry.behaviorPatterns.filter(
      pattern => !patternMatches(pattern, responseText),
    );
    if (missing.length > 0) {
      errors.push(
        `response missed ${missing.length}/${entry.behaviorPatterns.length} required behavioral evidence patterns: ` +
        missing.join(', '),
      );
    }
  }
  if (entry.recusalReasonPattern instanceof RegExp) {
    const reason = result.recusalReason || '';
    if (!patternMatches(entry.recusalReasonPattern, reason)) {
      const diagnosticReason = boundedDiagnosticSnippet(reason) || '(missing)';
      errors.push(
        `recusal reason ${JSON.stringify(diagnosticReason)} did not match ` +
        `${entry.recusalReasonPattern}`,
      );
    }
  }
  if (Array.isArray(entry.recusalResponsePatterns)) {
    const missing = entry.recusalResponsePatterns.filter(
      pattern => !patternMatches(pattern, responseText),
    );
    if (missing.length > 0) {
      errors.push(
        `recusal response missed ${missing.length}/${entry.recusalResponsePatterns.length} ` +
        `required contract fields: ${missing.join(', ')}`,
      );
    }
  }
  return errors;
}

function universalNormalRecusalError(cases, observations) {
  const normalCases = cases.filter(entry => entry.scenario === 'normal');
  const byCaseId = new Map(
    observations.map(observation => [observation.caseId, observation.result]),
  );
  if (normalCases.length > 0 &&
      normalCases.every(entry => byCaseId.get(entry.caseId)?.kind === 'recusal')) {
    return `all ${normalCases.length} actionable normal cases returned STATUS: RECUSE`;
  }
  return null;
}

module.exports = {
  STRUCTURED_AGENTS,
  INTENTIONALLY_UNSTRUCTURED_AGENTS,
  ROUTING_ONLY_AGENTS,
  AGENT_CONTRACT_CASES,
  CURRENT_TASK_STATUS_DECLARATION,
  FINAL_BLOCK_RULE_AGENTS,
  FAILURE_RESPONSE_TAIL_CHARS,
  AGENT_CONTRACT_MAX_TOKENS,
  hasMandatoryFinalBlockRule,
  boundedResponseTail,
  formatContractFailureDiagnostics,
  validateContractResponseIntegrity,
  preflightAgentContracts,
  validateContractCase,
  universalNormalRecusalError,
};
