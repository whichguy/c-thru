'use strict';

// Shared classify_intent logic — used by llm-capabilities-mcp.js and claude-proxy.
// No external deps; Node.js stdlib only.

const CLASSIFY_INTENT_DEF = {
  description: 'Best first tool for a raw prompt. Use it when the request is ambiguous, underspecified, or needs routing. It takes a prompt and returns an intent classification, confidence, recommended next tool, and clarification questions.',
  category: 'classifier',
  supportsPromptAlias: true,
  responseGuidance: 'Classify the prompt, recommend the most appropriate next tool when one is clear, and ask only the minimum clarification questions needed to unblock progress.',
  extraOutput: {
    recommended_tool: { type: ['string', 'null'] },
    clarification_questions: { type: 'array', items: { type: 'string' } },
  },
};

function resolveCapabilityModel(config, toolName) {
  const capabilities = config.llm_capabilities || {};
  const entry = capabilities[toolName] || capabilities.default;
  if (!entry || typeof entry.model !== 'string' || !entry.model.trim()) {
    throw new Error(`No llm_capabilities model configured for ${toolName}`);
  }
  return entry.model.trim();
}

function buildClassifyOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['result', 'confidence', 'recuse_reason', 'dynamic_hints'],
    properties: {
      result: { type: 'string' },
      confidence: { type: 'integer', minimum: 0, maximum: 100 },
      recuse_reason: { type: ['string', 'null'] },
      dynamic_hints: { type: 'array', items: { type: 'string' } },
      recommended_tool: { type: ['string', 'null'] },
      clarification_questions: { type: 'array', items: { type: 'string' } },
    },
  };
}

function buildClassifyPrompt(prompt, modelName) {
  const outputSchema = JSON.stringify(buildClassifyOutputSchema(), null, 2);
  const dynamicHints = [
    CLASSIFY_INTENT_DEF.responseGuidance,
    'Set dynamic_hints to concise routing cues for the next LLM turn, for example which tool to call next or what missing input would unblock progress.',
  ];
  const system = [
    'You are executing the logical MCP tool "classify_intent".',
    CLASSIFY_INTENT_DEF.description,
    `The requested model identifier for this call is "${modelName}".`,
    'Return strict JSON only. The first character of your response must be "{". Do not wrap it in markdown.',
    'If you cannot answer reliably, set recuse_reason and keep result minimal.',
    'Always include dynamic_hints as a JSON array. Use an empty array when there are no useful downstream hints.',
    'Tool-specific response guidance:',
    ...dynamicHints.map(hint => `- ${hint}`),
    'Use this exact JSON schema:',
    outputSchema,
  ].join('\n\n');
  return { system, user: `Prompt:\n${prompt}` };
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
  try { return { parsed: JSON.parse(trimmed), kind: 'strict_json' }; } catch {}
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    try { return { parsed: JSON.parse(fencedMatch[1].trim()), kind: 'fenced_json' }; } catch {}
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return { parsed: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)), kind: 'embedded_json' }; } catch {}
  }
  return { parsed: null, kind: 'unparsed_text' };
}

function normalizeClassifyResult(parsed, rawText) {
  const parsedConfidence = Number.isInteger(parsed?.confidence) ? parsed.confidence : 0;
  return {
    result: typeof parsed?.result === 'string' ? parsed.result : rawText || '',
    confidence: Math.max(0, Math.min(100, parsedConfidence)),
    recuse_reason: typeof parsed?.recuse_reason === 'string' ? parsed.recuse_reason : null,
    dynamic_hints: Array.isArray(parsed?.dynamic_hints) ? parsed.dynamic_hints.map(String) : [],
    recommended_tool: typeof parsed?.recommended_tool === 'string' ? parsed.recommended_tool : null,
    clarification_questions: Array.isArray(parsed?.clarification_questions) ? parsed.clarification_questions.map(String) : [],
  };
}

/**
 * Classify a prompt's intent.
 *
 * @param {string} prompt - The user prompt to classify.
 * @param {object} config - Loaded model-map config (must have llm_capabilities.classify_intent.model).
 * @param {function} postToMessages - async (payload) => responseBody. Caller supplies the HTTP call
 *   so this module has no http dependency and both mcp and proxy can inject their own transport.
 * @returns {Promise<{result, confidence, recuse_reason, recommended_tool, clarification_questions, dynamic_hints}>}
 */
async function classifyIntent(prompt, config, postToMessages) {
  const modelName = resolveCapabilityModel(config, 'classify_intent');
  const { system, user } = buildClassifyPrompt(prompt, modelName);
  const body = await postToMessages({
    model: modelName,
    max_tokens: 1200,
    stream: false,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const rawText = parseTextResponse(body);
  const { parsed } = tryParseJsonText(rawText);
  return normalizeClassifyResult(parsed, rawText);
}

module.exports = {
  CLASSIFY_INTENT_DEF,
  resolveCapabilityModel,
  buildClassifyPrompt,
  parseTextResponse,
  tryParseJsonText,
  normalizeClassifyResult,
  classifyIntent,
};
