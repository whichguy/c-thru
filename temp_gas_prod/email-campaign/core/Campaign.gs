function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const {
    getCampaign, updateCampaign, listCampaigns,
    getRecipientBatch, getRecipients, cancelPendingRecipients,
  } = require('email-campaign/storage/CampaignStorage');

  // Valid state transition map — keys are current state, values are allowed next states
  const TRANSITIONS = {
    DRAFT:      ['GENERATING', 'SCHEDULED', 'CANCELLED'],
    GENERATING: ['SCHEDULED', 'FAILED', 'CANCELLED'],
    SCHEDULED:  ['SENDING', 'CANCELLED', 'PAUSED'],
    SENDING:    ['PAUSED', 'COMPLETE', 'FAILED', 'CANCELLED'],
    PAUSED:     ['SENDING', 'CANCELLED', 'FAILED'],
    COMPLETE:   [],
    FAILED:     ['SCHEDULED', 'CANCELLED'],
    CANCELLED:  [],
  };

  const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1AMEPouG0QeSs6fjov-Iha7XrcxO-AyUOckM0aqRGg0A';

  class Campaign {
    /**
     * @param {string|Object} data - campaignId string or campaign row object
     */
    constructor(data) {
      if (typeof data === 'string') {
        this._data = getCampaign(data);
        if (!this._data) throw new Error('Campaign not found: ' + data);
      } else {
        this._data = data;
      }
    }

    get campaignId() { return this._data.campaignId; }
    get state()      { return this._data.state; }
    get data()       { return this._data; }

    /**
     * Validates and applies a state transition. Updates _Campaigns tab.
     * @param {string} newState
     * @param {Object} [extraFields]
     * @param {boolean} [useStateLock] - acquire LockService before write
     */
    transitionTo(newState, extraFields, useStateLock) {
      const current = this._data.state;
      const allowed = TRANSITIONS[current] || [];
      if (!allowed.includes(newState)) {
        throw new Error('Invalid transition: ' + current + ' → ' + newState + ' (id=' + this.campaignId + ')');
      }
      const fields = Object.assign({ state: newState }, extraFields || {});
      updateCampaign(this.campaignId, fields, useStateLock || false);
      this._data = Object.assign({}, this._data, fields);
      log('Campaign: ' + current + ' → ' + newState + ' | id=' + this.campaignId);
    }

    /**
     * SCHEDULED → SENDING. Caller MUST hold LockService.getScriptLock().
     * Re-reads state after lock acquisition to prevent double-start (E15).
     * @returns {boolean} true if started, false if already transitioned
     */
    start() {
      // Guard: re-read state to detect concurrent start
      const fresh = getCampaign(this.campaignId);
      if (!fresh || fresh.state !== 'SCHEDULED') {
        log('Campaign.start: skipped — state=' + (fresh && fresh.state) + ' | id=' + this.campaignId);
        return false;
      }
      this._data = fresh;
      const now     = new Date();
      const todayStr = now.toISOString().split('T')[0];
      this.transitionTo('SENDING', {
        startedAt:      now.toISOString(),
        lastBatchAt:    now.toISOString(),
        dailySentCount: 0,
        dailyResetDate: todayStr,
        warmupDay:      Number(fresh.warmupDay) || 1,
      }, false); // Lock already held by caller
      return true;
    }

    /**
     * SENDING → COMPLETE. Recalculates aggregates, sends completion email.
     * @returns {{ isLastActiveCampaign: boolean }}
     */
    complete() {
      this.recalculateAggregates();
      const fresh = getCampaign(this.campaignId) || this._data;
      this._data = Object.assign({}, fresh);
      this.transitionTo('COMPLETE', {
        completedAt:           new Date().toISOString(),
        estimatedCompleteDate: '',
      }, false);

      // S15: Completion notification email
      try {
        const sent   = Number(this._data.sent) || 0;
        const total  = Number(this._data.totalRecipients) || 0;
        const pct    = (n) => total > 0 ? (n / total * 100).toFixed(2) + '%' : '0.00%';
        GmailApp.sendEmail(
          this._data.createdBy,
          '[CAMPAIGN COMPLETE] ' + this._data.name + ' — ' + sent + '/' + total + ' sent',
          'Your campaign "' + this._data.name + '" has finished sending.\n\n' +
          'Delivery rate:    ' + pct(sent) + '\n' +
          'Bounce rate:      ' + pct(Number(this._data.bounced) || 0) + '\n' +
          'Reply rate:       ' + pct(Number(this._data.replied) || 0) + '\n' +
          'Unsubscribe rate: ' + pct(Number(this._data.unsubscribed) || 0) + '\n\n' +
          'View spreadsheet: ' + SPREADSHEET_URL
        );
      } catch (e) {
        log('[WARN] Campaign.complete: notification failed: ' + e.message);
      }

      // S15: Check if this is the last active campaign (for S16 fleet notification)
      const active = listCampaigns().filter(c => ['SCHEDULED','SENDING','PAUSED'].includes(c.state));
      return { isLastActiveCampaign: active.length === 0 };
    }

    /**
     * Transitions to PAUSED and sends an alert email to the author.
     * @param {string} [reason] - Why the campaign was paused
     */
    pause(reason) {
      this.transitionTo('PAUSED', { pauseReason: reason || '' }, true);
      // S5: Auto-pause notification
      try {
        const fresh = getCampaign(this.campaignId) || this._data;
        GmailApp.sendEmail(
          fresh.createdBy,
          '[CAMPAIGN PAUSED] ' + fresh.name + ' — threshold exceeded',
          'Campaign "' + fresh.name + '" was automatically paused.\n\n' +
          'Reason: ' + (reason || '(manual pause)') + '\n' +
          'Estimated spam rate: ' + (fresh.estimatedSpamRate || 'unknown') + '%\n\n' +
          'Resume by setting state = SENDING in _Campaigns or calling:\n' +
          '  CampaignManager.resumeCampaign("' + this.campaignId + '")\n\n' +
          'View spreadsheet: ' + SPREADSHEET_URL
        );
      } catch (e) {
        log('[WARN] Campaign.pause: notification failed: ' + e.message);
      }
    }

    resume() {
      const fresh = getCampaign(this.campaignId);
      if (!fresh || fresh.state !== 'PAUSED') {
        throw new Error('Campaign ' + this.campaignId + ' is not PAUSED (state=' + (fresh && fresh.state) + ')');
      }
      this._data = fresh;
      this.transitionTo('SENDING', { pauseReason: '' }, true);
    }

    cancel() {
      cancelPendingRecipients(this.campaignId);
      this.transitionTo('CANCELLED', {}, true);
    }

    /**
     * Returns the next batch of PENDING recipients for sending.
     * Handles daily reset and warmup schedule limits.
     * NOTE: Batch loops check campaign state once at the top; mid-batch state
     * changes (e.g., CANCELLED) take effect at the next batch invocation, not mid-flight.
     */
    getNextBatch(batchSize) {
      const fresh = getCampaign(this.campaignId);
      if (!fresh || fresh.state !== 'SENDING') return [];

      _resetDailyCountIfNeeded(this.campaignId, fresh);

      // Re-read after potential daily reset — dailySentCount may have been zeroed
      const current = getCampaign(this.campaignId) || fresh;
      const sendConfig       = _parseSendConfig(current.sendConfig);
      const effectiveBatchSz = _getEffectiveBatchSize(current, sendConfig, batchSize || sendConfig.batchSize || 20);
      if (effectiveBatchSz <= 0) {
        log('Campaign.getNextBatch: daily limit reached | id=' + this.campaignId);
        return [];
      }

      const startRow = Number(current.lastProcessedRow) || 1;
      return getRecipientBatch(this.campaignId, startRow, effectiveBatchSz);
    }

    /** Updates the cursor (lastProcessedRow) after a batch completes. */
    updateCursor(lastRowIndex) {
      updateCampaign(this.campaignId, { lastProcessedRow: lastRowIndex });
    }

    getProgress() {
      const fresh   = getCampaign(this.campaignId) || this._data;
      const total   = Number(fresh.totalRecipients) || 0;
      const pending = getRecipients(this.campaignId, 'PENDING').length;
      const sent    = Math.max(0, total - pending);
      return { total, pending, sent, percent: total > 0 ? Math.round(sent / total * 100) : 0 };
    }

    /**
     * Scans all recipients and returns aggregate counts.
     * Shared by recalculateAggregates() and TrackingManager health check.
     * @param {string} campaignId
     * @returns {{ sent, failed, bounced, replied, unsubscribed, skipped, total,
     *   bounceRate: number (0-1 ratio), unsubRate: number (0-1 ratio),
     *   estimatedSpamRate: number (0-100 percent, for _Campaigns storage) }}
     */
    static computeAggregates(campaignId) {
      const all = getRecipients(campaignId);
      const counts = { sent: 0, failed: 0, bounced: 0, replied: 0, unsubscribed: 0, skipped: 0 };
      for (const r of all) {
        if (!r || !r.data) continue;
        const s = r.data.status;
        if (['SENT', 'DELIVERED', 'REPLIED'].includes(s)) counts.sent++;
        if (s === 'FAILED')       counts.failed++;
        if (s === 'BOUNCED')      counts.bounced++;
        if (s === 'REPLIED')      counts.replied++;
        if (s === 'UNSUBSCRIBED') counts.unsubscribed++;
        if (['SUPPRESSED', 'SKIPPED', 'CANCELLED'].includes(s)) counts.skipped++;
      }
      const total     = all.length;
      const bounceRate = total > 0 ? counts.bounced / total : 0;
      const unsubRate  = total > 0 ? counts.unsubscribed / total : 0;
      return {
        ...counts, total, bounceRate, unsubRate,
        estimatedSpamRate: parseFloat(((bounceRate + unsubRate) * 100).toFixed(4)),
      };
    }

    /** Recomputes all aggregate counters from _Recipients rows and writes to _Campaigns. */
    recalculateAggregates() {
      const agg = Campaign.computeAggregates(this.campaignId);
      updateCampaign(this.campaignId, {
        sent: agg.sent, failed: agg.failed, bounced: agg.bounced,
        replied: agg.replied, unsubscribed: agg.unsubscribed, skipped: agg.skipped,
        totalRecipients: agg.total, estimatedSpamRate: agg.estimatedSpamRate,
      });
      log('Campaign.recalculateAggregates | total=' + agg.total + ' sent=' + agg.sent + ' id=' + this.campaignId);
    }

    /**
     * Computes estimated completion date and writes to _Campaigns.estimatedCompleteDate.
     * Returns null with reason for PAUSED/COMPLETE/CANCELLED/FAILED states.
     */
    estimateCompletionDate() {
      const fresh = getCampaign(this.campaignId);
      if (!fresh) return { estimatedCompleteDate: null, reason: 'NOT_FOUND' };
      if (fresh.state === 'PAUSED') return { estimatedCompleteDate: null, reason: 'PAUSED' };
      if (['COMPLETE','CANCELLED','FAILED'].includes(fresh.state))
        return { estimatedCompleteDate: null, reason: fresh.state };

      const sendConfig        = _parseSendConfig(fresh.sendConfig);
      const warmupDay         = Number(fresh.warmupDay) || 1;
      const warmupSchedule    = sendConfig.warmupSchedule || {};
      const dailyLimit        = Number(sendConfig.dailyLimit) || 1600;
      const warmupLimit       = warmupSchedule['day' + warmupDay] || Infinity;
      const effectiveDailyLim = Math.min(dailyLimit, warmupLimit);

      const pendingCount = getRecipients(this.campaignId, 'PENDING').length;
      if (pendingCount === 0) return { estimatedCompleteDate: null, reason: 'NO_PENDING' };

      const daysToComplete = Math.max(1, Math.ceil(pendingCount / effectiveDailyLim));
      const est = new Date();
      est.setDate(est.getDate() + daysToComplete);
      const estimatedCompleteDate = est.toISOString().split('T')[0];
      updateCampaign(this.campaignId, { estimatedCompleteDate });
      return { estimatedCompleteDate, pendingCount, effectiveDailyLimit: effectiveDailyLim, warmupDay };
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  function _parseSendConfig(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }

  /**
   * Resets dailySentCount on a new calendar day.
   * Advances warmupDay only if yesterday had at least one send (warmup semantics).
   */
  function _resetDailyCountIfNeeded(campaignId, campaign) {
    const todayStr = new Date().toISOString().split('T')[0];
    if ((campaign.dailyResetDate || '') === todayStr) return;
    const prevCount = Number(campaign.dailySentCount) || 0;
    const updates   = { dailySentCount: 0, dailyResetDate: todayStr };
    if (prevCount > 0) updates.warmupDay = (Number(campaign.warmupDay) || 1) + 1;
    updateCampaign(campaignId, updates);
    log('Campaign: daily reset | prevSent=' + prevCount + ' newWarmupDay=' + (updates.warmupDay || campaign.warmupDay));
  }

  /** Returns effective batch size after applying daily and warmup limits. */
  function _getEffectiveBatchSize(campaign, sendConfig, requested) {
    const dailyLimit  = Number(sendConfig.dailyLimit) || 1600;
    const warmupDay   = Number(campaign.warmupDay) || 1;
    const warmupSched = sendConfig.warmupSchedule || {};
    const warmupLimit = warmupSched['day' + warmupDay] || Infinity;
    const effective   = Math.min(dailyLimit, warmupLimit);
    const dailySent   = Number(campaign.dailySentCount) || 0;
    const remaining   = Math.max(0, effective - dailySent);
    return Math.min(requested || 20, remaining);
  }

  module.exports = { Campaign };
}

__defineModule__(_main);