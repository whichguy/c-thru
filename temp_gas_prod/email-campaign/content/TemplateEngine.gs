function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { getContentForSegment } = require('email-campaign/storage/CampaignStorage');

  // Maximum rendered body length (Sheets cell limit is 50K; rendered may expand)
  const MAX_RENDERED_CHARS = 48000;

  /**
   * Renders email content for a recipient by merging segment template with recipient fields.
   * Returns {subject, htmlBody, textBody} ready for EmailSender.
   *
   * @param {Object} campaign    - Campaign row from _Campaigns
   * @param {Object} recipient   - Recipient row from _Recipients (includes merge fields)
   * @returns {{ subject, htmlBody, textBody }}
   * @throws {Error} if content not found or rendered body exceeds limit
   */
  function render(campaign, recipient) {
    const segmentId = recipient.segment || 'default';

    // Try segment-specific content, fall back to 'default'
    let content = getContentForSegment(campaign.campaignId, segmentId);
    if (!content || content.status !== 'GENERATED') {
      content = getContentForSegment(campaign.campaignId, 'default');
    }
    if (!content || content.status !== 'GENERATED') {
      throw new Error('No GENERATED content found for campaign ' + campaign.campaignId + ' segment ' + segmentId);
    }

    // Merge fields from recipient row
    const subject  = _substitute(content.subject || '', recipient);
    const htmlBody = _substitute(content.htmlBody || '', recipient);
    const textBody = _substitute(content.textBody || '', recipient);

    // Footer (unsubscribe link + physical address) is injected by EmailSender at send time.
    // EmailSender has the token generation context; TemplateEngine does not. (E1 fix)
    const finalHtml = htmlBody;
    const finalText = textBody;

    // Validate rendered length (Assumption 6 — post-merge expansion)
    if (finalHtml.length > MAX_RENDERED_CHARS) {
      throw new Error(
        'Rendered htmlBody exceeds ' + MAX_RENDERED_CHARS + ' chars for recipient ' +
        recipient.email + ' (' + finalHtml.length + ' chars)'
      );
    }

    // Validate no unresolved merge fields remain
    const unresolved = _findUnresolved(subject + ' ' + finalHtml + ' ' + finalText);
    if (unresolved.length > 0) {
      log('[WARN] TemplateEngine.render: unresolved placeholders | email=' + recipient.email +
          ' fields=' + unresolved.join(', '));
      // Non-fatal: send with placeholders visible rather than blocking (author review recommended)
    }

    return { subject, htmlBody: finalHtml, textBody: finalText };
  }

  /**
   * Substitutes {{fieldName}} placeholders with values from the recipient object.
   * Unknown placeholders are left as-is (visible in the sent email).
   */
  function _substitute(template, recipient) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, field) => {
      const val = recipient[field];
      return val !== undefined && val !== null && val !== '' ? String(val) : match;
    });
  }

  /**
   * Returns a list of unresolved {{placeholder}} names remaining after substitution.
   */
  function _findUnresolved(text) {
    const matches = text.match(/\{\{(\w+)\}\}/g) || [];
    // Exclude the UNSUBSCRIBE_URL placeholder which is resolved by EmailSender
    return [...new Set(matches.filter(m => m !== '{{UNSUBSCRIBE_URL}}'))];
  }

  module.exports = { render, _substitute, _findUnresolved };
}

__defineModule__(_main);