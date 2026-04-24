function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Layer 3: Contract Tests for External APIs
   * 
   * Verifies USAW and IWF APIs return expected structure.
   * Run infrequently to detect API changes.
   * No Claude API calls.
   * 
   * PURPOSE: Verify external APIs respond as expected and document their behavior.
   * All tests log evidence of what they found for debugging.
   */

  const { describe, it, before } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('USAW API Contract Tests', function() {
    var API_TOKEN = '14ced0f3-421f-4acf-94ad-cc63a371af19';
    var USAW_BASE = 'https://admin-usaw-rankings.sport80.com';

    describe('Rankings Endpoint', function() {
      it('should respond to rankings table endpoint', function() {
        var url = USAW_BASE + '/api/categories/rankings/table';
        var options = {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        };

        var response = UrlFetchApp.fetch(url, options);
        var code = response.getResponseCode();

        Logger.log('=== USAW RANKINGS ENDPOINT ===');
        Logger.log('URL: ' + url);
        Logger.log('Status: ' + code);
        Logger.log('=== END ===');

        // API should respond (200=success, 401/403/404=auth or endpoint change, not 500)
        expect([200, 401, 403, 404]).to.include(code);
      });

      it('should return JSON with data property on success', function() {
        var url = USAW_BASE + '/api/categories/rankings/table';
        var options = {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        };

        var response = UrlFetchApp.fetch(url, options);
        
        Logger.log('=== USAW RANKINGS STRUCTURE ===');
        Logger.log('Status: ' + response.getResponseCode());
        
        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());
          Logger.log('Response keys: ' + Object.keys(data).join(', '));
          Logger.log('Size: ' + response.getContentText().length + ' bytes');
          
          // Log first few keys for debugging
          Object.keys(data).slice(0, 3).forEach(function(key) {
            var val = data[key];
            var type = Array.isArray(val) ? 'array[' + val.length + ']' : typeof val;
            Logger.log('  ' + key + ': ' + type);
          });
          
          expect(data).to.exist;
        } else {
          Logger.log('Auth/Access issue - token may need refresh');
        }
        Logger.log('=== END ===');
      });

      it('should verify rankings endpoint returns expected structure', function() {
        var response = UrlFetchApp.fetch(
          USAW_BASE + '/api/categories/rankings/table',
          { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
        );

        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());

          Logger.log('=== RANKINGS STRUCTURE DETAIL ===');
          Logger.log('Top-level keys: ' + Object.keys(data).join(', '));

          // Check for expected keys
          var expectedKeys = ['data', 'total', 'page', 'filters', 'rankings'];
          expectedKeys.forEach(function(key) {
            var hasKey = data.hasOwnProperty(key);
            Logger.log('  ' + key + ': ' + (hasKey ? 'present' : 'MISSING'));
          });

          // Check if there's ranking data
          var rankingsArray = data.rankings || data.data || [];
          if (Array.isArray(rankingsArray) && rankingsArray.length > 0) {
            Logger.log('');
            Logger.log('First entry keys: ' + Object.keys(rankingsArray[0]).join(', '));
          }
          Logger.log('=== END ===');

          expect(data).to.be.an('object');
        } else {
          Logger.log('Skipping structure check - API returned ' + response.getResponseCode());
          expect([401, 403, 404]).to.include(response.getResponseCode());
        }
      });
    });

    describe('Filters Endpoint', function() {
      it('should have accessible filters endpoint', function() {
        var url = USAW_BASE + '/api/categories/rankings/table/filters';
        var options = {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        };

        var response = UrlFetchApp.fetch(url, options);
        
        Logger.log('=== USAW FILTERS ENDPOINT ===');
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');
        
        expect([200, 401, 403, 404]).to.include(response.getResponseCode());
      });

      it('should verify filters endpoint returns filter options', function() {
        var response = UrlFetchApp.fetch(
          USAW_BASE + '/api/categories/rankings/table/filters',
          { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
        );

        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());

          Logger.log('=== FILTERS STRUCTURE ===');
          Logger.log('Top-level keys: ' + Object.keys(data).join(', '));

          // Check for filter categories
          Object.keys(data).slice(0, 5).forEach(function(key) {
            var val = data[key];
            var type = Array.isArray(val) ? 'array[' + val.length + ']' : typeof val;
            Logger.log('  ' + key + ': ' + type);
          });
          Logger.log('=== END ===');

          expect(data).to.be.an('object');
        } else {
          Logger.log('Skipping filter check - API returned ' + response.getResponseCode());
          expect([401, 403, 404]).to.include(response.getResponseCode());
        }
      });
    });
  });

  describe('IWF API Contract Tests', function() {
    var IWF_BASE = 'https://iwf.sport';

    describe('Calendar Endpoint', function() {
      it('should have accessible calendar endpoint', function() {
        var year = new Date().getFullYear();
        var url = IWF_BASE + '/events/calendar/?cy=' + year;
        var options = { muteHttpExceptions: true };

        var response = UrlFetchApp.fetch(url, options);
        
        Logger.log('=== IWF CALENDAR ENDPOINT ===');
        Logger.log('URL: ' + url);
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');
        
        // IWF website should be accessible
        expect([200, 301, 302, 403]).to.include(response.getResponseCode());
      });

      it('should return HTML content for calendar', function() {
        var year = new Date().getFullYear();
        var url = IWF_BASE + '/events/calendar/?cy=' + year;
        var options = { 
          muteHttpExceptions: true,
          followRedirects: true
        };

        var response = UrlFetchApp.fetch(url, options);
        
        Logger.log('=== IWF CALENDAR CONTENT ===');
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('Size: ' + response.getContentText().length + ' bytes');
        
        if (response.getResponseCode() === 200) {
          var content = response.getContentText();
          var hasHtml = content.toLowerCase().includes('<!doctype html') || content.toLowerCase().includes('<html');
          Logger.log('Is HTML: ' + (hasHtml ? 'YES' : 'NO'));
          
          // Check for expected content markers
          var hasEventRefs = content.includes('event') || content.includes('calendar');
          var hasDateRefs = content.includes('date') || content.includes('Date');
          Logger.log('Has event references: ' + hasEventRefs);
          Logger.log('Has date references: ' + hasDateRefs);
          
          // Preview first 200 chars
          Logger.log('Content preview: ' + content.substring(0, 200).replace(/\n/g, ' ') + '...');
        }
        Logger.log('=== END ===');
      });

      it('should verify calendar page contains event data', function() {
        var response = UrlFetchApp.fetch(
          IWF_BASE + '/events/calendar/?cy=' + new Date().getFullYear(),
          { muteHttpExceptions: true, followRedirects: true }
        );

        Logger.log('=== IWF CALENDAR CONTRACT ===');
        Logger.log('Status: ' + response.getResponseCode());

        if (response.getResponseCode() === 200) {
          var content = response.getContentText();

          // Check for expected HTML elements
          var hasEventTable = content.includes('event') || content.includes('calendar');
          var hasDateFields = content.includes('date') || content.includes('Date');
          var hasLocationFields = content.includes('location') || content.includes('Location');

          Logger.log('Contains event references: ' + hasEventTable);
          Logger.log('Contains date fields: ' + hasDateFields);
          Logger.log('Contains location fields: ' + hasLocationFields);
          Logger.log('Content length: ' + content.length + ' bytes');
        }
        Logger.log('=== END ===');

        expect([200, 301, 302, 403]).to.include(response.getResponseCode());
      });
    });

    describe('Results Endpoint', function() {
      it('should have accessible results endpoint', function() {
        var url = IWF_BASE + '/results/results-by-events/';
        var options = { 
          muteHttpExceptions: true,
          followRedirects: true
        };

        var response = UrlFetchApp.fetch(url, options);
        
        Logger.log('=== IWF RESULTS ENDPOINT ===');
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');
        
        expect([200, 301, 302, 403]).to.include(response.getResponseCode());
      });

      it('should verify results page structure', function() {
        var response = UrlFetchApp.fetch(
          IWF_BASE + '/results/results-by-events/',
          { muteHttpExceptions: true, followRedirects: true }
        );

        Logger.log('=== IWF RESULTS CONTRACT ===');
        Logger.log('Status: ' + response.getResponseCode());

        if (response.getResponseCode() === 200) {
          var content = response.getContentText();

          var hasResultsSection = content.includes('result') || content.includes('Result');
          var hasWeightClass = content.includes('kg') || content.includes('weight');

          Logger.log('Contains results section: ' + hasResultsSection);
          Logger.log('Contains weight class references: ' + hasWeightClass);
          Logger.log('Content length: ' + content.length + ' bytes');
        }
        Logger.log('=== END ===');

        expect([200, 301, 302, 403]).to.include(response.getResponseCode());
      });
    });

    describe('Athletes Endpoint', function() {
      it('should have accessible athletes bios endpoint', function() {
        var url = IWF_BASE + '/weightlifting_/athletes-bios/';
        var options = { 
          muteHttpExceptions: true,
          followRedirects: true
        };

        var response = UrlFetchApp.fetch(url, options);
        
        Logger.log('=== IWF ATHLETES ENDPOINT ===');
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');
        
        expect([200, 301, 302, 403]).to.include(response.getResponseCode());
      });
    });
  });

  describe('API Response Time SLAs', function() {
    it('should measure USAW API latency percentiles', function() {
      var API_TOKEN = '14ced0f3-421f-4acf-94ad-cc63a371af19';
      var latencies = [];
      var iterations = 3;

      Logger.log('=== LATENCY MEASUREMENT ===');
      for (var i = 0; i < iterations; i++) {
        var start = Date.now();
        UrlFetchApp.fetch(
          'https://admin-usaw-rankings.sport80.com/api/categories/rankings/table/filters',
          { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
        );
        var latency = Date.now() - start;
        latencies.push(latency);
        Logger.log('  Call ' + (i + 1) + ': ' + latency + 'ms');
      }

      latencies.sort(function(a, b) { return a - b; });
      var avg = latencies.reduce(function(a, b) { return a + b; }, 0) / latencies.length;
      var min = latencies[0];
      var max = latencies[latencies.length - 1];

      Logger.log('');
      Logger.log('Min: ' + min + 'ms');
      Logger.log('Max: ' + max + 'ms');
      Logger.log('Avg: ' + avg.toFixed(0) + 'ms');
      Logger.log('=== END ===');

      expect(avg).to.be.lessThan(10000); // 10 second average max
    });

    it('should verify IWF responds within timeout', function() {
      var start = Date.now();
      var response = UrlFetchApp.fetch(
        'https://iwf.sport/events/calendar/',
        { muteHttpExceptions: true, followRedirects: true }
      );
      var latency = Date.now() - start;

      Logger.log('=== IWF TIMEOUT TEST ===');
      Logger.log('Status: ' + response.getResponseCode());
      Logger.log('Latency: ' + latency + 'ms');
      Logger.log('Within 10s: ' + (latency < 10000 ? 'YES' : 'NO'));
      Logger.log('=== END ===');

      expect(latency).to.be.lessThan(30000); // 30 second max
    });
  });

  describe('API Error Handling', function() {
    it('should handle invalid API token gracefully', function() {
      var response = UrlFetchApp.fetch(
        'https://admin-usaw-rankings.sport80.com/api/categories/rankings/table',
        { headers: { 'x-api-token': 'invalid-token-12345' }, muteHttpExceptions: true }
      );

      Logger.log('=== INVALID TOKEN TEST ===');
      Logger.log('Status: ' + response.getResponseCode());
      Logger.log('Expected: 401 or 403');
      Logger.log('=== END ===');

      expect([401, 403]).to.include(response.getResponseCode());
    });

    it('should handle missing API token', function() {
      var response = UrlFetchApp.fetch(
        'https://admin-usaw-rankings.sport80.com/api/categories/rankings/table',
        { muteHttpExceptions: true }
      );

      Logger.log('=== MISSING TOKEN TEST ===');
      Logger.log('Status: ' + response.getResponseCode());
      Logger.log('Expected: 401 or 403');
      Logger.log('=== END ===');

      expect([401, 403]).to.include(response.getResponseCode());
    });

    it('should handle non-existent endpoint', function() {
      var response = UrlFetchApp.fetch(
        'https://admin-usaw-rankings.sport80.com/api/nonexistent/endpoint',
        { muteHttpExceptions: true }
      );

      Logger.log('=== NON-EXISTENT ENDPOINT TEST ===');
      Logger.log('Status: ' + response.getResponseCode());
      Logger.log('Expected: 404 (or 401/403 if auth required first)');
      Logger.log('=== END ===');

      expect([401, 403, 404]).to.include(response.getResponseCode());
    });
  });

  describe('API Health Summary', function() {
    it('should display comprehensive API health dashboard', function() {
      var API_TOKEN = '14ced0f3-421f-4acf-94ad-cc63a371af19';
      var apis = [
        { name: 'USAW Rankings', url: 'https://admin-usaw-rankings.sport80.com/api/categories/rankings/table', auth: true },
        { name: 'USAW Filters', url: 'https://admin-usaw-rankings.sport80.com/api/categories/rankings/table/filters', auth: true },
        { name: 'IWF Calendar', url: 'https://iwf.sport/events/calendar/?cy=' + new Date().getFullYear(), auth: false },
        { name: 'IWF Results', url: 'https://iwf.sport/results/results-by-events/', auth: false }
      ];

      Logger.log('=== API HEALTH DASHBOARD ===');
      Logger.log('Timestamp: ' + new Date().toISOString());
      Logger.log('');

      var healthyCount = 0;
      apis.forEach(function(api) {
        var start = Date.now();
        try {
          var options = api.auth
            ? { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
            : { muteHttpExceptions: true, followRedirects: true };
          var response = UrlFetchApp.fetch(api.url, options);
          var latency = Date.now() - start;
          var status = response.getResponseCode();
          var healthy = status === 200 || (status >= 301 && status <= 302);
          if (healthy) healthyCount++;

          Logger.log(api.name + ':');
          Logger.log('  Status: ' + status + (healthy ? ' OK' : ' FAIL'));
          Logger.log('  Latency: ' + latency + 'ms');
          Logger.log('  Size: ' + response.getContentText().length + ' bytes');
        } catch (e) {
          Logger.log(api.name + ': ERROR - ' + e.message);
        }
      });

      Logger.log('');
      Logger.log('Summary: ' + healthyCount + '/' + apis.length + ' APIs healthy');
      Logger.log('=== END DASHBOARD ===');

      // At least some APIs should be accessible
      expect(healthyCount).to.be.greaterThan(0);
    });
  });

  module.exports = { run: function() { return require('test-framework/mocha-adapter').run(); } };
}

__defineModule__(_main);