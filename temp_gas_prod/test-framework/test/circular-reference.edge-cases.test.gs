function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Comprehensive tests for circular reference detection
   */

  const { describe, it, executeAll, resetContext, formatResults, getSummary } = require('test-framework/mocha-adapter');
  const { expect, deepEqual } = require('test-framework/chai-assertions');

  /**
   * Test suite for verifying circular reference handling
   */
  function testCircularReferenceEdgeCases() {
    resetContext();
    
    describe('Circular Reference Detection', function() {
      
      describe('Edge Case 1: Simple circular object reference', function() {
        it('should detect direct circular reference', function() {
          const obj1 = { name: 'obj1' };
          obj1.self = obj1;
          
          const obj2 = { name: 'obj1' };
          obj2.self = obj2;
          
          expect(obj1).to.deep.equal(obj2);
        });
        
        it('should reject non-matching circular reference', function() {
          const obj1 = { name: 'obj1' };
          obj1.self = obj1;
          
          const obj2 = { name: 'obj2' };
          obj2.self = obj2;
          
          expect(obj1).to.not.deep.equal(obj2);
        });
      });
      
      describe('Edge Case 2: Circular array reference', function() {
        it('should detect circular reference in array', function() {
          const arr1 = [1, 2, 3];
          arr1.push(arr1);
          
          const arr2 = [1, 2, 3];
          arr2.push(arr2);
          
          expect(arr1).to.deep.equal(arr2);
        });
      });
      
      describe('Edge Case 3: Nested circular reference', function() {
        it('should handle deeply nested circular structures', function() {
          const obj1 = {
            level1: {
              level2: {
                level3: {}
              }
            }
          };
          obj1.level1.level2.level3.root = obj1;
          
          const obj2 = {
            level1: {
              level2: {
                level3: {}
              }
            }
          };
          obj2.level1.level2.level3.root = obj2;
          
          expect(obj1).to.deep.equal(obj2);
        });
      });
      
      describe('Edge Case 4: Multiple circular references', function() {
        it('should handle multiple circular paths', function() {
          const obj1 = { name: 'root' };
          const child1 = { parent: obj1 };
          obj1.child = child1;
          obj1.self = obj1;
          
          const obj2 = { name: 'root' };
          const child2 = { parent: obj2 };
          obj2.child = child2;
          obj2.self = obj2;
          
          expect(obj1).to.deep.equal(obj2);
        });
      });
      
      describe('Edge Case 5: Cross-referencing objects', function() {
        it('should handle mutual references between objects', function() {
          const a1 = { name: 'a' };
          const b1 = { name: 'b' };
          a1.ref = b1;
          b1.ref = a1;
          
          const a2 = { name: 'a' };
          const b2 = { name: 'b' };
          a2.ref = b2;
          b2.ref = a2;
          
          expect(a1).to.deep.equal(a2);
        });
      });
      
      describe('Edge Case 6: WeakMap initialization', function() {
        it('should properly initialize WeakMap on first call', function() {
          const obj1 = { a: 1 };
          obj1.self = obj1;
          
          const obj2 = { a: 1 };
          obj2.self = obj2;
          
          // Call deepEqual directly without pre-initialized WeakMaps
          const result = deepEqual(obj1, obj2);
          expect(result).to.be.true;
        });
      });
      
      describe('Edge Case 7: Circular reference ID matching', function() {
        it('should correctly match circular references by ID', function() {
          const shared = { value: 'shared' };
          
          const obj1 = {
            first: shared,
            second: shared
          };
          
          const obj2 = {
            first: shared,
            second: shared
          };
          
          expect(obj1).to.deep.equal(obj2);
        });
      });
      
      describe('Edge Case 8: Mixed circular and non-circular', function() {
        it('should handle objects with both circular and normal properties', function() {
          const obj1 = {
            normal: 'value',
            array: [1, 2, 3],
            nested: { a: 1, b: 2 }
          };
          obj1.circular = obj1;
          
          const obj2 = {
            normal: 'value',
            array: [1, 2, 3],
            nested: { a: 1, b: 2 }
          };
          obj2.circular = obj2;
          
          expect(obj1).to.deep.equal(obj2);
        });
      });
      
      describe('Edge Case 9: No memory leaks with WeakMap', function() {
        it('should not leak memory with repeated comparisons', function() {
          // Create and compare many circular objects
          for (let i = 0; i < 100; i++) {
            const obj1 = { id: i };
            obj1.self = obj1;
            
            const obj2 = { id: i };
            obj2.self = obj2;
            
            deepEqual(obj1, obj2);
          }
          
          // If we get here without stack overflow or memory errors, test passes
          expect(true).to.be.true;
        });
      });
      
      describe('Edge Case 10: Different structure with circular refs', function() {
        it('should reject different structures even with circular refs', function() {
          const obj1 = { a: 1 };
          obj1.self = obj1;
          
          const obj2 = { b: 1 };
          obj2.self = obj2;
          
          expect(obj1).to.not.deep.equal(obj2);
        });
      });
      
      describe('Edge Case 11: Array with object circular references', function() {
        it('should handle arrays containing circular objects', function() {
          const obj1 = { name: 'item' };
          obj1.self = obj1;
          const arr1 = [obj1, 2, 3];
          
          const obj2 = { name: 'item' };
          obj2.self = obj2;
          const arr2 = [obj2, 2, 3];
          
          expect(arr1).to.deep.equal(arr2);
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
    testCircularReferenceEdgeCases
  };
}

__defineModule__(_main);