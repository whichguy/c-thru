#!/usr/bin/env node
'use strict';
/**
 * Shared pin-match + identity scoring for brand-leaf probes.
 * Used by test/c-thru-brand-identity-live.sh (via node -e require) and unit tests.
 */

const _GENERIC_PARTS = new Set([
  'cloud', 'local', 'pro', 'flash', 'plus', 'mini', 'base', 'chat',
  'instruct', 'latest', 'free', 'fast', 'slow', 'oss',
]);

/**
 * True only when **served_by** evidence matches the expected pin.
 * Request `model` alone is NOT enough: silent fallback (e.g. xAI 402 →
 * generalist/glm) can leave model=grok while served_by is another backend.
 *
 * @param {string} expectedPin
 * @param {{ served_by?: string, model?: string }} row
 */
function pinMatches(expectedPin, row) {
  const exp = String(expectedPin || '').trim().toLowerCase();
  if (!exp) return false;
  const sb = String((row && row.served_by) || '').toLowerCase();
  if (!sb) return false;
  // Exact / substring on served_by (gemini-pro vs gemini-pro-latest)
  if (sb === exp || sb.includes(exp) || exp.includes(sb)) return true;
  const pinCore = exp.split(':')[0];
  if (pinCore.length >= 4 && (sb.includes(pinCore) || pinCore.includes(sb.split(':')[0]))) {
    return true;
  }
  const fam = pinCore.split(/[-:]/)[0];
  if (fam.length >= 3 && !_GENERIC_PARTS.has(fam) && sb.includes(fam)) return true;
  return false;
}

const POSITIVE = {
  deepseek: /\bdeepseek\b/i,
  qwen: /\bqwen\b|\btongyi\b|\balibaba\b/i,
  kimi: /\bkimi\b|\bmoonshot\b/i,
  glm: /\bglm\b|\bz\.?ai\b|\bthudm\b/i,
  gemma: /\bgemma\b|\bgoogle\b/i,
  'gpt-oss': /\bgpt-?oss\b/i,
  xai: /\bgrok\b|\bxai\b/i,
  gemini: /\bgemini\b|\bgoogle\b/i,
  'anthropic-claude': /\bclaude\b|\banthropic\b/i,
};

const CLAUDE_CLAIM_RE = new RegExp(
  String.raw`\b(I(?:'m| am)\s+Claude|Claude\s+Sonnet|Claude\s+Opus|Claude\s+Haiku|` +
    String.raw`built by Anthropic|made by Anthropic|model ID [` + '`' + String.raw`']?claude-|` +
    String.raw`powered by the Sonnet|I(?:'m| am)\s+ChatGPT)\b`,
  'i',
);

/**
 * @param {{ agent: string, family: string, leafText: string }} args
 * @returns {{ identity_ok: boolean, reason: string, claude_claim: boolean, has_positive: boolean, advisory?: boolean }}
 */
function scoreIdentity({ agent, family, leafText }) {
  const text = String(leafText || '');
  const fam = String(family || '').toLowerCase();
  const claudeFam = fam === 'anthropic-claude' || fam === 'claude';
  const claudeClaim = CLAUDE_CLAIM_RE.test(text);
  const posRe = POSITIVE[fam];
  const hasPositive = Boolean(posRe && posRe.test(text));

  // gpt-oss: models often claim ChatGPT — identity is advisory only (plan C1/U3).
  if (fam === 'gpt-oss') {
    if (!text.trim()) {
      return {
        identity_ok: true,
        reason: 'gpt-oss empty leaf (advisory identity)',
        claude_claim: claudeClaim,
        has_positive: hasPositive,
        advisory: true,
      };
    }
    return {
      identity_ok: true,
      reason: claudeClaim
        ? 'gpt-oss ChatGPT/Claude claim (advisory; invoke still required)'
        : hasPositive
          ? 'gpt-oss family signal (advisory ok)'
          : 'gpt-oss identity advisory',
      claude_claim: claudeClaim,
      has_positive: hasPositive,
      advisory: true,
    };
  }

  if (!text.trim()) {
    return { identity_ok: false, reason: 'empty leaf text', claude_claim: false, has_positive: false };
  }
  if (claudeFam) {
    const ok = claudeClaim || hasPositive;
    return {
      identity_ok: ok,
      reason: ok ? 'claude family ok' : 'claude family missing Claude/Anthropic claim',
      claude_claim: claudeClaim,
      has_positive: hasPositive,
    };
  }
  if (claudeClaim) {
    return {
      identity_ok: false,
      reason: 'non-claude family claimed Claude/Anthropic/ChatGPT',
      claude_claim: true,
      has_positive: hasPositive,
    };
  }
  if (hasPositive) {
    return {
      identity_ok: true,
      reason: 'family signal present',
      claude_claim: false,
      has_positive: true,
    };
  }
  return {
    identity_ok: true,
    reason: 'no claude misclaim (weak family signal)',
    claude_claim: false,
    has_positive: false,
  };
}

module.exports = {
  pinMatches,
  scoreIdentity,
  _GENERIC_PARTS,
  CLAUDE_CLAIM_RE,
};
