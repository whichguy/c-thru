function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Module: testFactoryExecution
   * Auto-wrapped for GAS CommonJS compatibility
   */

  /**
   * Test to manually execute CacheStoreAdapter factory
   * This will help us understand WHY it exports an empty object
   */
  function testManualFactoryExecution() {
    log('=== MANUAL FACTORY EXECUTION TEST ===');
    
    const moduleName = 'gas-queue/CacheStoreAdapter';
    const results = {
      moduleName,
      factoryExists: false,
      executionSucceeded: false,
      error: null,
      exportType: null,
      exportDetails: null
    };
    
    // Get the factory
    const factory = globalThis.__moduleFactories__?.[moduleName];
    if (!factory) {
      log(`✗ Factory not found for ${moduleName}`);
      return results;
    }
    
    results.factoryExists = true;
    log(`✓ Factory found for ${moduleName}`);
    log(`  Factory type: ${typeof factory}`);
    log(`  Factory length: ${factory.length}`);
    
    // Create a fresh module object
    const freshModule = {
      id: moduleName,
      exports: {},
      loaded: false
    };
    
    log('\n--- Executing Factory Manually ---');
    try {
      // Call the factory with the fresh module
      const factoryResult = factory(freshModule, freshModule.exports);
      
      results.executionSucceeded = true;
      log('✓ Factory executed without throwing error');
      
      // Check what the factory returned
      if (factoryResult !== undefined) {
        log(`  Factory returned: ${typeof factoryResult}`);
        freshModule.exports = factoryResult;
      } else {
        log('  Factory returned: undefined (using module.exports)');
      }
      
      // Check the final exports
      results.exportType = typeof freshModule.exports;
      log(`  Final export type: ${results.exportType}`);
      
      if (results.exportType === 'function') {
        results.exportDetails = {
          functionName: freshModule.exports.name,
          hasGetInstance: freshModule.exports.getInstance !== undefined,
          staticMethods: Object.getOwnPropertyNames(freshModule.exports).filter(
            n => n !== 'length' && n !== 'name' && n !== 'prototype'
          )
        };
        log(`  Function name: ${results.exportDetails.functionName}`);
        log(`  Has getInstance: ${results.exportDetails.hasGetInstance}`);
        log(`  Static methods: [${results.exportDetails.staticMethods.join(', ')}]`);
        
        // Try calling getInstance if it exists
        if (freshModule.exports.getInstance) {
          log('\n--- Testing getInstance() ---');
          try {
            const instance = freshModule.exports.getInstance();
            log(`✓ getInstance() succeeded`);
            log(`  Instance type: ${typeof instance}`);
            log(`  Instance constructor: ${instance?.constructor?.name}`);
          } catch (e) {
            log(`✗ getInstance() failed: ${e.toString()}`);
            log(`  Stack: ${e.stack}`);
          }
        }
      } else if (results.exportType === 'object') {
        const keys = Object.keys(freshModule.exports);
        results.exportDetails = { keys };
        log(`  Keys: [${keys.join(', ')}]`);
        if (keys.length === 0) {
          log('  ⚠️  EMPTY EXPORT - Factory completed but exports nothing!');
        }
      }
      
    } catch (e) {
      results.error = {
        message: e.toString(),
        stack: e.stack
      };
      log(`✗ Factory threw error: ${e.toString()}`);
      log(`  Stack trace:`);
      log(e.stack);
    }
    
    return results;
  }

  /**
   * Test to compare with a working module (PropertiesStoreAdapter)
   */
  function testWorkingModuleFactory() {
    log('\n=== WORKING MODULE COMPARISON TEST ===');
    
    const moduleName = 'gas-queue/PropertiesStoreAdapter';
    const results = {
      moduleName,
      factoryExists: false,
      executionSucceeded: false,
      error: null,
      exportType: null
    };
    
    const factory = globalThis.__moduleFactories__?.[moduleName];
    if (!factory) {
      log(`✗ Factory not found for ${moduleName}`);
      return results;
    }
    
    results.factoryExists = true;
    log(`✓ Factory found for ${moduleName}`);
    log(`  Factory length: ${factory.length}`);
    
    const freshModule = { id: moduleName, exports: {}, loaded: false };
    
    try {
      const factoryResult = factory(freshModule, freshModule.exports);
      results.executionSucceeded = true;
      
      if (factoryResult !== undefined) {
        freshModule.exports = factoryResult;
      }
      
      results.exportType = typeof freshModule.exports;
      log(`✓ Factory executed successfully`);
      log(`  Export type: ${results.exportType}`);
      log(`  Has getInstance: ${freshModule.exports?.getInstance !== undefined}`);
      
    } catch (e) {
      results.error = { message: e.toString(), stack: e.stack };
      log(`✗ Factory failed: ${e.toString()}`);
    }
    
    return results;
  }

  /**
   * Main test runner
   */
  function runFactoryExecutionTest() {
    const results = {
      cacheStoreAdapter: null,
      propertiesStoreAdapter: null,
      runAt: new Date().toISOString()
    };
    
    results.cacheStoreAdapter = testManualFactoryExecution();
    results.propertiesStoreAdapter = testWorkingModuleFactory();
    
    log('\n=== FACTORY EXECUTION TEST COMPLETE ===');
    return results;
  }

  // Export public API
  module.exports = {
    testManualFactoryExecution,
    testWorkingModuleFactory,
    runFactoryExecutionTest
  };
}

__defineModule__(_main);