function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Test suite for ConfigManager
   * Tests all major functionality including hierarchy, overrides, and privacy
   */

  const ConfigManager = require('common-js/ConfigManager');

  function testBasicOperations() {
    Logger.log('=== Testing Basic Operations ===');
    
    const config = new ConfigManager('TEST_APP');
    
    // Test 1: Set and get value
    config.setUser('TEST_KEY', 'test_value');
    const value = config.get('TEST_KEY');
    Logger.log('Test 1 - Basic set/get: ' + (value === 'test_value' ? 'PASS' : 'FAIL'));
    
    // Test 2: Get non-existent key
    const nullValue = config.get('NON_EXISTENT_KEY');
    Logger.log('Test 2 - Non-existent key: ' + (nullValue === null ? 'PASS' : 'FAIL'));
    
    // Cleanup
    PropertiesService.getUserProperties().deleteProperty('TEST_APP_DATA_TEST_KEY');
    
    return true;
  }

  function testHierarchy() {
    Logger.log('=== Testing Hierarchical Lookup ===');
    
    const config = new ConfigManager('TEST_APP');
    
    // Test 3: Script < Domain < User < Document < UserDoc priority
    config.setScript('PRIORITY_TEST', 'script_value');
    Logger.log('Test 3a - Script value: ' + (config.get('PRIORITY_TEST') === 'script_value' ? 'PASS' : 'FAIL'));
    
    config.setDomain('PRIORITY_TEST', 'domain_value');
    Logger.log('Test 3b - Domain overrides Script: ' + (config.get('PRIORITY_TEST') === 'domain_value' ? 'PASS' : 'FAIL'));
    
    config.setUser('PRIORITY_TEST', 'user_value');
    Logger.log('Test 3c - User overrides Domain: ' + (config.get('PRIORITY_TEST') === 'user_value' ? 'PASS' : 'FAIL'));
    
    config.setDocument('PRIORITY_TEST', 'doc_value');
    Logger.log('Test 3d - Document overrides User: ' + (config.get('PRIORITY_TEST') === 'doc_value' ? 'PASS' : 'FAIL'));
    
    config.setUserDoc('PRIORITY_TEST', 'userdoc_value');
    Logger.log('Test 3e - UserDoc overrides Document: ' + (config.get('PRIORITY_TEST') === 'userdoc_value' ? 'PASS' : 'FAIL'));
    
    // FIX #2: Add null check for getActiveSpreadsheet() - can return null in trigger/API contexts
    let docId;
    try {
      const sheet = SpreadsheetApp.getActiveSpreadsheet();
      if (sheet) {
        docId = sheet.getId();
        PropertiesService.getUserProperties().deleteProperty(`${docId}_TEST_APP_DATA_PRIORITY_TEST`);
      }
    } catch (e) {
      Logger.log('Note: Could not access active spreadsheet for cleanup: ' + e.message);
    }
    
    PropertiesService.getDocumentProperties().deleteProperty('TEST_APP_DATA_PRIORITY_TEST');
    PropertiesService.getUserProperties().deleteProperty('TEST_APP_DATA_PRIORITY_TEST');
    PropertiesService.getScriptProperties().deleteProperty('DOMAIN_TEST_APP_DATA_PRIORITY_TEST');
    PropertiesService.getScriptProperties().deleteProperty('TEST_APP_DATA_PRIORITY_TEST');
    
    return true;
  }

  function testOverride() {
    Logger.log('=== Testing Policy Enforcement (OVERRIDE) ===');
    
    const config = new ConfigManager('TEST_APP');
    
    // Test 4: OVERRIDE beats DATA at higher priority
    config.setUser('POLICY_KEY', 'user_value');
    Logger.log('Test 4a - User DATA value: ' + (config.get('POLICY_KEY') === 'user_value' ? 'PASS' : 'FAIL'));
    
    // Set OVERRIDE at script level (lowest priority)
    config.setScriptOverride('POLICY_KEY', 'enforced_value');
    Logger.log('Test 4b - Script OVERRIDE beats User DATA: ' + (config.get('POLICY_KEY') === 'enforced_value' ? 'PASS' : 'FAIL'));
    
    // Cleanup
    PropertiesService.getUserProperties().deleteProperty('TEST_APP_DATA_POLICY_KEY');
    PropertiesService.getScriptProperties().deleteProperty('TEST_APP_OVERRIDE_POLICY_KEY');
    
    return true;
  }

  function testPrivacy() {
    Logger.log('=== Testing Privacy Enforcement ===');
    
    const config = new ConfigManager('TEST_APP');
    
    // FIX #1: Validate caught exceptions to prevent false positives
    // Test 5: THREAD cannot be stored in shared scopes
    try {
      config.setScript('THREAD', 'should_fail');
      Logger.log('Test 5a - Privacy violation for THREAD: FAIL (should have thrown error)');
    } catch (e) {
      // Verify it's the RIGHT error (privacy violation, not some other error)
      if (e.message && e.message.toLowerCase().includes('privacy')) {
        Logger.log('Test 5a - Privacy violation for THREAD: PASS (correctly blocked with: ' + e.message + ')');
      } else {
        Logger.log('Test 5a - Privacy violation for THREAD: FAIL (wrong error: ' + e.message + ')');
      }
    }
    
    // Test 6: THINKING_QUEUE cannot be stored in shared scopes
    try {
      config.setDomain('THINKING_QUEUE', 'should_fail');
      Logger.log('Test 5b - Privacy violation for THINKING_QUEUE: FAIL (should have thrown error)');
    } catch (e) {
      // Verify it's the RIGHT error (privacy violation, not some other error)
      if (e.message && e.message.toLowerCase().includes('privacy')) {
        Logger.log('Test 5b - Privacy violation for THINKING_QUEUE: PASS (correctly blocked with: ' + e.message + ')');
      } else {
        Logger.log('Test 5b - Privacy violation for THINKING_QUEUE: FAIL (wrong error: ' + e.message + ')');
      }
    }
    
    // Test 7: Private keys CAN be stored in user scopes
    try {
      config.setUser('THREAD', 'allowed_value');
      const value = config.get('THREAD');
      Logger.log('Test 5c - User scope for THREAD: ' + (value === 'allowed_value' ? 'PASS' : 'FAIL'));
      PropertiesService.getUserProperties().deleteProperty('TEST_APP_DATA_THREAD');
    } catch (e) {
      Logger.log('Test 5c - User scope for THREAD: FAIL (should be allowed)');
    }
    
    return true;
  }

  function testCollisionPrevention() {
    Logger.log('=== Testing Namespace Collision Prevention ===');
    
    const config = new ConfigManager('TEST_APP');
    
    // Test 8: User key "OVERRIDE_MODEL" doesn't collide with system OVERRIDE
    config.setUser('OVERRIDE_MODEL', 'user_override_model_value');
    const userValue = config.get('OVERRIDE_MODEL');
    Logger.log('Test 6 - User OVERRIDE_MODEL key: ' + (userValue === 'user_override_model_value' ? 'PASS' : 'FAIL'));
    
    // Cleanup
    PropertiesService.getUserProperties().deleteProperty('TEST_APP_DATA_OVERRIDE_MODEL');
    
    return true;
  }

  function testCache() {
    Logger.log('=== Testing Cache Behavior ===');
    
    const config = new ConfigManager('TEST_APP');
    
    // Test 9: Cache works correctly
    config.setUser('CACHE_TEST', 'initial_value');
    const value1 = config.get('CACHE_TEST');
    
    // Directly modify property (bypass config)
    PropertiesService.getUserProperties().setProperty('TEST_APP_DATA_CACHE_TEST', 'direct_change');
    
    // Should still return cached value
    const value2 = config.get('CACHE_TEST');
    Logger.log('Test 7a - Cache returns stale value: ' + (value2 === 'initial_value' ? 'PASS' : 'FAIL'));
    
    // Invalidate cache by setting through config
    config.setUser('CACHE_TEST', 'updated_value');
    const value3 = config.get('CACHE_TEST');
    Logger.log('Test 7b - Cache invalidates on write: ' + (value3 === 'updated_value' ? 'PASS' : 'FAIL'));
    
    // Cleanup
    PropertiesService.getUserProperties().deleteProperty('TEST_APP_DATA_CACHE_TEST');
    
    return true;
  }

  function runAllTests() {
    Logger.log('========================================');
    Logger.log('ConfigManager Test Suite');
    Logger.log('========================================');
    
    try {
      testBasicOperations();
      testHierarchy();
      testOverride();
      testPrivacy();
      testCollisionPrevention();
      testCache();
      
      Logger.log('========================================');
      Logger.log('All tests completed!');
      Logger.log('========================================');
      return 'Tests completed - check logs for results';
    } catch (error) {
      Logger.log('========================================');
      Logger.log('TEST SUITE FAILED: ' + error.message);
      Logger.log('Stack: ' + error.stack);
      Logger.log('========================================');
      return 'Tests failed: ' + error.message;
    }
  }

  // Export for CommonJS
  module.exports = { runAllTests };
}

__defineModule__(_main);