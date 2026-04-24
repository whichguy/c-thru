function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const {
    getCampaign, updateCampaign, listCampaigns: _listCampaigns,
    getRecipients, appendRecipients,
  } = require('email-campaign/storage/CampaignStorage');
  const { Campaign } = require('email-campaign/core/Campaign');
  const { validateStateFilter } = require('email-campaign/send/ComplianceGuard');

  // Trigger handler names (registered in entrypoints.gs via __global__)
  const SCHEDULER_HANDLER = 'runCampaignScheduler';
  const TRACKING_HANDLER  = 'pollCampaignTracking';

  // ─── Read methods ──────────────────────────────────────────────────────────

  /**
   * Lists campaigns with optional filter.
   * @param {Object} [filter] - { state?, channel?, createdBy? }
   */
  function listCampaigns(filter) {
    if (filter && filter.state) validateStateFilter(filter.state);
    const all = _listCampaigns(filter);
    return all.map(c => ({
      campaignId:   c.campaignId,
      name:         c.name,
      state:        c.state,
      channel:      c.channel || 'email',
      sent:         Number(c.sent)             || 0,
      totalRecipients: Number(c.totalRecipients) || 0,
      bounceRate:   _rate(c.bounced, c.totalRecipients),
      replyRate:    _rate(c.replied, c.totalRecipients),
      warmupDay:    Number(c.warmupDay) || 1,
      createdAt:    c.createdAt,
      createdBy:    c.createdBy,
    }));
  }

  function getCampaignDetails(campaignId) {
    return getCampaign(campaignId);
  }

  /**
   * Returns derived metrics for a campaign.
   */
  function getCampaignMetrics(campaignId) {
    const c = getCampaign(campaignId);
    if (!c) throw new Error('Campaign not found: ' + campaignId);
    const total = Number(c.totalRecipients) || 0;
    const sent  = Number(c.sent) || 0;
    return {
      campaignId,
      deliveryRate:       _rate(sent, total),
      bounceRate:         _rate(c.bounced, total),
      replyRate:          _rate(c.replied, total),
      unsubscribeRate:    _rate(c.unsubscribed, total),
      estimatedSpamRate:  Number(c.estimatedSpamRate) || 0,
      warmupDay:          Number(c.warmupDay) || 1,
      dailySentCount:     Number(c.dailySentCount) || 0,
      progress:           _rate(sent, total),
    };
  }

  function getRecipientList(campaignId, statusFilter) {
    return getRecipients(campaignId, statusFilter).map(r => r.data);
  }

  function getDashboardSummary() {
    const all = _listCampaigns();
    const active  = all.filter(c => ['SENDING','PAUSED','SCHEDULED'].includes(c.state));
    const paused  = all.filter(c => c.state === 'PAUSED');
    const failed  = all.filter(c => c.state === 'FAILED');
    const todaySent = active.reduce((sum, c) => sum + (Number(c.dailySentCount) || 0), 0);
    return {
      activeCampaignCount: active.length,
      totalSentToday:      todaySent,
      pausedCampaigns:     paused.map(c => ({ campaignId: c.campaignId, name: c.name, pauseReason: c.pauseReason })),
      failedCampaigns:     failed.map(c => ({ campaignId: c.campaignId, name: c.name })),
    };
  }

  /**
   * Fleet status — all campaigns with progress and estimates. Sorted by state priority.
   */
  function getFleetStatus() {
    const order = { SENDING: 0, PAUSED: 1, SCHEDULED: 2, GENERATING: 3, DRAFT: 4, COMPLETE: 5, CANCELLED: 6, FAILED: 7 };
    return _listCampaigns()
      .map(c => ({
        campaignId:           c.campaignId,
        name:                 c.name,
        state:                c.state,
        progress:             _rate(c.sent, c.totalRecipients),
        sent:                 Number(c.sent) || 0,
        totalRecipients:      Number(c.totalRecipients) || 0,
        estimatedCompleteDate: c.estimatedCompleteDate || null,
        bounceRate:           _rate(c.bounced, c.totalRecipients),
        replyRate:            _rate(c.replied, c.totalRecipients),
      }))
      .sort((a, b) => (order[a.state] !== undefined ? order[a.state] : 99) - (order[b.state] !== undefined ? order[b.state] : 99));
  }

  function getEstimatedCompletionDate(campaignId) {
    return new Campaign(campaignId).estimateCompletionDate();
  }

  // ─── Lifecycle methods ────────────────────────────────────────────────────

  function pauseCampaign(campaignId, reason) {
    new Campaign(campaignId).pause(reason);
    return { success: true, campaignId, state: 'PAUSED' };
  }

  function resumeCampaign(campaignId) {
    new Campaign(campaignId).resume();
    return { success: true, campaignId, state: 'SENDING' };
  }

  function cancelCampaign(campaignId) {
    new Campaign(campaignId).cancel();
    return { success: true, campaignId, state: 'CANCELLED' };
  }

  /**
   * Manually starts a SCHEDULED campaign (for campaigns with scheduledAt=null or immediate-start override).
   * Acquires LockService to prevent double-start (E15).
   */
  function startCampaign(campaignId) {
    const c = getCampaign(campaignId);
    if (!c) throw new Error('Campaign not found: ' + campaignId);
    if (c.state !== 'SCHEDULED') throw new Error('Campaign is not SCHEDULED (state=' + c.state + ')');

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error('Could not acquire lock to start campaign');
    try {
      const campaign = new Campaign(campaignId);
      const started = campaign.start();
      if (!started) return { success: false, reason: 'Campaign already transitioned' };
      ensureSchedulerTrigger();
      return { success: true, campaignId, state: 'SENDING' };
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Appends new recipients to an existing campaign.
   * For SENDING/PAUSED campaigns, enforces append-only (no mid-sheet inserts).
   */
  function addRecipients(campaignId, recipients) {
    const c = getCampaign(campaignId);
    if (!c) throw new Error('Campaign not found: ' + campaignId);
    if (['COMPLETE', 'CANCELLED', 'FAILED'].includes(c.state)) {
      throw new Error('Cannot add recipients to a ' + c.state + ' campaign');
    }
    // For SENDING/PAUSED: append-only (protect lastProcessedRow cursor)
    const rows = recipients.map(r => Object.assign({}, r, {
      campaignId,
      channelAddress: r.email,
      status:        'PENDING',
      autoReplyCount: 0,
    }));
    appendRecipients(rows);
    // Re-read after append — other concurrent callers may have incremented totalRecipients
    const freshC = getCampaign(campaignId);
    const newTotal = (Number(freshC && freshC.totalRecipients) || 0) + rows.length;
    updateCampaign(campaignId, { totalRecipients: newTotal });
    return { added: rows.length, totalRecipients: newTotal };
  }

  // ─── Trigger management ──────────────────────────────────────────────────

  /**
   * Ensures exactly one Campaign Scheduler trigger exists (idempotent).
   * Alerts author and returns false if trigger quota is full (>= 18 triggers) — E16.
   */
  function ensureSchedulerTrigger() {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      log('[WARN] ensureSchedulerTrigger: could not acquire lock — skipping');
      return false;
    }
    try {
      const triggers = ScriptApp.getProjectTriggers();

      // Check for existing scheduler trigger
      for (const t of triggers) {
        if (t.getHandlerFunction() === SCHEDULER_HANDLER) {
          log('ensureSchedulerTrigger: already exists');
          return true;
        }
      }

      // E16: Guard against trigger quota exhaustion
      if (triggers.length >= 18) {
        const msg = 'Cannot create Campaign Scheduler trigger — trigger quota full (' + triggers.length + '/20). ' +
                    'Delete unused triggers first, then retry.\n\n' +
                    'Current triggers: ' + triggers.map(t => t.getHandlerFunction()).join(', ');
        log('[ERROR] ensureSchedulerTrigger: ' + msg);
        // Notify author of the first active campaign
        try {
          const active = _listCampaigns().filter(c => ['SCHEDULED','SENDING','PAUSED'].includes(c.state));
          if (active.length > 0) {
            GmailApp.sendEmail(active[0].createdBy, '[CAMPAIGN ERROR] Trigger quota full', msg);
          }
        } catch (e) { /* best effort */ }
        return false;
      }

      ScriptApp.newTrigger(SCHEDULER_HANDLER)
        .timeBased()
        .everyMinutes(5)
        .create();
      log('ensureSchedulerTrigger: created 5-min Campaign Scheduler trigger');
      return true;
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Removes all Campaign Scheduler triggers. Called when no campaigns remain active.
   */
  function removeSchedulerTrigger() {
    const triggers = ScriptApp.getProjectTriggers();
    let removed = 0;
    for (const t of triggers) {
      if (t.getHandlerFunction() === SCHEDULER_HANDLER) {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    }
    if (removed > 0) log('removeSchedulerTrigger: removed ' + removed + ' trigger(s)');
  }

  /**
   * Ensures exactly one hourly Tracking Poll trigger exists (idempotent).
   * Creates it if absent. Skips if trigger quota is full (>= 18).
   */
  function ensureTrackingTrigger() {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      log('[WARN] ensureTrackingTrigger: could not acquire lock — skipping');
      return false;
    }
    try {
      const triggers = ScriptApp.getProjectTriggers();
      for (const t of triggers) {
        if (t.getHandlerFunction() === TRACKING_HANDLER) {
          log('ensureTrackingTrigger: already exists');
          return true;
        }
      }
      if (triggers.length >= 18) {
        log('[WARN] ensureTrackingTrigger: trigger quota near full, skipping');
        return false;
      }
      ScriptApp.newTrigger(TRACKING_HANDLER)
        .timeBased()
        .everyHours(1)
        .create();
      log('ensureTrackingTrigger: created hourly tracking trigger');
      return true;
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Removes all Tracking Poll triggers. Called when no campaigns remain active.
   */
  function removeTrackingTrigger() {
    const triggers = ScriptApp.getProjectTriggers();
    let removed = 0;
    for (const t of triggers) {
      if (t.getHandlerFunction() === TRACKING_HANDLER) {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    }
    if (removed > 0) log('removeTrackingTrigger: removed ' + removed + ' trigger(s)');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function _rate(count, total) {
    const n = Number(count) || 0;
    const t = Number(total) || 0;
    return t > 0 ? parseFloat((n / t * 100).toFixed(2)) : 0;
  }

  module.exports = {
    listCampaigns,
    getCampaign:                getCampaignDetails,
    getCampaignMetrics,
    getRecipients:              getRecipientList,
    getDashboardSummary,
    getFleetStatus,
    getEstimatedCompletionDate,
    pauseCampaign,
    resumeCampaign,
    cancelCampaign,
    startCampaign,
    addRecipients,
    ensureSchedulerTrigger,
    removeSchedulerTrigger,
    ensureTrackingTrigger,
    removeTrackingTrigger,
  };
}

__defineModule__(_main);