function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Integration tests for USAW tools with array parameter support
   * Tests parser, normalizers, metadata cache, and filter helpers
   */

  // Helper function stubs for testing
  function test(suite, name, fn) {
    try {
      fn();
      Logger.log('✓ ' + suite + ' - ' + name);
      return true;
    } catch (e) {
      Logger.log('✗ ' + suite + ' - ' + name + ': ' + e.message);
      return false;
    }
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error((message || 'Assertion failed') + ': expected ' + expected + ', got ' + actual);
    }
  }

  function assertTrue(condition, message) {
    if (!condition) {
      throw new Error(message || 'Expected true, got false');
    }
  }

  function assertFalse(condition, message) {
    if (condition) {
      throw new Error(message || 'Expected false, got true');
    }
  }

  /**
   * Run all integration tests
   */
  function runUsawIntegrationTests() {
    Logger.log('=== USAW Tools Integration Tests ===\n');
    
    var results = {
      passed: 0,
      failed: 0,
      total: 0
    };
    
    // Test suites
    var suites = [
      testDynamicToolParserArrays,
      testUsawNormalizers,
      testUsawFilterHelpers,
      testUsawMetadataCache
    ];
    
    suites.forEach(function(suite) {
      var suiteResults = suite();
      results.passed += suiteResults.passed;
      results.failed += suiteResults.failed;
      results.total += suiteResults.total;
    });
    
    Logger.log('\n=== Test Summary ===');
    Logger.log('Total: ' + results.total);
    Logger.log('Passed: ' + results.passed);
    Logger.log('Failed: ' + results.failed);
    Logger.log('Success Rate: ' + Math.round(results.passed / results.total * 100) + '%');
    
    return results;
  }

  /**
   * Test DynamicToolParser array notation support
   */
  function testDynamicToolParserArrays() {
    var DynamicToolParser = require('tools/DynamicToolParser');
    var suite = 'DynamicToolParser Arrays';
    var passed = 0, failed = 0;
    
    Logger.log('\n--- ' + suite + ' ---');
    
    // Test 1: Basic array notation
    if (test(suite, 'parseParams handles array notation', function() {
      var schema = DynamicToolParser.parseParams('states[]');
      assertEqual(schema.properties.states.type, 'array', 'Type should be array');
      assertEqual(schema.properties.states.items.type, 'string', 'Items should be string');
    })) passed++; else failed++;
    
    // Test 2: Array with type hint
    if (test(suite, 'parseParams handles array with type hint', function() {
      var schema = DynamicToolParser.parseParams('ids[]: int');
      assertEqual(schema.properties.ids.type, 'array', 'Type should be array');
      assertEqual(schema.properties.ids.items.type, 'integer', 'Items should be integer');
    })) passed++; else failed++;
    
    // Test 3: Array with default
    if (test(suite, 'parseParams handles array with default', function() {
      var schema = DynamicToolParser.parseParams('tags[] = []');
      assertEqual(schema.properties.tags.type, 'array');
      assertTrue(Array.isArray(schema.properties.tags.default));
      assertEqual(schema.properties.tags.default.length, 0);
    })) passed++; else failed++;
    
    // Test 4: Required array
    if (test(suite, 'parseParams handles required array', function() {
      var schema = DynamicToolParser.parseParams('names[]!');
      assertEqual(schema.properties.names.type, 'array');
      assertTrue(schema.required.indexOf('names') !== -1, 'Should be in required array');
    })) passed++; else failed++;
    
    // Test 5: Validate array type
    if (test(suite, 'validateInput validates array types', function() {
      var schema = DynamicToolParser.parseParams('values[]: int');
      var result = DynamicToolParser.validateInput({ values: [1, 2, 3] }, schema);
      assertTrue(result.valid, 'Should be valid');
      assertEqual(result.errors.length, 0);
    })) passed++; else failed++;
    
    // Test 6: Detect invalid array item type
    if (test(suite, 'validateInput detects invalid array item types', function() {
      var schema = DynamicToolParser.parseParams('values[]: int');
      var result = DynamicToolParser.validateInput({ values: [1, 'two', 3] }, schema);
      assertFalse(result.valid, 'Should be invalid');
      assertTrue(result.errors.length > 0, 'Should have errors');
    })) passed++; else failed++;
    
    // Test 7: applyDefaults rejects null input
    if (test(suite, 'applyDefaults rejects null input', function() {
      var schema = DynamicToolParser.parseParams('count = 10');
      try {
        DynamicToolParser.applyDefaults(null, schema);
        assertTrue(false, 'Should have thrown error');
      } catch (e) {
        assertTrue(e.message.includes('object'), 'Error should mention object requirement');
      }
    })) passed++; else failed++;
    
    // Test 8: validateInput rejects null input
    if (test(suite, 'validateInput rejects null input', function() {
      var schema = DynamicToolParser.parseParams('id!');
      var result = DynamicToolParser.validateInput(null, schema);
      assertFalse(result.valid, 'Should be invalid');
      assertTrue(result.errors.length > 0, 'Should have errors');
    })) passed++; else failed++;
    
    // Test 9: validateInput handles null array items
    if (test(suite, 'validateInput handles null array items', function() {
      var schema = DynamicToolParser.parseParams('ids[]: int');
      var result = DynamicToolParser.validateInput({ ids: [1, null, 3] }, schema);
      assertFalse(result.valid, 'Should be invalid (null not integer)');
      assertTrue(result.errors.some(function(e) { return e.includes('null'); }), 'Should mention null');
    })) passed++; else failed++;
    
    return { passed: passed, failed: failed, total: passed + failed };
  }

  /**
   * Test UsawNormalizers functions
   */
  function testUsawNormalizers() {
    var Normalizers = require('tools/helpers/UsawNormalizers');
    var suite = 'UsawNormalizers';
    var passed = 0, failed = 0;
    
    Logger.log('\n--- ' + suite + ' ---');
    
    // Test 1: Normalize states
    if (test(suite, 'normalizeStates expands abbreviations', function() {
      var result = Normalizers.normalizeStates(['CA', 'TX', 'New York']);
      assertEqual(result[0], 'California');
      assertEqual(result[1], 'Texas');
      assertEqual(result[2], 'New York');
    })) passed++; else failed++;
    
    // Test 2: Normalize gender male
    if (test(suite, 'normalizeGender handles male variants', function() {
      assertEqual(Normalizers.normalizeGender('Male'), 'M');
      assertEqual(Normalizers.normalizeGender('M'), 'M');
      assertEqual(Normalizers.normalizeGender('male'), 'M');
    })) passed++; else failed++;
    
    // Test 3: Normalize gender female
    if (test(suite, 'normalizeGender handles female variants', function() {
      assertEqual(Normalizers.normalizeGender('Female'), 'F');
      assertEqual(Normalizers.normalizeGender('F'), 'F');
      assertEqual(Normalizers.normalizeGender('female'), 'F');
    })) passed++; else failed++;
    
    // Test 4: Parse weight class from string
    if (test(suite, 'parseWeightClass extracts number from string', function() {
      assertEqual(Normalizers.parseWeightClass("Men's 81kg"), 81);
      assertEqual(Normalizers.parseWeightClass("81kg"), 81);
      assertEqual(Normalizers.parseWeightClass("81"), 81);
      assertEqual(Normalizers.parseWeightClass(81), 81);
    })) passed++; else failed++;
    
    // Test 5: Parse weight classes array
    if (test(suite, 'parseWeightClasses handles arrays', function() {
      var result = Normalizers.parseWeightClasses([81, "89kg", "96"]);
      assertEqual(result.length, 3);
      assertEqual(result[0], 81);
      assertEqual(result[1], 89);
      assertEqual(result[2], 96);
    })) passed++; else failed++;
    
    // Test 6: Parse weight classes from comma string
    if (test(suite, 'parseWeightClasses handles comma strings', function() {
      var result = Normalizers.parseWeightClasses("81, 89, 96");
      assertEqual(result.length, 3);
      assertEqual(result[0], 81);
      assertEqual(result[1], 89);
      assertEqual(result[2], 96);
    })) passed++; else failed++;
    
    // Test 7: normalizeStates filters null items
    if (test(suite, 'normalizeStates filters null items', function() {
      var result = Normalizers.normalizeStates(['CA', null, 'TX', undefined]);
      assertEqual(result.length, 2);  // Only CA and TX
      assertEqual(result[0], 'California');
      assertEqual(result[1], 'Texas');
    })) passed++; else failed++;
    
    // Test 8: parseWeightClasses rejects invalid types
    if (test(suite, 'parseWeightClasses rejects invalid types', function() {
      try {
        Normalizers.parseWeightClasses({ foo: 'bar' });
        assertTrue(false, 'Should have thrown error');
      } catch (e) {
        assertTrue(e.message.includes('expects'), 'Error should mention expected types');
      }
    })) passed++; else failed++;
    
    return { passed: passed, failed: failed, total: passed + failed };
  }

  /**
   * Test UsawFilterHelpers functions
   */
  function testUsawFilterHelpers() {
    var FilterHelpers = require('tools/helpers/UsawFilterHelpers');
    var suite = 'UsawFilterHelpers';
    var passed = 0, failed = 0;
    
    Logger.log('\n--- ' + suite + ' ---');
    
    // Test 1: matchesAny - partial match
    if (test(suite, 'matchesAny performs partial matching', function() {
      assertTrue(FilterHelpers.matchesAny('California North Central', ['California']));
      assertTrue(FilterHelpers.matchesAny('John Smith', ['Smith', 'Jones']));
      assertFalse(FilterHelpers.matchesAny('John Smith', ['Lee']));
    })) passed++; else failed++;
    
    // Test 2: matchesAny - empty array
    if (test(suite, 'matchesAny returns true for empty filter array', function() {
      assertTrue(FilterHelpers.matchesAny('anything', []));
      assertTrue(FilterHelpers.matchesAny('anything', null));
    })) passed++; else failed++;
    
    // Test 3: Cartesian product - 2 arrays
    if (test(suite, 'cartesianProduct generates 2-array combinations', function() {
      var result = FilterHelpers.cartesianProduct([['A', 'B'], ['1', '2']]);
      assertEqual(result.length, 4);
      assertEqual(JSON.stringify(result[0]), '["A","1"]');
      assertEqual(JSON.stringify(result[3]), '["B","2"]');
    })) passed++; else failed++;
    
    // Test 4: Cartesian product - 3 arrays
    if (test(suite, 'cartesianProduct generates 3-array combinations', function() {
      var result = FilterHelpers.cartesianProduct([['A'], ['1', '2'], ['X', 'Y']]);
      assertEqual(result.length, 4);  // 1 × 2 × 2
    })) passed++; else failed++;
    
    // Test 5: Deduplicate by key
    if (test(suite, 'deduplicateByKey removes duplicates', function() {
      var data = [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 1, name: 'A' },
        { id: 3, name: 'C' }
      ];
      var result = FilterHelpers.deduplicateByKey(data, 'id');
      assertEqual(result.length, 3);
    })) passed++; else failed++;
    
    // Test 6: Apply sorting - single field
    if (test(suite, 'applySorting handles single field', function() {
      var data = [
        { name: 'C', total: 100 },
        { name: 'A', total: 200 },
        { name: 'B', total: 150 }
      ];
      var result = FilterHelpers.applySorting(data, 'name:asc');
      assertEqual(result[0].name, 'A');
      assertEqual(result[2].name, 'C');
    })) passed++; else failed++;
    
    // Test 7: Apply sorting - compound
    if (test(suite, 'applySorting handles compound sorts', function() {
      var data = [
        { name: 'B', total: 100 },
        { name: 'A', total: 200 },
        { name: 'A', total: 150 }
      ];
      var result = FilterHelpers.applySorting(data, 'name:asc,total:desc');
      assertEqual(result[0].name, 'A');
      assertEqual(result[0].total, 200);
      assertEqual(result[1].total, 150);
      assertEqual(result[2].name, 'B');
    })) passed++; else failed++;
    
    // Test 8: Apply top_n
    if (test(suite, 'applyTopN limits results', function() {
      var data = [1, 2, 3, 4, 5];
      var result = FilterHelpers.applyTopN(data, 3);
      assertEqual(result.length, 3);
      assertEqual(result[0], 1);
      assertEqual(result[2], 3);
    })) passed++; else failed++;
    
    // Test 9: Estimate API calls
    if (test(suite, 'estimateAndWarnApiCalls calculates correctly', function() {
      var count = FilterHelpers.estimateAndWarnApiCalls({
        divisions: ['Youth', 'Junior'],
        weight_classes: ['55', '61', '67']
      });
      assertEqual(count, 6);  // 2 × 3
    })) passed++; else failed++;
    
    // Test 10: cartesianProduct rejects non-arrays
    if (test(suite, 'cartesianProduct rejects non-arrays', function() {
      try {
        FilterHelpers.cartesianProduct('not an array');
        assertTrue(false, 'Should have thrown error');
      } catch (e) {
        assertTrue(e.message.includes('array'), 'Error should mention array requirement');
      }
    })) passed++; else failed++;
    
    // Test 11: applyFilters rejects non-arrays
    if (test(suite, 'applyFilters rejects non-array results', function() {
      try {
        FilterHelpers.applyFilters('not an array', {});
        assertTrue(false, 'Should have thrown error');
      } catch (e) {
        assertTrue(e.message.includes('array'), 'Error should mention array requirement');
      }
    })) passed++; else failed++;
    
    // Test 12: applyFilters accepts 0 for min_total
    if (test(suite, 'applyFilters accepts 0 for min_total', function() {
      var data = [
        { total: 0 },
        { total: 50 },
        { total: 100 }
      ];
      var result = FilterHelpers.applyFilters(data, { min_total: 0 });
      assertEqual(result.length, 3);  // All should pass >= 0
    })) passed++; else failed++;
    
    // Test 13: applyFilters accepts 0 for max_total
    if (test(suite, 'applyFilters accepts 0 for max_total', function() {
      var data = [
        { total: 0 },
        { total: 50 },
        { total: 100 }
      ];
      var result = FilterHelpers.applyFilters(data, { max_total: 0 });
      assertEqual(result.length, 1);  // Only 0 should pass <= 0
      assertEqual(result[0].total, 0);
    })) passed++; else failed++;
    
    return { passed: passed, failed: failed, total: passed + failed };
  }

  /**
   * Test UsawMetadataCache functions (limited - no actual API calls)
   */
  function testUsawMetadataCache() {
    var MetadataCache = require('tools/helpers/UsawMetadataCache');
    var suite = 'UsawMetadataCache';
    var passed = 0, failed = 0;
    
    Logger.log('\n--- ' + suite + ' ---');
    
    // Test 1: Clear cache
    if (test(suite, 'clearUsawMetadataCache runs without error', function() {
      MetadataCache.clearUsawMetadataCache();
      // Just verify it doesn't throw
      assertTrue(true);
    })) passed++; else failed++;
    
    // Note: getRankingsFilterMeta and getEventsFilterMeta require actual API calls
    // which we skip in unit tests. These would be tested in integration tests.
    
    return { passed: passed, failed: failed, total: passed + failed };
  }

  module.exports = {
    runUsawIntegrationTests: runUsawIntegrationTests,
    testDynamicToolParserArrays: testDynamicToolParserArrays,
    testUsawNormalizers: testUsawNormalizers,
    testUsawFilterHelpers: testUsawFilterHelpers,
    testUsawMetadataCache: testUsawMetadataCache
  };
}

__defineModule__(_main);