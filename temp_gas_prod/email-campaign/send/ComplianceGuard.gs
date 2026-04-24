function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { isSuppressed } = require('email-campaign/compliance/SuppressionList');
  const { getOptInRecord } = require('email-campaign/storage/CampaignStorage');

  // Active channels — non-email channels are stubs not yet implemented.
  const ACTIVE_CHANNELS = ['email'];

  // Valid campaign states (used for filter validation in CampaignManager).
  const VALID_STATES = ['DRAFT','GENERATING','SCHEDULED','SENDING','PAUSED','COMPLETE','CANCELLED','FAILED'];

  // Regex patterns for deceptive subject detection (CAN-SPAM).
  const DECEPTIVE_PATTERNS = [
    /^re:/i,
    /^fwd:/i,
    /^fw:/i,
    /\bACT NOW\b/i,
    /\bURGENT\b/i,
    /\bLimited Time Offer\b/i,
    /\bYou've been selected\b/i,
    /\bCongratulations.*won\b/i,
  ];

  // Patterns that simulate personal familiarity (FTC guidance on AI content).
  const FAMILIARITY_PATTERNS = [
    /\bAs your (friend|colleague|partner)\b/i,
    /\bWe've been working together\b/i,
    /\bAs we discussed\b/i,
    /\bPer our (last )?conversation\b/i,
  ];

  // Email format validation regex (RFC 5322 simplified).
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /**
   * Validates campaign configuration at build time. Throws on blocking issues.
   * Called by CampaignBuilder.build() before writing to _Campaigns tab.
   *
   * @param {Object} campaign - Campaign fields object
   * @throws {Error} If required fields are missing or invalid
   */
  function validateCampaign(campaign) {
    const errors = [];

    if (!campaign.senderEmail) errors.push('senderEmail is required');
    if (!campaign.senderName) errors.push('senderName is required');
    if (!campaign.physicalAddress) errors.push('physicalAddress is required (CAN-SPAM)');
    if (!campaign.name) errors.push('campaign name is required');

    // Channel guard: only 'email' is active
    const channel = campaign.channel || 'email';
    if (!ACTIVE_CHANNELS.includes(channel)) {
      errors.push('Channel "' + channel + '" is not yet active. Only "email" is supported.');
    }

    // Sender email format
    if (campaign.senderEmail && !EMAIL_REGEX.test(campaign.senderEmail)) {
      errors.push('senderEmail has invalid format: ' + campaign.senderEmail);
    }

    // Validate send-as alias via Gmail Advanced Service
    if (campaign.senderEmail) {
      try {
        const aliases = Gmail.Users.Settings.SendAs.list('me');
        const validAliases = (aliases.sendAs || []).map(a => a.sendAsEmail.toLowerCase());
        const sender = campaign.senderEmail.toLowerCase();
        if (!validAliases.includes(sender)) {
          errors.push(
            'senderEmail "' + campaign.senderEmail + '" is not a verified send-as alias on this Workspace account. ' +
            'DMARC alignment will fail. Valid aliases: ' + validAliases.join(', ')
          );
        }
      } catch (e) {
        // Gmail Advanced Service not yet available — log warning, don't block
        log('[WARN] Could not verify send-as alias: ' + e.message);
      }
    }

    if (errors.length > 0) {
      throw new Error('Campaign validation failed:\n- ' + errors.join('\n- '));
    }
    log('validateCampaign: PASS | campaign=' + campaign.name);
  }

  /**
   * Pre-send check for a single recipient. Returns a result object:
   * { pass: true }  — proceed with send
   * { pass: false, action: 'SUPPRESSED'|'SKIPPED'|'DEFERRED', reason: string }
   *
   * @param {Object} campaign - Campaign config object
   * @param {Object} recipient - Recipient row object
   * @param {Object} [metrics]                    - Campaign health snapshot (optional; omit → guards silently pass)
   * @param {number} [metrics.bounceRate]         - Percent (0–100). e.g. 3.5 = 3.5%. Threshold: > 3
   * @param {number} [metrics.estimatedSpamRate]  - Percent (0–100). e.g. 0.3 = 0.3%. Threshold: > 0.2
   * @param {number} [metrics.dailySentCount]     - Raw count (not checked here; enforced by Campaign.getNextBatch)
   */
  function validateSend(campaign, recipient, metrics) {
    const email = (recipient.email || '').toLowerCase().trim();

    // Email format check
    if (!email || !EMAIL_REGEX.test(email)) {
      return { pass: false, action: 'SKIPPED', reason: 'invalid email format' };
    }

    // Channel guard
    const channel = campaign.channel || 'email';
    if (!ACTIVE_CHANNELS.includes(channel)) {
      return { pass: false, action: 'SKIPPED', reason: 'channel "' + channel + '" not yet active' };
    }

    // Suppression list check
    if (isSuppressed(email)) {
      return { pass: false, action: 'SUPPRESSED', reason: 'email in suppression list' };
    }

    // Prospect opt-in check (required for prospect campaigns)
    if (campaign.type === 'prospect') {
      const optIn = getOptInRecord(email, campaign.campaignId);
      if (!optIn) {
        return {
          pass: false,
          action: 'SKIPPED',
          reason: 'no valid opt-in record for prospect send'
        };
      }
    }

    // Bounce rate auto-pause check (> 3%)
    if (metrics && metrics.bounceRate > 3) {
      return {
        pass: false,
        action: 'DEFERRED',
        reason: 'bounce rate ' + metrics.bounceRate.toFixed(2) + '% exceeds 3% threshold — campaign should be paused'
      };
    }

    // Estimated spam rate check (> 0.2%)
    if (metrics && metrics.estimatedSpamRate > 0.2) {
      return {
        pass: false,
        action: 'DEFERRED',
        reason: 'estimated spam rate ' + metrics.estimatedSpamRate.toFixed(2) + '% exceeds 0.2% threshold'
      };
    }

    return { pass: true };
  }

  /**
   * Validates subject line for deceptive patterns (CAN-SPAM compliance).
   * Returns { pass: boolean, reason?: string }
   */
  function validateSubject(subject) {
    if (!subject) return { pass: false, reason: 'subject is required' };

    for (const pattern of DECEPTIVE_PATTERNS) {
      if (pattern.test(subject)) {
        return { pass: false, reason: 'subject contains deceptive pattern: ' + pattern.toString() };
      }
    }
    return { pass: true };
  }

  /**
   * Validates email body for simulated personal familiarity (FTC AI guidance).
   * Returns { pass: boolean, reason?: string }
   */
  function validateBody(body) {
    if (!body) return { pass: false, reason: 'email body is required' };

    for (const pattern of FAMILIARITY_PATTERNS) {
      if (pattern.test(body)) {
        return { pass: false, reason: 'body contains simulated familiarity pattern: ' + pattern.toString() };
      }
    }
    return { pass: true };
  }

  /**
   * Validates a state filter value before using in queries.
   * @param {string} state
   * @throws {Error} If state is not a valid campaign state enum value
   */
  function validateStateFilter(state) {
    if (state && !VALID_STATES.includes(state)) {
      throw new Error(
        'Invalid state filter "' + state + '". Valid states: ' + VALID_STATES.join(', ')
      );
    }
  }

  module.exports = {
    validateCampaign,
    validateSend,
    validateSubject,
    validateBody,
    validateStateFilter,
    VALID_STATES,
    EMAIL_REGEX,
  };
}

__defineModule__(_main);