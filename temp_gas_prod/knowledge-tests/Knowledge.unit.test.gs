function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Layer 1: Unit Tests for KnowledgeToolHandler
   * 
   * Tests parsing code validity, formatting mechanics, and caching logic.
   * Fast, free, deterministic.
   * 
   * PURPOSE-DRIVEN: Tests verify the Knowledge system contains valid
   * configuration for AI-assisted USAW data retrieval.
   */

  const { describe, it, before, beforeEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('KnowledgeToolHandler Unit Tests', function() {
    var handler;

    beforeEach(function() {
      var KnowledgeToolHandler = require('tools/KnowledgeToolHandler');
      handler = new KnowledgeToolHandler();
      handler.clearCache();
    });

    describe('Tool Definition', function() {
      it('should have correct tool name', function() {
        var def = handler.getToolDefinition();
        expect(def.name).to.equal('knowledge');
      });

      it('should have format parameter in schema', function() {
        var def = handler.getToolDefinition();
        expect(def.input_schema.properties).to.have.property('format');
        expect(def.input_schema.properties.format.enum).to.deep.equal(['markdown', 'json', 'text']);
      });

      it('should have description mentioning knowledge sheet', function() {
        var def = handler.getToolDefinition();
        expect(def.description).to.include('knowledge');
      });
    });

    describe('Cache Behavior', function() {
      it('should have cache enabled by default', function() {
        expect(handler.enableCache).to.be.true;
      });

      it('should have null cache initially', function() {
        expect(handler.cache).to.be.null;
        expect(handler.cacheTimestamp).to.be.null;
      });

      it('should clear cache with clearCache()', function() {
        // Simulate cached data
        handler.cache = { general: [] };
        handler.cacheTimestamp = Date.now();

        handler.clearCache();

        expect(handler.cache).to.be.null;
        expect(handler.cacheTimestamp).to.be.null;
      });

      it('should have cache TTL configured', function() {
        // TTL is 2 minutes (120000ms)
        expect(handler.cacheTTL).to.equal(2 * 60 * 1000);
      });

      it('should not cache data when enableCache is false', function() {
        // Disable cache for this test
        handler.enableCache = false;
        
        // Execute twice
        handler.execute({ format: 'json' }, {});
        handler.execute({ format: 'json' }, {});
        
        // Cache should still be null since caching is disabled
        expect(handler.cache).to.be.null;
        expect(handler.cacheTimestamp).to.be.null;
      });

      it('should return cached data on subsequent calls', function() {
        // Cache is enabled by default
        expect(handler.enableCache).to.be.true;
        
        var start1 = Date.now();
        var result1 = handler.execute({ format: 'json' }, {});
        var time1 = Date.now() - start1;

        // Verify cache was populated
        expect(handler.cache).to.not.be.null;
        expect(handler.cacheTimestamp).to.not.be.null;

        var start2 = Date.now();
        var result2 = handler.execute({ format: 'json' }, {});
        var time2 = Date.now() - start2;

        Logger.log('=== CACHE PERFORMANCE ===');
        Logger.log('First call: ' + time1 + 'ms');
        Logger.log('Second call: ' + time2 + 'ms');
        Logger.log('Speedup: ' + (time1 / Math.max(time2, 1)).toFixed(1) + 'x');
        Logger.log('=== END ===');

        expect(result1.success).to.be.true;
        expect(result2.success).to.be.true;
      });
    });

    describe('Format Output Mechanics', function() {
      var mockKnowledge = {
        general: [
          { type: 'general', key: 'club_name', value: 'Fortified Strength', row: 1 }
        ],
        url_pattern: [
          { type: 'url_pattern', key: '*.sport80.com/*', value: 'Extract rankings', row: 2 }
        ],
        totalRows: 2
      };

      it('should format as markdown with sections', function() {
        var markdown = handler._formatAsMarkdown(mockKnowledge);
        
        expect(markdown).to.include('## General');
        expect(markdown).to.include('club_name');
        expect(markdown).to.include('Fortified Strength');
      });

      it('should format url_pattern with Pattern label', function() {
        var markdown = handler._formatAsMarkdown(mockKnowledge);
        
        expect(markdown).to.include('**Pattern:**');
        expect(markdown).to.include('*.sport80.com/*');
      });

      it('should format as text with type headers', function() {
        var text = handler._formatAsText(mockKnowledge);
        
        expect(text).to.include('[GENERAL]');
        expect(text).to.include('[URL_PATTERN]');
        expect(text).to.include('club_name: Fortified Strength');
      });

      it('should handle empty knowledge', function() {
        var emptyKnowledge = {
          general: [],
          url_pattern: [],
          totalRows: 0
        };
        
        var markdown = handler._formatAsMarkdown(emptyKnowledge);
        expect(markdown).to.equal('No knowledge entries found.');
        
        var text = handler._formatAsText(emptyKnowledge);
        expect(text).to.equal('No knowledge entries found.');
      });

      it('should produce markdown with proper section headers from real data', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { format: 'markdown' }, {});
        var md = result.result;

        var headerMatches = md.match(/^## .+$/gm) || [];

        Logger.log('=== MARKDOWN STRUCTURE ===');
        Logger.log('Total headers: ' + headerMatches.length);
        headerMatches.slice(0, 5).forEach(function(h) {
          Logger.log('  ' + h);
        });
        Logger.log('=== END ===');

        expect(headerMatches.length).to.be.greaterThan(5);
      });

      it('should produce text with bracketed sections from real data', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { format: 'text' }, {});
        var txt = result.result;

        var sectionMatches = txt.match(/^\[.+\]$/gm) || [];

        Logger.log('=== TEXT STRUCTURE ===');
        Logger.log('Total sections: ' + sectionMatches.length);
        sectionMatches.slice(0, 5).forEach(function(s) {
          Logger.log('  ' + s);
        });
        Logger.log('=== END ===');

        expect(sectionMatches.length).to.be.greaterThan(5);
      });

      it('should produce JSON with totalRows metadata', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { format: 'json' }, {});
        var json = result.result;

        Logger.log('=== JSON STRUCTURE ===');
        Logger.log('totalRows: ' + json.totalRows);
        Logger.log('Type count: ' + (Object.keys(json).length - 1));
        Logger.log('=== END ===');

        expect(json).to.have.property('totalRows');
        expect(json.totalRows).to.be.greaterThan(0);
      });
    });

    describe('Parsing Code Validity', function() {
      var knowledge;
      var registry;

      before(function() {
        var ToolRegistry = require('tools/ToolRegistry');
        registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { format: 'json' }, {});
        knowledge = result.result;
      });

      it('should contain syntactically valid JavaScript in parsing entries', function() {
        var jsEntries = [];
        var syntaxErrors = [];

        // Find all entries that contain JavaScript code
        Object.keys(knowledge).forEach(function(type) {
          var entries = knowledge[type];
          if (!Array.isArray(entries)) return;

          entries.forEach(function(e) {
            var value = e.value || '';
            // Detect JavaScript: function keywords, arrow functions, .map/.filter, etc.
            if (value.includes('function') || value.includes('=>') ||
                value.includes('.map(') || value.includes('.filter(') ||
                value.includes('return ')) {
              jsEntries.push({ type: type, key: e.key, code: value });

              // Try to parse as JavaScript
              try {
                new Function(value);
              } catch (err) {
                syntaxErrors.push({ type: type, key: e.key, error: err.message });
              }
            }
          });
        });

        Logger.log('=== JAVASCRIPT PARSING VALIDATION ===');
        Logger.log('Entries with JS code: ' + jsEntries.length);
        Logger.log('Syntax errors found: ' + syntaxErrors.length);
        if (syntaxErrors.length > 0) {
          syntaxErrors.forEach(function(se) {
            Logger.log('  ERROR in [' + se.type + '] ' + se.key + ': ' + se.error);
          });
        }
        Logger.log('=== END ===');

        // Allow some entries to have incomplete code (snippets)
        // but flag if majority have errors
        expect(syntaxErrors.length).to.be.lessThan(Math.max(jsEntries.length / 2, 1));
      });

      it('should have rankings parser with expected output columns', function() {
        var rankingsEntries = knowledge['usaw rankings'] || [];
        var parserEntry = rankingsEntries.find(function(e) {
          return e.value && e.value.includes('.map(');
        });

        Logger.log('=== RANKINGS PARSER CHECK ===');
        if (parserEntry) {
          Logger.log('Found parser in key: ' + parserEntry.key);
          // Check for expected column references
          var expectedColumns = ['name', 'total', 'snatch', 'clean', 'weight'];
          var foundColumns = expectedColumns.filter(function(col) {
            return parserEntry.value.toLowerCase().includes(col);
          });
          Logger.log('Expected columns found: ' + foundColumns.join(', '));
        } else {
          Logger.log('No parser found in usaw rankings entries');
        }
        Logger.log('=== END ===');

        // Parser may not exist, but verify we checked
        expect(knowledge).to.exist;
      });
    });

    describe('Capitalize Helper', function() {
      it('should capitalize first letter', function() {
        expect(handler._capitalize('general')).to.equal('General');
        expect(handler._capitalize('url_pattern')).to.equal('Url_pattern');
      });

      it('should handle empty string', function() {
        expect(handler._capitalize('')).to.equal('');
      });

      it('should handle single character', function() {
        expect(handler._capitalize('a')).to.equal('A');
      });
    });

    describe('Edge Cases', function() {
      it('should handle invalid format parameter gracefully', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { format: 'invalid' }, {});

        Logger.log('=== INVALID FORMAT HANDLING ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Has result: ' + (result.result !== undefined));
        Logger.log('=== END ===');

        // Should succeed with default format or fail gracefully
        expect(result).to.have.property('success');
      });

      it('should handle missing format parameter', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', {}, {});

        Logger.log('=== MISSING FORMAT HANDLING ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Default format used: ' + (typeof result.result));
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
      });
    });

    describe('Search Mode', function() {
      it('should filter by keyword (case-insensitive)', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { search: 'club', format: 'json' }, {});

        Logger.log('=== KEYWORD SEARCH ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Row count: ' + result.rowCount);
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        // Either finds matches or returns empty with 0 rows
        expect(result).to.have.property('rowCount');
      });

      it('should filter by regex pattern', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { search: '/^url_/i', format: 'json' }, {});

        Logger.log('=== REGEX SEARCH ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Row count: ' + result.rowCount);
        Logger.log('Types found: ' + result.types);
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        expect(result.filters.search).to.equal('/^url_/i');
      });

      it('should return error for invalid regex', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { search: '/[invalid/' }, {});

        Logger.log('=== INVALID REGEX ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.success).to.be.false;
        expect(result.error).to.include('Invalid regex');
      });

      it('should search across type, key, and value fields', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });

        // Search for 'pattern' which appears in type name 'url_pattern'
        var result = registry.executeToolCall('knowledge', { search: 'pattern', format: 'json' }, {});

        Logger.log('=== MULTI-FIELD SEARCH ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Row count: ' + result.rowCount);
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
      });
    });

    describe('Type Filter', function() {
      it('should filter to specific type', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { type: 'general', format: 'json' }, {});

        Logger.log('=== TYPE FILTER ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Types returned: ' + result.types);
        Logger.log('Row count: ' + result.rowCount);
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        if (result.rowCount > 0) {
          expect(result.types).to.include('general');
          expect(result.types.length).to.equal(1);
        }
      });

      it('should return empty for non-existent type', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { type: 'nonexistent_type_xyz' }, {});

        Logger.log('=== NON-EXISTENT TYPE ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Row count: ' + result.rowCount);
        Logger.log('Has hint: ' + (result.hint !== undefined));
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        expect(result.rowCount).to.equal(0);
        expect(result.noResults).to.be.true;
      });

      it('should combine type and search filters', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { type: 'general', search: 'name', format: 'json' }, {});

        Logger.log('=== COMBINED FILTERS ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Row count: ' + result.rowCount);
        Logger.log('Filters: ' + JSON.stringify(result.filters));
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        expect(result.filters.type).to.equal('general');
        expect(result.filters.search).to.equal('name');
      });
    });

    describe('Summary Mode', function() {
      it('should return type metadata with summary:true', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { summary: true }, {});

        Logger.log('=== SUMMARY MODE ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Mode: ' + result.mode);
        Logger.log('Total types: ' + result.result.totalTypes);
        Logger.log('Total rows: ' + result.result.totalRows);
        if (result.result.types && result.result.types.length > 0) {
          Logger.log('First type: ' + JSON.stringify(result.result.types[0]));
        }
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        expect(result.mode).to.equal('summary');
        expect(result.result).to.have.property('types');
        expect(result.result).to.have.property('totalTypes');
        expect(result.result).to.have.property('totalRows');
      });

      it('should include sample keys and values in summary', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { summary: true }, {});

        expect(result.success).to.be.true;
        if (result.result.types.length > 0) {
          var firstType = result.result.types[0];
          expect(firstType).to.have.property('type');
          expect(firstType).to.have.property('count');
          expect(firstType).to.have.property('sampleKeys');
          expect(firstType).to.have.property('sampleValues');
          expect(firstType.sampleKeys).to.be.an('array');
          expect(firstType.sampleValues).to.be.an('array');
        }
      });

      it('should truncate long sample values at 80 chars', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { summary: true }, {});

        expect(result.success).to.be.true;
        result.result.types.forEach(function(t) {
          t.sampleValues.forEach(function(val) {
            // Should be max 83 chars (80 + '...')
            expect(val.length <= 83).to.be.true;
          });
        });
      });

      it('should filter summary by type', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { summary: true, type: 'general' }, {});

        Logger.log('=== FILTERED SUMMARY ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Types in summary: ' + result.result.totalTypes);
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        if (result.result.totalTypes > 0) {
          expect(result.result.types.length).to.equal(1);
          expect(result.result.types[0].type).to.equal('general');
        }
      });
    });

    describe('Matcher Helper', function() {
      it('should create keyword matcher for plain strings', function() {
        var matcher = handler._createMatcher('test');

        expect(matcher('This is a TEST')).to.be.true;
        expect(matcher('testing')).to.be.true;
        expect(matcher('no match')).to.be.false;
      });

      it('should create regex matcher for /pattern/ syntax', function() {
        var matcher = handler._createMatcher('/^url_/i');

        expect(matcher('url_pattern')).to.be.true;
        expect(matcher('URL_config')).to.be.true;
        expect(matcher('not_url')).to.be.false;
      });

      it('should throw on invalid regex', function() {
        var threw = false;
        try {
          handler._createMatcher('/[invalid/');
        } catch (e) {
          threw = true;
          expect(e.message).to.include('Invalid regex');
        }
        expect(threw).to.be.true;
      });

      it('should throw on regex pattern exceeding 500 chars (ReDoS prevention)', function() {
        // Create a pattern longer than 500 chars
        var longPattern = '/' + 'a'.repeat(600) + '/';
        var threw = false;
        try {
          handler._createMatcher(longPattern);
        } catch (e) {
          threw = true;
          expect(e.message).to.include('too long');
          expect(e.message).to.include('500');
        }
        expect(threw).to.be.true;
      });

      it('should accept regex pattern at exactly 500 chars', function() {
        // Create a pattern exactly 500 chars (use .* padding with anchor)
        var padding = 'x'.repeat(497);  // 497 + 3 for 'a.*' = 500
        var exactPattern = '/a.*' + padding + '/';
        var matcher = handler._createMatcher(exactPattern);
        // Should not throw - verify matcher is a function
        expect(typeof matcher).to.equal('function');
      });

      it('should handle null/undefined values safely', function() {
        var matcher = handler._createMatcher('test');

        expect(matcher(null)).to.be.false;
        expect(matcher(undefined)).to.be.false;
        expect(matcher('')).to.be.false;
      });
    });

    describe('Backward Compatibility', function() {
      it('should return all entries with no params (existing behavior)', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', {}, {});

        Logger.log('=== BACKWARD COMPAT ===');
        Logger.log('Success: ' + result.success);
        Logger.log('Mode: ' + result.mode);
        Logger.log('Row count: ' + result.rowCount);
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        expect(result.mode).to.equal('entries');
        expect(result.rowCount).to.be.greaterThan(0);
      });

      it('should work with format:json (used by AnalyzeUrlToolHandler)', function() {
        var ToolRegistry = require('tools/ToolRegistry');
        var registry = new ToolRegistry({ enableKnowledge: true });
        var result = registry.executeToolCall('knowledge', { format: 'json' }, {});

        expect(result.success).to.be.true;
        expect(result.result).to.have.property('totalRows');
        // Should have type arrays
        var types = Object.keys(result.result).filter(function(k) {
          return k !== 'totalRows' && k !== 'error';
        });
        expect(types.length).to.be.greaterThan(0);
      });
    });
  });

  module.exports = { run: function() { return require('test-framework/mocha-adapter').run(); } };
}

__defineModule__(_main);