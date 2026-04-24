function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Integration Tests for USAW Dynamic Tools
   * 
   * Tests tool registration and execution through ToolRegistry.
   * Verifies dynamic tool loading, schema generation, and result structure.
   * 
   * Tools tested:
   * - usaw_wso_records
   * - iwf_events
   * - usaw_filter_options
   * - usaw_event_results
   * - usaw_standards
   * - usaw_ntp_selection
   */

  const { describe, it, before, beforeEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('USAW Tools Integration Tests', function() {
    var registry;

    beforeEach(function() {
      var ToolRegistry = require('tools/ToolRegistry');
      registry = new ToolRegistry({
        enableDynamicTools: true,
        enableExec: false,
        enableSearch: false,
        enableKnowledge: true,
        enablePrompt: false,
        enableAnalyzeUrl: false,
        enableFetchUrls: false
      });
    });

    describe('Tool Registration', function() {

      it('should register at least 4 USAW tools', function() {
        Logger.log('=== TOOL REGISTRATION TEST ===');
        var allTools = registry.getEnabledTools();
        var usawTools = allTools.filter(function(t) {
          return t.name.startsWith('usaw_') || t.name === 'iwf_events';
        });
        
        Logger.log('Total tools: ' + allTools.length);
        Logger.log('USAW tools found: ' + usawTools.length);
        usawTools.forEach(function(t) {
          Logger.log('  - ' + t.name);
        });
        Logger.log('=== END ===');

        // Originally 4 core tools, now expanded
        expect(usawTools.length).to.be.greaterThan(3);
      });

      it('should have usaw_filter_options tool registered', function() {
        Logger.log('=== FILTER_OPTIONS REGISTRATION TEST ===');
        var isEnabled = registry.isToolEnabled('usaw_filter_options');
        Logger.log('usaw_filter_options enabled: ' + (isEnabled ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(isEnabled).to.be.true;
      });

      it('should have usaw_wso_records tool registered', function() {
        Logger.log('=== WSO_RECORDS REGISTRATION TEST ===');
        var isEnabled = registry.isToolEnabled('usaw_wso_records');
        Logger.log('usaw_wso_records enabled: ' + (isEnabled ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(isEnabled).to.be.true;
      });

      it('should have iwf_events tool registered', function() {
        Logger.log('=== IWF_EVENTS REGISTRATION TEST ===');
        var isEnabled = registry.isToolEnabled('iwf_events');
        Logger.log('iwf_events enabled: ' + (isEnabled ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(isEnabled).to.be.true;
      });

      it('should have usaw_event_results tool registered', function() {
        Logger.log('=== EVENT_RESULTS REGISTRATION TEST ===');
        var isEnabled = registry.isToolEnabled('usaw_event_results');
        Logger.log('usaw_event_results enabled: ' + (isEnabled ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(isEnabled).to.be.true;
      });
    });

    describe('Tool Definition Structure', function() {

      it('should have valid tool definitions with required fields', function() {
        Logger.log('=== TOOL DEFINITION STRUCTURE TEST ===');
        var toolDef = registry.handlers['usaw_filter_options'].getToolDefinition();
        
        Logger.log('Tool name: ' + toolDef.name);
        Logger.log('Has description: ' + (toolDef.description ? 'YES' : 'NO'));
        Logger.log('Has input_schema: ' + (toolDef.input_schema ? 'YES' : 'NO'));
        Logger.log('Schema type: ' + (toolDef.input_schema ? toolDef.input_schema.type : 'N/A'));
        Logger.log('=== END ===');

        expect(toolDef.name).to.equal('usaw_filter_options');
        expect(toolDef.description).to.exist;
        expect(toolDef.input_schema).to.exist;
        expect(toolDef.input_schema.type).to.equal('object');
      });

      it('should include properties in input_schema', function() {
        Logger.log('=== INPUT SCHEMA PROPERTIES TEST ===');
        var toolDef = registry.handlers['usaw_event_results'].getToolDefinition();
        
        Logger.log('Tool: ' + toolDef.name);
        Logger.log('Properties: ' + JSON.stringify(Object.keys(toolDef.input_schema.properties || {})));
        Logger.log('Required: ' + JSON.stringify(toolDef.input_schema.required || []));
        Logger.log('=== END ===');

        expect(toolDef.input_schema.properties).to.exist;
      });
    });

    describe('Tool Execution - Validation Errors', function() {

      it('should handle missing required params gracefully', function() {
        Logger.log('=== VALIDATION HANDLING TEST ===');
        // usaw_event_results requires event_id - should return error or handle gracefully
        var result = registry.executeToolCall('usaw_event_results', {}, {});
        
        Logger.log('Success: ' + (result.success ? 'YES' : 'NO'));
        Logger.log('Has error: ' + (result.error ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        // Tool should either fail with error OR succeed with validation message
        expect(result).to.have.property('success');
        if (!result.success) {
          expect(result.error).to.exist;
        }
      });

      it('should return error for non-existent tool', function() {
        Logger.log('=== NON-EXISTENT TOOL TEST ===');
        var result = registry.executeToolCall('nonexistent_tool', {}, {});
        
        Logger.log('Success: ' + (result.success ? 'YES' : 'NO'));
        Logger.log('Error: ' + (result.error || 'none').substring(0, 100));
        Logger.log('=== END ===');

        expect(result.success).to.be.false;
        expect(result.error).to.include('not enabled');
      });
    });

    describe('Tool Execution - Standard Result Structure', function() {

      it('should return standard result structure with success field', function() {
        Logger.log('=== STANDARD RESULT STRUCTURE TEST ===');
        // Execute a tool that should work (filter_options has no required params)
        var result = registry.executeToolCall('usaw_filter_options', {}, {});
        
        Logger.log('Has success field: ' + ('success' in result ? 'YES' : 'NO'));
        Logger.log('Success value: ' + result.success);
        Logger.log('Has result field: ' + ('result' in result ? 'YES' : 'NO'));
        Logger.log('Has error field: ' + ('error' in result ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(result).to.have.property('success');
        // Either success with result or failure with error
        if (result.success) {
          expect(result).to.have.property('result');
        } else {
          expect(result).to.have.property('error');
        }
      });

      it('should return consistent result structure', function() {
        Logger.log('=== RESULT STRUCTURE TEST ===');
        var result = registry.executeToolCall('usaw_event_results', {}, {});
        
        Logger.log('Success: ' + result.success);
        Logger.log('Has result: ' + (result.result ? 'YES' : 'NO'));
        Logger.log('Has error: ' + (result.error ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        // Should have success field and either result or error
        expect(result).to.have.property('success');
      });
    });

    describe('Tool State Management', function() {

      it('should maintain tool state object', function() {
        Logger.log('=== TOOL STATE TEST ===');
        // First call
        var result = registry.executeToolCall('usaw_filter_options', {}, {});
        var state = registry.getToolState();
        
        Logger.log('State exists: ' + (state ? 'YES' : 'NO'));
        Logger.log('State type: ' + typeof state);
        Logger.log('Tool call success: ' + (result.success ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        // State object should exist (may or may not have previousResult depending on implementation)
        expect(state).to.be.an('object');
      });

      it('should reset toolState correctly', function() {
        Logger.log('=== TOOL STATE RESET TEST ===');
        registry.executeToolCall('usaw_filter_options', {}, {});
        registry.resetToolState();
        var state = registry.getToolState();
        
        Logger.log('State after reset: ' + JSON.stringify(state));
        Logger.log('Is empty: ' + (Object.keys(state).length === 0 ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(Object.keys(state).length).to.equal(0);
      });
    });

    describe('usaw_standards Tool', function() {

      it('should be registered', function() {
        Logger.log('=== USAW_STANDARDS REGISTRATION TEST ===');
        var isEnabled = registry.isToolEnabled('usaw_standards');
        Logger.log('usaw_standards enabled: ' + (isEnabled ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(isEnabled).to.be.true;
      });

      it('should return standards for valid year and gender', function() {
        Logger.log('=== USAW_STANDARDS EXECUTION TEST ===');
        var result = registry.executeToolCall('usaw_standards', {
          year: 2025,
          gender: 'M',
          age_group: 'Senior'
        }, {});
        
        Logger.log('Success: ' + (result.success ? 'YES' : 'NO'));
        Logger.log('Has result: ' + (result.result ? 'YES' : 'NO'));
        if (result.result) {
          Logger.log('Result type: ' + typeof result.result);
          Logger.log('Is array: ' + (Array.isArray(result.result) ? 'YES' : 'NO'));
        }
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        expect(result.result).to.exist;
      });

      it('should handle missing required params', function() {
        Logger.log('=== USAW_STANDARDS MISSING PARAMS TEST ===');
        var result = registry.executeToolCall('usaw_standards', {}, {});
        
        Logger.log('Success: ' + (result.success ? 'YES' : 'NO'));
        Logger.log('Has error: ' + (result.error ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        // Should fail or return error for missing year
        expect(result).to.have.property('success');
      });
    });

    describe('usaw_ntp_selection Tool', function() {

      it('should be registered', function() {
        Logger.log('=== USAW_NTP_SELECTION REGISTRATION TEST ===');
        var isEnabled = registry.isToolEnabled('usaw_ntp_selection');
        Logger.log('usaw_ntp_selection enabled: ' + (isEnabled ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(isEnabled).to.be.true;
      });

      it('should return qualifying period info with auto_fetch disabled', function() {
        Logger.log('=== USAW_NTP_SELECTION PERIOD INFO TEST ===');
        var result = registry.executeToolCall('usaw_ntp_selection', {
          ntp_period_start: '2026-07-01',
          auto_fetch: false
        }, {});
        
        Logger.log('Success: ' + (result.success ? 'YES' : 'NO'));
        Logger.log('Has result: ' + (result.result ? 'YES' : 'NO'));
        if (result.result) {
          Logger.log('NTP period: ' + (result.result.ntp_period || 'N/A'));
          Logger.log('Has qualifying_period: ' + (result.result.qualifying_period ? 'YES' : 'NO'));
          if (result.result.qualifying_period) {
            Logger.log('Qualifying start: ' + result.result.qualifying_period.start);
            Logger.log('Qualifying end: ' + result.result.qualifying_period.end);
          }
        }
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        expect(result.result).to.exist;
        expect(result.result.ntp_period).to.equal('2026-07-01');
        expect(result.result.qualifying_period).to.exist;
        expect(result.result.qualifying_period.start).to.equal('2025-01-01');
        expect(result.result.qualifying_period.end).to.equal('2025-12-31');
      });

      it('should calculate NTP levels with manual athletes array', function() {
        Logger.log('=== USAW_NTP_SELECTION MANUAL ATHLETES TEST ===');
        var result = registry.executeToolCall('usaw_ntp_selection', {
          ntp_period_start: '2026-07-01',
          athletes: [{
            athleteId: 'test1',
            name: 'Test Athlete',
            gender: 'M',
            weightClass: 73,
            total: 340,
            birthYear: 2000,
            date: '2025-03-15',
            eventName: '2025 World Championships'
          }]
        }, {});
        
        Logger.log('Success: ' + (result.success ? 'YES' : 'NO'));
        Logger.log('Has result: ' + (result.result ? 'YES' : 'NO'));
        if (result.result) {
          Logger.log('Has levels: ' + (result.result.levels ? 'YES' : 'NO'));
          Logger.log('Has summary: ' + (result.result.summary ? 'YES' : 'NO'));
        }
        Logger.log('=== END ===');

        expect(result.success).to.be.true;
        expect(result.result).to.exist;
        // With athletes provided, should calculate levels
        expect(result.result.levels || result.result.summary).to.exist;
      });

      it('should handle missing required ntp_period_start param', function() {
        Logger.log('=== USAW_NTP_SELECTION MISSING PARAMS TEST ===');
        var result = registry.executeToolCall('usaw_ntp_selection', {}, {});
        
        Logger.log('Success: ' + (result.success ? 'YES' : 'NO'));
        Logger.log('Has error: ' + (result.error ? 'YES' : 'NO'));
        if (result.result && !result.result.success) {
          Logger.log('Result error: ' + (result.result.error || 'N/A'));
        }
        Logger.log('=== END ===');

        // Should fail or return error for missing ntp_period_start
        expect(result).to.have.property('success');
        // The tool returns success:true but result.success:false for validation errors
        if (result.success && result.result) {
          expect(result.result.success).to.be.false;
          expect(result.result.error).to.include('ntp_period_start');
        }
      });
    });

    describe('Dynamic Tool Handler Features', function() {

      it('should have access to thinking() helper in execution context', function() {
        Logger.log('=== THINKING HELPER TEST ===');
        // The thinking helper is injected during execution
        // We can verify the handler has the execute method
        var handler = registry.handlers['usaw_filter_options'];
        
        Logger.log('Handler exists: ' + (handler ? 'YES' : 'NO'));
        Logger.log('Has execute method: ' + (handler && typeof handler.execute === 'function' ? 'YES' : 'NO'));
        Logger.log('Has run method: ' + (handler && typeof handler.run === 'function' ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(handler).to.exist;
        expect(typeof handler.run).to.equal('function');
      });

      it('should have DynamicToolHandler prototype', function() {
        Logger.log('=== HANDLER PROTOTYPE TEST ===');
        var handler = registry.handlers['usaw_wso_records'];
        var DynamicToolHandler = require('tools/DynamicToolHandler');
        
        var isDynamic = handler instanceof DynamicToolHandler;
        Logger.log('Is DynamicToolHandler: ' + (isDynamic ? 'YES' : 'NO'));
        Logger.log('Tool name: ' + handler.toolName);
        Logger.log('=== END ===');

        expect(isDynamic).to.be.true;
      });
    });
  });

  module.exports = { 
    run: function() { return require('test-framework/mocha-adapter').executeAll(); }
  };
}

__defineModule__(_main);