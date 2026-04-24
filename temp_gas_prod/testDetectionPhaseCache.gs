function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Test to verify detection phase cache pollution hypothesis
   * 
   * Hypothesis: During __defineModule__ detection phase (checking for __global__),
   * when UISupport's _main is temporarily executed, it requires QueueManager,
   * which requires CacheStoreAdapter. These get loaded into the REAL module cache
   * during what's supposed to be a temporary inspection, possibly with incomplete state.
   */
  function testDetectionPhaseCache() {
    log('=== DETECTION PHASE CACHE POLLUTION TEST ===');
    
    const results = {
      beforeClear: {},
      afterClear: {},
      timeline: [],
      hypothesis: 'Detection phase pollutes cache with incomplete CacheStoreAdapter'
    };
    
    // PART 1: Check current state (after detection has already happened)
    log('\n--- PART 1: Current Cache State (Post-Detection) ---');
    
    const cacheStoreAdapterName = 'gas-queue/CacheStoreAdapter';
    const queueManagerName = 'gas-queue/QueueManager';
    const uiSupportName = 'sheets-chat/UISupport';
    
    // Check what's in cache right now
    results.beforeClear.cacheStoreAdapter = {
      exists: cacheStoreAdapterName in globalThis.__modules__,
      loaded: globalThis.__modules__[cacheStoreAdapterName]?.loaded,
      exportsType: typeof globalThis.__modules__[cacheStoreAdapterName]?.exports,
      exportsKeys: globalThis.__modules__[cacheStoreAdapterName] 
        ? Object.keys(globalThis.__modules__[cacheStoreAdapterName].exports)
        : [],
      hasGetInstance: typeof globalThis.__modules__[cacheStoreAdapterName]?.exports?.getInstance === 'function'
    };
    
    results.beforeClear.queueManager = {
      exists: queueManagerName in globalThis.__modules__,
      loaded: globalThis.__modules__[queueManagerName]?.loaded
    };
    
    results.beforeClear.uiSupport = {
      exists: uiSupportName in globalThis.__modules__,
      loaded: globalThis.__modules__[uiSupportName]?.loaded,
      hasGlobal: typeof globalThis.__modules__[uiSupportName]?.exports?.__global__ === 'object'
    };
    
    log('Before clear - CacheStoreAdapter:');
    log(JSON.stringify(results.beforeClear.cacheStoreAdapter, null, 2));
    
    // PART 2: Clear cache and re-require to see if it fixes the issue
    log('\n--- PART 2: Cache Clear Test ---');
    
    results.timeline.push({ event: 'clearing_cache', timestamp: new Date().toISOString() });
    
    // Clear CacheStoreAdapter from cache
    delete globalThis.__modules__[cacheStoreAdapterName];
    
    results.timeline.push({ event: 'cache_cleared', timestamp: new Date().toISOString() });
    
    // Re-require CacheStoreAdapter
    let CacheStoreAdapter;
    try {
      CacheStoreAdapter = require(cacheStoreAdapterName);
      results.timeline.push({ event: 'require_successful', timestamp: new Date().toISOString() });
    } catch (error) {
      results.timeline.push({ 
        event: 'require_failed', 
        error: error.toString(),
        timestamp: new Date().toISOString() 
      });
    }
    
    // Check state after re-require
    results.afterClear.cacheStoreAdapter = {
      exportsType: typeof CacheStoreAdapter,
      exportsKeys: CacheStoreAdapter ? Object.keys(CacheStoreAdapter) : [],
      hasGetInstance: typeof CacheStoreAdapter?.getInstance === 'function',
      instanceTest: null
    };
    
    // Try to call getInstance
    if (typeof CacheStoreAdapter?.getInstance === 'function') {
      try {
        const instance = CacheStoreAdapter.getInstance();
        results.afterClear.cacheStoreAdapter.instanceTest = {
          success: true,
          instanceType: typeof instance,
          hasSet: typeof instance?.set === 'function',
          hasGet: typeof instance?.get === 'function'
        };
        results.timeline.push({ event: 'getInstance_successful', timestamp: new Date().toISOString() });
      } catch (error) {
        results.afterClear.cacheStoreAdapter.instanceTest = {
          success: false,
          error: error.toString()
        };
        results.timeline.push({ 
          event: 'getInstance_failed', 
          error: error.toString(),
          timestamp: new Date().toISOString() 
        });
      }
    }
    
    log('After clear - CacheStoreAdapter:');
    log(JSON.stringify(results.afterClear.cacheStoreAdapter, null, 2));
    
    // PART 3: Comparison and conclusion
    log('\n--- PART 3: Analysis ---');
    
    const beforeWorked = results.beforeClear.cacheStoreAdapter.hasGetInstance;
    const afterWorked = results.afterClear.cacheStoreAdapter.hasGetInstance;
    
    results.conclusion = {
      hypothesisSupported: !beforeWorked && afterWorked,
      explanation: !beforeWorked && afterWorked
        ? 'Cache clear fixed the issue - detection phase likely polluted cache with incomplete module'
        : beforeWorked
          ? 'Module was already working - detection phase did not cause issue'
          : 'Cache clear did not fix issue - problem is elsewhere'
    };
    
    log('Hypothesis supported: ' + results.conclusion.hypothesisSupported);
    log('Explanation: ' + results.conclusion.explanation);
    
    log('\n=== TEST COMPLETE ===');
    return results;
  }

  module.exports = { testDetectionPhaseCache };
}

__defineModule__(_main);