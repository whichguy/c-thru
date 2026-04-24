function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Prompt Engineering Tests for USAW Dynamic Tools
   * 
   * Tests tool descriptions and schemas for LLM-friendliness.
   * Verifies descriptions are action-oriented and contain relevant keywords.
   * 
   * These tests help ensure Claude can effectively discover and invoke the tools.
   */

  const { describe, it, before } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('USAW Prompt Engineering Tests', function() {
    var registry;
    var usawTools;
    var toolDefinitions;

    before(function() {
      var ToolRegistry = require('tools/ToolRegistry');
      registry = new ToolRegistry({ enableDynamicTools: true });
      var allTools = registry.getEnabledTools();
      usawTools = allTools.filter(function(t) {
        return t.name.startsWith('usaw_') || t.name === 'iwf_events';
      });
      
      // Build a map of tool definitions
      toolDefinitions = {};
      usawTools.forEach(function(t) {
        toolDefinitions[t.name] = t;
      });
      
      Logger.log('=== PROMPT TESTS SETUP ===');
      Logger.log('USAW tools loaded: ' + usawTools.length);
      usawTools.forEach(function(t) {
        Logger.log('  - ' + t.name);
      });
      Logger.log('=== END ===');
    });

    describe('Description Quality', function() {

      it('should have clear, action-oriented descriptions', function() {
        Logger.log('=== ACTION-ORIENTED DESCRIPTIONS TEST ===');
        
        var actionVerbs = ['get', 'fetch', 'find', 'list', 'search', 'retrieve', 'query', 'load', 'look up', 'return'];
        var allHaveVerbs = true;
        
        usawTools.forEach(function(tool) {
          var desc = tool.description.toLowerCase();
          var hasVerb = actionVerbs.some(function(verb) {
            return desc.includes(verb);
          });
          
          Logger.log(tool.name + ':');
          Logger.log('  Description: ' + tool.description.substring(0, 80) + '...');
          Logger.log('  Has action verb: ' + (hasVerb ? 'YES' : 'NO'));
          
          if (!hasVerb) allHaveVerbs = false;
        });
        
        Logger.log('All have action verbs: ' + (allHaveVerbs ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(allHaveVerbs).to.be.true;
      });

      it('should include relevant domain keywords in descriptions', function() {
        Logger.log('=== DOMAIN KEYWORDS TEST ===');
        
        var toolKeywords = {
          'usaw_wso_records': ['wso', 'record', 'weight'],
          'iwf_events': ['iwf', 'event', 'international'],
          'usaw_filter_options': ['filter', 'option', 'metadata'],
          'usaw_event_results': ['event', 'result', 'athlete']
        };
        
        var allHaveKeywords = true;
        
        Object.keys(toolKeywords).forEach(function(toolName) {
          var tool = toolDefinitions[toolName];
          if (!tool) {
            Logger.log(toolName + ': NOT FOUND');
            allHaveKeywords = false;
            return;
          }
          
          var desc = tool.description.toLowerCase();
          var keywords = toolKeywords[toolName];
          var matchedKeywords = keywords.filter(function(kw) {
            return desc.includes(kw.toLowerCase());
          });
          
          var hasAllKeywords = matchedKeywords.length >= 1; // At least one keyword
          
          Logger.log(toolName + ':');
          Logger.log('  Expected keywords: ' + keywords.join(', '));
          Logger.log('  Matched: ' + matchedKeywords.join(', '));
          Logger.log('  Has keywords: ' + (hasAllKeywords ? 'YES' : 'NO'));
          
          if (!hasAllKeywords) allHaveKeywords = false;
        });
        
        Logger.log('All have required keywords: ' + (allHaveKeywords ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(allHaveKeywords).to.be.true;
      });

      it('should have descriptions of reasonable length', function() {
        Logger.log('=== DESCRIPTION LENGTH TEST ===');
        
        var minLength = 20;
        var maxLength = 500;
        var allValidLength = true;
        
        usawTools.forEach(function(tool) {
          var len = tool.description.length;
          var valid = len >= minLength && len <= maxLength;
          
          Logger.log(tool.name + ':');
          Logger.log('  Length: ' + len + ' chars');
          Logger.log('  Valid range (' + minLength + '-' + maxLength + '): ' + (valid ? 'YES' : 'NO'));
          
          if (!valid) allValidLength = false;
        });
        
        Logger.log('All valid lengths: ' + (allValidLength ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(allValidLength).to.be.true;
      });
    });

    describe('Schema Clarity', function() {

      it('should have meaningful parameter names', function() {
        Logger.log('=== PARAMETER NAMES TEST ===');
        
        var badPatterns = [/^p\d+$/, /^arg\d*$/, /^param\d*$/, /^x$/, /^y$/];
        var allGoodNames = true;
        
        usawTools.forEach(function(tool) {
          var props = Object.keys(tool.input_schema.properties || {});
          
          Logger.log(tool.name + ':');
          Logger.log('  Parameters: ' + (props.length > 0 ? props.join(', ') : '(none)'));
          
          props.forEach(function(propName) {
            var isBadName = badPatterns.some(function(pattern) {
              return pattern.test(propName);
            });
            
            if (isBadName) {
              Logger.log('  BAD NAME: ' + propName);
              allGoodNames = false;
            }
          });
        });
        
        Logger.log('All have good names: ' + (allGoodNames ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(allGoodNames).to.be.true;
      });

      it('should have documented parameters in schema', function() {
        Logger.log('=== PARAMETERS DOCUMENTATION TEST ===');
        
        // These tools should have their key params documented in the schema
        var expectedParams = {
          'usaw_event_results': ['event_id'],
          'usaw_wso_records': ['wso']
        };
        
        var allHaveParams = true;
        
        Object.keys(expectedParams).forEach(function(toolName) {
          var tool = toolDefinitions[toolName];
          if (!tool) {
            Logger.log(toolName + ': NOT FOUND');
            allHaveParams = false;
            return;
          }
          
          var props = Object.keys(tool.input_schema.properties || {});
          var expected = expectedParams[toolName];
          
          Logger.log(toolName + ':');
          Logger.log('  Expected params: ' + expected.join(', '));
          Logger.log('  Available params: ' + (props.length > 0 ? props.join(', ') : '(none)'));
          
          // Check if expected params exist in properties (may or may not be marked required)
          var hasParams = expected.every(function(param) {
            return props.indexOf(param) !== -1;
          });
          
          Logger.log('  Params documented: ' + (hasParams ? 'YES' : 'NO'));
          
          if (!hasParams) allHaveParams = false;
        });
        
        Logger.log('All documented: ' + (allHaveParams ? 'YES' : 'NO'));
        Logger.log('=== END ===');

        expect(allHaveParams).to.be.true;
      });
    });

    describe('Expected Trigger Prompts', function() {

      it('should document expected trigger prompts for reference', function() {
        Logger.log('=== EXPECTED TRIGGER PROMPTS ===');
        
        var triggers = {
          'usaw_wso_records': 'What are the WSO records for Pacific Weightlifting?',
          'iwf_events': 'What IWF competitions are happening in 2024?',
          'usaw_filter_options': 'What weight classes are available?',
          'usaw_event_results': 'Get results from event 12345'
        };
        
        Object.keys(triggers).forEach(function(toolName) {
          var tool = toolDefinitions[toolName];
          Logger.log('');
          Logger.log('Tool: ' + toolName);
          Logger.log('  Trigger prompt: "' + triggers[toolName] + '"');
          if (tool) {
            Logger.log('  Description: ' + tool.description.substring(0, 60) + '...');
          }
        });
        
        Logger.log('');
        Logger.log('NOTE: These prompts should trigger the respective tools when used with Claude.');
        Logger.log('=== END ===');

        // This test documents expected triggers for manual verification
        expect(Object.keys(triggers).length).to.equal(4);
      });
    });
  });

  module.exports = { 
    run: function() { return require('test-framework/mocha-adapter').executeAll(); }
  };
}

__defineModule__(_main);