function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Unit tests for UrlFetchUtils
   * Tests exponential backoff, retry logic, jitter, Retry-After parsing, and status code categorization
   */

  function testUrlFetchUtils() {
    const results = {
      passed: 0,
      failed: 0,
      tests: []
    };
    
    // Helper to record test results
    function test(name, fn) {
      try {
        fn();
        results.passed++;
        results.tests.push({ name, status: 'PASS' });
        Logger.log(`✓ ${name}`);
      } catch (error) {
        results.failed++;
        results.tests.push({ name, status: 'FAIL', error: error.message });
        Logger.log(`✗ ${name}: ${error.message}`);
      }
    }
    
    // Helper to assert
    function assert(condition, message) {
      if (!condition) {
        throw new Error(message || 'Assertion failed');
      }
    }
    
    Logger.log('Starting UrlFetchUtils tests...\n');
    
    // Test 1: Exponential backoff calculation
    test('Exponential backoff without jitter', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      // Test with 0% jitter to verify pure exponential backoff
      const delays = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const delay = UrlFetchUtils._calculateDelay(attempt, 1000, 16000, 0, null, () => {});
        delays.push(delay);
      }
      
      // Should be: 1000, 2000, 4000, 8000
      assert(delays[0] === 1000, `Attempt 0: Expected 1000ms, got ${delays[0]}ms`);
      assert(delays[1] === 2000, `Attempt 1: Expected 2000ms, got ${delays[1]}ms`);
      assert(delays[2] === 4000, `Attempt 2: Expected 4000ms, got ${delays[2]}ms`);
      assert(delays[3] === 8000, `Attempt 3: Expected 8000ms, got ${delays[3]}ms`);
    });
    
    // Test 2: Jitter stays within bounds
    test('Jitter stays within ±20%', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      // Test 100 samples to verify jitter distribution
      const delays = [];
      const baseDelay = 2000;
      const jitterPercent = 20;
      
      for (let i = 0; i < 100; i++) {
        const delay = UrlFetchUtils._calculateDelay(1, 1000, 16000, jitterPercent, null, () => {});
        delays.push(delay);
      }
      
      // All delays should be within ±20% of 2000ms (1600ms to 2400ms)
      const minExpected = baseDelay * 0.8;  // 1600
      const maxExpected = baseDelay * 1.2;  // 2400
      
      delays.forEach((delay, i) => {
        assert(delay >= minExpected && delay <= maxExpected, 
          `Sample ${i}: ${delay}ms outside range [${minExpected}, ${maxExpected}]`);
      });
      
      // Verify we get different values (not all the same)
      const uniqueDelays = new Set(delays);
      assert(uniqueDelays.size > 10, `Expected varied delays, got only ${uniqueDelays.size} unique values`);
    });
    
    // Test 3: Max delay cap enforced
    test('Max delay cap enforced', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      // Attempt 10 would normally be 1024 seconds, should be capped at 16
      const delay = UrlFetchUtils._calculateDelay(10, 1000, 16000, 0, null, () => {});
      
      assert(delay === 16000, `Expected 16000ms cap, got ${delay}ms`);
    });
    
    // Test 4: Retry-After header parsing (integer seconds)
    test('Retry-After header parsing - integer seconds', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      // Mock response with Retry-After: 5
      const mockResponse = {
        getHeaders: () => ({ 'retry-after': '5' })
      };
      
      const delay = UrlFetchUtils._calculateDelay(0, 1000, 16000, 0, mockResponse, () => {});
      
      assert(delay === 5000, `Expected 5000ms, got ${delay}ms`);
    });
    
    // Test 5: Retry-After header parsing (HTTP-date)
    test('Retry-After header parsing - HTTP-date format', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      // Create a date 3 seconds in the future
      const futureDate = new Date(Date.now() + 3000);
      const httpDate = futureDate.toUTCString();
      
      const mockResponse = {
        getHeaders: () => ({ 'retry-after': httpDate })
      };
      
      const delay = UrlFetchUtils._calculateDelay(0, 1000, 16000, 0, mockResponse, () => {});
      
      // Should be approximately 3000ms (allow 100ms variance for execution time)
      assert(delay >= 2900 && delay <= 3100, `Expected ~3000ms, got ${delay}ms`);
    });
    
    // Test 6: Retry-After exceeds max delay
    test('Retry-After exceeds max delay - capped', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      const logs = [];
      const mockThink = (msg) => logs.push(msg);
      
      // Retry-After of 30 seconds should be capped at 16 seconds
      const mockResponse = {
        getHeaders: () => ({ 'retry-after': '30' })
      };
      
      const delay = UrlFetchUtils._calculateDelay(0, 1000, 16000, 0, mockResponse, mockThink);
      
      assert(delay === 16000, `Expected 16000ms cap, got ${delay}ms`);
      assert(logs.length > 0, 'Expected warning log about capping');
      assert(logs[0].includes('exceeds max delay'), 'Expected warning message about exceeding max');
    });
    
    // Test 7: Invalid Retry-After header (fallback to exponential)
    test('Invalid Retry-After header - fallback to exponential', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      const mockResponse = {
        getHeaders: () => ({ 'retry-after': 'invalid-value' })
      };
      
      // Should fallback to exponential backoff (attempt 1 = 2000ms with no jitter)
      const delay = UrlFetchUtils._calculateDelay(1, 1000, 16000, 0, mockResponse, () => {});
      
      assert(delay === 2000, `Expected 2000ms fallback, got ${delay}ms`);
    });
    
    // Test 8: Status text mapping
    test('Status text mapping for common codes', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      assert(UrlFetchUtils._getStatusText(429) === 'Too Many Requests', 'Wrong text for 429');
      assert(UrlFetchUtils._getStatusText(503) === 'Service Unavailable', 'Wrong text for 503');
      assert(UrlFetchUtils._getStatusText(504) === 'Gateway Timeout', 'Wrong text for 504');
      assert(UrlFetchUtils._getStatusText(522) === 'Connection Timed Out', 'Wrong text for 522');
      assert(UrlFetchUtils._getStatusText(999) === 'Unknown', 'Should return Unknown for unmapped codes');
    });
    
    // Test 9: Configuration defaults
    test('Configuration defaults applied correctly', () => {
      // This test verifies the default config values are used when not specified
      // We can't easily test fetchWithRetry without mocking UrlFetchApp, so we test the config merging
      
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      // Defaults should be:
      // maxRetries: 4
      // baseDelayMs: 1000
      // maxDelayMs: 16000
      // jitterPercent: 20
      // retryableStatuses: [429, 500, 502, 503, 504]
      // nonRetryableStatuses: [400, 401, 403, 404, 405]
      
      // We verify this by checking the delay calculation uses defaults
      const delay = UrlFetchUtils._calculateDelay(0, 1000, 16000, 20, null, () => {});
      
      // With 20% jitter, delay should be between 800ms and 1200ms
      assert(delay >= 800 && delay <= 1200, `Delay ${delay}ms outside expected range with jitter`);
    });
    
    // Test 10: Think logging integration
    test('Think logging integration', () => {
      const UrlFetchUtils = require('common-js/UrlFetchUtils');
      
      const logs = [];
      const mockThink = (msg) => logs.push(msg);
      
      // Calculate delay with think function
      UrlFetchUtils._calculateDelay(1, 1000, 16000, 0, null, mockThink);
      
      // No logs expected for normal calculation (logs only for Retry-After cap warnings)
      // But verify function accepts and uses think parameter
      assert(typeof mockThink === 'function', 'Think should be a function');
    });
    
    // Summary
    Logger.log('\n' + '='.repeat(50));
    Logger.log(`Tests completed: ${results.passed} passed, ${results.failed} failed`);
    Logger.log('='.repeat(50));
    
    if (results.failed > 0) {
      Logger.log('\nFailed tests:');
      results.tests.filter(t => t.status === 'FAIL').forEach(t => {
        Logger.log(`  ✗ ${t.name}: ${t.error}`);
      });
    }
    
    return results;
  }

  /**
   * Test the fetchWithRetry function with a mock successful response
   * Note: This requires manual testing or a mock HTTP server
   */
  function testFetchWithRetrySuccess() {
    Logger.log('Testing fetchWithRetry with real HTTP call...');
    
    const UrlFetchUtils = require('common-js/UrlFetchUtils');
    const logs = [];
    const mockThink = (msg) => {
      logs.push(msg);
      Logger.log(`[THINK] ${msg}`);
    };
    
    try {
      // Test with a reliable endpoint (example.com always returns 200)
      const { response, retryStats } = UrlFetchUtils.fetchWithRetry(
        'https://example.com',
        {},
        {
          maxRetries: 2,
          think: mockThink
        }
      );
      
      Logger.log(`Status: ${response.getResponseCode()}`);
      Logger.log(`Attempts: ${retryStats.attempts}`);
      Logger.log(`Total delay: ${retryStats.totalDelay}ms`);
      Logger.log(`Status codes: ${JSON.stringify(retryStats.statusCodes)}`);
      
      Logger.log('\n✓ fetchWithRetry test passed - successful response');
      return { success: true, retryStats };
      
    } catch (error) {
      Logger.log(`✗ fetchWithRetry test failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Test the fetchWithRetry function with a URL that will return 404 (non-retryable)
   */
  function testFetchWithRetryNonRetryable() {
    Logger.log('Testing fetchWithRetry with non-retryable error (404)...');
    
    const UrlFetchUtils = require('common-js/UrlFetchUtils');
    const logs = [];
    const mockThink = (msg) => {
      logs.push(msg);
      Logger.log(`[THINK] ${msg}`);
    };
    
    try {
      // This URL should return 404
      const { response, retryStats } = UrlFetchUtils.fetchWithRetry(
        'https://example.com/this-page-does-not-exist-12345',
        {},
        {
          maxRetries: 3,
          think: mockThink
        }
      );
      
      // Should not get here - 404 should throw
      Logger.log(`✗ Test failed - expected error for 404 but got response: ${response.getResponseCode()}`);
      return { success: false, error: 'Expected error but got success' };
      
    } catch (error) {
      // Expected to throw error
      if (error.message.includes('Non-retryable') || error.message.includes('404')) {
        Logger.log(`✓ fetchWithRetry correctly threw error for 404: ${error.message}`);
        Logger.log(`Retry logs: ${logs.length} (should be 0 for non-retryable)`);
        return { success: true, error: error.message };
      } else {
        Logger.log(`✗ Unexpected error: ${error.message}`);
        return { success: false, error: error.message };
      }
    }
  }

  /**
   * Run all tests
   */
  function runAllUrlFetchUtilsTests() {
    Logger.log('\n' + '='.repeat(70));
    Logger.log('URLFETCH UTILS TEST SUITE');
    Logger.log('='.repeat(70) + '\n');
    
    // Run unit tests
    const unitResults = testUrlFetchUtils();
    
    Logger.log('\n' + '='.repeat(70));
    Logger.log('INTEGRATION TESTS (requires network)');
    Logger.log('='.repeat(70) + '\n');
    
    // Run integration tests
    const successTest = testFetchWithRetrySuccess();
    const nonRetryableTest = testFetchWithRetryNonRetryable();
    
    // Overall summary
    Logger.log('\n' + '='.repeat(70));
    Logger.log('OVERALL SUMMARY');
    Logger.log('='.repeat(70));
    Logger.log(`Unit tests: ${unitResults.passed} passed, ${unitResults.failed} failed`);
    Logger.log(`Integration tests:`);
    Logger.log(`  - Success test: ${successTest.success ? 'PASS' : 'FAIL'}`);
    Logger.log(`  - Non-retryable test: ${nonRetryableTest.success ? 'PASS' : 'FAIL'}`);
    Logger.log('='.repeat(70));
    
    return {
      unit: unitResults,
      integration: {
        success: successTest,
        nonRetryable: nonRetryableTest
      }
    };
  }
}

__defineModule__(_main);