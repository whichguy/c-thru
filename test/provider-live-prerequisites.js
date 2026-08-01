'use strict';

const OPENAI_QUOTA_SENTENCE =
  'You exceeded your current quota, please check your plan and billing details.';
const XAI_CREDIT_SENTENCE =
  'has either used all available credits or reached its monthly spending limit.';
const XAI_REMEDIATION_SENTENCE =
  'please purchase more credits or raise your spending limit.';
const LIVE_OUTCOME_PREFIX = 'C_THRU_LIVE_OUTCOME';

function liveOutcomeField(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:/+-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'none';
}

// Stable line protocol consumed by test/run-all.sh. Keep every field on one
// line and delimiter-safe so shell runners can distinguish a provider block
// from a real pass without needing jq or interpreting human prose.
function liveOutcomeLine(provider, suite, status, reason) {
  const allowed = new Set(['passed', 'skipped', 'blocked', 'failed']);
  if (!allowed.has(status)) {
    throw new TypeError(`invalid live outcome status: ${status}`);
  }
  return [
    LIVE_OUTCOME_PREFIX,
    `provider=${liveOutcomeField(provider)}`,
    `suite=${liveOutcomeField(suite)}`,
    `status=${status}`,
    `reason=${liveOutcomeField(reason)}`,
  ].join('|');
}

function emitLiveOutcome(provider, suite, status, reason) {
  const line = liveOutcomeLine(provider, suite, status, reason);
  console.log(line);
  return line;
}

function responseJson(response) {
  if (response?.json && typeof response.json === 'object') return response.json;
  const raw = response?.bodyText ?? response?.body;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function responseText(response) {
  const raw = response?.bodyText ?? response?.body;
  if (typeof raw === 'string') return raw;
  const json = responseJson(response);
  return json ? JSON.stringify(json) : '';
}

function classifyOpenAIBillingBlock(response) {
  if (!response || response.status !== 429) return null;
  const json = responseJson(response);
  const code = json?.error?.code;
  const text = responseText(response);
  if (code === 'insufficient_quota' || text.includes(OPENAI_QUOTA_SENTENCE)) {
    return 'OpenAI insufficient_quota';
  }
  return null;
}

function classifyXaiBillingBlock(response) {
  if (!response || response.status !== 403) return null;
  const json = responseJson(response);
  const text = responseText(response).toLowerCase();
  if (json?.code === 'permission-denied' &&
      text.includes(XAI_CREDIT_SENTENCE) &&
      text.includes(XAI_REMEDIATION_SENTENCE)) {
    return 'xAI permission-denied spending/credit limit';
  }
  return null;
}

module.exports = {
  OPENAI_QUOTA_SENTENCE,
  XAI_CREDIT_SENTENCE,
  XAI_REMEDIATION_SENTENCE,
  LIVE_OUTCOME_PREFIX,
  liveOutcomeLine,
  emitLiveOutcome,
  classifyOpenAIBillingBlock,
  classifyXaiBillingBlock,
};
