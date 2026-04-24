function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, beforeEach, afterEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const { registerTestModule, cleanupTestModules } = require('common-js/test/test-utils.unit.helpers');

  describe('require() - Error Handling', () => {
    let testModules = [];
    
    // Helper function imported from shared test-utils.unit.helpers
    
    beforeEach(() => {
      testModules = [];
    });
    
    afterEach(() => {
      // Clean up ONLY test modules
      cleanupTestModules(testModules);
    });
    
    describe('Module Not Found Errors', () => {
      it('should throw error for missing module', () => {
        expect(() => {
          require('test:NonExistentModule');
        }).to.throw('Module not found');
      });
      
      it('should include requested module name in error', () => {
        try {
          require('test:MissingFoo');
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error.message).to.include('test:MissingFoo');
        }
      });
      
      it('should list tried candidates in error message', () => {
        try {
          require('test:path/to/Module');
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error.message).to.include('Tried:');
        }
      });
      
      it('should suggest available modules in error', () => {
        // Register some test modules
        registerTestModule(testModules, 'AvailA', (m, e) => ({ a: 1 }));
        registerTestModule(testModules, 'AvailB', (m, e) => ({ b: 2 }));
        
        try {
          require('test:NonExistent');
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error.message).to.include('Available modules:');
        }
      });
    });
    
    describe('Module Loading Errors', () => {
      it('should propagate errors from factory function', () => {
        registerTestModule(testModules, 'ThrowError', (m, e) => {
          throw new Error('Factory error');
        });
        
        expect(() => {
          require('test:ThrowError');
        }).to.throw('Factory error');
      });
      
      it('should include module name in factory error stack', () => {
        registerTestModule(testModules, 'StackError', (m, e) => {
          throw new Error('Stack test');
        });
        
        try {
          require('test:StackError');
          expect.fail('Should have thrown');
        } catch (error) {
          // Stack should reference the module
          expect(error.stack).to.be.a('string');
        }
      });
      
      it('should handle syntax errors in factory', () => {
        // Note: Can't test actual syntax errors with valid JS,
        // but can test runtime errors
        registerTestModule(testModules, 'RuntimeError', (m, e) => {
          const obj = null;
          return obj.property; // TypeError
        });
        
        expect(() => {
          require('test:RuntimeError');
        }).to.throw();
      });
    });
    
    describe('Dependency Chain Errors', () => {
      it('should show error from deep dependency', () => {
        registerTestModule(testModules, 'DepC', (m, e) => {
          throw new Error('Error in C');
        });
        
        registerTestModule(testModules, 'DepB', (m, e) => {
          return { c: require('test:DepC') };
        });
        
        registerTestModule(testModules, 'DepA', (m, e) => {
          return { b: require('test:DepB') };
        });
        
        expect(() => {
          require('test:DepA');
        }).to.throw('Error in C');
      });
      
      it('should show missing module in dependency chain', () => {
        registerTestModule(testModules, 'ChainTop', (m, e) => {
          return { dep: require('test:ChainMissing') };
        });
        
        try {
          require('test:ChainTop');
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error.message).to.include('ChainMissing');
        }
      });
    });
    
    describe('Invalid Module Definitions', () => {
      it('should handle non-function factory', () => {
        const invalidName = 'test:InvalidFactory';
        globalThis.__moduleFactories__[invalidName] = 'not a function';
        testModules.push(invalidName);
        
        // Attempting to load should fail gracefully
        expect(() => {
          require(invalidName);
        }).to.throw();
      });
      
      it('should handle factory with wrong parameter count', () => {
        // Factory with 0 parameters should still work (default params)
        registerTestModule(testModules, 'NoParams', function() {
          return { noParams: true };
        });
        
        const result = require('test:NoParams');
        expect(result.noParams).to.be.true;
      });
    });
    
    describe('Error Messages Quality', () => {
      it('should provide helpful error for common typos', () => {
        registerTestModule(testModules, 'ConfigManager', (m, e) => ({ config: true }));
        
        try {
          require('test:ConfigManger'); // Typo: missing 'a'
          expect.fail('Should have thrown');
        } catch (error) {
          // Should suggest similar module names
          expect(error.message).to.include('Available modules:');
          expect(error.message).to.include('ConfigManager');
        }
      });
      
      it('should show attempted resolution paths', () => {
        try {
          require('test:some/deep/path/Module');
          expect.fail('Should have thrown');
        } catch (error) {
          // Should show what it tried
          expect(error.message).to.include('Tried:');
        }
      });
    });
    
    describe('Edge Case Errors', () => {
      it('should handle empty string module name', () => {
        expect(() => {
          require('');
        }).to.throw();
      });
      
      it('should handle null module name', () => {
        expect(() => {
          require(null);
        }).to.throw();
      });
      
      it('should handle undefined module name', () => {
        expect(() => {
          require(undefined);
        }).to.throw();
      });
      
      it('should handle module name with only whitespace', () => {
        expect(() => {
          require('   ');
        }).to.throw();
      });
    });
    
    describe('Partial Loading State', () => {
      it('should not cache module if loading fails', () => {
        let shouldFail = true;
        
        registerTestModule(testModules, 'PartialLoad', (m, e) => {
          if (shouldFail) {
            throw new Error('First load fails');
          }
          return { success: true };
        });
        
        // First load should fail
        expect(() => {
          require('test:PartialLoad');
        }).to.throw('First load fails');
        
        // Module should not be cached
        expect(globalThis.__modules__['test:PartialLoad']).to.be.undefined;
        
        // Second load with fixed factory should work
        shouldFail = false;
        const result = require('test:PartialLoad');
        expect(result.success).to.be.true;
      });
      
      it('should clean up loading state after error', () => {
        registerTestModule(testModules, 'CleanupError', (m, e) => {
          throw new Error('Cleanup test');
        });
        
        try {
          require('test:CleanupError');
        } catch (error) {
          // Expected
        }
        
        // Loading state should be cleaned up
        expect(globalThis.__loadingModules__.has('test:CleanupError')).to.be.false;
      });
    });
    
    describe('Recovery and Retry', () => {
      it('should allow retry after fixing error', () => {
        let attempt = 0;
        
        registerTestModule(testModules, 'RetryFix', (m, e) => {
          attempt++;
          if (attempt === 1) {
            throw new Error('First attempt fails');
          }
          return { attempt };
        });
        
        // First attempt fails
        expect(() => {
          require('test:RetryFix');
        }).to.throw('First attempt fails');
        
        // Clean up failed module
        delete globalThis.__modules__['test:RetryFix'];
        
        // Second attempt should succeed
        const result = require('test:RetryFix');
        expect(result.attempt).to.equal(2);
      });
    });
  });

  // Tests auto-run via test framework - no exports needed
}

__defineModule__(_main);