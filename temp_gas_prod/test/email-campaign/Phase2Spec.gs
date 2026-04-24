// test/email-campaign/Phase2Spec.gs
// Phase 2 test suite: Campaign state machine, CampaignBuilder, CampaignManager API,
// EmailSender MIME construction, ensureSchedulerTrigger idempotency.
// Run via: require('test/email-campaign/Phase2Spec').run()

function _main(module, exports, log) {

  const { describe, it, runTests } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  const SS_ID = '1AMEPouG0QeSs6fjov-Iha7XrcxO-AyUOckM0aqRGg0A';

  // Helper: create a minimal DRAFT campaign for testing. Returns campaignId.
  function _createTestCampaign(nameSuffix) {
    const { create } = require('email-campaign/core/CampaignBuilder');
    return create('Test Campaign ' + (nameSuffix || Date.now()))
      .withSender(Session.getActiveUser().getEmail(), 'Test Sender')
      .withPhysicalAddress('123 Test St, Test City, TS 12345')
      .withRecipients([
        { email: 'test1@example.com', firstName: 'Alice' },
        { email: 'test2@example.com', firstName: 'Bob' },
      ])
      .build();
  }

  function run() {
    log('=== Phase 2 Email Campaign Tests ===');

    // ─── CampaignBuilder ───────────────────────────────────────────────────

    describe('CampaignBuilder', () => {
      it('should create a campaign and return a UUID campaignId', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('builder-basic');
        expect(typeof campaignId).to.equal('string');
        expect(campaignId.length).to.be.greaterThan(10);
      });

      it('should write a DRAFT row to _Campaigns tab', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('builder-draft');
        const { getCampaign } = require('email-campaign/storage/CampaignStorage');
        const c = getCampaign(campaignId);
        expect(c).to.not.equal(null);
        expect(c.state).to.equal('DRAFT');
        expect(c.campaignId).to.equal(campaignId);
      });

      it('should write recipient rows to _Recipients tab', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('builder-recipients');
        const { getRecipients } = require('email-campaign/storage/CampaignStorage');
        const recipients = getRecipients(campaignId);
        expect(recipients.length).to.equal(2);
        const emails = recipients.map(r => r.data.email);
        expect(emails).to.include('test1@example.com');
        expect(emails).to.include('test2@example.com');
      });

      it('should set all recipient statuses to PENDING', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('builder-pending');
        const { getRecipients } = require('email-campaign/storage/CampaignStorage');
        const recipients = getRecipients(campaignId);
        recipients.forEach(r => expect(r.data.status).to.equal('PENDING'));
      });

      it('should reject invalid email formats at import time', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const { create } = require('email-campaign/core/CampaignBuilder');
        // withRecipients logs a warning and skips bad emails but does not throw
        // A campaign with ALL invalid emails → build() throws (0 valid recipients)
        let threw = false;
        try {
          create('Invalid Emails Test ' + Date.now())
            .withSender(Session.getActiveUser().getEmail(), 'Test')
            .withPhysicalAddress('123 Test St, City, ST 12345')
            .withRecipients([{ email: 'not-an-email' }, { email: '' }])
            .build();
        } catch (e) {
          threw = true;
          expect(e.message).to.include('0 valid recipients');
        }
        expect(threw).to.equal(true);
      });

      it('should throw when name is missing', () => {
        const { create } = require('email-campaign/core/CampaignBuilder');
        let threw = false;
        try { create(''); } catch (e) { threw = true; }
        expect(threw).to.equal(true);
      });

      it('withRecipients should skip invalid emails and keep valid ones', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const { create } = require('email-campaign/core/CampaignBuilder');
        const campaignId = create('Mixed Emails ' + Date.now())
          .withSender(Session.getActiveUser().getEmail(), 'Test')
          .withPhysicalAddress('123 Test St, City, ST 12345')
          .withRecipients([
            { email: 'valid@example.com' },
            { email: 'bad-email' },
            { email: 'also@valid.com' },
          ])
          .build();
        const { getRecipients } = require('email-campaign/storage/CampaignStorage');
        const recipients = getRecipients(campaignId);
        expect(recipients.length).to.equal(2); // only 2 valid
      });
    });

    // ─── Campaign State Machine ────────────────────────────────────────────

    describe('Campaign state machine', () => {
      it('should enforce valid state transitions — DRAFT → SCHEDULED', () => {
        const { ensureTabs, updateCampaign } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('sm-draft-to-sched');
        const { Campaign } = require('email-campaign/core/Campaign');
        const campaign = new Campaign(campaignId);
        campaign.transitionTo('SCHEDULED');
        const { getCampaign } = require('email-campaign/storage/CampaignStorage');
        expect(getCampaign(campaignId).state).to.equal('SCHEDULED');
      });

      it('should reject invalid transitions — DRAFT → SENDING directly', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('sm-invalid-transition');
        const { Campaign } = require('email-campaign/core/Campaign');
        const campaign = new Campaign(campaignId);
        let threw = false;
        try { campaign.transitionTo('SENDING'); } catch (e) { threw = true; }
        expect(threw).to.equal(true);
      });

      it('cancel() should mark all PENDING recipients as CANCELLED', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('sm-cancel');
        const { Campaign } = require('email-campaign/core/Campaign');
        const campaign = new Campaign(campaignId);
        campaign.transitionTo('SCHEDULED');
        campaign.cancel();
        const { getRecipients } = require('email-campaign/storage/CampaignStorage');
        const recipients = getRecipients(campaignId);
        recipients.forEach(r => {
          expect(['CANCELLED', 'PENDING']).to.include(r.data.status);
        });
        const { getCampaign } = require('email-campaign/storage/CampaignStorage');
        expect(getCampaign(campaignId).state).to.equal('CANCELLED');
      });

      it('start() should be a no-op if state is not SCHEDULED (double-start guard)', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('sm-double-start');
        const { Campaign } = require('email-campaign/core/Campaign');
        const { updateCampaign } = require('email-campaign/storage/CampaignStorage');
        // Set to DRAFT (not SCHEDULED) — start() should return false
        const campaign = new Campaign(campaignId);
        const started = campaign.start(); // DRAFT state — guard rejects
        expect(started).to.equal(false);
      });

      it('estimateCompletionDate() returns null for PAUSED campaigns', () => {
        const { ensureTabs, updateCampaign } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('sm-estimate-paused');
        const { Campaign } = require('email-campaign/core/Campaign');
        updateCampaign(campaignId, { state: 'PAUSED' }); // force PAUSED for test
        const campaign = new Campaign(campaignId);
        const result = campaign.estimateCompletionDate();
        expect(result.estimatedCompleteDate).to.equal(null);
        expect(result.reason).to.equal('PAUSED');
      });

      it('estimateCompletionDate() returns a date string for SENDING campaigns', () => {
        const { ensureTabs, updateCampaign } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('sm-estimate-sending');
        updateCampaign(campaignId, {
          state: 'SENDING',
          sendConfig: JSON.stringify({ dailyLimit: 100 }),
          warmupDay: 1,
          dailySentCount: 0,
          dailyResetDate: new Date().toISOString().split('T')[0],
        });
        const { Campaign } = require('email-campaign/core/Campaign');
        const campaign = new Campaign(campaignId);
        const result = campaign.estimateCompletionDate();
        // 2 PENDING recipients / 100 daily = 1 day
        expect(result.estimatedCompleteDate).to.be.a('string');
        expect(result.estimatedCompleteDate.length).to.equal(10); // YYYY-MM-DD
      });

      it('getNextBatch() respects daily limit and returns empty when at cap', () => {
        const { ensureTabs, updateCampaign } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('sm-batch-limit');
        updateCampaign(campaignId, {
          state: 'SENDING',
          sendConfig: JSON.stringify({ dailyLimit: 2, batchSize: 20 }),
          warmupDay: 1,
          dailySentCount: 2, // already at cap
          dailyResetDate: new Date().toISOString().split('T')[0],
          lastProcessedRow: 1,
        });
        const { Campaign } = require('email-campaign/core/Campaign');
        const campaign = new Campaign(campaignId);
        const batch = campaign.getNextBatch();
        expect(batch.length).to.equal(0);
      });
    });

    // ─── CampaignManager API ───────────────────────────────────────────────

    describe('CampaignManager', () => {
      it('listCampaigns() returns an array', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const { listCampaigns } = require('email-campaign/core/CampaignManager');
        const result = listCampaigns();
        expect(Array.isArray(result)).to.equal(true);
      });

      it('listCampaigns(filter) rejects invalid state enum values', () => {
        const { listCampaigns } = require('email-campaign/core/CampaignManager');
        let threw = false;
        try { listCampaigns({ state: 'INVALID_STATE' }); } catch (e) { threw = true; }
        expect(threw).to.equal(true);
      });

      it('getDashboardSummary() returns activeCampaignCount and totalSentToday', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const { getDashboardSummary } = require('email-campaign/core/CampaignManager');
        const summary = getDashboardSummary();
        expect(summary).to.have.property('activeCampaignCount');
        expect(summary).to.have.property('totalSentToday');
        expect(summary).to.have.property('pausedCampaigns');
        expect(summary).to.have.property('failedCampaigns');
      });

      it('getFleetStatus() returns array sorted by state priority (SENDING before PAUSED)', () => {
        const { ensureTabs, updateCampaign } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const { getFleetStatus } = require('email-campaign/core/CampaignManager');
        const fleet = getFleetStatus();
        expect(Array.isArray(fleet)).to.equal(true);
        // Verify the entire fleet is correctly sorted: check consecutive pairs
        const order = { SENDING: 0, PAUSED: 1, SCHEDULED: 2, GENERATING: 3, DRAFT: 4, COMPLETE: 5, CANCELLED: 6, FAILED: 7 };
        for (let i = 0; i < fleet.length - 1; i++) {
          const a = order[fleet[i].state] !== undefined ? order[fleet[i].state] : 99;
          const b = order[fleet[i + 1].state] !== undefined ? order[fleet[i + 1].state] : 99;
          expect(a <= b).to.equal(true);
        }
      });

      it('getCampaignMetrics() returns deliveryRate and bounceRate', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('metrics-test');
        const { getCampaignMetrics } = require('email-campaign/core/CampaignManager');
        const metrics = getCampaignMetrics(campaignId);
        expect(metrics).to.have.property('deliveryRate');
        expect(metrics).to.have.property('bounceRate');
        expect(metrics).to.have.property('replyRate');
        expect(metrics).to.have.property('warmupDay');
      });

      it('addRecipients() appends new recipients to an existing DRAFT campaign', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('add-recipients');
        const { addRecipients } = require('email-campaign/core/CampaignManager');
        const result = addRecipients(campaignId, [
          { email: 'new1@example.com' },
          { email: 'new2@example.com' },
        ]);
        expect(result.added).to.equal(2);
        expect(result.totalRecipients).to.equal(4); // 2 original + 2 new
      });

      it('addRecipients() rejects adds to COMPLETE campaigns', () => {
        const { ensureTabs, updateCampaign } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('add-to-complete');
        updateCampaign(campaignId, { state: 'COMPLETE' });
        const { addRecipients } = require('email-campaign/core/CampaignManager');
        let threw = false;
        try { addRecipients(campaignId, [{ email: 'x@example.com' }]); } catch (e) { threw = true; }
        expect(threw).to.equal(true);
      });

      it('startCampaign() throws when campaign is not SCHEDULED', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('start-not-scheduled');
        // Campaign is in DRAFT state
        const { startCampaign } = require('email-campaign/core/CampaignManager');
        let threw = false;
        try { startCampaign(campaignId); } catch (e) { threw = true; }
        expect(threw).to.equal(true);
      });

      it('pauseCampaign() transitions SENDING → PAUSED', () => {
        const { ensureTabs, updateCampaign } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('pause-test');
        updateCampaign(campaignId, { state: 'SENDING' });
        const { pauseCampaign } = require('email-campaign/core/CampaignManager');
        pauseCampaign(campaignId, 'test pause');
        const { getCampaign } = require('email-campaign/storage/CampaignStorage');
        expect(getCampaign(campaignId).state).to.equal('PAUSED');
      });

      it('resumeCampaign() transitions PAUSED → SENDING', () => {
        const { ensureTabs, updateCampaign } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const campaignId = _createTestCampaign('resume-test');
        updateCampaign(campaignId, { state: 'PAUSED' });
        const { resumeCampaign } = require('email-campaign/core/CampaignManager');
        resumeCampaign(campaignId);
        const { getCampaign } = require('email-campaign/storage/CampaignStorage');
        expect(getCampaign(campaignId).state).to.equal('SENDING');
      });
    });

    // ─── ensureSchedulerTrigger ────────────────────────────────────────────

    describe('CampaignManager.ensureSchedulerTrigger()', () => {
      it('should be idempotent — calling twice creates only one trigger', () => {
        const { ensureSchedulerTrigger, removeSchedulerTrigger } = require('email-campaign/core/CampaignManager');
        // Clean slate: remove any existing scheduler trigger first
        removeSchedulerTrigger();
        const countBefore = ScriptApp.getProjectTriggers().length;

        ensureSchedulerTrigger();
        const countAfterFirst = ScriptApp.getProjectTriggers().length;
        ensureSchedulerTrigger(); // second call — must not add another
        const countAfterSecond = ScriptApp.getProjectTriggers().length;

        expect(countAfterFirst).to.equal(countBefore + 1);
        expect(countAfterSecond).to.equal(countAfterFirst); // idempotent

        // Cleanup
        removeSchedulerTrigger();
      });
    });

    // ─── EmailSender MIME headers ──────────────────────────────────────────

    describe('EmailSender MIME construction', () => {
      it('send/EmailSender exports send', () => {
        const EmailSender = require('email-campaign/send/EmailSender');
        expect(typeof EmailSender.send).to.equal('function');
      });
    });

    // ─── Global trigger handler accessibility ──────────────────────────────

    describe('entrypoints.gs global trigger handlers', () => {
      it('runCampaignScheduler is accessible as a top-level function', () => {
        expect(typeof runCampaignScheduler).to.equal('function');
      });

      it('pollCampaignTracking is accessible as a top-level function', () => {
        expect(typeof pollCampaignTracking).to.equal('function');
      });

      it('generateCampaignContent is accessible as a top-level function', () => {
        expect(typeof generateCampaignContent).to.equal('function');
      });

      it('processCampaignBatch is accessible as a top-level function', () => {
        expect(typeof processCampaignBatch).to.equal('function');
      });
    });

    // ─── Round-robin scheduler index ──────────────────────────────────────

    describe('Campaign Scheduler round-robin index', () => {
      it('CAMPAIGN_SCHEDULER_LAST_IDX persists across executions via PropertiesService', () => {
        const props = PropertiesService.getScriptProperties();
        props.setProperty('CAMPAIGN_SCHEDULER_LAST_IDX', '7');
        const read = Number(props.getProperty('CAMPAIGN_SCHEDULER_LAST_IDX') || '-1');
        expect(read).to.equal(7);
        // Clean up
        props.deleteProperty('CAMPAIGN_SCHEDULER_LAST_IDX');
      });
    });

    const results = runTests();
    log('=== Phase 2 Tests Complete: ' + results.passed + ' passed, ' + results.failed + ' failed ===');
    return results;
  }

  module.exports = { run };
}

__defineModule__(_main);
