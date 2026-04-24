function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Module: testModuleState
   * Auto-wrapped for GAS CommonJS compatibility
   */

  /**
   * Diagnostic test to analyze module loading state
   * This test examines:
   * - Which module factories are registered
   * - Which modules are loaded
   * - What each module exports
   * - Identifies modules with empty exports
   */
  function testModuleState() {
    Logger.log('=== MODULE STATE DIAGNOSTIC TEST ===');
    
    const results = {
      factoryCount: 0,
      loadedCount: 0,
      factories: [],
      loaded: [],
      emptyExports: [],
      timestamp: new Date().toISOString()
    };
    
    // Check registered module factories
    Logger.log('\n--- Registered Module Factories ---');
    if (globalThis.__moduleFactories__) {
      const factoryNames = Object.keys(globalThis.__moduleFactories__);
      results.factoryCount = factoryNames.length;
      results.factories = factoryNames;
      Logger.log(`Total factories: ${factoryNames.length}`);
      factoryNames.forEach(name => {
        const factory = globalThis.__moduleFactories__[name];
        Logger.log(`  - ${name} (type: ${typeof factory}, length: ${factory?.length})`);
      });
    } else {
      Logger.log('ERROR: globalThis.__moduleFactories__ is not defined!');
    }
    
    // Check loaded modules
    Logger.log('\n--- Loaded Modules ---');
    if (globalThis.__modules__) {
      const moduleNames = Object.keys(globalThis.__modules__);
      results.loadedCount = moduleNames.length;
      Logger.log(`Total loaded modules: ${moduleNames.length}`);
      
      moduleNames.forEach(name => {
        const module = globalThis.__modules__[name];
        const exportType = typeof module.exports;
        const exportKeys = module.exports && typeof module.exports === 'object' 
          ? Object.keys(module.exports) 
          : [];
        
        results.loaded.push({
          name,
          exportType,
          exportKeys,
          isEmpty: exportType === 'object' && exportKeys.length === 0,
          isFunction: exportType === 'function',
          hasGetInstance: module.exports?.getInstance !== undefined
        });
        
        Logger.log(`  - ${name}:`);
        Logger.log(`      Export type: ${exportType}`);
        if (exportType === 'function') {
          Logger.log(`      Function name: ${module.exports.name || '(anonymous)'}`);
          Logger.log(`      Has getInstance: ${module.exports.getInstance !== undefined}`);
        } else if (exportType === 'object') {
          Logger.log(`      Keys: [${exportKeys.join(', ')}]`);
          if (exportKeys.length === 0) {
            Logger.log('      ⚠️  EMPTY EXPORT!');
            results.emptyExports.push(name);
          }
        }
      });
    } else {
      Logger.log('ERROR: globalThis.__modules__ is not defined!');
    }
    
    // Summary
    Logger.log('\n--- SUMMARY ---');
    Logger.log(`Total factories registered: ${results.factoryCount}`);
    Logger.log(`Total modules loaded: ${results.loadedCount}`);
    Logger.log(`Modules with empty exports: ${results.emptyExports.length}`);
    if (results.emptyExports.length > 0) {
      Logger.log('Empty export modules:');
      results.emptyExports.forEach(name => Logger.log(`  ⚠️  ${name}`));
    }
    
    return results;
  }

  /**
   * Test specifically for CacheStoreAdapter
   */
  function testCacheStoreAdapter() {
    Logger.log('\n=== CACHESTOREADAPTER SPECIFIC TEST ===');
    
    const moduleName = 'gas-queue/CacheStoreAdapter';
    const results = {
      moduleName,
      isRegistered: false,
      isLoaded: false,
      exportType: null,
      details: {}
    };
    
    // Check if factory is registered
    if (globalThis.__moduleFactories__ && globalThis.__moduleFactories__[moduleName]) {
      results.isRegistered = true;
      Logger.log(`✓ Factory registered for ${moduleName}`);
    } else {
      Logger.log(`✗ Factory NOT registered for ${moduleName}`);
    }
    
    // Check if module is loaded
    if (globalThis.__modules__ && globalThis.__modules__[moduleName]) {
      results.isLoaded = true;
      const module = globalThis.__modules__[moduleName];
      results.exportType = typeof module.exports;
      
      Logger.log(`✓ Module loaded: ${moduleName}`);
      Logger.log(`  Export type: ${results.exportType}`);
      
      if (results.exportType === 'function') {
        results.details = {
          functionName: module.exports.name,
          hasGetInstance: module.exports.getInstance !== undefined,
          staticMethods: Object.getOwnPropertyNames(module.exports).filter(n => n !== 'length' && n !== 'name' && n !== 'prototype')
        };
        Logger.log(`  Function name: ${results.details.functionName}`);
        Logger.log(`  Has getInstance: ${results.details.hasGetInstance}`);
        Logger.log(`  Static methods: [${results.details.staticMethods.join(', ')}]`);
      } else if (results.exportType === 'object') {
        const keys = Object.keys(module.exports);
        results.details = { keys };
        Logger.log(`  Keys: [${keys.join(', ')}]`);
        if (keys.length === 0) {
          Logger.log('  ⚠️  EMPTY EXPORT - THIS IS THE PROBLEM!');
        }
      }
    } else {
      Logger.log(`✗ Module NOT loaded: ${moduleName}`);
    }
    
    return results;
  }

  /**
   * Combined test runner
   */
  function runModuleDiagnostics() {
    const overallResults = {
      moduleState: null,
      cacheStoreAdapter: null,
      runAt: new Date().toISOString()
    };
    
    try {
      overallResults.moduleState = testModuleState();
    } catch (e) {
      Logger.log('ERROR in testModuleState: ' + e.toString());
      overallResults.moduleStateError = e.toString();
    }
    
    try {
      overallResults.cacheStoreAdapter = testCacheStoreAdapter();
    } catch (e) {
      Logger.log('ERROR in testCacheStoreAdapter: ' + e.toString());
      overallResults.cacheStoreAdapterError = e.toString();
    }
    
    Logger.log('\n=== DIAGNOSTIC TEST COMPLETE ===');
    return overallResults;
  }
}

__defineModule__(_main);