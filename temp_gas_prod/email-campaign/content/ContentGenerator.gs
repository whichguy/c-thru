function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const {
    getCampaign, writeContent,
  } = require('email-campaign/storage/CampaignStorage');
  const { Campaign } = require('email-campaign/core/Campaign');

  // Character limits (Sheets cell max ≈ 50,000 chars)
  const MAX_HTML_CHARS = 48000;
  const MAX_TEXT_CHARS = 10000;

  // Claude model for content generation (cost/speed optimized)
  const CONTENT_MODEL = 'claude-haiku-4-5-20251001';

  /**
   * Generates email content for all segments of a campaign.
   * Transitions campaign DRAFT → GENERATING → SCHEDULED on completion.
   * @param {Object} e - Trigger event (may contain campaignId as property)
   */
  function generateForCampaign(e) {
    const campaignId = (e && e.campaignId) || (e && e.parameter && e.parameter.campaignId);
    if (!campaignId) {
      log('[ERROR] ContentGenerator.generateForCampaign: no campaignId in event');
      return;
    }

    const campaign = getCampaign(campaignId);
    if (!campaign) {
      log('[ERROR] ContentGenerator.generateForCampaign: campaign not found | id=' + campaignId);
      return;
    }

    log('ContentGenerator.generateForCampaign | id=' + campaignId + ' name=' + campaign.name);

    // MODIFIED: reordered GENERATING transition before JSON parse — see Phase 1 fix
    // Transition early so invalid JSON triggers GENERATING→FAILED (not silent DRAFT)
    new Campaign(campaignId).transitionTo('GENERATING', {}, true);

    let strategy;
    try {
      strategy = typeof campaign.contentStrategy === 'string'
        ? JSON.parse(campaign.contentStrategy)
        : (campaign.contentStrategy || {});
    } catch (err) {
      log('[ERROR] ContentGenerator: invalid contentStrategy JSON: ' + err.message);
      new Campaign(campaignId).transitionTo('FAILED', {
        notes: 'Invalid contentStrategy JSON: ' + err.message,
      }, true);
      return;
    }

    const segments = _resolveSegments(strategy);
    log('ContentGenerator: generating for ' + segments.length + ' segment(s)');

    let allSucceeded = true;
    for (const segmentId of segments) {
      try {
        _generateSegment(campaign, segmentId, strategy);
      } catch (err) {
        log('[ERROR] ContentGenerator: segment failed | id=' + campaignId + ' seg=' + segmentId + ' err=' + err.message);
        writeContent(campaignId, segmentId, {
          status:      'FAILED',
          generatedAt: new Date().toISOString(),
        });
        allSucceeded = false;
      }
    }

    // Transition to SCHEDULED via state machine when all segments succeeded — S13 fix
    if (allSucceeded) {
      new Campaign(campaignId).transitionTo('SCHEDULED', {}, true);
      log('ContentGenerator: content generation complete → SCHEDULED | id=' + campaignId);
    } else {
      // Partial failure — transition to FAILED so author is notified and can retry
      try {
        new Campaign(campaignId).transitionTo('FAILED', {
          notes: 'Partial content generation failure — review _CampaignContent tab',
        }, true);
      } catch (te) {
        log('[ERROR] ContentGenerator: could not transition to FAILED: ' + te.message);
      }
      log('[WARN] ContentGenerator: partial generation failure — campaign set to FAILED | id=' + campaignId);
    }
  }

  /**
   * Generates content for a single segment via Claude API.
   * Validates HTML length before writing (Assumption 6).
   */
  function _generateSegment(campaign, segmentId, strategy) {
    log('ContentGenerator._generateSegment | seg=' + segmentId);

    const prompt = _buildPrompt(campaign, segmentId, strategy);
    const response = _callClaude(prompt);
    const content = _parseContent(response);

    // Validate HTML length (Sheets cell limit)
    if (content.htmlBody && content.htmlBody.length > MAX_HTML_CHARS) {
      log('[WARN] ContentGenerator: htmlBody exceeds ' + MAX_HTML_CHARS + ' chars for seg=' + segmentId + ' — marking FAILED');
      writeContent(campaign.campaignId, segmentId, {
        status:      'FAILED',
        generatedAt: new Date().toISOString(),
      });
      throw new Error('Generated htmlBody exceeds cell limit (' + content.htmlBody.length + ' chars)');
    }
    if (content.textBody && content.textBody.length > MAX_TEXT_CHARS) {
      content.textBody = content.textBody.substring(0, MAX_TEXT_CHARS) + '\n[truncated]';
      log('[WARN] ContentGenerator: textBody truncated to ' + MAX_TEXT_CHARS + ' chars | seg=' + segmentId);
    }

    writeContent(campaign.campaignId, segmentId, {
      subject:     content.subject || '',
      htmlBody:    content.htmlBody || '',
      textBody:    content.textBody || '',
      status:      'GENERATED',
      generatedAt: new Date().toISOString(),
      model:       CONTENT_MODEL,
    });

    log('ContentGenerator._generateSegment: done | seg=' + segmentId);
  }

  /**
   * Builds the Claude API prompt for a segment.
   * Includes campaign context, system prompt override, merge-field instructions.
   */
  function _buildPrompt(campaign, segmentId, strategy) {
    const senderName = campaign.senderName || 'the sender';
    const mergeFields = Array.isArray(strategy.mergeFields) ? strategy.mergeFields : [];
    const systemPrompt = strategy.systemPrompt ||
      'You are an expert email copywriter. Write professional, honest marketing emails that comply with CAN-SPAM.';

    const mergeInstructions = mergeFields.length > 0
      ? 'Use these merge fields in the copy where natural: ' + mergeFields.map(f => '{{' + f + '}}').join(', ') + '.'
      : '';

    const segmentContext = segmentId === 'default' ? '' : 'This email is for the "' + segmentId + '" audience segment. ';

    return {
      model: CONTENT_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          'Write a marketing email for the following campaign:',
          '',
          'Campaign name: ' + campaign.name,
          'Sender: ' + senderName,
          'Campaign type: ' + (campaign.type || 'existing_customer'),
          segmentContext + mergeInstructions,
          '',
          'Requirements:',
          '- Write an attention-grabbing subject line (max 60 chars)',
          '- Write a plain-text version of the email body',
          '- Write an HTML version of the email body (professional formatting)',
          '- Do NOT include unsubscribe links or physical address (added by system)',
          '- Do NOT add fake familiarity (e.g. "As you know", "I wanted to reach out personally")',
          '- Merge fields use {{fieldName}} syntax',
          '',
          'Respond in this EXACT JSON format (no markdown, no code blocks):',
          '{"subject":"...","htmlBody":"...","textBody":"..."}',
        ].filter(Boolean).join('\n'),
      }],
    };
  }

  /**
   * Calls Claude API via UrlFetchApp. Returns response text.
   * Retries up to 3 times with exponential backoff on 429/5xx responses.
   */
  function _callClaude(payload) {
    const ConfigManager = require('common-js/ConfigManager');
    const cm = new ConfigManager('SHEETS_CHAT');
    const apiKey = cm.get('ANTHROPIC_API_KEY', null);
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const RETRYABLE = [429, 500, 502, 503, 529];
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post',
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });

      const code = response.getResponseCode();
      const text = response.getContentText();

      if (code === 200) {
        const parsed = JSON.parse(text);
        if (!parsed.content || !parsed.content[0] || !parsed.content[0].text) {
          throw new Error('Claude API 200 response missing content[0].text: ' + text.substring(0, 200));
        }
        return parsed.content[0].text;
      }

      if (RETRYABLE.includes(code) && attempt < MAX_ATTEMPTS - 1) {
        const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s
        log('[WARN] ContentGenerator._callClaude: HTTP ' + code + ' — retrying in ' + delayMs + 'ms (attempt ' + (attempt + 1) + '/' + MAX_ATTEMPTS + ')');
        Utilities.sleep(delayMs);
        continue;
      }

      throw new Error('Claude API error ' + code + ': ' + text.substring(0, 200));
    }
  }

  /**
   * Parses the Claude JSON response into {subject, htmlBody, textBody}.
   * Throws on parse failure so the segment is marked FAILED.
   */
  function _parseContent(responseText) {
    // Strip any accidental markdown code fences
    const cleaned = responseText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      throw new Error('Failed to parse Claude response as JSON: ' + err.message + ' | raw=' + cleaned.substring(0, 200));
    }
  }

  /**
   * Resolves the list of segment IDs to generate from strategy config.
   * Falls back to ['default'] if no segments defined.
   */
  function _resolveSegments(strategy) {
    if (Array.isArray(strategy.segments)) {
      // segments: ['tier_gold', 'tier_silver', 'prospect']
      return strategy.segments.length > 0 ? strategy.segments : ['default'];
    }
    if (typeof strategy.segments === 'number' && strategy.segments > 0) {
      // segments: 3 → ['segment_1', 'segment_2', 'segment_3']
      return Array.from({ length: strategy.segments }, (_, i) => 'segment_' + (i + 1));
    }
    return ['default'];
  }

  const ContentGenerator = { generateForCampaign };
  module.exports = { generateForCampaign, ContentGenerator, _parseContent };
}

__defineModule__(_main);