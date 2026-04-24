function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, beforeEach, afterEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const { registerTestModule, cleanupTestModules } = require('common-js/test/test-utils.unit.helpers');

  describe('require() - Export Patterns', () => {
    let testModules = [];
    
    // Helper function imported from shared test-utils.unit.helpers
    
    beforeEach(() => {
      testModules = [];
    });
    
    afterEach(() => {
      // Clean up ONLY test modules
      cleanupTestModules(testModules);
    });
    
    describe('Return Value Exports', () => {
      it('should use return value as exports', () => {
        const name = registerTestModule(testModules, 'ReturnValue', (m, e) => {
          return { value: 42, method: () => 'hello' };
        });
        
        const result = require(name);
        
        expect(result.value).to.equal(42);
        expect(result.method()).to.equal('hello');
      });
      
      it('should override initial exports with return value', () => {
        const name = registerTestModule(testModules, 'ReturnOverride', (m, e) => {
          m.exports = { initial: true };
          return { final: true };
        });
        
        const result = require(name);
        
        expect(result.final).to.be.true;
        expect(result.initial).to.be.undefined;
      });
    });
    
    describe('module.exports Assignment', () => {
      it('should use module.exports when no return value', () => {
        const name = registerTestModule(testModules, 'ModuleExports', (m, e) => {
          m.exports = { assigned: true };
        });
        
        const result = require(name);
        
        expect(result.assigned).to.be.true;
      });
      
      it('should support object assignment to module.exports', () => {
        const name = registerTestModule(testModules, 'ObjectExport', (m, e) => {
          m.exports = {
            prop1: 'value1',
            prop2: 123,
            method: () => 'result'
          };
        });
        
        const result = require(name);
        
        expect(result.prop1).to.equal('value1');
        expect(result.prop2).to.equal(123);
        expect(result.method()).to.equal('result');
      });
      
      it('should support property assignment to exports', () => {
        const name = registerTestModule(testModules, 'PropertyExport', (m, e) => {
          e.func1 = () => 'one';
          e.func2 = () => 'two';
          e.value = 99;
        });
        
        const result = require(name);
        
        expect(result.func1()).to.equal('one');
        expect(result.func2()).to.equal('two');
        expect(result.value).to.equal(99);
      });
    });
    
    describe('Empty and Null Exports', () => {
      it('should handle empty exports object', () => {
        const name = registerTestModule(testModules, 'EmptyExports', (m, e) => {
          // Do nothing - exports remains empty
        });
        
        const result = require(name);
        
        expect(result).to.be.an('object');
        expect(Object.keys(result)).to.have.lengthOf(0);
      });
      
      it('should handle null return value', () => {
        const name = registerTestModule(testModules, 'NullReturn', (m, e) => {
          m.exports = { initial: true };
          return null;
        });
        
        const result = require(name);
        
        // null return means use module.exports
        expect(result.initial).to.be.true;
      });
      
      it('should handle undefined return value', () => {
        const name = registerTestModule(testModules, 'UndefinedReturn', (m, e) => {
          m.exports = { value: 123 };
          return undefined;
        });
        
        const result = require(name);
        
        // undefined return means use module.exports
        expect(result.value).to.equal(123);
      });
    });
    
    describe('Factory Signatures', () => {
      it('should support 2-parameter factory (module, exports)', () => {
        const name = registerTestModule(testModules, 'TwoParam', function(module, exports) {
          expect(arguments.length).to.be.at.least(2);
          return { twoParam: true };
        });
        
        const result = require(name);
        
        expect(result.twoParam).to.be.true;
      });
      
      it('should support 3-parameter factory (module, exports, log)', () => {
        const name = registerTestModule(testModules, 'ThreeParam', function(module, exports, log) {
          expect(arguments.length).to.be.at.least(3);
          expect(log).to.be.a('function');
          return { threeParam: true };
        });
        
        const result = require(name);
        
        expect(result.threeParam).to.be.true;
      });
      
      it('should provide log function to 3-parameter factory', () => {
        let logProvided = false;
        
        const name = registerTestModule(testModules, 'LogTest', function(module, exports, log) {
          logProvided = typeof log === 'function';
          return { logProvided };
        });
        
        const result = require(name);
        
        expect(result.logProvided).to.be.true;
      });
      
      it('should handle factory with default parameters', () => {
        const name = registerTestModule(testModules, 'DefaultParams', function(
          module = {}, 
          exports = {},
          log = () => {}
        ) {
          // Default parameters should be overridden by actual params
          return { hasDefaults: true };
        });
        
        const result = require(name);
        
        expect(result.hasDefaults).to.be.true;
      });
    });
    
    describe('Export Patterns', () => {
      it('should support function export', () => {
        const name = registerTestModule(testModules, 'FunctionExport', (m, e) => {
          const myFunc = (x) => x * 2;
          return myFunc;
        });
        
        const result = require(name);
        
        expect(result).to.be.a('function');
        expect(result(5)).to.equal(10);
      });
      
      it('should support class export', () => {
        const name = registerTestModule(testModules, 'ClassExport', (m, e) => {
          class MyClass {
            constructor(value) {
              this.value = value;
            }
            getValue() {
              return this.value;
            }
          }
          return MyClass;
        });
        
        const MyClass = require(name);
        const instance = new MyClass(42);
        
        expect(instance.getValue()).to.equal(42);
      });
      
      it('should support mixed exports (functions and values)', () => {
        const name = registerTestModule(testModules, 'MixedExport', (m, e) => {
          return {
            constant: 100,
            add: (a, b) => a + b,
            multiply: (a, b) => a * b
          };
        });
        
        const result = require(name);
        
        expect(result.constant).to.equal(100);
        expect(result.add(2, 3)).to.equal(5);
        expect(result.multiply(4, 5)).to.equal(20);
      });
    });
    
    describe('Module and Exports References', () => {
      it('should provide module object to factory', () => {
        let moduleRef = null;
        
        const name = registerTestModule(testModules, 'ModuleRef', (m, e) => {
          moduleRef = m;
          return { value: 1 };
        });
        
        require(name);
        
        expect(moduleRef).to.be.an('object');
        expect(moduleRef.exports).to.exist;
      });
      
      it('should provide exports object as second parameter', () => {
        let exportsRef = null;
        
        const name = registerTestModule(testModules, 'ExportsRef', (m, e) => {
          exportsRef = e;
          e.value = 42;
        });
        
        require(name);
        
        expect(exportsRef).to.be.an('object');
        expect(exportsRef.value).to.equal(42);
      });
      
      it('should sync module.exports and exports parameter', () => {
        const name = registerTestModule(testModules, 'ExportsSync', (m, e) => {
          e.prop1 = 'one';
          m.exports.prop2 = 'two';
          // Both should be on the same object
        });
        
        const result = require(name);
        
        expect(result.prop1).to.equal('one');
        expect(result.prop2).to.equal('two');
      });
    });
  });

  // Tests auto-run via test framework - no exports needed
}

__defineModule__(_main);