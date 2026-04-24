function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, beforeEach, afterEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const { registerTestModule, cleanupTestModules } = require('common-js/test/test-utils.unit.helpers');

  describe('require() - Module Loading', () => {
    let testModules = [];
    
    // Helper function imported from shared test-utils.unit.helpers
    
    beforeEach(() => {
      testModules = [];
    });
    
    afterEach(() => {
      // Clean up ONLY test modules (test: prefix)
      cleanupTestModules(testModules);
    });
    
    describe('Module Registration', () => {
      it('should register module factory', () => {
        const name = registerTestModule(testModules, 'BasicReg', (m, e) => ({ value: 42 }));
        
        expect(globalThis.__moduleFactories__[name]).to.be.a('function');
      });
      
      it('should not load module immediately with loadNow=false', () => {
        const name = registerTestModule(testModules, 'LazyReg', (m, e) => ({ value: 42 }));
        
        expect(globalThis.__modules__[name]).to.be.undefined;
      });
      
      it('should load module immediately with loadNow=true', () => {
        const name = registerTestModule(testModules, 'EagerReg', (m, e) => ({ value: 42 }), { loadNow: true });
        
        expect(globalThis.__modules__[name]).to.not.be.undefined;
        expect(globalThis.__modules__[name].exports.value).to.equal(42);
      });
    });
    
    describe('Module Loading', () => {
      it('should load registered module on require()', () => {
        const name = registerTestModule(testModules, 'BasicLoad', (m, e) => ({ value: 99 }));
        
        const result = require(name);
        
        expect(result).to.be.an('object');
        expect(result.value).to.equal(99);
      });
      
      it('should execute factory function during load', () => {
        let executed = false;
        const name = registerTestModule(testModules, 'FactoryExec', (m, e) => {
          executed = true;
          return { loaded: true };
        });
        
        expect(executed).to.be.false;
        require(name);
        expect(executed).to.be.true;
      });
      
      it('should make module available in __modules__ after load', () => {
        const name = registerTestModule(testModules, 'ModuleAvail', (m, e) => ({ value: 123 }));
        
        require(name);
        
        expect(globalThis.__modules__[name]).to.exist;
        expect(globalThis.__modules__[name].exports.value).to.equal(123);
      });
    });
    
    describe('Module Caching', () => {
      it('should return same exports on multiple requires', () => {
        const name = registerTestModule(testModules, 'CacheTest', (m, e) => ({ value: 55 }));
        
        const first = require(name);
        const second = require(name);
        
        expect(first).to.equal(second); // Same reference
      });
      
      it('should execute factory only once', () => {
        let executeCount = 0;
        const name = registerTestModule(testModules, 'FactoryOnce', (m, e) => {
          executeCount++;
          return { count: executeCount };
        });
        
        require(name);
        require(name);
        require(name);
        
        expect(executeCount).to.equal(1);
      });
      
      it('should preserve module state across requires', () => {
        const name = registerTestModule(testModules, 'StatePreserve', (m, e) => {
          let counter = 0;
          return {
            increment: () => ++counter,
            getCount: () => counter
          };
        });
        
        const first = require(name);
        first.increment();
        first.increment();
        
        const second = require(name);
        expect(second.getCount()).to.equal(2);
      });
    });
    
    describe('loadNow Parameter', () => {
      it('should defer execution with loadNow=false', () => {
        let executed = false;
        
        const factory = (m, e) => {
          executed = true;
          return { value: 1 };
        };
        
        const name = 'test:DeferTest';
        globalThis.__moduleFactories__[name] = factory;
        testModules.push(name);
        
        // __defineModule__ equivalent with loadNow=false
        expect(executed).to.be.false;
        
        require(name);
        expect(executed).to.be.true;
      });
      
      it('should execute immediately with loadNow=true', () => {
        let executed = false;
        
        const factory = (m, e) => {
          executed = true;
          return { value: 2 };
        };
        
        const name = 'test:ImmediateTest';
        globalThis.__moduleFactories__[name] = factory;
        testModules.push(name);
        
        // Simulate loadNow=true
        require(name);
        expect(executed).to.be.true;
      });
    });
  });

  // Tests auto-run via test framework - no exports needed
}

__defineModule__(_main);