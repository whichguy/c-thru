function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, runTests } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  function run() {
    log('=== Phase 4 Email Campaign Tests ===');

    // ─── TemplateEngine — merge-field substitution ─────────────────────────

    describe('TemplateEngine._substitute', () => {
      const { _substitute } = require('email-campaign/content/TemplateEngine');

      it('substitutes a single {{field}} placeholder', () => {
        const result = _substitute('Hello {{firstName}}!', { firstName: 'Alice' });
        expect(result).to.equal('Hello Alice!');
      });

      it('substitutes multiple different fields', () => {
        const result = _substitute('Hi {{firstName}}, your tier is {{tier}}.', {
          firstName: 'Bob', tier: 'Gold',
        });
        expect(result).to.equal('Hi Bob, your tier is Gold.');
      });

      it('leaves unknown placeholders unchanged', () => {
        const result = _substitute('Hello {{firstName}} {{unknown}}!', { firstName: 'Carol' });
        expect(result).to.equal('Hello Carol {{unknown}}!');
      });

      it('leaves placeholder when recipient field is empty string', () => {
        const result = _substitute('Hi {{firstName}}!', { firstName: '' });
        expect(result).to.equal('Hi {{firstName}}!');
      });

      it('leaves placeholder when recipient field is null', () => {
        const result = _substitute('Hi {{firstName}}!', { firstName: null });
        expect(result).to.equal('Hi {{firstName}}!');
      });

      it('handles template with no placeholders', () => {
        const result = _substitute('No placeholders here.', { firstName: 'Dave' });
        expect(result).to.equal('No placeholders here.');
      });

      it('handles empty template string', () => {
        const result = _substitute('', { firstName: 'Eve' });
        expect(result).to.equal('');
      });

      it('converts numeric field values to strings', () => {
        const result = _substitute('Score: {{score}}', { score: 42 });
        expect(result).to.equal('Score: 42');
      });
    });

    // ─── TemplateEngine — unresolved placeholder detection ────────────────

    describe('TemplateEngine._findUnresolved', () => {
      const { _findUnresolved } = require('email-campaign/content/TemplateEngine');

      it('returns empty array when no placeholders remain', () => {
        expect(_findUnresolved('Hello Alice, your tier is Gold.')).to.deep.equal([]);
      });

      it('detects unresolved {{field}} placeholders', () => {
        const result = _findUnresolved('Hi {{firstName}} {{lastName}}!');
        expect(result).to.include('{{firstName}}');
        expect(result).to.include('{{lastName}}');
      });

      it('excludes {{UNSUBSCRIBE_URL}} (resolved by EmailSender)', () => {
        const result = _findUnresolved('Click here: {{UNSUBSCRIBE_URL}} and {{firstName}}');
        expect(result).to.not.include('{{UNSUBSCRIBE_URL}}');
        expect(result).to.include('{{firstName}}');
      });

      it('deduplicates repeated unresolved fields', () => {
        const result = _findUnresolved('{{firstName}} and {{firstName}} again');
        expect(result.length).to.equal(1);
      });
    });

    // ─── TemplateEngine — footer injection ────────────────────────────────

    describe('TemplateEngine._buildFooter', () => {
      const { _buildFooter } = require('email-campaign/content/TemplateEngine');

      const campaign = {
        campaignId:      'test-campaign',
        physicalAddress: '123 Main St, Anytown, US 12345',
        senderEmail:     'sender@example.com',
      };
      const recipient = { email: 'user@example.com' };

      it('returns html and text keys', () => {
        const footer = _buildFooter(campaign, recipient);
        expect(footer).to.have.property('html');
        expect(footer).to.have.property('text');
      });

      it('html footer contains unsubscribe placeholder', () => {
        const footer = _buildFooter(campaign, recipient);
        expect(footer.html).to.include('{{UNSUBSCRIBE_URL}}');
      });

      it('html footer contains physical address', () => {
        const footer = _buildFooter(campaign, recipient);
        expect(footer.html).to.include('123 Main St');
      });

      it('text footer contains physical address', () => {
        const footer = _buildFooter(campaign, recipient);
        expect(footer.text).to.include('123 Main St');
      });

      it('text footer contains unsubscribe URL placeholder', () => {
        const footer = _buildFooter(campaign, recipient);
        expect(footer.text).to.include('{{UNSUBSCRIBE_URL}}');
      });

      it('footer works when physicalAddress is absent', () => {
        const noAddr = { campaignId: 'x', senderEmail: 'a@b.com' };
        const footer = _buildFooter(noAddr, recipient);
        expect(footer.html).to.be.a('string');
        expect(footer.text).to.be.a('string');
      });
    });

    // ─── TemplateEngine — full render ─────────────────────────────────────

    describe('TemplateEngine.render', () => {
      it('module exports render function', () => {
        const te = require('email-campaign/content/TemplateEngine');
        expect(typeof te.render).to.equal('function');
      });

      it('render throws when no content found for campaign', () => {
        const { render } = require('email-campaign/content/TemplateEngine');
        const { ensureTabs } = require('email-campaign/storage/CampaignStorage');
        ensureTabs();
        let threw = false;
        try {
          render(
            { campaignId: 'nonexistent-id-xyz', physicalAddress: '123 St' },
            { email: 'user@example.com', segment: 'default' }
          );
        } catch (e) {
          threw = true;
          expect(e.message).to.include('No GENERATED content found');
        }
        expect(threw).to.equal(true);
      });
    });

    // ─── ContentGenerator module structure ────────────────────────────────

    describe('ContentGenerator module', () => {
      it('exports generateForCampaign as a function', () => {
        const cg = require('email-campaign/content/ContentGenerator');
        expect(typeof cg.generateForCampaign).to.equal('function');
      });

      it('exports ContentGenerator facade', () => {
        const { ContentGenerator } = require('email-campaign/content/ContentGenerator');
        expect(typeof ContentGenerator).to.equal('object');
        expect(typeof ContentGenerator.generateForCampaign).to.equal('function');
      });
    });

    // ─── BUG 2 regression: appendRecipients header column placement ──────
    // Verifies that appendRecipients writes merge-field headers at getLastColumn()+1,
    // not at the fragile allHeaders.filter(h=>h).length+1 position.

    describe('CampaignStorage.appendRecipients (BUG 2 regression)', () => {
      const { ensureTabs, getRecipients } = require('email-campaign/storage/CampaignStorage');
      const { appendRecipients } = require('email-campaign/storage/CampaignStorage');

      it('appends a recipient with a new merge field without throwing', () => {
        ensureTabs();
        const testCampaignId = 'phase4-spec-bug2-' + Date.now();
        let threw = false;
        try {
          appendRecipients([{
            campaignId: testCampaignId,
            email:      'bug2test@example.com',
            status:     'PENDING',
            customField: 'TestValue', // merge field not in fixed schema
          }]);
        } catch (e) {
          threw = true;
          log('[BUG2 TEST] threw: ' + e.message);
        }
        expect(threw).to.equal(false);
      });

      it('appended recipient is retrievable with correct status', () => {
        ensureTabs();
        const testCampaignId = 'phase4-spec-bug2b-' + Date.now();
        appendRecipients([{
          campaignId: testCampaignId,
          email:      'bug2b@example.com',
          status:     'PENDING',
          mergeFieldX: 'ValueX',
        }]);
        const recipients = getRecipients(testCampaignId);
        expect(recipients.length).to.equal(1);
        expect(recipients[0].data.email).to.equal('bug2b@example.com');
        expect(recipients[0].data.status).to.equal('PENDING');
      });
    });

    // ─── BUG 3 regression: ContentGenerator._parseContent edge cases ──────
    // _callClaude's content[0].text guard is HTTP-layer only (untestable without
    // mocking UrlFetchApp). These tests cover the _parseContent contract that
    // _callClaude's output feeds into, confirming valid JSON is handled correctly
    // and parse failures produce actionable errors.

    describe('ContentGenerator._parseContent (BUG 3 regression)', () => {
      const { _parseContent } = require('email-campaign/content/ContentGenerator');

      it('parses valid JSON response into subject/htmlBody/textBody', () => {
        const result = _parseContent('{"subject":"Test","htmlBody":"<p>Hi</p>","textBody":"Hi"}');
        expect(result.subject).to.equal('Test');
        expect(result.htmlBody).to.equal('<p>Hi</p>');
        expect(result.textBody).to.equal('Hi');
      });

      it('strips markdown code fences before parsing', () => {
        const result = _parseContent('```json\n{"subject":"S","htmlBody":"H","textBody":"T"}\n```');
        expect(result.subject).to.equal('S');
      });

      it('throws with actionable message on invalid JSON', () => {
        let err = null;
        try { _parseContent('not valid json'); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.message).to.include('Failed to parse Claude response as JSON');
      });

      it('throws with raw preview in error message on invalid JSON', () => {
        let err = null;
        try { _parseContent('{broken'); } catch (e) { err = e; }
        expect(err.message).to.include('raw=');
      });
    });

    const results = runTests();
    log('=== Phase 4 Tests Complete: ' + results.passed + ' passed, ' + results.failed + ' failed ===');
    return results;
  }

  module.exports = { run };
}

__defineModule__(_main);