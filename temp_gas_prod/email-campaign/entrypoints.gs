function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * doGet handler — routes ?action=unsubscribe requests to UnsubscribeHandler.
   * Returns null for unrecognized requests (allows other handlers to pick up).
   */
  function campaignDoGetHandler(e) {
    try {
      const { doGetHandler } = require('email-campaign/compliance/UnsubscribeHandler');
      return doGetHandler(e);
    } catch (err) {
      log('[ERROR] campaignDoGetHandler: ' + err.message);
      return null;
    }
  }

  /**
   * doPost handler — routes RFC 8058 one-click unsubscribe POST requests.
   * Returns null for unrecognized requests.
   */
  function campaignDoPostHandler(e) {
    try {
      const { doPostHandler } = require('email-campaign/compliance/UnsubscribeHandler');
      return doPostHandler(e);
    } catch (err) {
      log('[ERROR] campaignDoPostHandler: ' + err.message);
      return null;
    }
  }

  /**
   * runCampaignScheduler — master 5-min recurring trigger (S14).
   * Acquires script lock, processes SCHEDULED→SENDING transitions and SENDING batches,
   * checks completion, and self-terminates when no campaigns remain active.
   *
   * Created by CampaignManager.ensureSchedulerTrigger() when a campaign goes SCHEDULED.
   * Deleted by itself when all campaigns reach terminal state.
   */
  function runCampaignScheduler(e) {
    log('runCampaignScheduler() | triggerUid=' + (e && e.triggerUid));
    const startTime = Date.now();
    const BUDGET_MS = 5.5 * 60 * 1000; // 5.5 minutes

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      log('runCampaignScheduler: could not acquire lock — another invocation is running');
      return;
    }

    try {
      const { listCampaigns, updateCampaign, getRecipients,
              bulkUpdateRecipients, updateRecipient } = require('email-campaign/storage/CampaignStorage');
      const { Campaign } = require('email-campaign/core/Campaign');
      const { removeSchedulerTrigger, ensureTrackingTrigger, removeTrackingTrigger } = require('email-campaign/core/CampaignManager');
      const { send: sendEmail } = require('email-campaign/send/EmailSender');
      const { validateSend } = require('email-campaign/send/ComplianceGuard');
      const { isSuppressed } = require('email-campaign/compliance/SuppressionList');
      const { render } = require('email-campaign/content/TemplateEngine');

      const now = new Date();
      const active = listCampaigns().filter(c =>
        ['SCHEDULED', 'SENDING', 'PAUSED'].includes(c.state)
      );

      if (active.length === 0) {
        log('runCampaignScheduler: no active campaigns — removing triggers');
        removeSchedulerTrigger();
        removeTrackingTrigger();
        return;
      }

      // Ensure hourly tracking trigger exists while campaigns are active
      ensureTrackingTrigger();

      // Start any SCHEDULED campaigns whose scheduledAt has passed (or is null = immediate)
      for (const c of active) {
        if (c.state !== 'SCHEDULED') continue;
        const scheduledAt = c.scheduledAt ? new Date(c.scheduledAt) : null;
        if (!scheduledAt || scheduledAt <= now) {
          try {
            const campaign = new Campaign(c);
            // Re-read inside lock and check state (E15 double-start guard)
            const started = campaign.start();
            if (started) {
              log('runCampaignScheduler: started campaign | id=' + c.campaignId);
            }
          } catch (err) {
            log('[ERROR] runCampaignScheduler: start failed | id=' + c.campaignId + ' err=' + err.message);
          }
        }
      }

      // Round-robin batch processing for SENDING campaigns
      const sending = listCampaigns().filter(c => c.state === 'SENDING');
      if (sending.length === 0) return;

      // Round-robin via PropertiesService key CAMPAIGN_SCHEDULER_LAST_IDX
      const props = PropertiesService.getScriptProperties();
      const lastIdx = Number(props.getProperty('CAMPAIGN_SCHEDULER_LAST_IDX') || '-1');
      const startIdx = (lastIdx + 1) % sending.length;

      for (let i = 0; i < sending.length; i++) {
        const idx = (startIdx + i) % sending.length;
        const c = sending[idx];

        // Check time budget
        if (Date.now() - startTime > BUDGET_MS) {
          log('runCampaignScheduler: budget exhausted, deferring remaining campaigns');
          break;
        }

        try {
          const campaign = new Campaign(c);
          const batch = campaign.getNextBatch();

          if (batch.length === 0) {
            // Check if ALL recipients are done (no PENDING or QUEUED)
            const pending = getRecipients(c.campaignId, 'PENDING');
            const queued  = getRecipients(c.campaignId, 'QUEUED');
            if (pending.length === 0 && queued.length === 0) {
              log('runCampaignScheduler: completing campaign | id=' + c.campaignId);
              const { isLastActiveCampaign } = campaign.complete();
              if (isLastActiveCampaign) {
                _sendFleetNotification(listCampaigns);
                removeSchedulerTrigger();
                removeTrackingTrigger();
              }
            }
            continue;
          }

          // Write lastBatchAt now that we have actual work to process (stall detection ground truth)
          updateCampaign(c.campaignId, { lastBatchAt: now.toISOString() });

          // Bulk-mark batch PENDING → QUEUED (crash-recovery lock)
          const queuedUpdates = batch.map(r => ({
            rowIndex: r.rowIndex,
            fields: { status: 'QUEUED' },
          }));
          bulkUpdateRecipients(queuedUpdates);

          // Send each recipient.
          // NOTE: Batch loops check campaign state once at the top; mid-batch state changes
          // (e.g., CANCELLED) take effect at the next batch invocation, not mid-flight.
          let lastRow = Number(c.lastProcessedRow) || 1;
          let lastRowAdvanced = false;
          let minDeferredRow = Infinity; // Flow 4: track earliest DEFERRED row to prevent cursor over-advance
          let batchSentCount = 0;
          // Metrics snapshot: built once per batch from last TrackingManager poll.
          // Units: bounceRate and estimatedSpamRate are percent (0–100), matching ComplianceGuard thresholds.
          // Denominator: totalRecipients (list size) — same as TrackingManager so thresholds align.
          const _bounced = Number(c.bounced || 0);
          const _total   = Number(c.totalRecipients) || (Number(c.sent || 0) + Number(c.failed || 0)) || 1;
          const metrics = {
            bounceRate:        (_bounced / _total) * 100,
            estimatedSpamRate: parseFloat(c.estimatedSpamRate || '0'),
            dailySentCount:    Number(c.dailySentCount || 0),
          };
          for (const r of batch) {
            const recipientData = r.data || r;
            const email = recipientData.email;
            const rowIndex = r.rowIndex || lastRow;

            // Blank email guard — cannot identify or update recipient without email key.
            // Use bulkUpdateRecipients (row-indexed) to mark FAILED so it doesn't stay QUEUED.
            if (!email) {
              log('[WARN] runCampaignScheduler: recipient at row ' + rowIndex + ' has no email — skipping');
              bulkUpdateRecipients([{ rowIndex, fields: { status: 'FAILED', errorDetails: 'no email address' } }]);
              lastRow = rowIndex;
              lastRowAdvanced = true;
              continue;
            }

            // Suppression check
            if (isSuppressed(email)) {
              updateRecipient(c.campaignId, email, { status: 'SUPPRESSED' });
              lastRow = rowIndex;
              lastRowAdvanced = true;
              continue;
            }

            // DEFERRED = campaign-level health threshold exceeded; revert to PENDING for retry
            //   when TrackingManager auto-pauses and operator resumes. Do NOT advance cursor.
            // SKIPPED/SUPPRESSED = permanent per-recipient exclusion; advance cursor past them.
            const complianceOk = validateSend(c, recipientData, metrics);
            if (!complianceOk.pass) {
              if (complianceOk.action === 'DEFERRED') {
                updateRecipient(c.campaignId, email, { status: 'PENDING' });
                // Track earliest DEFERRED row — cursor must not advance past this point (Flow 4).
                minDeferredRow = Math.min(minDeferredRow, rowIndex);
                // lastRow intentionally not updated — cursor stays so next batch retries from here
              } else {
                updateRecipient(c.campaignId, email, {
                  status: 'SKIPPED',
                  errorDetails: complianceOk.reason,
                });
                lastRow = rowIndex;
                lastRowAdvanced = true;
              }
              continue;
            }

            // Renders segment content with {{merge-field}} substitution from recipient row.
            // Throws on missing content or htmlBody > 48KB; warns (non-fatal) on unresolved placeholders.
            let rendered;
            try {
              rendered = render(c, recipientData);
            } catch (renderErr) {
              updateRecipient(c.campaignId, email, {
                status: 'FAILED',
                errorDetails: renderErr.message,
              });
              lastRow = rowIndex;
              lastRowAdvanced = true;
              continue;
            }

            const result = sendEmail(c, recipientData, rendered);
            if (result.status === 'SENT') batchSentCount++;
            updateRecipient(c.campaignId, email, {
              status: result.status,
              sentAt: result.status === 'SENT' ? new Date().toISOString() : undefined,
              messageId: result.messageId || undefined,
              gmailMessageId: result.gmailMessageId || undefined,
              threadId: result.threadId || undefined,
              errorDetails: result.error || undefined,
            });
            lastRow = rowIndex;
            lastRowAdvanced = true;
          }

          // Increment dailySentCount — re-read fresh value to avoid stale-read race (E3)
          if (batchSentCount > 0) {
            try {
              const freshCampaign = require('email-campaign/storage/CampaignStorage').getCampaign(c.campaignId);
              updateCampaign(c.campaignId, {
                dailySentCount: (Number(freshCampaign && freshCampaign.dailySentCount) || 0) + batchSentCount,
              });
              log('runCampaignScheduler: dailySentCount +' + batchSentCount + ' | id=' + c.campaignId);
            } catch (e) {
              log('[WARN] runCampaignScheduler: failed to update dailySentCount: ' + e.message);
            }
          }

          // All-DEFERRED batch guard: if no recipients were permanently processed, the entire
          // batch was deferred due to health thresholds. Auto-pause to prevent a busy-loop
          // running every 5 minutes while waiting for the hourly TrackingManager to act.
          if (!lastRowAdvanced && batch.length > 0) {
            log('[WARN] runCampaignScheduler: entire batch DEFERRED — auto-pausing | id=' + c.campaignId);
            try {
              campaign.pause('batch fully deferred: bounce/spam threshold exceeded');
            } catch (pauseErr) {
              log('[WARN] runCampaignScheduler: auto-pause failed: ' + pauseErr.message);
            }
          }

          // Update cursor only when at least one recipient was permanently processed.
          // Clamp to minDeferredRow-1 when a DEFERRED row sits strictly before lastRow so
          // that DEFERRED recipients are not orphaned past the cursor (Flow 4 fix).
          // Note: strict < so that when minDeferredRow === lastRow, lastRow was not
          // advanced for the DEFERRED row and no clamping is needed.
          if (lastRowAdvanced) {
            const effectiveLastRow = minDeferredRow < lastRow ? minDeferredRow - 1 : lastRow;
            campaign.updateCursor(effectiveLastRow + 1);
          }

          // Recalculate estimatedCompleteDate after batch
          campaign.estimateCompletionDate();

          props.setProperty('CAMPAIGN_SCHEDULER_LAST_IDX', String(idx));

        } catch (err) {
          log('[ERROR] runCampaignScheduler: batch error | id=' + c.campaignId + ' err=' + err.message);
        }
      }

    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Sends fleet completion summary email when ALL campaigns complete (S16).
   * Guards against duplicate notification on the same calendar day via
   * CAMPAIGN_FLEET_NOTIFIED_DATE PropertiesService key.
   */
  function _sendFleetNotification(listCampaigns) {
    const props = PropertiesService.getScriptProperties();
    const today = new Date().toISOString().split('T')[0];
    if (props.getProperty('CAMPAIGN_FLEET_NOTIFIED_DATE') === today) {
      log('runCampaignScheduler: fleet notification already sent today');
      return;
    }

    const completed = listCampaigns().filter(c => c.state === 'COMPLETE');
    if (completed.length === 0) {
      log('[WARN] _sendFleetNotification: no COMPLETE campaigns found — notification skipped');
      return;
    }

    // Aggregate by unique createdBy addresses
    const byAuthor = {};
    for (const c of completed) {
      if (!byAuthor[c.createdBy]) byAuthor[c.createdBy] = [];
      byAuthor[c.createdBy].push(c);
    }

    const pct = (n, t) => t > 0 ? (n / t * 100).toFixed(2) + '%' : '0.00%';

    let allSucceeded = true;
    for (const [author, campaigns] of Object.entries(byAuthor)) {
      try {
        const rows = campaigns.map(c => {
          const t = Number(c.totalRecipients) || 0;
          return [
            c.name,
            t,
            pct(Number(c.sent) || 0, t),
            pct(Number(c.bounced) || 0, t),
            pct(Number(c.replied) || 0, t),
          ].join('\t');
        });

        const body = 'All campaigns complete! Final summary:\n\n' +
          'Campaign\tRecipients\tDelivery\tBounce\tReply\n' +
          rows.join('\n') + '\n\n' +
          'View spreadsheet: ' + (SpreadsheetApp.getActiveSpreadsheet()?.getUrl() ?? '(spreadsheet URL unavailable)');

        GmailApp.sendEmail(
          author,
          '[CAMPAIGN FLEET COMPLETE] All campaigns finished',
          body
        );
        log('runCampaignScheduler: fleet notification sent | to=' + author);
      } catch (err) {
        log('[WARN] runCampaignScheduler: fleet notification failed | to=' + author + ' err=' + err.message);
        allSucceeded = false;
      }
    }

    if (allSucceeded) {
      props.setProperty('CAMPAIGN_FLEET_NOTIFIED_DATE', today);
    }
  }

  /**
   * pollCampaignTracking — hourly trigger handler for bounce/reply detection.
   */
  function pollCampaignTracking(e) {
    log('pollCampaignTracking() | triggerUid=' + (e && e.triggerUid));
    try {
      const { TrackingManager } = require('email-campaign/tracking/TrackingManager');
      TrackingManager.pollAll(e);
    } catch (err) {
      log('[ERROR] pollCampaignTracking: ' + err.message);
      throw err;
    }
  }

  /**
   * generateCampaignContent — trigger handler for LLM content generation jobs.
   */
  function generateCampaignContent(e) {
    log('generateCampaignContent() | triggerUid=' + (e && e.triggerUid));
    try {
      const { ContentGenerator } = require('email-campaign/content/ContentGenerator');
      ContentGenerator.generateForCampaign(e);
    } catch (err) {
      log('[ERROR] generateCampaignContent: ' + err.message);
      throw err;
    }
  }

  // processCampaignBatch kept for backward compatibility with any existing triggers
  function processCampaignBatch(e) {
    log('processCampaignBatch() redirecting to runCampaignScheduler');
    runCampaignScheduler(e);
  }

  module.exports = {
    campaignDoGetHandler,
    campaignDoPostHandler,
    runCampaignScheduler,
    processCampaignBatch,
    pollCampaignTracking,
    generateCampaignContent,
    __events__: {
      doGet: 'campaignDoGetHandler',
      doPost: 'campaignDoPostHandler',
    },
    // loadNow:true required — __global__ registers trigger functions on globalThis at startup
    __global__: {
      runCampaignScheduler,
      processCampaignBatch,
      pollCampaignTracking,
      generateCampaignContent,
    },
  };
}

__defineModule__(_main, true);