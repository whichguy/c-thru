function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, beforeEach, afterEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('require() - Integration Tests', () => {
    let testModules = [];

    /**
     * Register a test module programmatically
     * @param {string} name - Module name (without test: prefix)
     * @param {Function} factory - Module factory function
     * @param {boolean} loadNow - Whether to load immediately
     * @returns {string} Full module name
     */
    function registerTestModule(name, factory, loadNow = false) {
      const fullName = `test:integration:${name}`;
      globalThis.__moduleFactories__[fullName] = factory;
      testModules.push(fullName);

      if (loadNow) {
        require(fullName);
      }

      return fullName;
    }

    beforeEach(() => {
      testModules = [];
    });

    afterEach(() => {
      // Clean up test modules
      testModules.forEach(name => {
        delete globalThis.__modules__[name];
        delete globalThis.__moduleFactories__[name];
        globalThis.__loadingModules__.delete(name);
      });
      testModules = [];
    });

    describe('Real Module Loading', () => {
      it('should load test-framework mocha-adapter', () => {
        const mochaAdapter = require('test-framework/mocha-adapter');

        expect(mochaAdapter).to.be.an('object');
        expect(mochaAdapter.describe).to.be.a('function');
        expect(mochaAdapter.it).to.be.a('function');
        expect(mochaAdapter.beforeEach).to.be.a('function');
        expect(mochaAdapter.afterEach).to.be.a('function');
      });

      it('should load test-framework chai-assertions', () => {
        const chaiAssertions = require('test-framework/chai-assertions');

        expect(chaiAssertions).to.be.an('object');
        expect(chaiAssertions.expect).to.be.a('function');
      });

      it('should cache real modules on multiple requires', () => {
        const first = require('test-framework/mocha-adapter');
        const second = require('test-framework/mocha-adapter');

        expect(first).to.equal(second);
      });

      it('should handle test-framework modules as dependencies', () => {
        // Create a test module that depends on test framework
        const name = registerTestModule('WithTestDeps', (m, e) => {
          const mocha = require('test-framework/mocha-adapter');
          const chai = require('test-framework/chai-assertions');

          return {
            hasMocha: typeof mocha.describe === 'function',
            hasChai: typeof chai.expect === 'function'
          };
        });

        const result = require(name);

        expect(result.hasMocha).to.be.true;
        expect(result.hasChai).to.be.true;
      });
    });

    describe('Module Loading Chains', () => {
      it('should load A → B → C chain', () => {
        // Register modules in reverse order to test resolution
        registerTestModule('ChainC', (m, e) => {
          return { name: 'C', value: 3 };
        });

        registerTestModule('ChainB', (m, e) => {
          const c = require('test:integration:ChainC');
          return { name: 'B', value: 2, c };
        });

        registerTestModule('ChainA', (m, e) => {
          const b = require('test:integration:ChainB');
          return { name: 'A', value: 1, b };
        });

        const a = require('test:integration:ChainA');

        expect(a.name).to.equal('A');
        expect(a.value).to.equal(1);
        expect(a.b.name).to.equal('B');
        expect(a.b.value).to.equal(2);
        expect(a.b.c.name).to.equal('C');
        expect(a.b.c.value).to.equal(3);
      });

      it('should handle diamond dependency (A → B,C → D)', () => {
        // D is shared dependency
        registerTestModule('DiamondD', (m, e) => {
          return { name: 'D', shared: true };
        });

        // B depends on D
        registerTestModule('DiamondB', (m, e) => {
          const d = require('test:integration:DiamondD');
          return { name: 'B', d };
        });

        // C depends on D
        registerTestModule('DiamondC', (m, e) => {
          const d = require('test:integration:DiamondD');
          return { name: 'C', d };
        });

        // A depends on B and C
        registerTestModule('DiamondA', (m, e) => {
          const b = require('test:integration:DiamondB');
          const c = require('test:integration:DiamondC');
          return { name: 'A', b, c };
        });

        const a = require('test:integration:DiamondA');

        expect(a.name).to.equal('A');
        expect(a.b.name).to.equal('B');
        expect(a.c.name).to.equal('C');

        // D should be same instance in both paths
        expect(a.b.d).to.equal(a.c.d);
        expect(a.b.d.shared).to.be.true;
      });

      it('should handle multiple independent chains', () => {
        // Chain 1: X → Y
        registerTestModule('ChainY', (m, e) => ({ chain: 1, name: 'Y' }));
        registerTestModule('ChainX', (m, e) => {
          const y = require('test:integration:ChainY');
          return { chain: 1, name: 'X', y };
        });

        // Chain 2: P → Q
        registerTestModule('ChainQ', (m, e) => ({ chain: 2, name: 'Q' }));
        registerTestModule('ChainP', (m, e) => {
          const q = require('test:integration:ChainQ');
          return { chain: 2, name: 'P', q };
        });

        const x = require('test:integration:ChainX');
        const p = require('test:integration:ChainP');

        expect(x.chain).to.equal(1);
        expect(x.y.chain).to.equal(1);
        expect(p.chain).to.equal(2);
        expect(p.q.chain).to.equal(2);

        // Chains should be independent
        expect(x).to.not.equal(p);
      });
    });

    describe('Module Resolution Integration', () => {
      it('should resolve with different path formats', () => {
        registerTestModule('PathTest', (m, e) => ({ resolved: true }));

        // Try different path formats
        const direct = require('test:integration:PathTest');
        const withJs = require('test:integration:PathTest.js');
        const relative = require('./test:integration:PathTest');

        // All should resolve to same module
        expect(direct).to.equal(withJs);
        expect(direct).to.equal(relative);
        expect(direct.resolved).to.be.true;
      });

      it('should handle path normalization in chains', () => {
        registerTestModule('NormBase', (m, e) => ({ base: true }));

        registerTestModule('NormMid', (m, e) => {
          // Use different path format
          const base = require('./test:integration:NormBase.js');
          return { mid: true, base };
        });

        registerTestModule('NormTop', (m, e) => {
          // Use yet another format
          const mid = require('test:integration:NormMid');
          const base = require('test:integration:NormBase'); // Direct
          return { top: true, mid, base };
        });

        const result = require('test:integration:NormTop');

        // Base should be same instance regardless of path format
        expect(result.base).to.equal(result.mid.base);
        expect(result.base.base).to.be.true;
      });
    });

    describe('Export Pattern Integration', () => {
      it('should support mixed export patterns in chain', () => {
        // Module using module.exports
        registerTestModule('ExportA', (m, e) => {
          m.exports = { type: 'module.exports', value: 'A' };
        });

        // Module using return
        registerTestModule('ExportB', (m, e) => {
          const a = require('test:integration:ExportA');
          return { type: 'return', value: 'B', a };
        });

        // Module using exports properties
        registerTestModule('ExportC', (m, e) => {
          const b = require('test:integration:ExportB');
          e.type = 'exports properties';
          e.value = 'C';
          e.b = b;
        });

        const c = require('test:integration:ExportC');

        expect(c.type).to.equal('exports properties');
        expect(c.b.type).to.equal('return');
        expect(c.b.a.type).to.equal('module.exports');
      });

      it('should handle __events__ registration in dependency chain', () => {
        // Base module with events
        registerTestModule('EventBase', (m, e) => {
          function onTest() { return 'base-event'; }

          m.exports = {
            onTest,
            __events__: { onTest: 'onTest' }
          };
        });

        // Consumer module
        registerTestModule('EventConsumer', (m, e) => {
          const base = require('test:integration:EventBase');
          return {
            hasEventHandler: typeof base.__events__ === 'object',
            canCallHandler: typeof base.onTest === 'function',
            result: base.onTest()
          };
        });

        const consumer = require('test:integration:EventConsumer');

        expect(consumer.hasEventHandler).to.be.true;
        expect(consumer.canCallHandler).to.be.true;
        expect(consumer.result).to.equal('base-event');
      });

      it('should handle __global__ registration in dependency chain', () => {
        // Base module with globals
        registerTestModule('GlobalBase', (m, e) => {
          function globalFunction() { return 'global-fn'; }

          m.exports = {
            localFunction: () => 'local-fn',
            __global__: { globalFunction }
          };
        });

        // Consumer module
        registerTestModule('GlobalConsumer', (m, e) => {
          const base = require('test:integration:GlobalBase');
          return {
            hasGlobal: typeof base.__global__ === 'object',
            hasLocal: typeof base.localFunction === 'function',
            localResult: base.localFunction(),
            globalExists: typeof base.__global__.globalFunction === 'function'
          };
        });

        const consumer = require('test:integration:GlobalConsumer');

        expect(consumer.hasGlobal).to.be.true;
        expect(consumer.hasLocal).to.be.true;
        expect(consumer.localResult).to.equal('local-fn');
        expect(consumer.globalExists).to.be.true;
      });
    });

    describe('Error Handling Integration', () => {
      it('should propagate errors through chain', () => {
        registerTestModule('ErrorLeaf', (m, e) => {
          throw new Error('Leaf error');
        });

        registerTestModule('ErrorMid', (m, e) => {
          const leaf = require('test:integration:ErrorLeaf');
          return { mid: true, leaf };
        });

        registerTestModule('ErrorRoot', (m, e) => {
          const mid = require('test:integration:ErrorMid');
          return { root: true, mid };
        });

        expect(() => {
          require('test:integration:ErrorRoot');
        }).to.throw('Leaf error');

        // None of the modules should be cached due to error
        expect(globalThis.__modules__['test:integration:ErrorLeaf']).to.be.undefined;
        expect(globalThis.__modules__['test:integration:ErrorMid']).to.be.undefined;
        expect(globalThis.__modules__['test:integration:ErrorRoot']).to.be.undefined;
      });

      it('should handle missing dependency in chain', () => {
        registerTestModule('MissingDepConsumer', (m, e) => {
          const missing = require('test:integration:DoesNotExist');
          return { value: missing };
        });

        expect(() => {
          require('test:integration:MissingDepConsumer');
        }).to.throw('Module not found');
      });

      it('should recover from partial chain failure', () => {
        let shouldFail = true;

        registerTestModule('RecoverMiddle', (m, e) => {
          if (shouldFail) {
            throw new Error('Middle fails first time');
          }
          return { recovered: true };
        });

        registerTestModule('RecoverTop', (m, e) => {
          const mid = require('test:integration:RecoverMiddle');
          return { top: true, mid };
        });

        // First attempt fails
        expect(() => {
          require('test:integration:RecoverTop');
        }).to.throw('Middle fails first time');

        // Fix the issue
        shouldFail = false;

        // Second attempt succeeds
        const result = require('test:integration:RecoverTop');
        expect(result.top).to.be.true;
        expect(result.mid.recovered).to.be.true;
      });
    });

    describe('Circular Dependency Integration', () => {
      it('should detect circular dependency in real chain', () => {
        registerTestModule('CircRealA', (m, e) => {
          const b = require('test:integration:CircRealB');
          return { name: 'A', b };
        });

        registerTestModule('CircRealB', (m, e) => {
          const c = require('test:integration:CircRealC');
          return { name: 'B', c };
        });

        registerTestModule('CircRealC', (m, e) => {
          const a = require('test:integration:CircRealA');
          return { name: 'C', a };
        });

        expect(() => {
          require('test:integration:CircRealA');
        }).to.throw('Circular dependency');

        // Loading state should be cleaned up
        expect(globalThis.__loadingModules__.has('test:integration:CircRealA')).to.be.false;
        expect(globalThis.__loadingModules__.has('test:integration:CircRealB')).to.be.false;
        expect(globalThis.__loadingModules__.has('test:integration:CircRealC')).to.be.false;
      });

      it('should detect circular dependency with deep chain', () => {
        // A → B → C → D → E → B (circular)
        registerTestModule('DeepCircA', (m, e) => {
          return { name: 'A', b: require('test:integration:DeepCircB') };
        });

        registerTestModule('DeepCircB', (m, e) => {
          return { name: 'B', c: require('test:integration:DeepCircC') };
        });

        registerTestModule('DeepCircC', (m, e) => {
          return { name: 'C', d: require('test:integration:DeepCircD') };
        });

        registerTestModule('DeepCircD', (m, e) => {
          return { name: 'D', e: require('test:integration:DeepCircE') };
        });

        registerTestModule('DeepCircE', (m, e) => {
          return { name: 'E', b: require('test:integration:DeepCircB') }; // Back to B
        });

        expect(() => {
          require('test:integration:DeepCircA');
        }).to.throw('Circular dependency');
      });
    });

    describe('Module Cache Integration', () => {
      it('should share cached modules across independent chains', () => {
        // Shared dependency
        let loadCount = 0;
        registerTestModule('SharedDep', (m, e) => {
          loadCount++;
          return { loadCount, shared: true };
        });

        // Chain 1
        registerTestModule('Chain1A', (m, e) => {
          return { chain: 1, dep: require('test:integration:SharedDep') };
        });

        // Chain 2
        registerTestModule('Chain2A', (m, e) => {
          return { chain: 2, dep: require('test:integration:SharedDep') };
        });

        const result1 = require('test:integration:Chain1A');
        const result2 = require('test:integration:Chain2A');

        // SharedDep should only load once
        expect(loadCount).to.equal(1);

        // Both chains should have same SharedDep instance
        expect(result1.dep).to.equal(result2.dep);
        expect(result1.dep.loadCount).to.equal(1);
      });
    });
  });

  // Export for test runner
  module.exports = {
    runTests: () => {
      console.log('Integration tests for require() module system');
    }
  };
}

__defineModule__(_main);