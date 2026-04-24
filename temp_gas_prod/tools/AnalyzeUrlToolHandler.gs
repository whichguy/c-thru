function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * AnalyzeUrlToolHandler - Intelligent URL analysis using pattern-based directives
   * Combines knowledge, fetch, and prompt tools for context-aware URL processing
   * Extends ToolBase for consistent behavior
   */

  class AnalyzeUrlToolHandler extends require('tools/ToolBase') {
    constructor() {
      super('analyzeUrl');
    }
    
    /**
     * Get the Claude API tool definition
     * @returns {Object} Tool definition
     */
    getToolDefinition() {
      return {
        name: "analyzeUrl",
        description: `Intelligently analyze a URL using pattern-based directives from the knowledge base.

  WORKFLOW:
  1. Load knowledge base (URL patterns + general context)
  2. Match URL to pattern using wildcard matching
  3. Fetch URL content via fetch
  4. Apply pattern-specific directive via prompt tool
  5. Return structured analysis

  URL PATTERN MATCHING:
  The knowledge sheet contains URL patterns with analysis directives:
  - *.sport80.com/*/rankings/* → Extract competition rankings
  - github.com/*/* → Analyze repository structure
  - */docs/* → Extract technical documentation

  CUSTOM DIRECTIVES:
  You can override pattern matching with a custom directive:
  { "url": "...", "directive": "Extract product prices in JSON format" }

  EXAMPLES:

  1. Auto-match pattern from knowledge:
  {
    "url": "https://usaweightlifting.sport80.com/public/rankings/results/5929"
  }
  → Matches "*.sport80.com/*/rankings/*" pattern
  → Applies "Extract competition rankings" directive

  2. Custom directive (override pattern):
  {
    "url": "https://example.com/products/123",
    "directive": "Extract product ID, name, price, and description as JSON"
  }

  3. Documentation analysis:
  {
    "url": "https://docs.example.com/api/reference"
  }
  → Matches "*/docs/*" pattern
  → Applies documentation extraction directive`,
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to analyze"
            },
            directive: {
              type: "string",
              description: "Optional custom analysis directive (overrides pattern matching)"
            }
          },
          required: ["url"]
        }
      };
    }
    
    /**
     * Execute URL analysis with pattern matching
     * @param {Object} input - Tool input {url, directive?}
     * @param {Object} context - Execution context
     * @returns {Object} Success/error result
     */
    execute(input, context = {}) {
      const think = context.think || function(msg) { Logger.log(msg); };
      
      try {
        const { url, directive: customDirective } = input;
        
        think(`[ANALYZEURL] Analyzing: ${url}`);
        
        // 1. Get knowledge (patterns + context)
        const knowledge = this._getKnowledge(context, think);
        
        // 2. Match URL pattern or use custom directive
        let directive;
        let matchedPattern = null;
        
        if (customDirective) {
          directive = customDirective;
          think(`[ANALYZEURL] Using custom directive`);
        } else {
          const match = this._matchUrlPattern(url, knowledge);
          directive = match.directive;
          matchedPattern = match.pattern;
          think(`[ANALYZEURL] Matched pattern: ${matchedPattern || 'none'}`);
        }
        
        // 3. Fetch URL content
        const urlContent = this._fetchUrl(url, context);
        
        if (!urlContent.success) {
          return this._errorResult(`Failed to fetch URL: ${urlContent.error}`);
        }
        
        // 4. Build analysis prompt
        const analysisPrompt = this._buildAnalysisPrompt(
          url,
          urlContent.content,
          directive,
          knowledge.general
        );
        
        // 5. Execute analysis via prompt tool
        const analysis = this._executeAnalysis(analysisPrompt, context);
        
        if (!analysis.success) {
          return this._errorResult(`Analysis failed: ${analysis.error}`);
        }
        
        // Return structured result
        return this._successResult({
          url: url,
          matchedPattern: matchedPattern,
          directive: directive,
          analysis: analysis.result.response,
          thinking: analysis.result.thinking,
          httpStatus: urlContent.status,
          contentLength: urlContent.content.length
        });
        
      } catch (error) {
        return this._errorResult(error.toString(), error);
      }
    }
    
    /**
     * Get knowledge from knowledge tool
     * @private
     * @param {Object} context - Execution context
     * @param {Function} think - Thinking/logging function
     * @returns {Object} Knowledge data with url_pattern and general arrays
     */
    _getKnowledge(context, think) {
      try {
        const KnowledgeToolHandler = require('tools/KnowledgeToolHandler');
        const knowledgeHandler = new KnowledgeToolHandler();
        
        const result = knowledgeHandler.run({ format: 'json' }, context);
        
        if (result.success && result.result) {
          return {
            url_pattern: result.result.url_pattern || [],
            general: result.result.general || []
          };
        }
        
        return { url_pattern: [], general: [] };
        
      } catch (error) {
        think(`[ANALYZEURL] Knowledge loading failed: ${error.message}`);
        return { url_pattern: [], general: [] };
      }
    }
    
    /**
     * Match URL to pattern using wildcard matching
     * @private
     * @param {string} url - URL to match
     * @param {Object} knowledge - Knowledge data with url_pattern array
     * @returns {Object} {pattern, directive} or {pattern: null, directive: default}
     */
    _matchUrlPattern(url, knowledge) {
      const patterns = knowledge.url_pattern || [];
      
      // Try each pattern
      for (const entry of patterns) {
        const pattern = entry.key;
        const directive = entry.value;
        
        if (this._wildcardMatch(url, pattern)) {
          return { pattern: pattern, directive: directive };
        }
      }
      
      // No match - return default directive
      return {
        pattern: null,
        directive: 'Analyze this URL content and extract the key information in a structured format.'
      };
    }
    
    /**
     * Wildcard pattern matching
     * @private
     * @param {string} text - Text to test
     * @param {string} pattern - Pattern with * wildcards
     * @returns {boolean} True if matches
     */
    _wildcardMatch(text, pattern) {
      // Convert wildcard pattern to regex
      const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
        .replace(/\*/g, '.*'); // Convert * to .*
      
      const regex = new RegExp('^' + regexPattern + '$', 'i');
      return regex.test(text);
    }
    
    /**
     * Fetch URL content via fetch tool
     * @private
     * @param {string} url - URL to fetch
     * @param {Object} context - Execution context
     * @returns {Object} {success, content, status} or {success: false, error}
     */
    _fetchUrl(url, context) {
      try {
        const SearchToolHandler = require('tools/SearchToolHandler');
        const searchHandler = new SearchToolHandler();
        
        const result = searchHandler.run({ url: url }, context);
        
        if (result.success && result.result) {
          return {
            success: true,
            content: result.result.body || result.result.content || '',
            status: result.result.status || 200
          };
        }
        
        return {
          success: false,
          error: result.error || 'Unknown error'
        };
        
      } catch (error) {
        return {
          success: false,
          error: error.toString()
        };
      }
    }
    
    /**
     * Build analysis prompt with context
     * @private
     * @param {string} url - URL being analyzed
     * @param {string} content - URL content
     * @param {string} directive - Analysis directive
     * @param {Array} generalKnowledge - General knowledge entries
     * @returns {string} Complete prompt
     */
    _buildAnalysisPrompt(url, content, directive, generalKnowledge) {
      const parts = [];
      
      parts.push(`# URL Analysis Task`);
      parts.push('');
      parts.push(`**URL:** ${url}`);
      parts.push('');
      parts.push(`**Directive:** ${directive}`);
      parts.push('');
      
      // Add general knowledge context if available
      if (generalKnowledge && generalKnowledge.length > 0) {
        parts.push(`## Context`);
        parts.push('');
        generalKnowledge.forEach(entry => {
          parts.push(`- **${entry.key}:** ${entry.value}`);
        });
        parts.push('');
      }
      
      parts.push(`## Content to Analyze`);
      parts.push('');
      parts.push('```');
      // Truncate content if too long (keep first 10000 chars)
      const truncatedContent = content.length > 10000 
        ? content.substring(0, 10000) + '\n... (content truncated)'
        : content;
      parts.push(truncatedContent);
      parts.push('```');
      parts.push('');
      parts.push(`Please analyze the content according to the directive and provide a structured response.`);
      
      return parts.join('\n');
    }
    
    /**
     * Execute analysis via prompt tool
     * @private
     * @param {string} prompt - Analysis prompt
     * @param {Object} context - Execution context
     * @returns {Object} Prompt tool result
     */
    _executeAnalysis(prompt, context) {
      try {
        const PromptToolHandler = require('tools/PromptToolHandler');
        const promptHandler = new PromptToolHandler();
        
        return promptHandler.run({
          text: prompt,
          maxTokens: 4096,
          enableThinking: false
        }, context);
        
      } catch (error) {
        return {
          success: false,
          error: error.toString()
        };
      }
    }
  }

  module.exports = AnalyzeUrlToolHandler;
}

__defineModule__(_main);