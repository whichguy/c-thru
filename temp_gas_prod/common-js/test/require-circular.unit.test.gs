function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, beforeEach, afterEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const { registerTestModule, cleanupTestModules } = require('common-js/test/test-utils.unit.helpers');

  describe('require() - Circular Dependencies', () => {
    let testModules = [];
    
    // Helper function imported from shared test-utils.unit.helpers
    
    beforeEach(() => {
      testModules = [];
    });
    
    afterEach(() => {
      // Clean up ONLY test modules
      cleanupTestModules(testModules);
    });
    
    describe('Simple Circular Dependencies', () => {
      it('should detect A → B → A circular dependency', () => {
        // Module A requires B
        registerTestModule(testModules, 'CircA', (m, e) => {
          const b = require('test:CircB');
          return { name: 'A', b };
        });
        
        // Module B requires A (circular!)
        registerTestModule(testModules, 'CircB', (m, e) => {
          const a = require('test:CircA');
          return { name: 'B', a };
        });
        
        // Attempt to load A should throw
        expect(() => {
          require('test:CircA');
        }).to.throw('Circular dependency');
      });
      
      it('should include module name in error message', () => {
        registerTestModule(testModules, 'CircX', (m, e) => {
          require('test:CircY');
        });
        
        registerTestModule(testModules, 'CircY', (m, e) => {
          require('test:CircX');
        });
        
        try {
          require('test:CircX');
          expect.fail('Should have thrown circular dependency error');
        } catch (error) {
          expect(error.message).to.include('test:CircY');
        }
      });
    });
    
    describe('Self-Circular Dependencies', () => {
      it('should detect module requiring itself', () => {
        registerTestModule(testModules, 'SelfCirc', (m, e) => {
          const self = require('test:SelfCirc');
          return { self };
        });
        
        expect(() => {
          require('test:SelfCirc');
        }).to.throw('Circular dependency');
      });
      
      it('should provide module name in self-circular error', () => {
        registerTestModule(testModules, 'SelfRef', (m, e) => {
          require('test:SelfRef');
        });
        
        try {
          require('test:SelfRef');
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error.message).to.include('test:SelfRef');
        }
      });
    });
    
    describe('Nested Circular Dependencies', () => {
      it('should detect A → B → C �� A circular dependency', () => {
        registerTestModule(testModules, 'ChainA', (m, e) => {
          const b = require('test:ChainB');
          return { name: 'A', chain: b };
        });
        
        registerTestModule(testModules, 'ChainB', (m, e) => {
          const c = require('test:ChainC');
          return { name: 'B', chain: c };
        });
        
        registerTestModule(testModules, 'ChainC', (m, e) => {
          const a = require('test:ChainA'); // Circular!
          return { name: 'C', chain: a };
        });
        
        expect(() => {
          require('test:ChainA');
        }).to.throw('Circular dependency');
      });
      
      it('should detect circular in deep dependency chain', () => {
        registerTestModule(testModules, 'Deep1', (m, e) => {
          return { next: require('test:Deep2') };
        });
        
        registerTestModule(testModules, 'Deep2', (m, e) => {
          return { next: require('test:Deep3') };
        });
        
        registerTestModule(testModules, 'Deep3', (m, e) => {
          return { next: require('test:Deep4') };
        });
        
        registerTestModule(testModules, 'Deep4', (m, e) => {
          return { next: require('test:Deep1') }; // Back to start
        });
        
        expect(() => {
          require('test:Deep1');
        }).to.throw('Circular dependency');
      });
    });
    
    describe('Loading State Management', () => {
      it('should track loading modules in __loadingModules__', () => {
        let loadingSetSnapshot = null;
        
        registerTestModule(testModules, 'TrackLoad', (m, e) => {
          loadingSetSnapshot = Array.from(globalThis.__loadingModules__);
          return { tracked: true };
        });
        
        require('test:TrackLoad');
        
        expect(loadingSetSnapshot).to.include('test:TrackLoad');
      });
      
      it('should clear loading state after successful load', () => {
        registerTestModule(testModules, 'ClearLoad', (m, e) => {
          return { cleared: true };
        });
        
        require('test:ClearLoad');
        
        expect(globalThis.__loadingModules__.has('test:ClearLoad')).to.be.false;
      });
      
      it('should clear loading state even after circular error', () => {
        registerTestModule(testModules, 'ErrCircA', (m, e) => {
          require('test:ErrCircB');
        });
        
        registerTestModule(testModules, 'ErrCircB', (m, e) => {
          require('test:ErrCircA');
        });
        
        try {
          require('test:ErrCircA');
        } catch (error) {
          // Error expected
        }
        
        // Loading state should be cleaned up
        expect(globalThis.__loadingModules__.has('test:ErrCircA')).to.be.false;
        expect(globalThis.__loadingModules__.has('test:ErrCircB')).to.be.false;
      });
    });
    
    describe('Valid Dependency Chains', () => {
      it('should allow linear dependency chain A → B → C', () => {
        registerTestModule(testModules, 'LinearC', (m, e) => {
          return { name: 'C', value: 3 };
        });
        
        registerTestModule(testModules, 'LinearB', (m, e) => {
          const c = require('test:LinearC');
          return { name: 'B', value: 2, c };
        });
        
        registerTestModule(testModules, 'LinearA', (m, e) => {
          const b = require('test:LinearB');
          return { name: 'A', value: 1, b };
        });
        
        const result = require('test:LinearA');
        
        expect(result.name).to.equal('A');
        expect(result.b.name).to.equal('B');
        expect(result.b.c.name).to.equal('C');
      });
      
      it('should allow shared dependency (A → C, B → C)', () => {
        registerTestModule(testModules, 'SharedC', (m, e) => {
          return { name: 'SharedC' };
        });
        
        registerTestModule(testModules, 'SharedA', (m, e) => {
          const c = require('test:SharedC');
          return { name: 'A', c };
        });
        
        registerTestModule(testModules, 'SharedB', (m, e) => {
          const c = require('test:SharedC');
          return { name: 'B', c };
        });
        
        const a = require('test:SharedA');
        const b = require('test:SharedB');
        
        // Both should get the same instance of C
        expect(a.c).to.equal(b.c);
      });
    });
    
    describe('Error Recovery', () => {
      it('should allow retry after circular error', () => {
        // First, set up circular dependency
        registerTestModule(testModules, 'RetryA', (m, e) => {
          require('test:RetryB');
        });
        
        registerTestModule(testModules, 'RetryB', (m, e) => {
          require('test:RetryA');
        });
        
        // First attempt should fail
        expect(() => {
          require('test:RetryA');
        }).to.throw('Circular dependency');
        
        // Clean up and redefine non-circular version
        delete globalThis.__modules__['test:RetryA'];
        delete globalThis.__modules__['test:RetryB'];
        delete globalThis.__moduleFactories__['test:RetryB'];
        
        // Redefine B without circular dependency
        registerTestModule('RetryB', (m, e) => {
          return { name: 'B', fixed: true };
        });
        
        // Now should succeed
        const result = require('test:RetryA');
        expect(result).to.exist;
      });
    });
  });

  // Tests auto-run via test framework - no exports needed
}

__defineModule__(_main);