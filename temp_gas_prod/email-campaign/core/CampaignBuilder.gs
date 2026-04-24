function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { validateCampaign, EMAIL_REGEX } = require('email-campaign/send/ComplianceGuard');
  const { appendCampaign, appendRecipients, updateCampaign } = require('email-campaign/storage/CampaignStorage');

  class CampaignBuilder {
    constructor(name) {
      if (!name) throw new Error('CampaignBuilder: campaign name is required');
      this._fields = {
        campaignId:  Utilities.getUuid(),
        name,
        channel:     'email',
        state:       'DRAFT',
        createdAt:   new Date().toISOString(),
        createdBy:   Session.getActiveUser().getEmail(),
        sent:        0, failed: 0, bounced: 0, replied: 0,
        unsubscribed: 0, skipped: 0, totalRecipients: 0,
        lastProcessedRow: 1, dailySentCount: 0, warmupDay: 1,
      };
      this._recipients = [];
    }

    withType(type) {
      if (!['existing_customer', 'prospect'].includes(type)) {
        throw new Error('Invalid campaign type: ' + type + '. Must be existing_customer or prospect.');
      }
      this._fields.type = type;
      return this;
    }

    withChannel(channel) {
      if (!['email'].includes(channel)) {
        throw new Error('Channel "' + channel + '" is not yet active. Only "email" is supported.');
      }
      this._fields.channel = channel;
      return this;
    }

    withSender(email, name, replyTo) {
      this._fields.senderEmail = email;
      this._fields.senderName  = name;
      if (replyTo) this._fields.replyTo = replyTo;
      return this;
    }

    withPhysicalAddress(address) {
      this._fields.physicalAddress = address;
      return this;
    }

    /**
     * Validates and stages recipient rows.
     * Invalid email formats are flagged (logged as warnings) and skipped.
     * @param {Array<Object>} recipients - Array of recipient objects with at least { email }
     */
    withRecipients(recipients) {
      if (!Array.isArray(recipients) || recipients.length === 0) {
        throw new Error('CampaignBuilder.withRecipients: recipients must be a non-empty array');
      }
      const valid = [];
      const invalid = [];
      recipients.forEach(r => {
        if (!r.email || !EMAIL_REGEX.test(r.email)) {
          invalid.push(r.email || '(empty)');
          return;
        }
        valid.push(Object.assign({}, r, {
          campaignId:     this._fields.campaignId,
          channelAddress: r.email, // email channel: channelAddress = email
          status:         'PENDING',
          autoReplyCount: 0,
        }));
      });
      if (invalid.length > 0) {
        log('[WARN] CampaignBuilder: skipped ' + invalid.length + ' invalid email(s): ' + invalid.slice(0, 5).join(', '));
      }
      this._recipients = this._recipients.concat(valid);
      this._fields.totalRecipients = this._recipients.length;
      return this;
    }

    withContentStrategy(strategy) {
      this._fields.contentStrategy = typeof strategy === 'string' ? strategy : JSON.stringify(strategy);
      return this;
    }

    withSendConfig(config) {
      this._fields.sendConfig = typeof config === 'string' ? config : JSON.stringify(config);
      return this;
    }

    withWarmupSchedule(schedule) {
      // Merge into sendConfig
      let cfg = {};
      try { cfg = JSON.parse(this._fields.sendConfig || '{}'); } catch (e) {}
      cfg.warmupSchedule = schedule;
      this._fields.sendConfig = JSON.stringify(cfg);
      return this;
    }

    withScheduledAt(date) {
      this._fields.scheduledAt = date instanceof Date ? date.toISOString() : date;
      return this;
    }

    /**
     * Validates the campaign, writes _Campaigns + _Recipients rows, and returns the campaignId.
     * On success, state is DRAFT (or SCHEDULED if scheduledAt is set).
     */
    build() {
      // Set defaults for missing optional fields
      if (!this._fields.type)    this._fields.type    = 'existing_customer';
      if (!this._fields.channel) this._fields.channel = 'email';

      // Validate via ComplianceGuard
      validateCampaign(this._fields);

      // E7: Block if no recipients
      if (this._recipients.length === 0) {
        throw new Error('Campaign cannot be built with 0 valid recipients');
      }

      // Promote to SCHEDULED if a future send time was configured
      if (this._fields.scheduledAt) this._fields.state = 'SCHEDULED';

      // Write campaign row
      appendCampaign(this._fields);
      log('CampaignBuilder.build: campaign created | id=' + this._fields.campaignId + ' name=' + this._fields.name);

      // Write recipient rows — guarded so a failure does not leave an orphaned campaign row
      // with totalRecipients > 0 but no PENDING recipients (which would trigger false completion).
      try {
        appendRecipients(this._recipients);
      } catch (err) {
        log('[ERROR] CampaignBuilder.build: appendRecipients failed — marking campaign CANCELLED | id=' + this._fields.campaignId + ' err=' + err.message);
        try { updateCampaign(this._fields.campaignId, { state: 'CANCELLED', notes: 'Build failed: ' + err.message }); } catch (e) { /* best effort */ }
        throw err;
      }
      log('CampaignBuilder.build: ' + this._recipients.length + ' recipients added');

      return this._fields.campaignId;
    }
  }

  /**
   * Factory function — entry point for the fluent builder.
   * @param {string} name - Human-readable campaign name
   * @returns {CampaignBuilder}
   */
  function create(name) {
    return new CampaignBuilder(name);
  }

  module.exports = { create, CampaignBuilder };
}

__defineModule__(_main);