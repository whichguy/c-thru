function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Module: testRequireTrace
   * Auto-wrapped for GAS CommonJS compatibility
   */

  /**
   * Test to trace what happens during require() vs manual factory execution
   */
  function testRequireVsManual() {
    Logger.log('=== REQUIRE VS MANUAL EXECUTION TEST ===');
    
    const moduleName = 'gas-queue/CacheStoreAdapter';
    
    // First, check current state
    Logger.log('\n--- Current Module State ---');
    const currentModule = globalThis.__modules__?.[moduleName];
    if (currentModule) {
      Logger.log(`Module already loaded`);
      Logger.log(`  Export type: ${typeof currentModule.exports}`);
      Logger.log(`  Export keys: [${Object.keys(currentModule.exports).join(', ')}]`);
      Logger.log(`  Is empty object: ${typeof currentModule.exports === 'object' && Object.keys(currentModule.exports).length === 0}`);
    }
    
    // Clear and re-require
    Logger.log('\n--- Clearing Module Cache ---');
    delete globalThis.__modules__[moduleName];
    Logger.log('✓ Module cache cleared');
    
    // Now require it fresh
    Logger.log('\n--- Re-requiring Module ---');
    try {
      const CacheStoreAdapter = require(moduleName);
      Logger.log('✓ require() succeeded');
      Logger.log(`  Export type: ${typeof CacheStoreAdapter}`);
      
      if (typeof CacheStoreAdapter === 'function') {
        Logger.log(`  Function name: ${CacheStoreAdapter.name}`);
        Logger.log(`  Has getInstance: ${CacheStoreAdapter.getInstance !== undefined}`);
        Logger.log(`  Static methods: ${Object.getOwnPropertyNames(CacheStoreAdapter).filter(n => n !== 'length' && n !== 'name' && n !== 'prototype').join(', ')}`);
        
        // Test getInstance
        if (CacheStoreAdapter.getInstance) {
          try {
            const instance = CacheStoreAdapter.getInstance();
            Logger.log(`  ✓ getInstance() works`);
            Logger.log(`    Instance type: ${typeof instance}`);
          } catch (e) {
            Logger.log(`  ✗ getInstance() failed: ${e.toString()}`);
          }
        }
      } else if (typeof CacheStoreAdapter === 'object') {
        Logger.log(`  Keys: [${Object.keys(CacheStoreAdapter).join(', ')}]`);
        if (Object.keys(CacheStoreAdapter).length === 0) {
          Logger.log('  ⚠️  EMPTY OBJECT AFTER FRESH REQUIRE!');
        }
      }
      
      return {
        success: true,
        exportType: typeof CacheStoreAdapter,
        isEmpty: typeof CacheStoreAdapter === 'object' && Object.keys(CacheStoreAdapter).length === 0,
        hasGetInstance: CacheStoreAdapter?.getInstance !== undefined
      };
      
    } catch (e) {
      Logger.log(`✗ require() failed: ${e.toString()}`);
      Logger.log(`  Stack: ${e.stack}`);
      return {
        success: false,
        error: e.toString(),
        stack: e.stack
      };
    }
  }

  /**
   * Test to examine the module object during require
   */
  function testModuleObjectInspection() {
    Logger.log('\n=== MODULE OBJECT INSPECTION ===');
    
    const moduleName = 'gas-queue/CacheStoreAdapter';
    
    // Check if __getCurrentModule works
    Logger.log('\n--- Testing __getCurrentModule ---');
    if (typeof globalThis.__getCurrentModule === 'function') {
      Logger.log('✓ __getCurrentModule exists');
      try {
        const currentMod = globalThis.__getCurrentModule();
        Logger.log(`  Returns: ${typeof currentMod}`);
        if (currentMod) {
          Logger.log(`  Module id: ${currentMod.id}`);
          Logger.log(`  Has exports: ${currentMod.exports !== undefined}`);
        }
      } catch (e) {
        Logger.log(`  Error calling: ${e.toString()}`);
      }
    } else {
      Logger.log('✗ __getCurrentModule does not exist');
    }
    
    // Check the factory signature
    Logger.log('\n--- Factory Signature Analysis ---');
    const factory = globalThis.__moduleFactories__?.[moduleName];
    if (factory) {
      Logger.log(`Factory for ${moduleName}:`);
      Logger.log(`  Type: ${typeof factory}`);
      Logger.log(`  Length (param count before defaults): ${factory.length}`);
      Logger.log(`  String representation (first 200 chars):`);
      Logger.log(`  ${factory.toString().substring(0, 200)}...`);
      
      // Check if it has default parameters
      const factoryStr = factory.toString();
      const hasDefaultParams = factoryStr.includes('module = ') || factoryStr.includes('exports = ');
      Logger.log(`  Has default parameters: ${hasDefaultParams}`);
    }
    
    return {
      getCurrentModuleExists: typeof globalThis.__getCurrentModule === 'function',
      factoryLength: factory?.length,
      hasDefaultParams: factory?.toString().includes('module = ')
    };
  }

  /**
   * Main runner
   */
  function runRequireTraceTest() {
    const results = {
      requireTest: null,
      inspectionTest: null,
      runAt: new Date().toISOString()
    };
    
    results.inspectionTest = testModuleObjectInspection();
    results.requireTest = testRequireVsManual();
    
    Logger.log('\n=== REQUIRE TRACE TEST COMPLETE ===');
    return results;
  }
}

__defineModule__(_main);