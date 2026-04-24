function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * SearchToolHandler - Makes HTTP requests via UrlFetchApp
   * Provides the 'fetch' tool for Claude AI to make external API calls
   * Supports JSON, text, AND BINARY files (images, PDFs, audio, video)
   * Extends ToolBase for consistent behavior
   */

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

  class SearchToolHandler extends require('tools/ToolBase') {
    constructor() {
      super('fetch');
    }
    
    /**
     * Returns the Claude API tool definition for the 'fetch' tool
     * @returns {Object} Tool definition with comprehensive documentation
     */
    getToolDefinition() {
      return {
        name: "fetch",
        description: `Make HTTP requests using UrlFetchApp. Supports JSON, text, AND BINARY files (images, PDFs, audio, video).

  DOCUMENTATION:
  https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app

  BINARY FILE SUPPORT:
  Images, PDFs, audio, video are automatically detected and base64 encoded.
  Response includes: { isBinary: true, base64: "...", mimeType: "image/png", encoding: "base64" }

  RECOMMENDED PATTERN (saves tokens):
    Use responseHeadersOnly=true (default) with storeAs to avoid overwhelming the LLM.
    Full response is stored in toolState for later access via exec tool.

    PREFERRED WORKFLOW - Call from exec tool:
    Instead of: fetch -> exec
    Use: exec (calls UrlFetchApp internally and writes to cells)
    This is MORE EFFICIENT and reduces round trips.

  TOKEN-EFFICIENT PATTERN (transform parameter):
    Use 'transform' to extract only what the LLM needs from large responses.
    The transformed result is both stored AND returned to LLM.

    Example - Extract only item count from large dataset:
    {
      "url": "https://api.com/huge-dataset",
      "storeAs": "data",
      "transform": "{ count: r.body.items.length, sample: r.body.items.slice(0,3) }"
    }
    // Returns to LLM: { count: 5000, sample: [{...},{...},{...}] }  // ~100 tokens
    // Same object stored in toolState.data

  BASIC EXAMPLES:

  1. Simple GET request (headers only, body in toolState):
  {
    "url": "https://api.example.com/data",
    "storeAs": "apiData",
    "responseHeadersOnly": true
  }
  // Returns: { success, statusCode, headers }
  // Full response with body stored as apiData

  2. Binary file (image/PDF) - auto-detected:
  {
    "url": "https://example.com/image.png",
    "storeAs": "image"
  }
  // Returns: { success, isBinary: true, base64: "...", mimeType: "image/png" }

  3. POST request with transform for token efficiency:
  {
    "url": "https://api.example.com/search",
    "method": "POST",
    "payload": "{\\"query\\":\\"test\\"}",
    "storeAs": "searchResult",
    "transform": "r.body.results.map(x => x.title)"
  }
  // Returns: ["Title 1", "Title 2", ...] - just the titles, not full objects

  4. Transform examples (JSON):
  - Count only: "r.body.items.length"
  - Extract fields: "{ id: r.body.id, name: r.body.name }"
  - Status check: "r.success"
  - First item: "r.body.items[0]"
  - Filter: "r.body.items.filter(x => x.active)"

  5. HTML PARSING EXAMPLE - Extract structured data from raw HTML:
  {
    "url": "https://iwf.sport/results/results-by-events/?event_year=2024",
    "responseHeadersOnly": false,
    "storeAs": "events",
    "transform": "[...r.body.matchAll(/<a href=\\"\\?event_id=(\\d+)\\"[\\s\\S]*?class=\\"text\\">(.*?)<\\/span>[\\s\\S]*?normal__text\\">(.*?)<\\/p>[\\s\\S]*?normal__text\\">([\\s\\S]*?)<\\/p>/g)].map(m => ({ event_id: +m[1], title: m[2].trim(), date: m[3].trim(), location: m[4].replace(/<[^>]+>/g, ' ').trim() }))"
  }
  // Converts 50KB+ raw HTML → ~2KB structured array:
  // [{ event_id: 123, title: "World Championships", date: "Jan 2024", location: "Paris, France" }, ...]

  HTML TRANSFORM PATTERN:
  - r.body contains raw HTML string for text/html responses
  - Use matchAll() with regex to extract DOM patterns
  - Map matches to structured objects
  - Return array of clean objects instead of raw HTML

  RESPONSE FORMAT (text/JSON):
  {
    "url": "...",
    "success": true/false,
    "statusCode": 200,
    "contentType": "application/json",
    "isBinary": false,
    "size": 1234,
    "body": { ... },
    "encoding": "utf8"
  }

  RESPONSE FORMAT (binary):
  {
    "url": "...",
    "success": true/false,
    "statusCode": 200,
    "contentType": "image/png",
    "isBinary": true,
    "size": 50000,
    "base64": "...",
    "mimeType": "image/png",
    "encoding": "base64"
  }

  FOR CLAUDE VISION API (images):
  Convert image result to Claude vision format:
  { type: "image", source: { type: "base64", media_type: result.mimeType, data: result.base64 } }

  FOR CLAUDE PDF SUPPORT:
  Convert PDF result to Claude document format:
  { type: "document", source: { type: "base64", media_type: "application/pdf", data: result.base64 } }

  PROCESSING BINARY IN exec:
  {
    "jsCode": "const file = toolState.myFile; if (file.isBinary) { const blob = Utilities.newBlob(Utilities.base64Decode(file.base64), file.mimeType, 'document.pdf'); DriveApp.createFile(blob); } return 'File saved';"
  }

  With responseHeadersOnly=true:
  {
    "success": true/false,
    "statusCode": 200,
    "headers": { ... }
  }`,
        input_schema: {
          type: "object",
          properties: {
            url: { 
              type: "string", 
              description: "Target URL (include query parameters in URL string)" 
            },
            method: { 
              type: "string", 
              enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], 
              description: "HTTP method (default: GET)"
            },
            headers: { 
              type: "object", 
              description: "HTTP headers as key-value pairs (e.g., {\"Authorization\": \"Bearer token\"})" 
            },
            payload: { 
              type: "string", 
              description: "Request body as string (use JSON.stringify for objects)" 
            },
            contentType: { 
              type: "string", 
              description: "Content-Type header (default: application/json)"
            },
            storeAs: {
              type: "string",
              description: `Store result in toolState with this key.

  STORED SHAPE (single result object):
  toolState.{key} = {
    url, success, statusCode, headers, contentType,
    isBinary, size, body/base64, mimeType, encoding
  }

  ACCESS PATTERNS IN exec:
  - Response body: toolState.key.body
  - Status check: toolState.key.success
  - Binary data: toolState.key.base64

  With transform, stores transformed value:
  toolState.{key} = transformedResult

  NOTE: fetch stores SINGLE object, fetchUrls stores ARRAY.`
            },
            responseHeadersOnly: {
              type: "boolean",
              description: "Return only headers and metadata, omitting body from response (default: true). Saves tokens. WARNING: If true without storeAs, response body is discarded."
            },
            transform: {
              type: "string",
              description: `Expression to extract data from response. Variable 'r' is the response object.

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
  1. fetch with transform, storeAs: "data"
     Transform: "[['id','name'], ...r.body.filter(x => x.active).map(x => [x.id, x.name])]"
  2. exec: "var d=toolState.data; SpreadsheetApp.getActiveRange().offset(0,0,d.length,d[0].length).setValues(d)"

  HTML PARSING:
    [...r.body.matchAll(/href=\"([^\"]+)\"/g)].map(m => m[1])
    [...r.body.matchAll(/<tr>([\\s\\S]*?)<\\/tr>/g)].map(m => m[1])

  HINT: If response >10KB, use transform to extract only needed fields.`,
              llmHints: {
                syntax: "Expression body - result IS return value. 'r.body.length' returns the count. No 'r =>' or 'return'",
                autoWrap: "Object literals auto-wrapped: { x: 1 } works (no parens needed)",
                wrongVsRight: ["r => r.body → r.body", "return r.body → r.body"],
                nullSafe: "r.body?.items ?? [], r.body?.data?.id ?? 'unknown'"
              }
            }
          },
          required: ["url"]
        }
      };
    }
    
    /**
     * Execute HTTP request via UrlFetchApp
     * @param {Object} input - Tool input with url, method, headers, payload, contentType
     * @param {Object} context - Execution context
     * @returns {Object} Response object with success, statusCode, headers, body
     */
    execute(input, context = {}) {
      const { 
        url, 
        method = 'GET', 
        headers = {}, 
        payload, 
        contentType = 'application/json',
        storeAs,
        responseHeadersOnly = true,
        transform
      } = input;
      const toolState = context.toolState || {};
      
      // Log request initiation
      const urlPreview = url.length > 80 ? url.substring(0, 80) + '...' : url;
      log('[FETCH] → ' + method + ' ' + urlPreview);
      
      // Build UrlFetchApp options
      const options = {
        method: method.toLowerCase(),
        headers: headers,
        muteHttpExceptions: true  // Don't throw on non-2xx status codes
      };
      
      // Add payload if provided
      if (payload) {
        options.payload = payload;
        // Set Content-Type if not already in headers
        if (!headers['Content-Type'] && !headers['content-type']) {
          options.contentType = contentType;
        }
      }
      
      try {
        const response = UrlFetchApp.fetch(url, options);
        const parsedResponse = this._parseResponse(response, url);
        
        // Log response result
        if (parsedResponse.success) {
          const binaryInfo = parsedResponse.isBinary ? ' (binary)' : '';
          log('[FETCH] ✓ ' + parsedResponse.statusCode + binaryInfo);
        } else {
          log('[FETCH] ✗ ' + parsedResponse.statusCode);
        }
        
        // Apply transform if provided
        let resultToStore = parsedResponse;
        let transformWarning = null;
        
        if (transform) {
          try {
            const transformFn = compileTransform(transform);
            resultToStore = transformFn(parsedResponse);
            log('[FETCH] 🔄 transformed');
          } catch (e) {
            transformWarning = `Transform failed: ${e.toString()}. Storing full response.`;
            log('[FETCH] ⚠️ ' + transformWarning);
            resultToStore = parsedResponse;
          }
        }
        
        // Store in toolState if specified (transformed or full, depending on transform param)
        if (storeAs) {
          const sizeInfo = typeof resultToStore === 'object' ? JSON.stringify(resultToStore).length : String(resultToStore).length;
          log('[FETCH] 📦 stored as "' + storeAs + '" (' + sizeInfo + ' bytes)');
          toolState[storeAs] = resultToStore;
        }
        
        // Prepare result for LLM
        let resultForLLM = resultToStore;
        let warnings = [];
        
        if (transformWarning) {
          warnings.push(transformWarning);
        }
        
        // If responseHeadersOnly and no transform, return headers-only version
        if (responseHeadersOnly && !transform) {
          resultForLLM = {
            success: parsedResponse.success,
            statusCode: parsedResponse.statusCode,
            headers: parsedResponse.headers
            // body intentionally omitted
          };
          
          // Warn if body is being discarded without storage
          if (!storeAs) {
            warnings.push("WARNING: responseHeadersOnly=true without storeAs - response body was discarded. Set storeAs to preserve data or set responseHeadersOnly=false to return body.");
          }
        }
        
        // Add warnings to result if any
        if (warnings.length > 0) {
          if (typeof resultForLLM === 'object' && resultForLLM !== null) {
            resultForLLM.warnings = warnings;
          } else {
            // If transform returned a primitive, wrap it
            resultForLLM = { value: resultForLLM, warnings };
          }
        }
        
        return this._successResult(resultForLLM, { toolState: toolState });
      } catch (error) {
        return this._errorResult(error.toString(), error);
      }
    }
    
    /**
     * Parse HTTP response with binary detection
     * @private
     * @param {HTTPResponse} response - UrlFetchApp response object
     * @param {string} url - Original URL for echo in response
     * @returns {Object} Parsed response with binary detection and encoding metadata
     */
    _parseResponse(response, url) {
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
          const mime = blob.getContentType();
          
          // Determine Claude API hint based on mime type
          // Claude natively supports: jpeg, png, gif, webp (images) and pdf (documents)
          const CLAUDE_SUPPORTED_IMAGES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          let claudeApiHint;
          
          if (CLAUDE_SUPPORTED_IMAGES.includes(mime)) {
            claudeApiHint = `Use with Claude Vision API: { type: "image", source: { type: "base64", media_type: result.mimeType, data: result.base64 } } where result.base64 contains the image data and result.mimeType is "${mime}"`;
          } else if (mime === 'application/pdf') {
            claudeApiHint = `Use with Claude PDF support: { type: "document", source: { type: "base64", media_type: result.mimeType, data: result.base64 } } where result.base64 contains the PDF data`;
          } else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
            claudeApiHint = `Binary ${mime.split('/')[0]} stored in result.base64. Claude cannot process this directly. To save to Drive, use exec tool: DriveApp.createFile(Utilities.newBlob(Utilities.base64Decode(toolState.KEY.base64), toolState.KEY.mimeType, 'filename'))`;
          } else {
            // Other binary (BMP, TIFF, SVG, etc.) - Claude cannot process natively
            claudeApiHint = `Binary data stored in result.base64 (${mime}). Claude cannot process this format natively. To extract text via OCR (requires Drive Advanced Service enabled): var blob = Utilities.newBlob(Utilities.base64Decode(toolState.KEY.base64), toolState.KEY.mimeType); var file = Drive.Files.insert({title: 'temp', mimeType: 'application/vnd.google-apps.document'}, blob, {ocr: true}); var text = DocumentApp.openById(file.id).getBody().getText(); DriveApp.getFileById(file.id).setTrashed(true); return text;`;
          }
          
          return {
            url,
            success,
            statusCode,
            headers,
            contentType,
            isBinary: true,
            size: bytes.length,
            base64: Utilities.base64Encode(bytes),
            mimeType: mime,
            encoding: 'base64',
            claudeApiHint
          };
        } catch (e) {
          return {
            url,
            success: false,
            statusCode,
            headers,
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
        headers,
        contentType,
        isBinary: false,
        size: text.length,
        body,
        encoding: 'utf8'
      };
    }
  }

  module.exports = SearchToolHandler;
}

__defineModule__(_main);