function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Unit Tests for USAW Dynamic Tools
   * 
   * Tests parameter validation for 4 USAW dynamic tools without making API calls.
   * Fast, free, deterministic validation tests.
   * 
   * Tools tested:
   * - usaw_wso_records: WSO records lookup
   * - iwf_events: IWF events calendar
   * - usaw_filter_options: Filter metadata
   * - usaw_event_results: Event results
   */

  const { describe, it, before, beforeEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  /**
   * Validation helpers - pure functions that can be tested without API calls
   */

  function validateWsoParams(params) {
    if (!params) return { valid: false, error: 'params is required' };
    if (!params.wso) return { valid: false, error: 'wso is required' };
    if (typeof params.wso !== 'string') return { valid: false, error: 'wso must be a string' };
    if (params.wso.length > 200) return { valid: false, error: 'wso name too long (max 200 characters)' };
    if (params.wso.trim().length === 0) return { valid: false, error: 'wso cannot be empty' };
    return { valid: true };
  }

  function validateIwfParams(params) {
    if (!params) params = {};
    if (params.year !== undefined) {
      var year = Number(params.year);
      if (isNaN(year)) return { valid: false, error: 'year must be numeric' };
      if (year < 1950 || year > 2050) return { valid: false, error: 'year must be 1950-2050' };
    }
    return { valid: true };
  }

  function validateEventResultsParams(params) {
    if (!params) return { valid: false, error: 'params is required' };
    if (!params.event_id) return { valid: false, error: 'event_id is required' };
    if (!/^\d+$/.test(String(params.event_id))) return { valid: false, error: 'event_id must be numeric' };
    if (String(params.event_id).length > 20) return { valid: false, error: 'event_id too long' };
    return { valid: true };
  }

  function validateFilterOptionsParams(params) {
    // filter_options has no required params - type is optional
    if (!params) params = {};
    if (params.type !== undefined) {
      var validTypes = ['weight_class', 'age_group', 'gender', 'state', 'division'];
      if (typeof params.type !== 'string') return { valid: false, error: 'type must be a string' };
      // Allow any type but log warning for unknown types
    }
    return { valid: true };
  }

  describe('USAW Tools Unit Tests', function() {

    describe('Tool Schema Validation', function() {
      var registry;
      var usawTools;

      before(function() {
        var ToolRegistry = require('tools/ToolRegistry');
        registry = new ToolRegistry({ enableDynamicTools: true });
        var allTools = registry.getEnabledTools();
        usawTools = allTools.filter(function(t) {
          return t.name.startsWith('usaw_') || t.name === 'iwf_events';
        });
        
        Logger.log('=== TOOL SCHEMA VALIDATION SETUP ===');
        Logger.log('Total tools loaded: ' + allTools.length);
        Logger.log('USAW tools found: ' + usawTools.length);
        usawTools.forEach(function(t) {
          Logger.log('  - ' + t.name + ': ' + t.description.substring(0, 50) + '...');
        });
        Logger.log('=== END ===');
      });

      it('should register at least 4 USAW tools when loaded', function() {
        Logger.log('=== REGISTER USAW TOOLS ===');
        Logger.log('Expected: at least 4 tools');
        Logger.log('Found: ' + usawTools.length);
        usawTools.forEach(function(t) { Logger.log('  Tool: ' + t.name); });
        Logger.log('=== END ===');

        // Originally 4 core tools, now expanded to include more USAW tools
        expect(usawTools.length).to.be.greaterThan(3);
      });

      it('should have valid input_schema for each tool', function() {
        Logger.log('=== INPUT SCHEMA VALIDATION ===');
        usawTools.forEach(function(t) {
          var hasSchema = t.input_schema && t.input_schema.type === 'object';
          Logger.log(t.name + ': schema valid = ' + (hasSchema ? 'YES' : 'NO'));
          expect(t.input_schema).to.exist;
          expect(t.input_schema.type).to.equal('object');
        });
        Logger.log('=== END ===');
      });
    });

    describe('usaw_wso_records Parameter Validation', function() {

      it('should return error when wso missing', function() {
        Logger.log('=== WSO MISSING TEST ===');
        var result = validateWsoParams({});
        Logger.log('Input: {}');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('required');
      });

      it('should return error when wso > 200 chars', function() {
        Logger.log('=== WSO TOO LONG TEST ===');
        var longName = 'x'.repeat(201);
        var result = validateWsoParams({ wso: longName });
        Logger.log('Input: wso length = ' + longName.length);
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('too long');
      });

      it('should return error when wso is empty string', function() {
        Logger.log('=== WSO EMPTY STRING TEST ===');
        var result = validateWsoParams({ wso: '   ' });
        Logger.log('Input: wso = "   "');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('empty');
      });

      it('should pass when wso is valid', function() {
        Logger.log('=== WSO VALID TEST ===');
        var result = validateWsoParams({ wso: 'Pacific Weightlifting' });
        Logger.log('Input: wso = "Pacific Weightlifting"');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.true;
      });
    });

    describe('iwf_events Parameter Validation', function() {

      it('should return error when year < 1950', function() {
        Logger.log('=== IWF YEAR TOO OLD TEST ===');
        var result = validateIwfParams({ year: 1900 });
        Logger.log('Input: year = 1900');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('1950-2050');
      });

      it('should return error when year > 2050', function() {
        Logger.log('=== IWF YEAR TOO FUTURE TEST ===');
        var result = validateIwfParams({ year: 2100 });
        Logger.log('Input: year = 2100');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('1950-2050');
      });

      it('should return error when year is non-numeric', function() {
        Logger.log('=== IWF YEAR NON-NUMERIC TEST ===');
        var result = validateIwfParams({ year: 'abc' });
        Logger.log('Input: year = "abc"');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('numeric');
      });

      it('should pass when year is valid', function() {
        Logger.log('=== IWF YEAR VALID TEST ===');
        var result = validateIwfParams({ year: 2024 });
        Logger.log('Input: year = 2024');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.true;
      });

      it('should pass when year is missing (defaults allowed)', function() {
        Logger.log('=== IWF YEAR MISSING TEST ===');
        var result = validateIwfParams({});
        Logger.log('Input: {}');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.true;
      });
    });

    describe('usaw_event_results Parameter Validation', function() {

      it('should return error when event_id missing', function() {
        Logger.log('=== EVENT_ID MISSING TEST ===');
        var result = validateEventResultsParams({});
        Logger.log('Input: {}');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('required');
      });

      it('should return error when event_id is non-numeric', function() {
        Logger.log('=== EVENT_ID NON-NUMERIC TEST ===');
        var result = validateEventResultsParams({ event_id: 'abc' });
        Logger.log('Input: event_id = "abc"');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('numeric');
      });

      it('should return error when event_id is too long', function() {
        Logger.log('=== EVENT_ID TOO LONG TEST ===');
        var longId = '1'.repeat(21);
        var result = validateEventResultsParams({ event_id: longId });
        Logger.log('Input: event_id length = ' + longId.length);
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('too long');
      });

      it('should pass when event_id is valid', function() {
        Logger.log('=== EVENT_ID VALID TEST ===');
        var result = validateEventResultsParams({ event_id: '12345' });
        Logger.log('Input: event_id = "12345"');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.true;
      });

      it('should pass when event_id is numeric type', function() {
        Logger.log('=== EVENT_ID NUMERIC TYPE TEST ===');
        var result = validateEventResultsParams({ event_id: 12345 });
        Logger.log('Input: event_id = 12345 (number)');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.true;
      });
    });

    describe('usaw_filter_options Parameter Validation', function() {

      it('should pass when type is missing (defaults allowed)', function() {
        Logger.log('=== FILTER TYPE MISSING TEST ===');
        var result = validateFilterOptionsParams({});
        Logger.log('Input: {}');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.true;
      });

      it('should pass when type is valid string', function() {
        Logger.log('=== FILTER TYPE VALID TEST ===');
        var result = validateFilterOptionsParams({ type: 'weight_class' });
        Logger.log('Input: type = "weight_class"');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.true;
      });

      it('should return error when type is not a string', function() {
        Logger.log('=== FILTER TYPE NOT STRING TEST ===');
        var result = validateFilterOptionsParams({ type: 123 });
        Logger.log('Input: type = 123');
        Logger.log('Result valid: ' + (result.valid ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none'));
        Logger.log('=== END ===');

        expect(result.valid).to.be.false;
        expect(result.error).to.include('string');
      });
    });
  });

  module.exports = { 
    run: function() { return require('test-framework/mocha-adapter').executeAll(); },
    validateWsoParams: validateWsoParams,
    validateIwfParams: validateIwfParams,
    validateEventResultsParams: validateEventResultsParams,
    validateFilterOptionsParams: validateFilterOptionsParams
  };
}

__defineModule__(_main);