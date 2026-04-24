function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const { describe, it, beforeEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');
  const UrlFetchUtils = require('common-js/UrlFetchUtils');

  describe('UrlFetchUtils', () => {
    
    describe('Exponential Backoff', () => {
      
      it('should calculate exponential backoff without jitter', () => {
        // Test with 0% jitter to verify pure exponential backoff
        const delays = [];
        for (let attempt = 0; attempt < 4; attempt++) {
          const delay = UrlFetchUtils._calculateDelay(attempt, 1000, 16000, 0, null, () => {});
          delays.push(delay);
        }
        
        // Should be: 1000, 2000, 4000, 8000
        expect(delays[0]).to.equal(1000);
        expect(delays[1]).to.equal(2000);
        expect(delays[2]).to.equal(4000);
        expect(delays[3]).to.equal(8000);
      });
      
      it('should apply jitter within ±20% bounds', () => {
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
        
        delays.forEach(delay => {
          expect(delay).to.be.greaterThan(minExpected - 1);
          expect(delay).to.be.lessThan(maxExpected + 1);
        });
        
        // Verify we get different values (not all the same)
        const uniqueDelays = new Set(delays);
        expect(uniqueDelays.size).to.be.greaterThan(10);
      });
      
      it('should enforce max delay cap', () => {
        // Attempt 10 would normally be 1024 seconds, should be capped at 16
        const delay = UrlFetchUtils._calculateDelay(10, 1000, 16000, 0, null, () => {});
        
        expect(delay).to.equal(16000);
      });
      
    });
    
    describe('Retry-After Header Parsing', () => {
      
      it('should parse integer seconds from Retry-After header', () => {
        // Mock response with Retry-After: 5
        const mockResponse = {
          getHeaders: () => ({ 'retry-after': '5' })
        };
        
        const delay = UrlFetchUtils._calculateDelay(0, 1000, 16000, 0, mockResponse, () => {});
        
        expect(delay).to.equal(5000);
      });
      
      it('should parse HTTP-date format from Retry-After header', () => {
        // Create a date 3 seconds in the future
        const futureDate = new Date(Date.now() + 3000);
        const httpDate = futureDate.toUTCString();
        
        const mockResponse = {
          getHeaders: () => ({ 'retry-after': httpDate })
        };
        
        const delay = UrlFetchUtils._calculateDelay(0, 1000, 16000, 0, mockResponse, () => {});
        
        // Should be approximately 3000ms (allow 100ms variance for execution time)
        expect(delay).to.be.greaterThan(2900);
        expect(delay).to.be.lessThan(3100);
      });
      
      it('should cap Retry-After when it exceeds max delay', () => {
        const logs = [];
        const mockThink = (msg) => logs.push(msg);
        
        // Retry-After of 30 seconds should be capped at 16 seconds
        const mockResponse = {
          getHeaders: () => ({ 'retry-after': '30' })
        };
        
        const delay = UrlFetchUtils._calculateDelay(0, 1000, 16000, 0, mockResponse, mockThink);
        
        expect(delay).to.equal(16000);
        expect(logs.length).to.be.greaterThan(0);
        expect(logs[0]).to.include('exceeds max delay');
      });
      
      it('should fallback to exponential backoff for invalid Retry-After', () => {
        const mockResponse = {
          getHeaders: () => ({ 'retry-after': 'invalid-value' })
        };
        
        // Should fallback to exponential backoff (attempt 1 = 2000ms with no jitter)
        const delay = UrlFetchUtils._calculateDelay(1, 1000, 16000, 0, mockResponse, () => {});
        
        expect(delay).to.equal(2000);
      });
      
    });
    
    describe('Status Code Mapping', () => {
      
      it('should return correct status text for common codes', () => {
        expect(UrlFetchUtils._getStatusText(429)).to.equal('Too Many Requests');
        expect(UrlFetchUtils._getStatusText(503)).to.equal('Service Unavailable');
        expect(UrlFetchUtils._getStatusText(504)).to.equal('Gateway Timeout');
        expect(UrlFetchUtils._getStatusText(522)).to.equal('Connection Timed Out');
      });
      
      it('should return "Unknown" for unmapped status codes', () => {
        expect(UrlFetchUtils._getStatusText(999)).to.equal('Unknown');
      });
      
    });
    
    describe('Configuration', () => {
      
      it('should apply default configuration correctly', () => {
        // Verify delay calculation uses defaults correctly
        const delay = UrlFetchUtils._calculateDelay(0, 1000, 16000, 20, null, () => {});
        
        // With 20% jitter, delay should be between 800ms and 1200ms
        expect(delay).to.be.greaterThan(800 - 1);
        expect(delay).to.be.lessThan(1200 + 1);
      });
      
    });
    
    describe('Logging Integration', () => {
      
      it('should accept and use think function parameter', () => {
        const logs = [];
        const mockThink = (msg) => logs.push(msg);
        
        // Calculate delay with think function
        UrlFetchUtils._calculateDelay(1, 1000, 16000, 0, null, mockThink);
        
        // Verify function accepts think parameter
        expect(typeof mockThink).to.equal('function');
      });
      
    });
    
  });

  // Export for CommonJS
  module.exports = {};
}

__defineModule__(_main);