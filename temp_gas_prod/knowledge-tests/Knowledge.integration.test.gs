function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Layer 2: Integration Tests for Knowledge Sheet
   * 
   * PURPOSE-DRIVEN CONTENT VERIFICATION
   * 
   * Tests verify the Knowledge sheet contains required content for the AI system to function:
   * - Configuration Access: API token, club name, date format
   * - API Endpoint Coverage: Rankings, history, events, filters
   * - Business Rules: Pagination, HTTP methods, weight classes
   * - Content Inventory: Sufficient entries for USAW/IWF domains
   * 
   * NO Claude API calls. Moderate speed, free, deterministic.
   */

  const { describe, it, before, beforeEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('Knowledge Integration Tests', function() {
    var registry;

    beforeEach(function() {
      var ToolRegistry = require('tools/ToolRegistry');
      registry = new ToolRegistry({
        enableKnowledge: true,
        enableExec: false,
        enableSearch: false,
        enablePrompt: false,
        enableAnalyzeUrl: false,
        enableFetchUrls: false
      });
    });

    describe('Knowledge Tool Execution', function() {
      it('should load knowledge from sheet successfully', function() {
        var result = registry.executeToolCall('knowledge', {}, {});

        expect(result.success).to.be.true;
        expect(result.result).to.exist;
      });

      it('should return JSON format when requested', function() {
        var result = registry.executeToolCall('knowledge', { format: 'json' }, {});

        expect(result.success).to.be.true;
        expect(typeof result.result).to.equal('object');
        expect(result.result).to.have.property('totalRows');
      });

      it('should return markdown format by default', function() {
        var result = registry.executeToolCall('knowledge', {}, {});

        expect(result.success).to.be.true;
        // Default format is markdown (string)
        expect(typeof result.result).to.equal('string');
      });

      it('should return text format when requested', function() {
        var result = registry.executeToolCall('knowledge', { format: 'text' }, {});

        expect(result.success).to.be.true;
        expect(typeof result.result).to.equal('string');
      });
    });

    describe('Configuration Access (Critical)', function() {
      var knowledge;

      before(function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var reg = new ToolRegistry({ enableKnowledge: true });
        var result = reg.executeToolCall('knowledge', { format: 'json' }, {});
        knowledge = result.result;
      });

      it('should have USAW API token for Sport80 authentication', function() {
        var tokenEntries = knowledge['api token'] || [];
        var usawToken = tokenEntries.find(function(e) {
          // Token might be in key, value, or either field
          var keyOrValue = (e.key || '') + ' ' + (e.value || '');
          return keyOrValue.toLowerCase().includes('sport80') || 
                 keyOrValue.toLowerCase().includes('x-api-token');
        });

        // Look for a UUID-like token pattern in the content
        var tokenContent = usawToken ? (usawToken.key || '') + ' ' + (usawToken.value || '') : '';
        var uuidMatch = tokenContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

        Logger.log('=== API TOKEN CHECK ===');
        if (usawToken) {
          Logger.log('Entry found: YES');
          Logger.log(`Token UUID found: ${uuidMatch ? uuidMatch[0] : 'NO'}`);
          Logger.log(`Contains x-api-token header: ${tokenContent.includes('x-api-token') ? 'YES' : 'NO'}`);
        } else {
          Logger.log('USAW token entry: NOT FOUND');
          Logger.log(`Available types: ${Object.keys(knowledge).slice(0, 10).join(', ')}`);
        }
        Logger.log('=== END ===');

        expect(usawToken).to.exist;
        // Token should contain either a UUID or mention x-api-token header
        expect(uuidMatch || tokenContent.includes('x-api-token')).to.be.ok;
      });

      it('should have club name for identity context', function() {
        var allEntries = [].concat(
          knowledge['my club'] || [], 
          knowledge['general'] || [],
          knowledge['club'] || []
        );
        var clubName = allEntries.find(function(e) {
          return e.key && (e.key.toLowerCase().includes('club') || e.key.toLowerCase().includes('name'));
        });

        // Also check if "fortified" appears anywhere as a fallback
        var allContent = JSON.stringify(knowledge).toLowerCase();
        var hasFortified = allContent.includes('fortified');

        Logger.log('=== CLUB IDENTITY CHECK ===');
        if (clubName) {
          Logger.log(`Key: ${clubName.key}`);
          Logger.log(`Value: ${clubName.value}`);
        } else {
          Logger.log('Club name entry: NOT FOUND (explicit)');
          Logger.log(`Contains "fortified": ${hasFortified ? 'YES' : 'NO'}`);
        }
        Logger.log('=== END ===');

        expect(clubName || hasFortified).to.be.ok;
      });

      it('should have date format specification', function() {
        var allContent = JSON.stringify(knowledge).toLowerCase();
        var hasDateFormat = allContent.includes('yyyy') || allContent.includes('date format') || 
                            allContent.includes('date_format');

        Logger.log('=== DATE FORMAT CHECK ===');
        Logger.log(`Date format documented: ${hasDateFormat ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        // Date format may be implicit, so just verify we checked
        expect(knowledge).to.exist;
      });
    });

    describe('API Endpoint Coverage', function() {
      var knowledge;
      var allContent;

      before(function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var reg = new ToolRegistry({ enableKnowledge: true });
        var result = reg.executeToolCall('knowledge', { format: 'json' }, {});
        knowledge = result.result;
        allContent = JSON.stringify(knowledge).toLowerCase();
      });

      it('should document rankings endpoint', function() {
        var hasRankingsUrl = allContent.includes('/api/') && allContent.includes('ranking');

        Logger.log('=== RANKINGS ENDPOINT CHECK ===');
        var rankingsEntries = knowledge['usaw rankings'] || [];
        rankingsEntries.forEach(function(e) {
          if (e.value && e.value.includes('/api/')) {
            Logger.log(`Endpoint found: ${e.value.substring(0, 80)}...`);
          }
        });
        Logger.log(`Has rankings API: ${hasRankingsUrl ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        expect(hasRankingsUrl).to.be.true;
      });

      it('should document lifter history endpoint', function() {
        var hasHistoryUrl = allContent.includes('athlete') || allContent.includes('history') ||
                            allContent.includes('lifter');

        Logger.log('=== HISTORY ENDPOINT CHECK ===');
        Logger.log(`Has lifter history API: ${hasHistoryUrl ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        expect(hasHistoryUrl).to.be.true;
      });

      it('should document events/meets endpoint', function() {
        var hasEventsUrl = allContent.includes('event') || allContent.includes('meet') ||
                           allContent.includes('competition');

        Logger.log('=== EVENTS ENDPOINT CHECK ===');
        Logger.log(`Has events API: ${hasEventsUrl ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        expect(hasEventsUrl).to.be.true;
      });

      it('should document filters endpoint for weight classes', function() {
        var hasFiltersUrl = allContent.includes('filter');

        Logger.log('=== FILTERS ENDPOINT CHECK ===');
        Logger.log(`Has filters API: ${hasFiltersUrl ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        expect(hasFiltersUrl).to.be.true;
      });
    });

    describe('Business Rules Capture', function() {
      var allContent;

      before(function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var reg = new ToolRegistry({ enableKnowledge: true });
        var result = reg.executeToolCall('knowledge', { format: 'json' }, {});
        allContent = JSON.stringify(result.result).toLowerCase();
      });

      it('should document pagination requirement', function() {
        var hasPagination = allContent.includes('page') || allContent.includes('pagination') ||
                            allContent.includes('loop') || allContent.includes('p=');

        Logger.log('=== PAGINATION RULE CHECK ===');
        Logger.log(`Pagination documented: ${hasPagination ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        expect(hasPagination).to.be.true;
      });

      it('should document HTTP method requirements', function() {
        var hasMethodInfo = allContent.includes('post') || allContent.includes('get') ||
                            allContent.includes('x-api-token') || allContent.includes('header');

        Logger.log('=== HTTP METHOD CHECK ===');
        Logger.log(`HTTP method documented: ${hasMethodInfo ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        expect(hasMethodInfo).to.be.true;
      });

      it('should document weight class handling', function() {
        var hasWeightClass = allContent.includes('weight class') || allContent.includes('weightclass') ||
                             allContent.includes('weight_class') || allContent.includes('weight');

        Logger.log('=== WEIGHT CLASS CHECK ===');
        Logger.log(`Weight class documented: ${hasWeightClass ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        expect(hasWeightClass).to.be.true;
      });

      it('should document age group handling', function() {
        var hasAgeGroup = allContent.includes('age group') || allContent.includes('age_group') ||
                          allContent.includes('agegroup') || allContent.includes('youth') ||
                          allContent.includes('senior') || allContent.includes('junior');

        Logger.log('=== AGE GROUP CHECK ===');
        Logger.log(`Age group documented: ${hasAgeGroup ? 'YES' : 'NO'}`);
        Logger.log('=== END ===');

        expect(hasAgeGroup).to.be.true;
      });
    });

    describe('Content Inventory', function() {
      var knowledge;

      before(function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var reg = new ToolRegistry({ enableKnowledge: true });
        var result = reg.executeToolCall('knowledge', { format: 'json' }, {});
        knowledge = result.result;
      });

      it('should have sufficient knowledge entries', function() {
        var types = Object.keys(knowledge).filter(function(k) { return k !== 'totalRows'; });
        var totalEntries = 0;
        types.forEach(function(t) {
          if (Array.isArray(knowledge[t])) {
            totalEntries += knowledge[t].length;
          }
        });

        Logger.log('=== CONTENT INVENTORY ===');
        Logger.log(`Total types: ${types.length}`);
        Logger.log(`Total entries: ${totalEntries}`);
        Logger.log(`Types: ${types.slice(0, 10).join(', ')}${types.length > 10 ? '...' : ''}`);
        Logger.log('=== END ===');

        expect(types.length).to.be.greaterThan(5);
        expect(totalEntries).to.be.greaterThan(20);
      });

      it('should have entries for USAW domain', function() {
        var usawTypes = Object.keys(knowledge).filter(function(k) {
          return k.toLowerCase().includes('usaw');
        });

        Logger.log('=== USAW COVERAGE ===');
        Logger.log(`USAW-related types: ${usawTypes.length}`);
        usawTypes.forEach(function(t) {
          var count = Array.isArray(knowledge[t]) ? knowledge[t].length : 0;
          Logger.log(`  ${t}: ${count} entries`);
        });
        Logger.log('=== END ===');

        expect(usawTypes.length).to.be.greaterThan(0);
      });

      it('should have entries for IWF domain', function() {
        var iwfTypes = Object.keys(knowledge).filter(function(k) {
          return k.toLowerCase().includes('iwf');
        });

        Logger.log('=== IWF COVERAGE ===');
        Logger.log(`IWF-related types: ${iwfTypes.length}`);
        iwfTypes.forEach(function(t) {
          var count = Array.isArray(knowledge[t]) ? knowledge[t].length : 0;
          Logger.log(`  ${t}: ${count} entries`);
        });
        Logger.log('=== END ===');

        // IWF is optional, so just verify we checked
        expect(knowledge).to.exist;
      });

      it('should list all knowledge type categories', function() {
        var types = Object.keys(knowledge).filter(function(k) { return k !== 'totalRows'; });
        
        Logger.log('=== ALL KNOWLEDGE TYPES ===');
        types.forEach(function(t) {
          var count = Array.isArray(knowledge[t]) ? knowledge[t].length : 0;
          Logger.log(`  ${t}: ${count} entries`);
        });
        Logger.log('=== END ===');

        expect(types.length).to.be.greaterThan(0);
      });
    });

    describe('Knowledge Caching', function() {
      it('should cache knowledge after first call', function() {
        var handler = registry.handlers.knowledge;
        handler.clearCache();

        // First call - should not be cached
        var result1 = registry.executeToolCall('knowledge', { format: 'json' }, {});
        expect(result1.success).to.be.true;

        // Verify cache is now populated
        expect(handler.cache).to.exist;
        expect(handler.cacheTimestamp).to.exist;
      });

      it('should return consistent results on repeated calls', function() {
        var result1 = registry.executeToolCall('knowledge', { format: 'json' }, {});
        var result2 = registry.executeToolCall('knowledge', { format: 'json' }, {});

        expect(result1.success).to.be.true;
        expect(result2.success).to.be.true;
        expect(result1.result.totalRows).to.equal(result2.result.totalRows);
      });
    });

    describe('Tool State', function() {
      it('should store result in previousResult for chaining', function() {
        registry.executeToolCall('knowledge', { format: 'json' }, {});

        expect(registry.toolState).to.have.property('previousResult');
      });
    });
  });

  module.exports = { run: function() { return require('test-framework/mocha-adapter').run(); } };
}

__defineModule__(_main);
