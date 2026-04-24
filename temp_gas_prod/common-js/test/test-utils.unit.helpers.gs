function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Shared test utilities for CommonJS module unit tests
   * Consolidates duplicate helper functions across require-*.unit.test files
   */

  /**
   * Register a test module programmatically for testing purposes
   * Automatically tracks the module in the provided testModules array for cleanup
   * 
   * @param {string[]} testModules - Array to track registered module names (for cleanup)
   * @param {string} name - Module name (without 'test:' prefix)
   * @param {Function} factory - Module factory function (module, exports[, log]) => exports
   * @param {Object} [options={}] - Registration options
   * @param {boolean} [options.loadNow=false] - Load module immediately after registration
   * @returns {string} Full module name with 'test:' prefix
   * 
   * @example
   * // Register a lazy-loaded test module
   * const moduleName = registerTestModule(testModules, 'MyTest', (m, e) => ({ value: 42 }));
   * const exports = require(moduleName); // Load on demand
   * 
   * @example
   * // Register an immediately-loaded test module  
   * const moduleName = registerTestModule(testModules, 'MyTest', (m, e) => ({ value: 42 }), { loadNow: true });
   * // Module is already loaded at this point
   */
  function registerTestModule(testModules, name, factory, options = {}) {
    const { loadNow = false } = options;
    const fullName = `test:${name}`;
    
    // Register factory in global registry
    globalThis.__moduleFactories__[fullName] = factory;
    
    // Track for cleanup
    testModules.push(fullName);
    
    // Load immediately if requested (useful for testing loadNow behavior)
    if (loadNow) {
      require(fullName);
    }
    
    return fullName;
  }

  /**
   * Clean up test modules from global registries
   * Removes module from all three registries:
   * - __modules__ (loaded module cache)
   * - __moduleFactories__ (factory registry)
   * - __loadingModules__ (circular dependency detection)
   * 
   * @param {string[]} testModules - Array of full module names (with 'test:' prefix)
   * 
   * @example
   * afterEach(() => {
   *   cleanupTestModules(testModules);
   * });
   */
  function cleanupTestModules(testModules) {
    testModules.forEach(name => {
      delete globalThis.__modules__[name];
      delete globalThis.__moduleFactories__[name];
      globalThis.__loadingModules__.delete(name);
    });
  }

  /**
   * Create a test module tracker array
   * Used in beforeEach to initialize test module tracking
   * 
   * @returns {string[]} Empty array for tracking test module names
   * 
   * @example
   * describe('My Tests', () => {
   *   let testModules;
   *   
   *   beforeEach(() => {
   *     testModules = createTestModuleTracker();
   *   });
   *   
   *   afterEach(() => {
   *     cleanupTestModules(testModules);
   *   });
   *   
   *   it('should test something', () => {
   *     const name = registerTestModule(testModules, 'Test', (m, e) => ({ value: 1 }));
   *     // ... test code
   *   });
   * });
   */
  function createTestModuleTracker() {
    return [];
  }

  /**
   * Stub function for test auto-execution
   * Tests are automatically discovered and run by the test framework
   * This function exists for backwards compatibility
   */
  function runTests() {
    // Tests auto-run via test framework
  }

  module.exports = {
    registerTestModule,
    cleanupTestModules,
    createTestModuleTracker,
    runTests
  };
}

__defineModule__(_main);