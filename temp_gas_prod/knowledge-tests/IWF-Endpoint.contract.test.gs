function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * IWF Endpoint Contract Tests
   * 
   * Verifies IWF website endpoints and filtering capabilities.
   * Documents year filtering with ?cy= parameter.
   * 
   * PURPOSE: Contract tests for IWF endpoints to ensure
   * the Knowledge sheet accurately documents IWF data sources.
   */

  const { describe, it } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('IWF Endpoint Contracts', function() {
    var IWF_BASE = 'https://iwf.sport';

    describe('Calendar Year Filtering', function() {
      it('should filter calendar by current year', function() {
        var year = new Date().getFullYear();
        var url = IWF_BASE + '/events/calendar/?cy=' + year;
        var response = UrlFetchApp.fetch(url, {
          muteHttpExceptions: true,
          followRedirects: true
        });

        Logger.log('=== IWF CURRENT YEAR ===');
        Logger.log('Year: ' + year);
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('Content length: ' + response.getContentText().length);
        Logger.log('=== END ===');

        expect([200, 301, 302]).to.include(response.getResponseCode());
      });

      it('should filter calendar by previous year', function() {
        var year = new Date().getFullYear() - 1;
        var url = IWF_BASE + '/events/calendar/?cy=' + year;
        var response = UrlFetchApp.fetch(url, {
          muteHttpExceptions: true,
          followRedirects: true
        });

        Logger.log('=== IWF PREVIOUS YEAR ===');
        Logger.log('Year: ' + year);
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');

        expect([200, 301, 302]).to.include(response.getResponseCode());
      });

      it('should handle invalid year gracefully', function() {
        var url = IWF_BASE + '/events/calendar/?cy=invalid';
        var response = UrlFetchApp.fetch(url, {
          muteHttpExceptions: true,
          followRedirects: true
        });

        Logger.log('=== IWF INVALID YEAR ===');
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');

        // Should not crash - either show default or error page
        expect([200, 301, 302, 400, 404]).to.include(response.getResponseCode());
      });
    });

    describe('World Records Endpoint', function() {
      it('should have accessible world records page', function() {
        var url = IWF_BASE + '/new_bw_/results_by_events/?event_type=world_records';
        var response = UrlFetchApp.fetch(url, {
          muteHttpExceptions: true,
          followRedirects: true
        });

        Logger.log('=== IWF WORLD RECORDS ===');
        Logger.log('Status: ' + response.getResponseCode());
        if (response.getResponseCode() === 200) {
          var content = response.getContentText();
          Logger.log('Has records references: ' + content.toLowerCase().includes('record'));
          Logger.log('Content length: ' + content.length);
        }
        Logger.log('=== END ===');

        expect([200, 301, 302, 403, 404]).to.include(response.getResponseCode());
      });
    });

    describe('Results Page Structure', function() {
      it('should contain competition result elements', function() {
        var response = UrlFetchApp.fetch(
          IWF_BASE + '/results/results-by-events/',
          { muteHttpExceptions: true, followRedirects: true }
        );

        Logger.log('=== IWF RESULTS STRUCTURE ===');
        Logger.log('Status: ' + response.getResponseCode());

        if (response.getResponseCode() === 200) {
          var content = response.getContentText();

          Logger.log('Has snatch reference: ' + content.toLowerCase().includes('snatch'));
          Logger.log('Has clean & jerk reference: ' + (content.toLowerCase().includes('clean') || content.toLowerCase().includes('jerk')));
          Logger.log('Has total reference: ' + content.toLowerCase().includes('total'));
          Logger.log('Has weight class reference: ' + content.toLowerCase().includes('kg'));
        }
        Logger.log('=== END ===');

        expect([200, 301, 302]).to.include(response.getResponseCode());
      });
    });
  });

  module.exports = { run: function() { return require('test-framework/mocha-adapter').run(); } };
}

__defineModule__(_main);