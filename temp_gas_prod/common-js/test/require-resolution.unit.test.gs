function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, beforeEach, afterEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const { registerTestModule, cleanupTestModules } = require('common-js/test/test-utils.unit.helpers');

  describe('require() - Module Resolution', () => {
    let testModules = [];
    
    // Helper function imported from shared test-utils.unit.helpers
    
    beforeEach(() => {
      testModules = [];
    });
    
    afterEach(() => {
      // Clean up ONLY test modules
      cleanupTestModules(testModules);
    });
    
    describe('Exact Name Matching', () => {
      it('should resolve exact module name', () => {
        const name = registerTestModule(testModules, 'ExactMatch', (m, e) => ({ exact: true }));
        
        const result = require('test:ExactMatch');
        
        expect(result.exact).to.be.true;
      });
      
      it('should resolve module with path', () => {
        const name = registerTestModule(testModules, 'path/to/Module', (m, e) => ({ path: true }));
        
        const result = require('test:path/to/Module');
        
        expect(result.path).to.be.true;
      });
    });
    
    describe('.js Extension Handling', () => {
      it('should resolve module without .js extension', () => {
        const name = registerTestModule(testModules, 'NoExtension', (m, e) => ({ value: 1 }));
        
        const result = require('test:NoExtension');
        
        expect(result.value).to.equal(1);
      });
      
      it('should resolve module.js to module', () => {
        const name = registerTestModule(testModules, 'WithExt', (m, e) => ({ value: 2 }));
        
        const result = require('test:WithExt.js');
        
        expect(result.value).to.equal(2);
      });
      
      it('should try both name and name.js', () => {
        const name = registerTestModule(testModules, 'AutoExt', (m, e) => ({ value: 3 }));
        
        // Should work with or without .js
        const withoutExt = require('test:AutoExt');
        const withExt = require('test:AutoExt.js');
        
        expect(withoutExt).to.equal(withExt);
      });
    });
    
    describe('Path Normalization', () => {
      it('should strip leading ./ from module name', () => {
        const name = registerTestModule(testModules, 'RelativeModule', (m, e) => ({ rel: true }));
        
        const result = require('./test:RelativeModule');
        
        expect(result.rel).to.be.true;
      });
      
      it('should strip leading ../ from module name', () => {
        const name = registerTestModule(testModules, 'ParentModule', (m, e) => ({ parent: true }));
        
        const result = require('../test:ParentModule');
        
        expect(result.parent).to.be.true;
      });
    });
    
    describe('Basename Fallback', () => {
      it('should try basename when full path fails', () => {
        const name = registerTestModule(testModules, 'BaseOnly', (m, e) => ({ base: true }));
        
        // Try loading with path - should fall back to basename
        const result = require('some/path/test:BaseOnly');
        
        expect(result.base).to.be.true;
      });
      
      it('should prefer full path over basename', () => {
        // Register both full path and basename
        registerTestModule(testModules, 'path/Module', (m, e) => ({ type: 'full' }));
        registerTestModule(testModules, 'Module', (m, e) => ({ type: 'base' }));
        
        // Should get full path version
        const result = require('test:path/Module');
        
        expect(result.type).to.equal('full');
      });
    });
    
    describe('Candidate Priority', () => {
      it('should try candidates in order: exact, normalized, with .js, basename', () => {
        // Only register basename version
        const name = registerTestModule(testModules, 'CandBase', (m, e) => ({ found: 'basename' }));
        
        // Try with full path - should eventually match basename
        const result = require('test:some/path/CandBase');
        
        expect(result.found).to.equal('basename');
      });
      
      it('should stop at first match', () => {
        let loadCount = 0;
        const factory = (m, e) => {
          loadCount++;
          return { count: loadCount };
        };
        
        // Register with exact name
        registerTestModule(testModules, 'FirstMatch', factory);
        
        // Load - should only execute once
        require('test:FirstMatch');
        require('test:FirstMatch.js');
        require('./test:FirstMatch');
        
        // All should return cached version (loadCount = 1)
        expect(loadCount).to.equal(1);
      });
    });
    
    describe('Edge Cases', () => {
      it('should handle module name with multiple slashes', () => {
        const name = registerTestModule(testModules, 'a/b/c/Module', (m, e) => ({ deep: true }));
        
        const result = require('test:a/b/c/Module');
        
        expect(result.deep).to.be.true;
      });
      
      it('should handle module name with special characters', () => {
        const name = registerTestModule(testModules, 'module-name', (m, e) => ({ special: true }));
        
        const result = require('test:module-name');
        
        expect(result.special).to.be.true;
      });
      
      it('should handle module name with underscore', () => {
        const name = registerTestModule(testModules, 'module_name', (m, e) => ({ under: true }));
        
        const result = require('test:module_name');
        
        expect(result.under).to.be.true;
      });
    });
  });

  // Tests auto-run via test framework - no exports needed
}

__defineModule__(_main);