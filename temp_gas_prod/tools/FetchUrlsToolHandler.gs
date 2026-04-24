function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * FetchUrlsToolHandler - Parallel URL fetching with binary support
   * Uses UrlFetchApp.fetchAll() for parallel execution
   * Supports JSON, text, AND BINARY files (images, PDFs, audio, video)
   * Extends ToolBase for consistent behavior
   */

  const ToolBase = require('tools/ToolBase');
  const UrlFetchUtils = require('common-js/UrlFetchUtils');

  /**
   * Compile a transform expression into a function.
   * Expression body syntax: user writes "r.body.length" not "r => r.body.length"
   * @param {string} expr - Expression with 'r' as the response object
   * @returns {Function} Compiled function that takes r and returns the expression result
   */
  function compileTransform(expr) {
    expr = expr.trim();
    // Auto-wrap object literals: { x: 1 } → ({ x: 1 })
    if (expr.startsWith('{') && expr.endsWith('}') && !expr.includes('return')) {
      expr = `(${expr})`;
    }
    return new Function('r', `return ${expr}`);
  }

  class FetchUrlsToolHandler extends ToolBase {
    constructor() {
      super('fetchUrls');
    }
    
    /**
     * Returns the Claude API tool definition for the 'fetchUrls' tool
     * @returns {Object} Tool definition with comprehensive documentation
     */
    getToolDefinition() {
      return {
        name: "fetchUrls",
        description: `Fetch multiple URLs in parallel. Supports JSON, text, AND BINARY files (images, PDFs, audio, video).

  USE fetchUrls WHEN:
  - User says "fetch these URLs", "get these images", "download these files"
  - You have 2+ independent URLs to fetch simultaneously
  - Fetching images, PDFs, or other binary files from multiple sources
  - Want 10-100x faster execution than sequential fetch calls

  USE fetch INSTEAD WHEN:
  - Single URL only
  - URL 2 depends on URL 1's response (chained requests)

  EXEC-FIRST ALTERNATIVE (when you need full control):
  For complex transformations or direct sheet writes, use exec with UrlFetchApp.fetchAll:
  exec({ jsCode: "var reqs = [{url:'https://api1.com'}, {url:'https://api2.com'}]; var resps = UrlFetchApp.fetchAll(reqs); return resps.map(function(r){return JSON.parse(r.getContentText()).id});" })
  // Single call: parallel fetch + transform + return summary

  BINARY FILE SUPPORT:
  Images, PDFs, audio, video are automatically detected and base64 encoded.
  Response includes: { isBinary: true, base64: "...", mimeType: "image/png", size: 12345 }

  TOKEN-EFFICIENT PATTERN (transform parameter):
  Use 'transform' to extract only what the LLM needs from large responses.
  The transformed result is both stored AND returned to LLM.

  TRANSFORM EXAMPLES - Cleaning up JSON responses:
  {
    "urls": ["https://api.com/users", "https://api.com/products"],
    "storeAs": "data",
    "transform": "r.success ? r.body.items.length : 0"
  }
  // Returns: [42, 15] instead of full response objects

  More transform patterns:
  - Count only: "r.body.items.length"
  - Extract fields: "{ id: r.body.id, name: r.body.name }"
  - Status check: "r.success"
  - First item: "r.body.items[0]"
  - Filter active: "r.body.filter(x => x.active)"
  - Summary: "{ count: r.body.length, sample: r.body.slice(0,2) }"
  - Error-safe: "r.success ? r.body.data : { error: r.statusCode }"

  HTML PARSING EXAMPLE - Fetch multiple years of event data:
  {
    "urls": [
      "https://iwf.sport/results/results-by-events/?event_year=2023",
      "https://iwf.sport/results/results-by-events/?event_year=2024",
      "https://iwf.sport/results/results-by-events/?event_year=2025"
    ],
    "storeAs": "allEvents",
    "transform": "{ year: r.url.match(/year=(\\d+)/)?.[1], events: [...r.body.matchAll(/<a href=\\"\\?event_id=(\\d+)\\"[\\s\\S]*?class=\\"text\\">(.*?)<\\/span>/g)].map(m => ({ id: +m[1], title: m[2].trim() })) }"
  }
  // Fetches 3 years in parallel, parses HTML, returns:
  // [{ year: "2023", events: [{id, title}, ...] }, { year: "2024", events: [...] }, ...]

  BASIC EXAMPLE - Multiple APIs:
  {
    "urls": [
      "https://api1.example.com/data",
      "https://api2.example.com/users"
    ],
    "storeAs": "apiData"
  }

  BINARY EXAMPLE - Fetch images:
  {
    "urls": [
      "https://example.com/photo1.jpg",
      "https://example.com/photo2.png",
      "https://example.com/document.pdf"
    ],
    "storeAs": "files"
  }
  // Response: { results: [{ isBinary: true, base64: "...", mimeType: "image/jpeg" }, ...] }

  MIXED EXAMPLE - APIs + images with per-URL options:
  {
    "requests": [
      { "url": "https://api.com/users", "method": "GET" },
      { "url": "https://api.com/create", "method": "POST", "payload": "{\\"name\\":\\"test\\"}" },
      { "url": "https://cdn.com/logo.png" }
    ],
    "storeAs": "mixedResults"
  }

  RESPONSE FORMAT:
  {
    "success": true,
    "result": {
      "total": 3,
      "successful": 3,
      "failed": 0,
      "totalBytes": 125000,
      "storedAs": "apiData",
      "results": [
        { "url": "...", "success": true, "statusCode": 200, "isBinary": false, "contentType": "application/json", "body": {...}, "encoding": "utf8" },
        { "url": "...", "success": true, "statusCode": 200, "isBinary": true, "contentType": "image/png", "base64": "...", "mimeType": "image/png", "size": 50000, "encoding": "base64" },
        { "url": "...", "success": false, "statusCode": 404, "error": "Not Found" }
      ]
    }
  }

  With transform (results are transformed):
  {
    "success": true,
    "result": {
      "total": 3,
      "successful": 3,
      "failed": 0,
      "storedAs": "apiData",
      "results": [42, 15, 8]  // Just the counts, not full objects
    }
  }

  ENCODING METADATA:
  - encoding: "base64" (binary was base64-encoded for JSON transport) or "utf8" (text content)
  - isBinary: true for images/PDFs/audio/video, false for text/JSON

  FOR CLAUDE VISION API (images only):
  Convert image results to Claude vision format:
  { type: "image", source: { type: "base64", media_type: result.mimeType, data: result.base64 } }

  PROCESSING BINARY IN exec:
  {
    "jsCode": "const files = toolState.files; files.forEach(f => { if (f.isBinary) { const blob = Utilities.newBlob(Utilities.base64Decode(f.base64), f.mimeType, 'file'); DriveApp.createFile(blob); } }); return 'Files saved';"
  }

  LIMITS:
  - Maximum 30 URLs per batch (recommend 10 for large binary files)
  - GAS quota: 20,000 URL fetch calls per day
  - 6-minute total execution timeout`,

        input_schema: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              maxItems: 30,
              description: "Simple list of URLs to fetch with GET. Example: [\"https://api1.com\", \"https://cdn.com/image.png\"]. Use 'requests' instead if you need POST or custom headers."
            },
            requests: {
              type: "array",
              maxItems: 30,
              items: {
                type: "object",
                properties: {
                  url: { type: "string", description: "Target URL (required)" },
                  method: {
                    type: "string",
                    enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
                    description: "HTTP method (default: GET)"
                  },
                  headers: {
                    type: "object",
                    description: "HTTP headers as key-value pairs"
                  },
                  payload: {
                    type: "string",
                    description: "Request body as string"
                  },
                  contentType: {
                    type: "string",
                    description: "Content-Type header (default: application/json)"
                  }
                },
                required: ["url"]
              },
              description: "Alternative to 'urls': Array of request objects with per-URL options. Use when URLs need different methods/headers."
            },
            storeAs: {
              type: "string",
              description: `Store results in toolState with this key.

  STORED SHAPE (array of results - one per URL):
  toolState.{key} = [
    { url, success, statusCode, contentType, body/base64, ... },
    { url, success, statusCode, contentType, body/base64, ... },
    ...
  ]

  ACCESS PATTERNS IN exec:
  - First result: toolState.key[0].body
  - All bodies: toolState.key.map(r => r.body)
  - Filter successful: toolState.key.filter(r => r.success)

  With transform, stores transformed array:
  toolState.{key} = [transformedResult1, transformedResult2, ...]

  NOTE: fetchUrls stores ARRAY, fetch stores SINGLE object.`
            },
            continueOnError: {
              type: "boolean",
              description: "Continue processing remaining URLs if some fail (default: true)"
            },
            transform: {
              type: "string",
              description: `Expression to extract data from each response. Variable 'r' is the response object.

  r = {
    url: "https://...",        // Original URL
    success: true,             // true if status 200-299
    statusCode: 200,           // HTTP status
    body: <JSON or string>,    // ← Usually what you want
    headers: {...},
    isBinary: false
  }

  COMMON PATTERNS:
    r.body                         → full body
    r.body.length                  → count
    r.body.map(x => x.id)          → extract field
    r.body.filter(x => x.active)   → filter
    r.body[0]                      → first item
    { count: r.body.length }       → new object (auto-wrapped)
    r.success ? r.body : null      → conditional

  SPREADSHEET WORKFLOW:
  1. fetchUrls with transform, storeAs: "data"
     Transform: "r.body.filter(x => x.score > 100).map(x => [x.name, x.score])"
  2. exec: "var d=[['name','score'],...toolState.data.flat()]; SpreadsheetApp.getActiveRange().offset(0,0,d.length,d[0].length).setValues(d)"

  HTML PARSING:
    [...r.body.matchAll(/<title>([^<]+)<\\/title>/g)].map(m => m[1])
    { url: r.url, links: [...r.body.matchAll(/href=\"([^\"]+)\"/g)].map(m => m[1]).slice(0,10) }

  HINT: Multiple URL responses can be huge. Use transform to extract only needed fields.`,
              llmHints: {
                syntax: "Expression body - result IS return value. 'r.body.length' returns the count. No 'r =>' or 'return'",
                autoWrap: "Object literals auto-wrapped: { x: 1 } works (no parens needed)",
                wrongVsRight: ["r => r.body → r.body", "return r.body → r.body"],
                nullSafe: "r.body?.items ?? [], r.body?.data?.id ?? 'unknown'"
              }
            }
          }
          // Note: oneOf validation is done in execute() since GAS doesn't support it natively
        }
      };
    }
    
    /**
     * Execute parallel URL fetching
     * @param {Object} input - Tool input with urls or requests array
     * @param {Object} context - Execution context
     * @returns {Object} Result object with results array
     */
    execute(input, context = {}) {
      const { urls, requests: requestsInput, storeAs, continueOnError = true, transform } = input;
      const toolState = context.toolState || {};

      // Normalize input: support both 'urls' (simple) and 'requests' (detailed)
      let requests;
      if (urls && Array.isArray(urls)) {
        // Simple format: convert string URLs to request objects
        requests = urls.map(url => ({ url, method: 'GET' }));
      } else if (requestsInput && Array.isArray(requestsInput)) {
        requests = requestsInput;
      } else {
        return this._errorResult('Either "urls" (array of strings) or "requests" (array of objects) is required');
      }

      // Validation
      if (requests.length === 0) {
        return this._errorResult('At least one URL is required');
      }
      if (requests.length > 30) {
        return this._errorResult(`Maximum 30 URLs per batch, received ${requests.length}. Split into multiple calls.`);
      }

      // Validate each URL
      for (let i = 0; i < requests.length; i++) {
        if (!requests[i].url) {
          return this._errorResult(`URL required at index ${i}`);
        }
      }

      log(`[FETCHURLS] → ${requests.length} URLs`);
      const startTime = Date.now();

      // Compile transform function if provided
      let transformFn = null;
      let transformWarning = null;
      if (transform) {
        try {
          transformFn = compileTransform(transform);
          log('[FETCHURLS] 🔄 transform enabled');
        } catch (e) {
          transformWarning = `Transform compilation failed: ${e.toString()}. Returning full results.`;
          log('[FETCHURLS] ⚠️ ' + transformWarning);
        }
      }

      try {
        // Build request array for fetchAllWithRetry
        const fetchRequests = requests.map(req => ({
          url: req.url,
          options: {
            method: (req.method || 'GET').toUpperCase(),
            headers: req.headers || {},
            payload: req.payload,
            contentType: req.contentType || 'application/json'
          }
        }));

        // Execute parallel fetch using UrlFetchUtils
        const { responses, stats } = UrlFetchUtils.fetchAllWithRetry(fetchRequests, {
          continueOnError,
          think: context.think || (() => {})
        });

        // Process responses
        const results = [];
        let totalBytes = 0;
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < responses.length; i++) {
          const resp = responses[i];
          const reqUrl = requests[i].url;

          // Handle individual fetch error (from fallback mode)
          if (resp.__error) {
            failCount++;
            const errorResult = {
              url: reqUrl,
              success: false,
              error: resp.__error,
              encoding: null
            };
            // Apply transform even to errors if provided
            results.push(transformFn ? this._applyTransform(transformFn, errorResult) : errorResult);
            continue;
          }

          // Process response
          const processed = this._processResponse(resp, reqUrl);
          totalBytes += processed.size || 0;

          if (processed.success) {
            successCount++;
          } else {
            failCount++;
          }

          // Apply transform if provided
          results.push(transformFn ? this._applyTransform(transformFn, processed) : processed);
        }

        // Store results in toolState if specified (transformed or full)
        if (storeAs) {
          toolState[storeAs] = results;
          log(`[FETCHURLS] 📦 stored as "${storeAs}"`);
        }

        const duration = Date.now() - startTime;
        log(`[FETCHURLS] ✓ ${successCount}/${requests.length} successful, ${totalBytes} bytes, ${duration}ms`);

        // Build LLM response
        const result = {
          total: requests.length,
          successful: successCount,
          failed: failCount,
          totalBytes,
          durationMs: duration,
          fetchMethod: stats.method,
          storedAs: storeAs || null,
          results: results
        };

        // Add transform warning if any
        if (transformWarning) {
          result.warnings = [transformWarning];
        }

        return this._successResult(result, { toolState });

      } catch (error) {
        return this._errorResult(`Batch fetch failed: ${error.toString()}`, error);
      }
    }

    /**
     * Apply transform function safely
     * @private
     * @param {Function} transformFn - Compiled transform function
     * @param {Object} result - Result to transform
     * @returns {*} Transformed result or original with error
     */
    _applyTransform(transformFn, result) {
      try {
        return transformFn(result);
      } catch (e) {
        return { __transformError: e.toString(), url: result.url, success: result.success };
      }
    }

    /**
     * Process a single HTTP response
     * @private
     * @param {HTTPResponse} response - UrlFetchApp response object
     * @param {string} url - Original URL
     * @returns {Object} Processed response with binary detection and encoding metadata
     */
    _processResponse(response, url) {
      const headers = response.getHeaders();
      const contentType = headers['Content-Type'] || headers['content-type'] || '';
      const statusCode = response.getResponseCode();
      const success = statusCode >= 200 && statusCode < 300;

      // Check if binary content using UrlFetchUtils helper
      const isBinary = UrlFetchUtils.isBinaryContentType(contentType);

      if (isBinary) {
        try {
          const blob = response.getBlob();
          const bytes = blob.getBytes();
          
          return {
            url,
            success,
            statusCode,
            contentType,
            isBinary: true,
            size: bytes.length,
            base64: Utilities.base64Encode(bytes),
            mimeType: blob.getContentType(),
            // Encoding metadata - documents how binary was transformed for JSON transport
            encoding: 'base64'
          };
        } catch (e) {
          return {
            url,
            success: false,
            statusCode,
            contentType,
            isBinary: true,
            error: `Failed to process binary: ${e.toString()}`,
            encoding: null
          };
        }
      }

      // Text/JSON response
      const text = response.getContentText();
      let body = text;

      if (contentType.includes('application/json') || contentType.includes('text/json')) {
        try {
          body = JSON.parse(text);
        } catch (e) {
          // Keep as text if JSON parse fails
        }
      }

      return {
        url,
        success,
        statusCode,
        contentType,
        isBinary: false,
        size: text.length,
        body,
        // Encoding metadata - UTF-8 text (no additional transformation)
        encoding: 'utf8'
      };
    }
  }

  module.exports = FetchUrlsToolHandler;
}

__defineModule__(_main);