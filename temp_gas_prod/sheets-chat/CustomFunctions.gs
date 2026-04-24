function _main(
  
  exports = module.exports
) {
  /**
   * CustomFunctions.gs
   * 
   * Google Sheets custom functions that expose Claude AI capabilities
   * via the Anthropic API. Functions are decorated with @customfunction
   * for autocomplete support.
   */

  const ClaudeConversation = require('sheets-chat/ClaudeConversation');

  /**
   * The Claude model to use for API calls
   */
  const DEFAULT_MODEL = 'claude-sonnet-4-6';

  /**
   * Default maximum tokens for Claude API responses
   */
  const DEFAULT_MAX_TOKENS = 4096;

  /**
   * The maximum number of URLs to follow from sheet data
   */
  const MAX_URLS_TO_FOLLOW = 10;

  /**
   * Cache for URL fetch results to avoid redundant requests
   */
  const URL_CACHE = {};

  /**
   * System instruction prefix that guides Claude to return properly formatted
   * responses for Google Sheets. This is critical for ensuring clean JSON output.
   */
  const SHEETS_FORMAT_INSTRUCTION =
    "[CRITICAL SYSTEM INSTRUCTION: You MUST return ONLY valid JSON. " +
    "DO NOT include ANY explanatory text, preambles, or commentary. " +
    "DO NOT use markdown code blocks (```json). " +
    "DO NOT say things like 'Here is the output' or 'For Google Sheets'. " +
    "Return ONLY the raw JSON value itself.\n\n" +
    "Output format rules:\n" +
    "- For single-cell output: Return a primitive value (string/number/boolean) → Example: \"Tuesday\"\n" +
    "- For multi-cell output: Return a 2D JSON array → Example: [[\"Name\",\"Age\"],[\"Alice\",30]]\n" +
    "- For key-value data: Return a 2D array → Example: [[\"Key\",\"Value\"],[\"Status\",\"Active\"]]\n\n" +
    "INCORRECT (with preamble): \"Here's the data: [[1,2]]\"\n" +
    "CORRECT (JSON only): [[1,2]]\n\n" +
    "INCORRECT (with markdown): ```json\n[[1,2]]\n```\n" +
    "CORRECT (JSON only): [[1,2]]\n\n" +
    "Remember: Return ONLY the JSON value, nothing else.]\n\n";

  /**
   * ASK_AI - Query Claude AI with optional data from your spreadsheet
   * 
   * @param {string} prompt - Your question or instruction for Claude
   * @param {any} dataReference - Optional reference to cells containing data (e.g., A1:B10)
   * @param {boolean} followUrls - If true, fetch content from URLs in the data
   * @param {string} model - Claude model to use (default: claude-sonnet-4-20250514)
   * @param {number} maxTokens - Maximum tokens in response (default: 4096)
   * @return The AI's response (single value or array for multiple cells)
   * @customfunction
   */
  function ASK_AI(prompt, dataReference, followUrls, model, maxTokens) {
    try {
      // Validate prompt
      if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
        return '❌ Error: Prompt is required and must be a non-empty string';
      }

      // Set defaults
      const modelToUse = model || DEFAULT_MODEL;
      const maxTokensToUse = maxTokens || DEFAULT_MAX_TOKENS;
      const shouldFollowUrls = followUrls === true;

      // Extract data from the reference if provided
      let contextData = '';
      if (dataReference !== undefined && dataReference !== null && dataReference !== '') {
        const extractedData = extractDataFromReference(dataReference);
        
        if (shouldFollowUrls) {
          const urls = extractUrlsFromData(extractedData);
          if (urls.length > 0) {
            const urlContents = fetchUrlContents(urls);
            contextData = formatContextData(extractedData, urlContents);
          } else {
            contextData = formatContextData(extractedData, null);
          }
        } else {
          contextData = formatContextData(extractedData, null);
        }
      }

      // Build the full prompt with system instruction prefix
      const fullPrompt = SHEETS_FORMAT_INSTRUCTION + prompt + (contextData ? '\n\nContext Data:\n' + contextData : '');

      // Initialize conversation with thinking disabled for speed
      // Initialize conversation with correct API (auto-gets API key from UISupport)
      const conversation = new ClaudeConversation();
      
      // Set custom model if provided
      if (modelToUse) {
        conversation.model = modelToUse;
      }
      
      // Send message and get response
      // Send message using new params object API
      const result = conversation.sendMessage({
        messages: [],
        text: fullPrompt,
        maxTokens: maxTokensToUse,
        enableThinking: false
      });

      // Extract response string from result object
      const response = result.response;
      
      // Format response for Sheets display
      return formatResponseAsArray(response);

    } catch (error) {
      const errorMsg = error.message || String(error);
      log('ASK_AI Error: ' + errorMsg);
      return '❌ Error: ' + errorMsg;
    }
  }

  /**
   * Extract data from a cell reference or direct value
   * 
   * @param {any} dataReference - The data reference (cell range or direct value)
   * @return {any} The extracted data
   */
  function extractDataFromReference(dataReference) {
    if (Array.isArray(dataReference)) {
      return dataReference;
    }
    return dataReference;
  }

  /**
   * Extract URLs from data for fetching
   * 
   * @param {any} data - The data to search for URLs
   * @return {string[]} Array of URLs found in the data
   */
  function extractUrlsFromData(data) {
    const urls = [];
    const urlPattern = /^https?:\/\/[^\s.,;:!?)]+$/;
    
    function scanValue(value) {
      if (typeof value === 'string' && urlPattern.test(value.trim())) {
        urls.push(value.trim());
      }
    }
    
    if (Array.isArray(data)) {
      data.forEach(row => {
        if (Array.isArray(row)) {
          row.forEach(scanValue);
        } else {
          scanValue(row);
        }
      });
    } else {
      scanValue(data);
    }
    
    return urls.slice(0, MAX_URLS_TO_FOLLOW);
  }

  /**
   * Fetch contents from URLs with caching
   * 
   * @param {string[]} urls - Array of URLs to fetch
   * @return {Object} Map of URL to fetched content
   */
  function fetchUrlContents(urls) {
    const contents = {};
    
    urls.forEach(url => {
      try {
        if (URL_CACHE[url]) {
          contents[url] = URL_CACHE[url];
          return;
        }
        
        const response = UrlFetchApp.fetch(url, {
          muteHttpExceptions: true,
          followRedirects: true
        });
        
        const statusCode = response.getResponseCode();
        if (statusCode === 200) {
          const content = response.getContentText();
          const truncated = content.substring(0, 5000);
          URL_CACHE[url] = truncated;
          contents[url] = truncated;
        } else {
          contents[url] = `[HTTP ${statusCode}]`;
        }
      } catch (e) {
        contents[url] = `[Error: ${e.message}]`;
      }
    });
    
    return contents;
  }

  /**
   * Format context data and URL contents for the prompt
   * 
   * @param {any} data - The data reference
   * @param {Object} urlContents - Map of URL to content (or null)
   * @return {string} Formatted context string
   */
  function formatContextData(data, urlContents) {
    let context = '';
    
    if (Array.isArray(data)) {
      context += 'Data:\n' + JSON.stringify(data, null, 2);
    } else {
      context += 'Data: ' + String(data);
    }
    
    if (urlContents && Object.keys(urlContents).length > 0) {
      context += '\n\nURL Contents:\n';
      Object.keys(urlContents).forEach(url => {
        context += `\n[${url}]\n${urlContents[url]}\n`;
      });
    }
    
    return context;
  }

  /**
   * Format Claude's response for Google Sheets display
   * 
   * This function handles both primitive values and arrays, ensuring
   * proper formatting for single-cell and multi-cell output.
   * 
   * @param {string} response - The response from Claude
   * @return {any} Formatted value for Sheets (primitive or 2D array)
   */
  function formatResponseAsArray(response) {
    // Preprocess: Strip markdown code blocks and preambles
    let cleanResponse = response.trim();
    
    // Remove markdown code blocks: ```json ... ``` or ``` ... ```
    const codeBlockPattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
    const codeBlockMatch = cleanResponse.match(codeBlockPattern);
    if (codeBlockMatch) {
      cleanResponse = codeBlockMatch[1].trim();
    }
    
    // Try to find JSON array/object if response has preamble text
    if (!cleanResponse.startsWith('[') && !cleanResponse.startsWith('{') && !cleanResponse.startsWith('"')) {
      const jsonStart = Math.min(
        cleanResponse.indexOf('[') >= 0 ? cleanResponse.indexOf('[') : Infinity,
        cleanResponse.indexOf('{') >= 0 ? cleanResponse.indexOf('{') : Infinity
      );
      if (jsonStart !== Infinity) {
        cleanResponse = cleanResponse.substring(jsonStart).trim();
      }
    }
    
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(cleanResponse);
      
      // If it's already a 2D array, return as-is
      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && Array.isArray(parsed[0])) {
          return parsed;
        }
        // If it's a 1D array, wrap it in another array for single-row output
        return [parsed];
      }
      
      // If it's an object, convert to key-value pairs
      if (typeof parsed === 'object' && parsed !== null) {
        const entries = Object.entries(parsed);
        return [['Key', 'Value']].concat(entries);
      }
      
      // If it's a primitive, return as-is for single-cell output
      return parsed;
      
    } catch (e) {
      // If JSON parsing fails, try to detect if it looks like a simple value
      const trimmed = cleanResponse.trim();
      
      // Check for boolean
      if (trimmed === 'true') return true;
      if (trimmed === 'false') return false;
      
      // Check for number
      const num = Number(trimmed);
      if (!isNaN(num) && trimmed !== '') {
        return num;
      }
      
      // Check for date (ISO format)
      if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        return trimmed;
      }
      
      // Return as string, but clean up whitespace
      return cleanResponse.replace(/\s+/g, ' ').trim();
    }
  }

  // Export the custom function for module usage
  module.exports = {
    ASK_AI
  };
}

// ===== HOISTED CUSTOM FUNCTIONS (for Google Sheets autocomplete) =====
/**
 * ASK_AI - Query Claude AI with optional data from your spreadsheet
 * 
 * @param {string} prompt - Your question or instruction for Claude
 * @param {any} dataReference - Optional reference to cells containing data (e.g., A1:B10)
 * @param {boolean} followUrls - If true, fetch content from URLs in the data
 * @param {string} model - Claude model to use (default: claude-sonnet-4-20250514)
 * @param {number} maxTokens - Maximum tokens in response (default: 4096)
 * @return The AI's response (single value or array for multiple cells)
 * @customfunction
 */
function ASK_AI(prompt, dataReference, followUrls, model, maxTokens) {
  return require('sheets-chat/CustomFunctions').ASK_AI(prompt, dataReference, followUrls, model, maxTokens);
}
// ===== END HOISTED CUSTOM FUNCTIONS =====

__defineModule__(_main);