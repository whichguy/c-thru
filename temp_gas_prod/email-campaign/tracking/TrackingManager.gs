function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const {
    listCampaigns, updateCampaign,
    getRecipients, updateRecipient, bulkUpdateRecipients, addSuppression,
  } = require('email-campaign/storage/CampaignStorage');
  const { Campaign } = require('email-campaign/core/Campaign');

  const BOUNCE_RATE_THRESHOLD = 0.03;   // 3%  — auto-pause
  const SPAM_RATE_THRESHOLD   = 0.002;  // 0.2% — auto-pause
  const DELIVERY_HOURS        = 24;     // SENT → DELIVERED inference window (hours)
  const BUDGET_MS             = 5.5 * 60 * 1000;

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Main entry point — poll all trackable campaigns.
   * Called by pollCampaignTracking() in entrypoints.gs.
   */
  function pollAll(e) {
    const startTime = Date.now();
    log('TrackingManager.pollAll | triggerUid=' + (e && e.triggerUid));

    const campaigns = listCampaigns().filter(c =>
      ['SENDING', 'PAUSED', 'COMPLETE'].includes(c.state)
    );

    if (campaigns.length === 0) {
      log('TrackingManager.pollAll: no trackable campaigns');
      return;
    }

    // Single Gmail bounce search distributed across all campaigns (Q38)
    _processBounces(campaigns, startTime);

    if (Date.now() - startTime < BUDGET_MS) {
      _processReplies(campaigns, startTime);
    }
    if (Date.now() - startTime < BUDGET_MS) {
      _processDelivery(campaigns, startTime);
    }

    for (const c of campaigns) {
      if (Date.now() - startTime > BUDGET_MS) break;
      if (c.state === 'COMPLETE') continue; // no auto-pause for COMPLETE
      _recalculateAndCheckHealth(c);
    }

    PropertiesService.getScriptProperties()
      .setProperty('lastBounceSearchTime', new Date().toISOString());

    log('TrackingManager.pollAll: done | elapsed=' + (Date.now() - startTime) + 'ms');
  }

  // ─── Bounce detection ────────────────────────────────────────────────────

  /**
   * Performs ONE Gmail inbox search and distributes bounce results across all
   * active campaigns by matching DSN message-id references against the combined
   * recipient set. Prevents N concurrent campaigns from creating N redundant searches.
   */
  function _processBounces(campaigns, startTime) {
    const props = PropertiesService.getScriptProperties();
    const lastSearch = props.getProperty('lastBounceSearchTime');
    const afterDate = _gmailDate(lastSearch
      ? new Date(lastSearch)
      : new Date(Date.now() - 48 * 3600 * 1000)
    );

    // Build combined lookup maps across all campaigns
    const msgIdMap = {};    // '<msg-id>' → { campaignId, email }
    const emailMap = {};    // 'email@lc' → [{ campaignId, email }]
    const rowIndexMap = {}; // 'campaignId:email@lc' → rowIndex (for batch write)
    for (const c of campaigns) {
      const recipients = getRecipients(c.campaignId);
      for (const r of recipients) {
        const d = r.data;
        if (d.status === 'BOUNCED') continue; // already recorded
        if (d.messageId) {
          const key = d.messageId.startsWith('<') ? d.messageId : '<' + d.messageId + '>';
          const normalizedEmail = d.email ? d.email.toLowerCase().trim() : d.email;
          msgIdMap[key] = { campaignId: c.campaignId, email: normalizedEmail };
        }
        if (d.email) {
          const em = d.email.toLowerCase().trim(); // normalized key — must match rowIndexMap lookup
          if (!emailMap[em]) emailMap[em] = [];
          emailMap[em].push({ campaignId: c.campaignId, email: em });
          rowIndexMap[c.campaignId + ':' + em] = r.rowIndex;
        }
      }
    }

    let threads;
    try {
      threads = GmailApp.search(
        'from:mailer-daemon OR from:postmaster after:' + afterDate,
        0, 50
      );
    } catch (err) {
      log('[ERROR] TrackingManager._processBounces: ' + err.message);
      return;
    }
    log('TrackingManager._processBounces: ' + threads.length + ' thread(s) | after=' + afterDate);

    // Batch updates — collect bounce patches and suppression requests before writing
    const bounceUpdates = [];
    const hardBounces = []; // { email, campaignId } — for addSuppression (LockService, non-batchable)
    for (const thread of threads) {
      if (Date.now() - startTime > BUDGET_MS) break;
      try {
        for (const msg of thread.getMessages()) {
          const body = msg.getPlainBody() || '';
          _matchAndRecordBounce(body, msgIdMap, emailMap, rowIndexMap, bounceUpdates, hardBounces);
        }
      } catch (err) {
        log('[WARN] TrackingManager._processBounces thread: ' + err.message);
      }
    }

    // Single batch write for all bounce status updates
    if (bounceUpdates.length > 0) {
      bulkUpdateRecipients(bounceUpdates);
      log('TrackingManager._processBounces: ' + bounceUpdates.length + ' recipient(s) → BOUNCED');
    }
    // Suppression writes use LockService and cannot be batched
    for (const { email, campaignId } of hardBounces) {
      try {
        addSuppression(email, 'hard_bounce', 'campaign:' + campaignId, 'bounce');
      } catch (err) {
        log('[WARN] TrackingManager._processBounces: suppression failed for ' + email + ': ' + err.message);
      }
    }
  }

  /**
   * Matches a DSN body to a campaign recipient using message-id (primary)
   * or Final/Original-Recipient email (fallback).
   */
  function _matchAndRecordBounce(dsnBody, msgIdMap, emailMap, rowIndexMap, bounceUpdates, hardBounces) {
    let match;
    // Primary: match by Original-Message-ID (RFC 3461)
    const idMatch = dsnBody.match(/(?:Original-)?Message-ID:\s*<([^>]+)>/i);
    if (idMatch) {
      const key = '<' + idMatch[1] + '>';
      match = msgIdMap[key];
    }
    // Fallback: match by Final-Recipient or Original-Recipient address
    if (!match) {
      const recipMatch = dsnBody.match(/(?:Final|Original)-Recipient:\s*rfc822;\s*([^\s\r\n<>]+)/i);
      if (recipMatch) {
        const em = recipMatch[1].toLowerCase().replace(/[<>]/g, '').trim();
        const matches = emailMap[em];
        if (matches && matches.length > 0) {
          match = matches[matches.length - 1]; // most recently added campaign
        }
      }
    }
    if (!match) return;

    const { campaignId, email } = match;
    const bounceType = _classifyBounce(dsnBody);
    log('TrackingManager._matchAndRecordBounce | ' + email + ' type=' + bounceType);

    const rowIndex = rowIndexMap[campaignId + ':' + email.toLowerCase()];
    if (rowIndex !== undefined) {
      bounceUpdates.push({
        rowIndex,
        fields: { status: 'BOUNCED', bouncedAt: new Date().toISOString(), bounceType },
      });
    } else {
      // rowIndex missing (data race or email key mismatch) — fall back to individual write
      updateRecipient(campaignId, email, { status: 'BOUNCED', bouncedAt: new Date().toISOString(), bounceType });
    }
    if (bounceType === 'hard') {
      hardBounces.push({ email, campaignId });
    }
  }

  /**
   * Classifies a bounce as 'hard' (permanent) or 'soft' (temporary).
   * Uses RFC 3463 status codes (5.x.x = hard, 4.x.x = soft) with keyword fallback.
   */
  function _classifyBounce(body) {
    const m = body.match(/(?:Status:|smtp;\s*)\s*([45])\.\d+\.\d+/i);
    if (m) return m[1] === '5' ? 'hard' : 'soft';
    if (/\b55[0-4]\b|user unknown|does not exist|no such user|mailbox not found|invalid recipient/i.test(body)) {
      return 'hard';
    }
    return 'soft';
  }

  // ─── Reply detection ─────────────────────────────────────────────────────

  /**
   * Checks each SENT/DELIVERED recipient's Gmail thread for inbound replies.
   */
  function _processReplies(campaigns, startTime) {
    for (const c of campaigns) {
      if (Date.now() - startTime > BUDGET_MS) break;
      if (c.state === 'COMPLETE') continue;
      const sent = getRecipients(c.campaignId).filter(r =>
        ['SENT', 'DELIVERED'].includes(r.data.status) && r.data.threadId
      );
      for (const r of sent) {
        if (Date.now() - startTime > BUDGET_MS) break;
        try { _checkReply(c, r.data); } catch (err) {
          log('[WARN] TrackingManager._processReplies: ' + err.message);
        }
      }
    }
  }

  /**
   * Marks a recipient REPLIED when a non-sender message is detected in their thread.
   */
  function _checkReply(campaign, rData) {
    const thread = GmailApp.getThreadById(rData.threadId);
    if (!thread) return;
    const messages = thread.getMessages();
    if (messages.length <= 1) return;

    // Inbound only when last message is from the exact recipient address (avoids false positives from auto-replies)
    const lastMsg = messages[messages.length - 1];
    const rawFrom = lastMsg.getFrom();
    const fromAddrMatch = rawFrom.match(/<([^>]+)>/);
    const fromAddr = (fromAddrMatch ? fromAddrMatch[1] : rawFrom).toLowerCase();
    if (fromAddr === rData.email.toLowerCase().trim()) {
      updateRecipient(campaign.campaignId, rData.email, {
        status:    'REPLIED',
        repliedAt: new Date().toISOString(),
      });
      log('TrackingManager._checkReply: REPLIED | ' + rData.email);
    }
  }

  // ─── Delivery inference ──────────────────────────────────────────────────

  /**
   * Promotes SENT recipients to DELIVERED after DELIVERY_HOURS with no bounce.
   */
  function _processDelivery(campaigns, startTime) {
    const cutoff = new Date(Date.now() - DELIVERY_HOURS * 3600 * 1000);
    for (const c of campaigns) {
      if (Date.now() - startTime > BUDGET_MS) break;
      // Batch updates — avoids per-row Sheets API calls that exhaust the 300 calls/min quota on large campaigns
      const deliveryUpdates = [];
      for (const r of getRecipients(c.campaignId, 'SENT')) {
        const sentAt = r.data.sentAt ? new Date(r.data.sentAt) : null;
        if (sentAt && sentAt < cutoff) {
          deliveryUpdates.push({ rowIndex: r.rowIndex, fields: { status: 'DELIVERED', deliveredAt: new Date().toISOString() } });
        }
      }
      if (deliveryUpdates.length > 0) {
        bulkUpdateRecipients(deliveryUpdates);
        log('TrackingManager._processDelivery: ' + deliveryUpdates.length + ' → DELIVERED | id=' + c.campaignId);
      }
    }
  }

  // ─── Aggregate recalculation + health check ──────────────────────────────

  /**
   * Recalculates _Campaigns aggregate counters and checks auto-pause thresholds.
   * Delegates counting to Campaign.computeAggregates() (shared with Campaign.recalculateAggregates).
   */
  function _recalculateAndCheckHealth(campaign) {
    const agg = Campaign.computeAggregates(campaign.campaignId);
    if (agg.total === 0) return;

    updateCampaign(campaign.campaignId, {
      sent: agg.sent, failed: agg.failed, bounced: agg.bounced,
      replied: agg.replied, unsubscribed: agg.unsubscribed, skipped: agg.skipped,
      estimatedSpamRate: agg.estimatedSpamRate,
    });

    // Auto-pause threshold check (SENDING campaigns only)
    if (campaign.state !== 'SENDING') return;
    const bounceRate = agg.bounceRate;
    const spamRate   = agg.bounceRate + agg.unsubRate;
    if (bounceRate > BOUNCE_RATE_THRESHOLD || spamRate > SPAM_RATE_THRESHOLD) {
      const reason = bounceRate > BOUNCE_RATE_THRESHOLD
        ? 'Bounce rate ' + (bounceRate * 100).toFixed(2) + '% exceeds 3% threshold'
        : 'Estimated spam rate ' + (spamRate * 100).toFixed(2) + '% exceeds 0.2% threshold';
      log('[WARN] TrackingManager: auto-pausing | id=' + campaign.campaignId + ' reason=' + reason);
      try {
        new Campaign(campaign.campaignId).pause(reason);
      } catch (err) {
        log('[WARN] TrackingManager: auto-pause failed: ' + err.message);
      }
    }
  }

  // ─── Utility ─────────────────────────────────────────────────────────────

  /**
   * Formats a Date as YYYY/MM/DD for Gmail search after: filter.
   */
  function _gmailDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.getFullYear() + '/' +
      String(d.getMonth() + 1).padStart(2, '0') + '/' +
      String(d.getDate()).padStart(2, '0');
  }

  const TrackingManager = { pollAll };
  module.exports = { pollAll, TrackingManager, _classifyBounce };
}

__defineModule__(_main);