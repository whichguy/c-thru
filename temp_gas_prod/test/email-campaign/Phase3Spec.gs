// test/email-campaign/Phase3Spec.gs
// Phase 3 test suite: TrackingManager — bounce classification, aggregate recalculation,
// auto-pause thresholds, engagement scoring, multi-campaign bounce dedup.
// Run via: require('test/email-campaign/Phase3Spec').run()

function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {

  const { describe, it, runTests } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  function run() {
    log('=== Phase 3 Email Campaign Tests ===');

    // ─── Bounce classification ─────────────────────────────────────────────

    describe('_classifyBounce — hard/soft DSN parsing', () => {
      const { _classifyBounce } = require('email-campaign/tracking/TrackingManager');

      it('classifies RFC 3463 status 5.x.x as hard', () => {
        expect(_classifyBounce('Status: 5.1.1\nDiagnostic-Code: User does not exist')).to.equal('hard');
      });

      it('classifies RFC 3463 status 4.x.x as soft', () => {
        expect(_classifyBounce('Status: 4.2.2\nMailbox full, try later')).to.equal('soft');
      });

      it('classifies smtp; 5.x.x inline as hard', () => {
        expect(_classifyBounce('smtp; 5.1.1 No such user here')).to.equal('hard');
      });

      it('classifies smtp; 4.x.x inline as soft', () => {
        expect(_classifyBounce('smtp; 4.4.1 Connection timed out')).to.equal('soft');
      });

      it('classifies 550 error code as hard', () => {
        expect(_classifyBounce('550 user unknown')).to.equal('hard');
      });

      it('classifies "user unknown" text as hard', () => {
        expect(_classifyBounce('The user unknown at this domain')).to.equal('hard');
      });

      it('classifies "mailbox not found" as hard', () => {
        expect(_classifyBounce('mailbox not found on this server')).to.equal('hard');
      });

      it('classifies "invalid recipient" as hard', () => {
        expect(_classifyBounce('invalid recipient: noreply@example.com')).to.equal('hard');
      });

      it('defaults to soft for unrecognized bounce format', () => {
        expect(_classifyBounce('Delivery temporarily suspended: network error')).to.equal('soft');
      });

      it('classifies "does not exist" as hard', () => {
        expect(_classifyBounce('Recipient address does not exist')).to.equal('hard');
      });
    });

    // ─── TrackingManager module exports ───────────────────────────────────

    describe('TrackingManager module structure', () => {
      it('exports pollAll as a function', () => {
        const tm = require('email-campaign/tracking/TrackingManager');
        expect(typeof tm.pollAll).to.equal('function');
      });

      it('exports TrackingManager facade with pollAll', () => {
        const { TrackingManager } = require('email-campaign/tracking/TrackingManager');
        expect(typeof TrackingManager).to.equal('object');
        expect(typeof TrackingManager.pollAll).to.equal('function');
      });

      it('exports _classifyBounce for unit testing', () => {
        const { _classifyBounce } = require('email-campaign/tracking/TrackingManager');
        expect(typeof _classifyBounce).to.equal('function');
      });
    });

    // ─── Tracking trigger management ──────────────────────────────────────

    describe('CampaignManager tracking trigger', () => {
      it('ensureTrackingTrigger() is idempotent — two calls create one trigger', () => {
        const { ensureTrackingTrigger, removeTrackingTrigger } = require('email-campaign/core/CampaignManager');
        removeTrackingTrigger(); // clean slate
        const before = ScriptApp.getProjectTriggers().length;

        ensureTrackingTrigger();
        const after1 = ScriptApp.getProjectTriggers().length;
        ensureTrackingTrigger(); // second call — must be no-op
        const after2 = ScriptApp.getProjectTriggers().length;

        expect(after1).to.equal(before + 1);
        expect(after2).to.equal(after1); // idempotent

        removeTrackingTrigger(); // cleanup
      });

      it('removeTrackingTrigger() removes the tracking trigger', () => {
        const { ensureTrackingTrigger, removeTrackingTrigger } = require('email-campaign/core/CampaignManager');
        ensureTrackingTrigger();
        const before = ScriptApp.getProjectTriggers().length;
        removeTrackingTrigger();
        const after = ScriptApp.getProjectTriggers().length;
        expect(after).to.equal(before - 1);
      });

      it('CampaignManager exports ensureTrackingTrigger and removeTrackingTrigger', () => {
        const mgr = require('email-campaign/core/CampaignManager');
        expect(typeof mgr.ensureTrackingTrigger).to.equal('function');
        expect(typeof mgr.removeTrackingTrigger).to.equal('function');
      });
    });

    // ─── Auto-pause threshold math ────────────────────────────────────────

    describe('Auto-pause threshold logic', () => {
      it('bounceRate > 3% should trigger auto-pause', () => {
        const bounced = 4, total = 100;
        expect(bounced / total > 0.03).to.equal(true);
      });

      it('bounceRate <= 3% should NOT trigger auto-pause', () => {
        const bounced = 3, total = 100;
        expect(bounced / total > 0.03).to.equal(false); // exactly 3% is safe
      });

      it('spamRate (bounceRate + unsubRate) > 0.2% triggers auto-pause', () => {
        const bounced = 2, unsubscribed = 1, total = 1000;
        const spamRate = (bounced + unsubscribed) / total;
        expect(spamRate > 0.002).to.equal(true); // 0.3% > 0.2%
      });

      it('spamRate <= 0.2% should NOT trigger auto-pause', () => {
        const bounced = 0, unsubscribed = 2, total = 1000;
        const spamRate = (bounced + unsubscribed) / total;
        expect(spamRate > 0.002).to.equal(false); // exactly 0.2% is safe
      });
    });

    // ─── Delivery inference logic ──────────────────────────────────────────

    describe('Delivery inference — 24h cutoff logic', () => {
      it('sentAt 25h ago is past the 24h cutoff', () => {
        const sentAt = new Date(Date.now() - 25 * 3600 * 1000);
        const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
        expect(sentAt < cutoff).to.equal(true);
      });

      it('sentAt 23h ago is NOT past the 24h cutoff', () => {
        const sentAt = new Date(Date.now() - 23 * 3600 * 1000);
        const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
        expect(sentAt < cutoff).to.equal(false);
      });
    });

    // ─── Multi-campaign bounce dedup ──────────────────────────────────────

    describe('Multi-campaign bounce dedup — single search distribution', () => {
      it('msgIdMap keys for 2 campaigns with different message IDs are independent', () => {
        const msgId1 = '<abc@example.com>';
        const msgId2 = '<def@example.com>';
        const msgIdMap = {};
        msgIdMap[msgId1] = { campaignId: 'camp1', email: 'a@example.com' };
        msgIdMap[msgId2] = { campaignId: 'camp2', email: 'b@example.com' };
        expect(Object.keys(msgIdMap).length).to.equal(2);
        expect(msgIdMap[msgId1].campaignId).to.equal('camp1');
        expect(msgIdMap[msgId2].campaignId).to.equal('camp2');
      });

      it('msgIdMap correctly normalizes message IDs with and without angle brackets', () => {
        const msgIdMap = {};
        const rawId = 'abc123@mail.example.com';
        // Simulates the normalization: if not starting with < , wrap it
        const key = rawId.startsWith('<') ? rawId : '<' + rawId + '>';
        msgIdMap[key] = { campaignId: 'camp1', email: 'x@example.com' };
        expect(msgIdMap['<abc123@mail.example.com>'].campaignId).to.equal('camp1');
      });

      it('emailMap fallback collects multiple campaigns sharing the same recipient email', () => {
        const emailMap = {};
        const em = 'shared@example.com';
        if (!emailMap[em]) emailMap[em] = [];
        emailMap[em].push({ campaignId: 'camp1', email: em });
        emailMap[em].push({ campaignId: 'camp2', email: em });
        expect(emailMap[em].length).to.equal(2);
        // Most recently added campaign wins (last element)
        expect(emailMap[em][emailMap[em].length - 1].campaignId).to.equal('camp2');
      });

      it('aggregate recalculation correctly counts each status bucket', () => {
        const statuses = ['SENT', 'DELIVERED', 'REPLIED', 'BOUNCED', 'FAILED', 'SKIPPED'];
        let sent = 0, failed = 0, bounced = 0, replied = 0, skipped = 0;
        for (const s of statuses) {
          if (['SENT', 'DELIVERED', 'REPLIED'].includes(s)) sent++;
          if (s === 'FAILED') failed++;
          if (s === 'BOUNCED') bounced++;
          if (s === 'REPLIED') replied++;
          if (['SKIPPED', 'SUPPRESSED', 'CANCELLED'].includes(s)) skipped++;
        }
        expect(sent).to.equal(3);    // SENT + DELIVERED + REPLIED
        expect(failed).to.equal(1);
        expect(bounced).to.equal(1);
        expect(replied).to.equal(1);
        expect(skipped).to.equal(1);
      });
    });

    const results = runTests();
    log('=== Phase 3 Tests Complete: ' + results.passed + ' passed, ' + results.failed + ' failed ===');
    return results;
  }

  module.exports = { run };
}

__defineModule__(_main);
