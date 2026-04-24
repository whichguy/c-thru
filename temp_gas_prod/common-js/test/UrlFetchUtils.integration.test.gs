function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, before } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const UrlFetchUtils = require('common-js/UrlFetchUtils');

  describe('UrlFetchUtils Integration Tests', () => {
    
    // FIX #3: Validate module loaded correctly before running tests
    before(() => {
      expect(UrlFetchUtils, 'UrlFetchUtils module should be loaded').to.exist;
      expect(UrlFetchUtils.fetchWithRetry, 'fetchWithRetry function should exist').to.be.a('function');
      Logger.log('[SETUP] UrlFetchUtils module validation passed');
    });
    
    describe('fetchWithRetry with real HTTP requests', () => {
      
      it('should successfully fetch from a reliable endpoint', () => {
        const logs = [];
        const mockThink = (msg) => {
          logs.push(msg);
          log(`[THINK] ${msg}`);
        };
        
        // Test with a reliable endpoint (example.com always returns 200)
        const { response, retryStats } = UrlFetchUtils.fetchWithRetry(
          'https://example.com',
          {},
          {
            maxRetries: 2,
            think: mockThink
          }
        );
        
        // FIX #3: Validate return structure before accessing properties
        expect(response, 'Response should exist').to.exist;
        expect(retryStats, 'RetryStats should exist').to.exist;
        
        // Verify response
        expect(response.getResponseCode()).to.equal(200);
        
        // Verify stats
        expect(retryStats.attempts).to.equal(1); // Should succeed on first attempt
        expect(retryStats.totalDelay).to.equal(0); // No retries = no delay
        expect(retryStats.statusCodes).to.deep.equal([200]);
        
        Logger.log(`✓ Successfully fetched example.com: ${response.getResponseCode()}`);
        Logger.log(`  Attempts: ${retryStats.attempts}`);
        Logger.log(`  Total delay: ${retryStats.totalDelay}ms`);
      });
      
      it('should throw error for non-retryable status (404)', () => {
        const logs = [];
        const mockThink = (msg) => {
          logs.push(msg);
          Logger.log(`[THINK] ${msg}`);
        };
        
        // FIX #1 & #2: Execute function once, capture both throw behavior and error details
        let error;
        let didThrow = false;
        
        try {
          UrlFetchUtils.fetchWithRetry(
            'https://example.com/this-page-does-not-exist-12345',
            {},
            {
              maxRetries: 3,
              think: mockThink
            }
          );
          // If we reach here, the function didn't throw
        } catch (e) {
          didThrow = true;
          error = e;
        }
        
        // FIX #1: Verify error actually occurred (not silently caught)
        expect(didThrow, 'fetchWithRetry should have thrown an error for 404').to.be.true;
        expect(error, 'Error object should exist').to.exist;
        
        // Verify the error message mentions non-retryable or 404
        const errorMsg = error.message.toLowerCase();
        const hasExpectedError = errorMsg.includes('non-retryable') || 
                                  errorMsg.includes('404') ||
                                  errorMsg.includes('not found');
        
        expect(hasExpectedError, `Error message should mention 404 or non-retryable. Got: ${error.message}`).to.be.true;
        
        // Should not have retried (404 is non-retryable)
        const retryLogs = logs.filter(log => log.includes('Retry'));
        expect(retryLogs.length, '404 should not trigger retries').to.equal(0);
        
        Logger.log(`✓ Correctly threw error for 404: ${error.message}`);
        Logger.log(`  Retry logs: ${retryLogs.length} (expected 0 for non-retryable)`);
      });
      
      it('should handle response with headers', () => {
        const logs = [];
        const mockThink = (msg) => logs.push(msg);
        
        // Fetch and check headers exist
        const { response, retryStats } = UrlFetchUtils.fetchWithRetry(
          'https://example.com',
          {},
          {
            maxRetries: 2,
            think: mockThink
          }
        );
        
        // FIX #3: Validate structure before accessing
        expect(response, 'Response should exist').to.exist;
        expect(retryStats, 'RetryStats should exist').to.exist;
        
        const headers = response.getHeaders();
        
        // Should have some headers
        expect(headers).to.exist;
        expect(typeof headers).to.equal('object');
        
        // Common headers that example.com typically returns
        const headerKeys = Object.keys(headers);
        expect(headerKeys.length).to.be.greaterThan(0);
        
        Logger.log(`✓ Response has ${headerKeys.length} headers`);
      });
      
      it('should respect custom retry configuration', () => {
        const logs = [];
        const mockThink = (msg) => logs.push(msg);
        
        // Test with custom config
        const { response, retryStats } = UrlFetchUtils.fetchWithRetry(
          'https://example.com',
          {},
          {
            maxRetries: 1,
            baseDelayMs: 500,
            maxDelayMs: 5000,
            jitterPercent: 10,
            think: mockThink
          }
        );
        
        // FIX #3: Validate structure
        expect(response, 'Response should exist').to.exist;
        expect(retryStats, 'RetryStats should exist').to.exist;
        
        expect(response.getResponseCode()).to.equal(200);
        expect(retryStats.attempts).to.equal(1);
        
        Logger.log(`✓ Custom configuration respected`);
      });
      
    });
    
  });

  // Export for CommonJS
  module.exports = {};
}

__defineModule__(_main);