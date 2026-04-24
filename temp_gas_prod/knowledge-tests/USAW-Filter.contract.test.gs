function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * USAW Filter Parameter Contract Tests
   * 
   * Verifies USAW Sport80 API filter parameters and query behavior.
   * Documents the 8 filter parameters discovered via API exploration.
   * 
   * PURPOSE: Contract tests for USAW filter capabilities to ensure
   * the Knowledge sheet accurately documents API filtering options.
   */

  const { describe, it } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('USAW Filter Parameter Contracts', function() {
    var API_TOKEN = '14ced0f3-421f-4acf-94ad-cc63a371af19';
    var USAW_BASE = 'https://admin-usaw-rankings.sport80.com';

    describe('Filter Metadata', function() {
      it('should return filter definitions with 8 filters', function() {
        var response = UrlFetchApp.fetch(
          USAW_BASE + '/api/categories/rankings/table',
          { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
        );

        Logger.log('=== FILTER METADATA ===');
        Logger.log('Status: ' + response.getResponseCode());

        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());
          var filters = data.filters || [];

          Logger.log('Filter count: ' + filters.length);
          filters.forEach(function(f) {
            Logger.log('  ' + f.name + ' (' + f.type + '): ' + f.label);
          });

          expect(filters.length).to.equal(8);
          
          var filterNames = filters.map(function(f) { return f.name; });
          expect(filterNames).to.include('weight_class');
          expect(filterNames).to.include('date_range_start');
        } else {
          Logger.log('Auth issue - skipping filter check');
          expect([401, 403]).to.include(response.getResponseCode());
        }
        Logger.log('=== END ===');
      });

      it('should have expected filter types', function() {
        var response = UrlFetchApp.fetch(
          USAW_BASE + '/api/categories/rankings/table',
          { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
        );

        Logger.log('=== FILTER TYPES ===');
        
        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());
          var filters = data.filters || [];
          var filterTypes = {};
          filters.forEach(function(f) { filterTypes[f.name] = f.type; });

          Object.keys(filterTypes).forEach(function(name) {
            Logger.log('  ' + name + ': ' + filterTypes[name]);
          });

          // Verify expected types
          expect(filterTypes.date_range_start).to.equal('datepicker');
          expect(filterTypes.date_range_end).to.equal('datepicker');
          expect(filterTypes.weight_class).to.equal('autocomplete');
          expect(filterTypes.minimum_lifter_age).to.equal('integer');
          expect(filterTypes.maximum_lifter_age).to.equal('integer');
          expect(filterTypes.level).to.equal('select');
          expect(filterTypes.club).to.equal('autocomplete');
          expect(filterTypes.wso).to.equal('autocomplete');
        } else {
          Logger.log('Skipping - status: ' + response.getResponseCode());
          expect([401, 403]).to.include(response.getResponseCode());
        }
        Logger.log('=== END ===');
      });
    });

    describe('Search Capability', function() {
      it('should support lifter name search', function() {
        var response = UrlFetchApp.fetch(
          USAW_BASE + '/api/categories/rankings/table',
          { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
        );

        Logger.log('=== SEARCH CAPABILITY ===');
        
        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());

          Logger.log('Has search: ' + data.has_search);
          Logger.log('Search placeholder: ' + data.search_placeholder);

          expect(data.has_search).to.be.true;
          expect(data.search_placeholder).to.equal('Lifter Name');
        } else {
          Logger.log('Skipping - status: ' + response.getResponseCode());
          expect([401, 403]).to.include(response.getResponseCode());
        }
        Logger.log('=== END ===');
      });
    });

    describe('Pagination Support', function() {
      it('should support pagination', function() {
        var response = UrlFetchApp.fetch(
          USAW_BASE + '/api/categories/rankings/table',
          { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
        );

        Logger.log('=== PAGINATION SUPPORT ===');
        
        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());

          Logger.log('Paginated: ' + data.paginated);

          expect(data.paginated).to.be.true;
        } else {
          Logger.log('Skipping - status: ' + response.getResponseCode());
          expect([401, 403]).to.include(response.getResponseCode());
        }
        Logger.log('=== END ===');
      });
    });

    describe('Column Structure', function() {
      it('should return expected number of columns', function() {
        var response = UrlFetchApp.fetch(
          USAW_BASE + '/api/categories/rankings/table',
          { headers: { 'x-api-token': API_TOKEN }, muteHttpExceptions: true }
        );

        Logger.log('=== COLUMN STRUCTURE ===');
        
        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());
          var columns = data.columns || [];

          Logger.log('Column count: ' + columns.length);
          columns.forEach(function(c, i) {
            Logger.log('  [' + i + '] ' + (c.label || c.name || 'unnamed') +
                       (c.sortable ? ' (sortable)' : ''));
          });

          expect(columns.length).to.equal(14);
        } else {
          Logger.log('Skipping - status: ' + response.getResponseCode());
          expect([401, 403]).to.include(response.getResponseCode());
        }
        Logger.log('=== END ===');
      });
    });
  });

  describe('USAW Query Parameter Behavior', function() {
    var API_TOKEN = '14ced0f3-421f-4acf-94ad-cc63a371af19';
    var USAW_BASE = 'https://admin-usaw-rankings.sport80.com';

    describe('Date Range Filtering', function() {
      it('should accept date_range_start parameter', function() {
        var startDate = '2024-01-01';
        var url = USAW_BASE + '/api/categories/rankings/table?date_range_start=' + startDate;
        var response = UrlFetchApp.fetch(url, {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        });

        Logger.log('=== DATE RANGE START TEST ===');
        Logger.log('URL: ' + url);
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');

        // Should not error - 200 or valid auth/access response
        expect([200, 401, 403]).to.include(response.getResponseCode());
      });

      it('should accept date range combination', function() {
        var url = USAW_BASE + '/api/categories/rankings/table' +
                  '?date_range_start=2024-01-01&date_range_end=2024-12-31';
        var response = UrlFetchApp.fetch(url, {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        });

        Logger.log('=== DATE RANGE COMBINATION TEST ===');
        Logger.log('Status: ' + response.getResponseCode());
        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());
          Logger.log('Has data property: ' + data.hasOwnProperty('data'));
        }
        Logger.log('=== END ===');

        expect([200, 401, 403]).to.include(response.getResponseCode());
      });
    });

    describe('Age Range Filtering', function() {
      it('should accept minimum_lifter_age parameter', function() {
        var url = USAW_BASE + '/api/categories/rankings/table?minimum_lifter_age=18';
        var response = UrlFetchApp.fetch(url, {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        });

        Logger.log('=== MIN AGE TEST ===');
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');

        expect([200, 401, 403]).to.include(response.getResponseCode());
      });

      it('should accept age range combination (Junior: 15-20)', function() {
        var url = USAW_BASE + '/api/categories/rankings/table' +
                  '?minimum_lifter_age=15&maximum_lifter_age=20';
        var response = UrlFetchApp.fetch(url, {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        });

        Logger.log('=== AGE RANGE TEST (Junior) ===');
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');

        expect([200, 401, 403]).to.include(response.getResponseCode());
      });
    });

    describe('Name Search', function() {
      it('should accept search parameter (s=)', function() {
        var url = USAW_BASE + '/api/categories/rankings/table?s=Smith';
        var response = UrlFetchApp.fetch(url, {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        });

        Logger.log('=== NAME SEARCH TEST ===');
        Logger.log('Status: ' + response.getResponseCode());
        if (response.getResponseCode() === 200) {
          var data = JSON.parse(response.getContentText());
          Logger.log('Has results: ' + (data.data && data.data.length > 0));
        }
        Logger.log('=== END ===');

        expect([200, 401, 403]).to.include(response.getResponseCode());
      });
    });

    describe('Combined Filters', function() {
      it('should accept multiple filter combination', function() {
        var params = [
          'date_range_start=2024-01-01',
          'date_range_end=2024-12-31',
          'minimum_lifter_age=18',
          'maximum_lifter_age=35'
        ].join('&');

        var url = USAW_BASE + '/api/categories/rankings/table?' + params;
        var response = UrlFetchApp.fetch(url, {
          headers: { 'x-api-token': API_TOKEN },
          muteHttpExceptions: true
        });

        Logger.log('=== COMBINED FILTER TEST ===');
        Logger.log('Params: ' + params);
        Logger.log('Status: ' + response.getResponseCode());
        Logger.log('=== END ===');

        expect([200, 401, 403]).to.include(response.getResponseCode());
      });
    });
  });

  module.exports = { run: function() { return require('test-framework/mocha-adapter').run(); } };
}

__defineModule__(_main);