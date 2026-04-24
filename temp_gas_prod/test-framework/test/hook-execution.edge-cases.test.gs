function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Comprehensive tests for hook execution edge cases
   */

  const { describe, it, beforeEach, afterEach, executeAll, resetContext, formatResults, getSummary } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  /**
   * Test suite for verifying hook execution behavior
   */
  function testHookExecutionEdgeCases() {
    resetContext();
    
    describe('Hook Execution Edge Cases', function() {
      
      describe('Edge Case 1: Test passes, afterEach passes', function() {
        let hookExecuted = false;
        
        afterEach(function() {
          hookExecuted = true;
        });
        
        it('should pass and execute afterEach successfully', function() {
          expect(1).to.equal(1);
        });
        
        it('should have executed afterEach hook', function() {
          expect(hookExecuted).to.be.true;
        });
      });
      
      describe('Edge Case 2: Test fails, afterEach passes', function() {
        let hookExecuted = false;
        
        afterEach(function() {
          hookExecuted = true;
        });
        
        it('should fail but still execute afterEach', function() {
          expect(1).to.equal(2); // This will fail
        });
        
        it('should have executed afterEach despite test failure', function() {
          expect(hookExecuted).to.be.true;
        });
      });
      
      describe('Edge Case 3: Test passes, afterEach fails', function() {
        it('should mark test as failed when afterEach fails', function() {
          expect(1).to.equal(1); // Test passes
        });
        
        afterEach(function() {
          throw new Error('afterEach intentional failure');
        });
      });
      
      describe('Edge Case 4: Test fails, afterEach fails', function() {
        let testError;
        let hookError;
        
        it('should preserve test error when both fail', function() {
          testError = new Error('Test intentional failure');
          throw testError;
        });
        
        afterEach(function() {
          hookError = new Error('afterEach intentional failure');
          throw hookError;
        });
      });
      
      describe('Edge Case 5: Multiple afterEach hooks', function() {
        const executionOrder = [];
        
        afterEach(function() {
          executionOrder.push('hook1');
        });
        
        afterEach(function() {
          executionOrder.push('hook2');
        });
        
        it('should execute all afterEach hooks in order', function() {
          expect(1).to.equal(1);
        });
        
        it('should verify execution order', function() {
          expect(executionOrder).to.deep.equal(['hook1', 'hook2']);
        });
      });
      
      describe('Edge Case 6: First afterEach fails, second succeeds', function() {
        let secondHookExecuted = false;
        
        afterEach(function() {
          throw new Error('First afterEach fails');
        });
        
        afterEach(function() {
          secondHookExecuted = true;
        });
        
        it('should still execute remaining hooks after first fails', function() {
          expect(1).to.equal(1);
        });
      });
      
      describe('Edge Case 7: Nested suites with inherited hooks', function() {
        let parentHookExecuted = false;
        let childHookExecuted = false;
        
        afterEach(function() {
          parentHookExecuted = true;
        });
        
        describe('Child suite', function() {
          afterEach(function() {
            childHookExecuted = true;
          });
          
          it('should execute both parent and child hooks', function() {
            expect(1).to.equal(1);
          });
          
          it('should verify both hooks executed', function() {
            expect(parentHookExecuted).to.be.true;
            expect(childHookExecuted).to.be.true;
          });
        });
      });
      
      describe('Edge Case 8: BeforeEach fails', function() {
        let afterEachExecuted = false;
        
        beforeEach(function() {
          throw new Error('beforeEach intentional failure');
        });
        
        afterEach(function() {
          afterEachExecuted = true;
        });
        
        it('should not execute test but should execute afterEach', function() {
          // This test should never execute
          expect(false).to.be.true;
        });
      });
    });
    
    // Execute all tests
    const results = executeAll();
    const summary = getSummary(results);
    
    return {
      results: results,
      summary: summary,
      formatted: formatResults(results)
    };
  }

  module.exports = {
    testHookExecutionEdgeCases
  };
}

__defineModule__(_main);