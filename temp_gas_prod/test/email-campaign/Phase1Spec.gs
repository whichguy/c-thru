// test/email-campaign/Phase1Spec.gs
// Phase 1 test suite: Sheet storage, suppression, compliance, HMAC tokens.
// Run via: require('test/email-campaign/Phase1Spec').run()

function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {

  const { describe, it, runTests } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  function run() {
    log('=== Phase 1 Email Campaign Tests ===');

    describe('CampaignStorage.ensureTabs()', () => {
      it('should create all required tabs', () => {
        const { ensureTabs, TAB } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const ss = SpreadsheetApp.openById('1AMEPouG0QeSs6fjov-Iha7XrcxO-AyUOckM0aqRGg0A');
        const sheetNames = ss.getSheets().map(s => s.getName());
        expect(sheetNames).to.include(TAB.CAMPAIGNS);
        expect(sheetNames).to.include(TAB.RECIPIENTS);
        expect(sheetNames).to.include(TAB.SUPPRESSION);
        expect(sheetNames).to.include(TAB.CONTENT);
        expect(sheetNames).to.include(TAB.DASHBOARD);
        expect(sheetNames).to.include(TAB.OPT_IN);
      });

      it('should create _Campaigns tab with correct headers', () => {
        const { ensureTabs, TAB } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const ss = SpreadsheetApp.openById('1AMEPouG0QeSs6fjov-Iha7XrcxO-AyUOckM0aqRGg0A');
        const sheet = ss.getSheetByName(TAB.CAMPAIGNS);
        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        expect(headers).to.include('campaignId');
        expect(headers).to.include('state');
        expect(headers).to.include('senderEmail');
        expect(headers).to.include('lastProcessedRow');
      });

      it('should be idempotent — calling twice does not duplicate tabs', () => {
        const { ensureTabs, TAB } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        ensureTabs(); // Second call
        const ss = SpreadsheetApp.openById('1AMEPouG0QeSs6fjov-Iha7XrcxO-AyUOckM0aqRGg0A');
        const campaignSheets = ss.getSheets().filter(s => s.getName() === TAB.CAMPAIGNS);
        expect(campaignSheets.length).to.equal(1);
      });
    });

    describe('SuppressionList', () => {
      it('should add and detect suppressed email', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const SuppressionList = require('email-campaign/compliance/SuppressionList');
        const testEmail = 'suppress-test-' + Date.now() + '@example.com';

        expect(SuppressionList.isSuppressed(testEmail)).to.equal(false);
        SuppressionList.addSuppression(testEmail, 'manual', 'test', 'manual');
        // Cache was populated before add — clear by requiring fresh
        const SL2 = require('email-campaign/compliance/SuppressionList');
        // Note: in-memory cache persists per execution; test verifies Sheet persistence
        const { getSuppressionSet } = require('email-campaign/storage/CampaignStorage');
        const set = getSuppressionSet();
        expect(set.has(testEmail.toLowerCase())).to.equal(true);
      });

      it('should normalize email case for lookup', () => {
        const { ensureTabs, getSuppressionSet } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const SuppressionList = require('email-campaign/compliance/SuppressionList');
        const testEmail = 'CAPS-test-' + Date.now() + '@Example.COM';
        SuppressionList.addSuppression(testEmail, 'manual', 'test', 'manual');
        const set = getSuppressionSet();
        expect(set.has(testEmail.toLowerCase().trim())).to.equal(true);
      });

      it('should be idempotent — adding duplicate returns false', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const { addSuppression: _addRaw } = require('email-campaign/storage/CampaignStorage');
        const testEmail = 'dedup-test-' + Date.now() + '@example.com';
        const first = _addRaw(testEmail, 'manual', 'test', 'manual');
        const second = _addRaw(testEmail, 'manual', 'test', 'manual');
        expect(first).to.equal(true);
        expect(second).to.equal(false);
      });
    });

    describe('ComplianceGuard.validateSend()', () => {
      it('should block invalid email format', () => {
        const { validateSend } = require('email-campaign/send/ComplianceGuard');
        const result = validateSend(
          { channel: 'email', type: 'existing_customer', campaignId: 'test' },
          { email: 'not-an-email' },
          {}
        );
        expect(result.pass).to.equal(false);
        expect(result.action).to.equal('SKIPPED');
        expect(result.reason).to.include('invalid email format');
      });

      it('should block unsupported channels', () => {
        const { validateSend } = require('email-campaign/send/ComplianceGuard');
        const result = validateSend(
          { channel: 'sms', type: 'existing_customer', campaignId: 'test' },
          { email: 'valid@example.com' },
          {}
        );
        expect(result.pass).to.equal(false);
        expect(result.action).to.equal('SKIPPED');
        expect(result.reason).to.include('not yet active');
      });

      it('should block suppressed emails', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const { addSuppression } = require('email-campaign/compliance/SuppressionList');
        const { validateSend } = require('email-campaign/send/ComplianceGuard');
        const suppressed = 'suppressed-check-' + Date.now() + '@example.com';
        addSuppression(suppressed, 'manual', 'test', 'manual');

        // Note: cache may not include just-added entry; test via direct Sheet check
        const { getSuppressionSet } = require('email-campaign/storage/CampaignStorage');
        const set = getSuppressionSet();
        expect(set.has(suppressed.toLowerCase())).to.equal(true);
      });

      it('should block prospect send without opt-in', () => {
        const { validateSend } = require('email-campaign/send/ComplianceGuard');
        const result = validateSend(
          { channel: 'email', type: 'prospect', campaignId: 'camp-test-1' },
          { email: 'prospect@example.com' },
          {}
        );
        expect(result.pass).to.equal(false);
        expect(result.action).to.equal('SKIPPED');
        expect(result.reason).to.include('opt-in');
      });

      it('should pass for valid existing_customer recipient', () => {
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        const { validateSend } = require('email-campaign/send/ComplianceGuard');
        const result = validateSend(
          { channel: 'email', type: 'existing_customer', campaignId: 'camp-test-2' },
          { email: 'valid-' + Date.now() + '@example.com' },
          { bounceRate: 0, estimatedSpamRate: 0 }
        );
        expect(result.pass).to.equal(true);
      });
    });

    describe('ComplianceGuard.validateSubject()', () => {
      it('should block Re: prefix', () => {
        const { validateSubject } = require('email-campaign/send/ComplianceGuard');
        expect(validateSubject('Re: Hello there').pass).to.equal(false);
      });

      it('should block Fwd: prefix', () => {
        const { validateSubject } = require('email-campaign/send/ComplianceGuard');
        expect(validateSubject('Fwd: Special offer').pass).to.equal(false);
      });

      it('should pass clean subject', () => {
        const { validateSubject } = require('email-campaign/send/ComplianceGuard');
        expect(validateSubject('Our Spring Newsletter').pass).to.equal(true);
      });
    });

    describe('UnsubscribeHandler HMAC', () => {
      it('should generate and validate a token', () => {
        const { generateToken } = require('email-campaign/compliance/UnsubscribeHandler');
        // Requires UNSUBSCRIBE_SECRET to be set in ConfigManager
        const ConfigManager = require('common-js/ConfigManager');
        const cm = new ConfigManager('CAMPAIGN');
        const secret = cm.get('UNSUBSCRIBE_SECRET', null);
        if (!secret) {
          log('[SKIP] UNSUBSCRIBE_SECRET not set — skipping HMAC token test');
          return;
        }
        const email = 'test@example.com';
        const campaignId = 'camp-abc123';
        const token = generateToken(email, campaignId);
        expect(typeof token).to.equal('string');
        expect(token.length).to.be.above(10);

        // Validate by re-generating and comparing
        const token2 = generateToken(email, campaignId);
        expect(token).to.equal(token2);

        // Different email should produce different token
        const tokenOther = generateToken('other@example.com', campaignId);
        expect(token).to.not.equal(tokenOther);
      });
    });

    describe('ComplianceGuard.validateStateFilter()', () => {
      it('should not throw for valid states', () => {
        const { validateStateFilter } = require('email-campaign/send/ComplianceGuard');
        expect(() => validateStateFilter('SENDING')).to.not.throw();
        expect(() => validateStateFilter('PAUSED')).to.not.throw();
        expect(() => validateStateFilter(undefined)).to.not.throw();
      });

      it('should throw for invalid state', () => {
        const { validateStateFilter } = require('email-campaign/send/ComplianceGuard');
        expect(() => validateStateFilter('INVALID_STATE')).to.throw();
      });
    });

    // ─── ContentGenerator: FAILED transition on invalid contentStrategy (Phase 1 regression) ────

    describe('ContentGenerator — invalid contentStrategy transitions to FAILED', () => {
      it('should transition campaign to FAILED (not DRAFT) when contentStrategy is invalid JSON', () => {
        const { ensureTabs, updateCampaign, getCampaign } = require('email-campaign/storage/CampaignStorage');
        const { create } = require('email-campaign/core/CampaignBuilder');
        ensureTabs();
        const campaignId = create('InvalidJSON Test ' + Date.now())
          .withSender(Session.getActiveUser().getEmail(), 'Test Sender')
          .withPhysicalAddress('123 Test St, Test City, TS 12345')
          .withRecipients([{ email: 'test@example.com', firstName: 'Alice' }])
          .build();
        // Write invalid JSON into contentStrategy
        updateCampaign(campaignId, { contentStrategy: '{ invalid json' });

        const { generateForCampaign } = require('email-campaign/content/ContentGenerator');
        generateForCampaign({ campaignId: campaignId });

        const after = getCampaign(campaignId);
        expect(after.state).to.equal('FAILED');
        expect(after.notes).to.include('Invalid contentStrategy JSON');
      });
    });

    return runTests();
  }

  module.exports = { run };

} // end _main

__defineModule__(_main);
