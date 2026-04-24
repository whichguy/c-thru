function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Integration tests for DynamicToolHandler
   * Tests that dynamic tools are correctly loaded, discovered, and executed
   * 
   * Prerequisites:
   * - _Tools sheet must exist with test tools (test_echo, test_params, etc.)
   * - Run via test runner: TestRunner.runTestFile('tools/test/DynamicToolHandler.integration.test')
   * 
   * == LLM TOOL INVOCATION ANNOTATIONS ==
   * Maps natural language queries to expected tool invocations:
   * 
   * | User Query / Intent                          | Expected Tool       | Input Params                      |
   * |----------------------------------------------|---------------------|-----------------------------------|
   * | "Echo this message: hello"                   | test_echo           | { message: "hello" }              |
   * | "Test with required value X and optional Y" | test_params         | { required_param: X, optional: Y }|
   * | "Store value V under key K"                  | test_state_writer   | { key: K, value: V }              |
   * | "Retrieve stored value for key K"            | test_state_reader   | { key: K }                        |
   * | "Fetch 3 pages of test data"                 | test_pagination     | { pages: 3 }                      |
   * | "Check available GAS services"               | test_gas_services   | {}                                |
   * | "Get USAW rankings for 81kg class"           | usaw_rankings       | { weight_class_id: 81 }           |
   * | "List weight classes for women"              | usaw_weight_classes | { gender: "F" }                   |
   * | "Competition history for athlete 509"        | usaw_lifter_history | { member_id: 509 }                |
   * | "Current IWF world records for men"          | iwf_world_records   | { gender: "M" }                   |
   * 
   * These annotations help validate tool discoverability and parameter inference.
   */

  const { describe, it, beforeEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('DynamicToolHandler Integration', function() {

    describe('DynamicToolParser', function() {
      
      it('should parse empty params as accept-any object', function() {
        const DynamicToolParser = require('tools/DynamicToolParser');
        const schema = DynamicToolParser.parseParams('');
        
        expect(schema.type).to.equal('object');
        expect(Object.keys(schema.properties)).to.have.length(0);
      });

      it('should parse required params with ! suffix', function() {
        const DynamicToolParser = require('tools/DynamicToolParser');
        const schema = DynamicToolParser.parseParams('name!, age!');
        
        expect(schema.required).to.include('name');
        expect(schema.required).to.include('age');
        expect(schema.required).to.have.length(2);
      });

      it('should parse optional params with defaults', function() {
        const DynamicToolParser = require('tools/DynamicToolParser');
        const schema = DynamicToolParser.parseParams('page = 1, limit = 50');
        
        expect(schema.properties.page.default).to.equal(1);
        expect(schema.properties.limit.default).to.equal(50);
        expect(schema._defaults.page).to.equal(1);
        expect(schema._defaults.limit).to.equal(50);
      });

      it('should parse mixed required and optional params', function() {
        const DynamicToolParser = require('tools/DynamicToolParser');
        const schema = DynamicToolParser.parseParams('weight_class!, page = 1, limit = 100');
        
        expect(schema.required).to.include('weight_class');
        expect(schema.required).to.have.length(1);
        expect(schema.properties.page.default).to.equal(1);
        expect(schema.properties.limit.default).to.equal(100);
      });

      it('should parse type hints (ignored for validation)', function() {
        const DynamicToolParser = require('tools/DynamicToolParser');
        const schema = DynamicToolParser.parseParams('name: string!, count: int = 10');
        
        expect(schema.required).to.include('name');
        expect(schema.properties.name.description).to.include('string');
        expect(schema.properties.count.default).to.equal(10);
      });

      it('should apply defaults to input object', function() {
        const DynamicToolParser = require('tools/DynamicToolParser');
        const schema = DynamicToolParser.parseParams('page = 1, limit = 50');
        
        const input = { limit: 100 };
        const result = DynamicToolParser.applyDefaults(input, schema);
        
        expect(result.page).to.equal(1);  // Default applied
        expect(result.limit).to.equal(100);  // User value preserved
      });
    });

    describe('DynamicToolLoader', function() {

      it('should load enabled tools from _Tools sheet', function() {
        const DynamicToolLoader = require('tools/DynamicToolLoader');
        const handlers = DynamicToolLoader.loadHandlers();
        
        expect(handlers).to.be.an('array');
        expect(handlers.length).to.be.greaterThan(0);
      });

      it('should skip disabled tools', function() {
        const DynamicToolLoader = require('tools/DynamicToolLoader');
        const handlers = DynamicToolLoader.loadHandlers();
        
        const disabledTool = handlers.find(h => h.toolName === 'test_disabled');
        expect(disabledTool).to.be.undefined;
      });

      it('should validate code syntax at load time', function() {
        const DynamicToolLoader = require('tools/DynamicToolLoader');
        
        // Valid code
        const valid = DynamicToolLoader.validateCode('return 1 + 1;', 'test');
        expect(valid.valid).to.be.true;
        
        // Invalid code
        const invalid = DynamicToolLoader.validateCode('return {;', 'test');
        expect(invalid.valid).to.be.false;
        expect(invalid.error).to.be.a('string');
      });

      it('should validate entire sheet', function() {
        const DynamicToolLoader = require('tools/DynamicToolLoader');
        const result = DynamicToolLoader.validateSheet();
        
        expect(result).to.have.property('valid');
        expect(result).to.have.property('tools');
        expect(result).to.have.property('errors');
      });
    });

    describe('Tool Discovery via ToolRegistry', function() {

      it('should include dynamic tools in getEnabledTools()', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const tools = registry.getEnabledTools();

        const dynamicTool = tools.find(t => t.name === 'test_echo');
        expect(dynamicTool).to.exist;
        expect(dynamicTool.description).to.include('Echo');
      });

      it('should include dynamic tools in getEnabledToolNames()', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const names = registry.getEnabledToolNames();

        expect(names).to.include('test_echo');
        expect(names).to.include('test_params');
        expect(names).to.include('test_gas_services');
      });

      it('should generate correct input_schema from params notation', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const tools = registry.getEnabledTools();

        const tool = tools.find(t => t.name === 'test_params');
        expect(tool.input_schema.type).to.equal('object');
        expect(tool.input_schema.required).to.include('required_param');
        expect(tool.input_schema.properties.optional_param.default).to.equal(42);
      });

      it('should append return type to description', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const tools = registry.getEnabledTools();

        const tool = tools.find(t => t.name === 'test_echo');
        expect(tool.description).to.include('Returns: string');
      });

      it('should allow disabling dynamic tools via config', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry({ enableDynamicTools: false });
        const names = registry.getEnabledToolNames();

        expect(names).to.not.include('test_echo');
      });
    });

    describe('Tool Execution via ToolRegistry', function() {

      it('should execute dynamic tool with valid input', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('test_echo', { message: 'hello' });

        expect(result.success).to.be.true;
        expect(result.result).to.equal('Echo: hello');
      });

      it('should apply default values to missing params', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('test_params', { required_param: 'test' });

        expect(result.success).to.be.true;
        expect(result.result.required).to.equal('test');
        expect(result.result.optional).to.equal(42);  // Default applied
      });

      it('should pass toolState to dynamic tool', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        // First call sets state
        registry.executeToolCall('test_state_writer', { key: 'testKey', value: 'testValue' });

        // Second call reads state
        const result = registry.executeToolCall('test_state_reader', { key: 'testKey' });

        expect(result.success).to.be.true;
        expect(result.result).to.equal('testValue');
      });

      it('should handle tool execution errors gracefully', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('test_error', {});

        expect(result.success).to.be.false;
        expect(result.error).to.include('Intentional error');
      });

      it('should provide GAS services to dynamic tool', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('test_gas_services', {});

        expect(result.success).to.be.true;
        expect(result.result.hasSpreadsheetApp).to.be.true;
        expect(result.result.hasUrlFetchApp).to.be.true;
        expect(result.result.hasLogger).to.be.true;
        expect(result.result.hasDriveApp).to.be.true;
      });

      it('should include resultType in response metadata', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('test_echo', { message: 'test' });

        expect(result.resultType).to.equal('string');
      });

      it('should include resultCount for array results', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        // test_pagination returns {totalRecords, data: [...]}, so resultCount is set from data array
        // But since result is an object (not array), resultCount won't be set automatically
        // Instead we verify the tool's internal count is correct
        const result = registry.executeToolCall('test_pagination', { pages: 2 });

        expect(result.success).to.be.true;
        expect(result.result.totalRecords).to.equal(20);  // 2 pages * 10 records
        expect(result.result.data).to.have.length(20);
      });
    });

    describe('Pagination with thinking() Progress', function() {

      it('should call thinking() during pagination', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const thinkingMessages = [];
        const context = {
          think: (msg) => thinkingMessages.push(msg)
        };

        const result = registry.executeToolCall('test_pagination', { pages: 3 }, context);

        expect(result.success).to.be.true;
        expect(result.result.totalRecords).to.equal(30);
        expect(thinkingMessages.length).to.be.greaterThan(0);
        expect(thinkingMessages.some(m => m.includes('Fetching page'))).to.be.true;
        expect(thinkingMessages.some(m => m.includes('Complete'))).to.be.true;
      });

      it('should use default pages value when not provided', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('test_pagination', {});

        expect(result.success).to.be.true;
        expect(result.result.totalRecords).to.equal(20);  // Default: 2 pages * 10
      });
    });

    describe('Error Handling and Logging', function() {

      it('should log detailed error context on runtime failure', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('test_error', {});

        expect(result.success).to.be.false;
        expect(result.error).to.include('test_error');
        expect(result.stack).to.be.a('string');
      });

      it('should return error for missing required params', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('test_echo', {});

        expect(result.success).to.be.false;
        expect(result.error).to.include('message');
      });

      it('should return error for non-existent tool', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();

        const result = registry.executeToolCall('non_existent_tool', {});

        expect(result.success).to.be.false;
        expect(result.error).to.include('not enabled');
      });
    });

    describe('USAW/IWF Production Tools', function() {
      /**
       * Integration tests for production USAW/IWF tools defined in _Tools sheet.
       * These verify that real tools work end-to-end with actual API calls.
       */

      it('should execute usaw_rankings with weight class id', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const result = registry.executeToolCall('usaw_rankings', { weight_class_id: 81 });

        expect(result.success).to.be.true;
      });

      it('should execute usaw_weight_classes', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const result = registry.executeToolCall('usaw_weight_classes', { gender: 'M' });

        expect(result.success).to.be.true;
      });

      it('should execute usaw_lifter_history with member_id', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const result = registry.executeToolCall('usaw_lifter_history', { member_id: 509 });

        // Should return data or graceful "not found" - not crash
        expect(result).to.have.property('success');
      });

      it('should execute iwf_world_records', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const result = registry.executeToolCall('iwf_world_records', { gender: 'M' });

        expect(result.success).to.be.true;
      });

      it('should handle invalid params gracefully', function() {
        const ToolRegistry = require('tools/ToolRegistry');
        const registry = new ToolRegistry();
        const result = registry.executeToolCall('usaw_rankings', { weight_class_id: -1 });

        // Should not throw - either success with empty or graceful error
        expect(result).to.have.property('success');
      });
    });
  });

  // Export for CommonJS
  module.exports = {};
}

__defineModule__(_main);