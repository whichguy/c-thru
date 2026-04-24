function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * UrlFetchUtils - Robust HTTP fetching with exponential backoff retry logic
   * Handles rate limiting (429), server errors (500, 502, 503, 504), and network failures
   */

  class UrlFetchUtils {
    /**
     * Fetch URL with automatic retry on transient failures
     * 
     * @param {string} url - URL to fetch
     * @param {Object} options - UrlFetchApp.fetch options
     * @param {Object} context - Configuration and logging context
     * @param {number} context.maxRetries - Maximum retry attempts (default: 4)
     * @param {number} context.baseDelayMs - Base delay in milliseconds (default: 1000)
     * @param {number} context.maxDelayMs - Maximum delay in milliseconds (default: 16000)
     * @param {number} context.jitterPercent - Jitter percentage ±% (default: 20)
     * @param {Array<number>} context.retryableStatuses - HTTP status codes that trigger retry (default: [429, 500, 502, 503, 504])
     * @param {Array<number>} context.nonRetryableStatuses - HTTP status codes that should NOT retry (default: [400, 401, 403, 404, 405])
     * @param {Function} context.think - Logging function for retry attempts
     * @returns {Object} { response, retryStats: { attempts, totalDelay, statusCodes } }
     * @throws {Error} If all retry attempts exhausted or non-retryable error encountered
     */
    static fetchWithRetry(url, options = {}, context = {}) {
      // Default configuration
      const config = {
        maxRetries: context.maxRetries !== undefined ? context.maxRetries : 4,
        baseDelayMs: context.baseDelayMs || 1000,
        maxDelayMs: context.maxDelayMs || 16000,
        jitterPercent: context.jitterPercent !== undefined ? context.jitterPercent : 20,
        retryableStatuses: context.retryableStatuses || [429, 500, 502, 503, 504],
        nonRetryableStatuses: context.nonRetryableStatuses || [400, 401, 403, 404, 405],
        think: context.think || (() => {})
      };
      
      // Ensure muteHttpExceptions is true so we can handle status codes
      const fetchOptions = {
        ...options,
        muteHttpExceptions: true
      };
      
      // Retry statistics
      const retryStats = {
        attempts: 0,
        totalDelay: 0,
        statusCodes: []
      };
      
      let lastError = null;
      let lastStatusCode = null;
      
      // Attempt fetch with retries
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        retryStats.attempts = attempt + 1;
        
        try {
          // Make the HTTP request
          const response = UrlFetchApp.fetch(url, fetchOptions);
          const statusCode = response.getResponseCode();
          retryStats.statusCodes.push(statusCode);
          
          // Check if status code indicates success
          if (statusCode >= 200 && statusCode < 300) {
            // Success!
            return { response, retryStats };
          }
          
          // Check if status code is non-retryable
          if (config.nonRetryableStatuses.includes(statusCode)) {
            throw new Error(`Non-retryable HTTP error (${statusCode}): ${response.getContentText()}`);
          }
          
          // Check if status code is retryable
          if (!config.retryableStatuses.includes(statusCode)) {
            // Status code not in retryable list and not in non-retryable list
            // Treat as non-retryable
            throw new Error(`HTTP error (${statusCode}): ${response.getContentText()}`);
          }
          
          // Status code is retryable - prepare for retry
          lastStatusCode = statusCode;
          lastError = new Error(`HTTP ${statusCode} error`);
          
          // Don't retry if this was the last attempt
          if (attempt >= config.maxRetries) {
            break;
          }
          
          // Calculate delay for next retry
          const delay = this._calculateDelay(
            attempt,
            config.baseDelayMs,
            config.maxDelayMs,
            config.jitterPercent,
            response,
            config.think
          );
          
          retryStats.totalDelay += delay;
          
          // Log retry attempt
          const statusText = this._getStatusText(statusCode);
          config.think(`→ Retry ${attempt + 1}/${config.maxRetries} in ${(delay / 1000).toFixed(1)}s (${statusCode} ${statusText})`);
          
          // Wait before retrying
          Utilities.sleep(delay);
          
        } catch (error) {
          // Network error or other exception
          lastError = error;
          retryStats.statusCodes.push('error');
          
          // Check if this is a non-retryable error (based on message)
          if (error.message && error.message.includes('Non-retryable')) {
            throw error;
          }
          
          // Don't retry if this was the last attempt
          if (attempt >= config.maxRetries) {
            break;
          }
          
          // Calculate delay for next retry
          const delay = this._calculateDelay(
            attempt,
            config.baseDelayMs,
            config.maxDelayMs,
            config.jitterPercent,
            null,
            config.think
          );
          
          retryStats.totalDelay += delay;
          
          // Log retry attempt
          config.think(`→ Retry ${attempt + 1}/${config.maxRetries} in ${(delay / 1000).toFixed(1)}s (Network error: ${error.message})`);
          
          // Wait before retrying
          Utilities.sleep(delay);
        }
      }
      
      // All retries exhausted
      if (lastStatusCode) {
        throw new Error(`All ${config.maxRetries + 1} attempts failed. Last status: ${lastStatusCode}. ${lastError ? lastError.message : ''}`);
      } else {
        throw new Error(`All ${config.maxRetries + 1} attempts failed. ${lastError ? lastError.message : ''}`);
      }
    }
    
    /**
     * Calculate delay with exponential backoff and jitter
     * Respects Retry-After header if present
     * 
     * @private
     * @param {number} attempt - Current attempt number (0-indexed)
     * @param {number} baseDelayMs - Base delay in milliseconds
     * @param {number} maxDelayMs - Maximum delay in milliseconds
     * @param {number} jitterPercent - Jitter percentage ±%
     * @param {HTTPResponse} response - HTTP response (may contain Retry-After header)
     * @param {Function} think - Logging function
     * @returns {number} Delay in milliseconds
     */
    static _calculateDelay(attempt, baseDelayMs, maxDelayMs, jitterPercent, response, think) {
      // Check for Retry-After header first
      if (response) {
        const retryAfter = this._parseRetryAfter(response);
        if (retryAfter) {
          // Cap at maxDelayMs
          if (retryAfter > maxDelayMs) {
            think(`⚠️ Retry-After (${retryAfter}ms) exceeds max delay (${maxDelayMs}ms), using max`);
            return maxDelayMs;
          }
          return retryAfter;
        }
      }
      
      // Exponential backoff: baseDelay * 2^attempt
      let delay = baseDelayMs * Math.pow(2, attempt);
      
      // Cap at maxDelayMs
      delay = Math.min(delay, maxDelayMs);
      
      // Add jitter: ±jitterPercent%
      const jitterRange = delay * (jitterPercent / 100);
      const jitter = (Math.random() * 2 - 1) * jitterRange;  // Random between -range and +range
      delay = Math.floor(delay + jitter);
      
      // Ensure non-negative
      return Math.max(0, delay);
    }
    
    /**
     * Parse Retry-After header (supports both seconds and HTTP-date formats)
     * 
     * @private
     * @param {HTTPResponse} response - HTTP response
     * @returns {number|null} Delay in milliseconds, or null if not present/parseable
     */
    static _parseRetryAfter(response) {
      const headers = response.getHeaders();
      
      // Headers are normalized to lowercase keys in GAS
      const retryAfter = headers['retry-after'] || headers['Retry-After'];
      
      if (!retryAfter) {
        return null;
      }
      
      // Try parsing as integer (seconds)
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1000;  // Convert to milliseconds
      }
      
      // Try parsing as HTTP-date format
      try {
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
          const delayMs = date.getTime() - Date.now();
          if (delayMs > 0) {
            return delayMs;
          }
        }
      } catch (e) {
        // Parsing failed, return null
      }
      
      return null;
    }
    
    /**
     * Get human-readable status text for common HTTP status codes
     * 
     * @private
     * @param {number} statusCode - HTTP status code
     * @returns {string} Status text
     */
    static _getStatusText(statusCode) {
      const statusTexts = {
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        408: 'Request Timeout',
        429: 'Too Many Requests',
        500: 'Internal Server Error',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
        504: 'Gateway Timeout',
        522: 'Connection Timed Out',
        524: 'A Timeout Occurred'
      };
      
      return statusTexts[statusCode] || 'Unknown';
    }

    /**
     * Batch fetch multiple URLs in parallel with fallback to individual fetches
     * Uses UrlFetchApp.fetchAll() for parallel execution
     * 
     * @param {Array<Object>} requests - Array of request objects
     * @param {string} requests[].url - URL to fetch (required)
     * @param {Object} requests[].options - UrlFetchApp options (method, headers, payload, contentType)
     * @param {Object} context - Configuration options
     * @param {boolean} context.continueOnError - Continue processing if some URLs fail (default: true)
     * @param {number} context.maxTotalTimeMs - Maximum total execution time in ms (default: 300000 = 5 min)
     * @param {Function} context.think - Logging function
     * @returns {Object} { responses: Array, stats: { method, totalTime, count, errors? } }
     */
    static fetchAllWithRetry(requests, context = {}) {
      const config = {
        continueOnError: context.continueOnError !== false,
        maxTotalTimeMs: context.maxTotalTimeMs || 300000, // 5 min safety margin
        think: context.think || (() => {})
      };

      const startTime = Date.now();
      log(`[FETCHALL] → ${requests.length} URLs in parallel`);

      // Build request array for fetchAll
      const fetchRequests = requests.map(req => ({
        url: req.url,
        method: (req.options?.method || 'GET').toUpperCase(),
        headers: req.options?.headers || {},
        payload: req.options?.payload,
        contentType: req.options?.contentType || 'application/json',
        muteHttpExceptions: true
      }));

      try {
        // Attempt parallel fetch
        const responses = UrlFetchApp.fetchAll(fetchRequests);

        const stats = {
          method: 'fetchAll',
          totalTime: Date.now() - startTime,
          count: responses.length
        };

        log(`[FETCHALL] ✓ ${responses.length} responses in ${stats.totalTime}ms`);
        return { responses, stats };

      } catch (error) {
        // fetchAll failed entirely - network error or invalid URL in batch
        config.think(`[FETCHALL] Batch failed: ${error.message}`);

        if (!config.continueOnError) {
          throw error;
        }

        // Fallback: individual fetches
        config.think(`[FETCHALL] Falling back to individual fetches`);
        log(`[FETCHALL] Fallback to sequential fetches`);
        const responses = [];

        for (const req of fetchRequests) {
          // Check timeout
          if (Date.now() - startTime > config.maxTotalTimeMs) {
            config.think(`[FETCHALL] Timeout exceeded, remaining URLs skipped`);
            responses.push({ __error: 'Timeout exceeded', __url: req.url });
            continue;
          }

          try {
            const response = UrlFetchApp.fetch(req.url, req);
            responses.push(response);
          } catch (e) {
            responses.push({ __error: e.toString(), __url: req.url });
          }
        }

        const stats = {
          method: 'fallback',
          totalTime: Date.now() - startTime,
          count: responses.length,
          errors: responses.filter(r => r.__error).length
        };

        log(`[FETCHALL] ✓ Fallback complete: ${stats.count - (stats.errors || 0)} success, ${stats.errors || 0} errors in ${stats.totalTime}ms`);
        return { responses, stats };
      }
    }

    /**
     * Check if content type indicates binary data
     * 
     * @param {string} contentType - Content-Type header value
     * @returns {boolean} True if binary content type
     */
    static isBinaryContentType(contentType) {
      const binaryPrefixes = [
        'image/', 'audio/', 'video/', 'application/pdf',
        'application/octet-stream', 'application/zip',
        'application/gzip', 'application/x-gzip',
        'application/x-tar', 'application/x-rar',
        'font/', 'application/font', 'application/x-font'
      ];
      const lowerContentType = (contentType || '').toLowerCase();
      return binaryPrefixes.some(prefix => lowerContentType.startsWith(prefix));
    }
  }

  module.exports = UrlFetchUtils;
}

__defineModule__(_main);