function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * KnowledgeToolHandler - Reads "knowledge" sheet for system-wide context
   * Provides cached access with 2-minute TTL
   * Extends ToolBase for consistent behavior
   */

  class KnowledgeToolHandler extends require('tools/ToolBase') {
    constructor() {
      super('knowledge');
      
      // Cache configuration
      this.enableCache = true;
      this.cache = null;
      this.cacheTimestamp = null;
      this.cacheTTL = 120 * 1000; // 2 minutes in milliseconds
    }
    
    /**
     * Get the Claude API tool definition
     * @returns {Object} Tool definition
     */
    getToolDefinition() {
      return {
        name: "knowledge",
        description: `Access the knowledge sheet with filtering and discovery.
  - No params: returns all entries
  - summary:true: discover available types before fetching (call first when unsure what's available)
  - type/search: filter to specific entries
  Returns user-defined knowledge like URL patterns, configuration, and domain context. Companion write tools: append_knowledge, update_knowledge, delete_knowledge for persistent changes.

  The knowledge is cached for 2 minutes to improve performance.
  Note: summary mode returns structured data regardless of format parameter.`,
        input_schema: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["markdown", "json", "text"],
              default: "markdown",
              description: "Output format. Use 'json' for programmatic access, 'markdown' for display."
            },
            search: {
              type: "string",
              examples: ["club", "/^url_/i", "/ranking.*/"],
              description: "Filter by keyword (case-insensitive) or regex (/pattern/flags). Examples: 'club' matches entries containing 'club', '/^url_.*/i' matches types starting with 'url_'. Searches across type, key, and value fields."
            },
            type: {
              type: "string",
              examples: ["general", "url_pattern", "config"],
              description: "Filter to specific type (exact match). E.g., 'url_pattern', 'general', 'config'. Get available types via summary:true first."
            },
            summary: {
              type: "boolean",
              default: false,
              description: "Returns overview of available types (counts, sample keys/values) instead of entries. Call with summary:true FIRST to discover what's available, then fetch specific entries with type/search."
            }
          },
          required: []  // All parameters optional
        }
      };
    }
    
    /**
     * Execute the knowledge retrieval
     * @param {Object} input - Tool input {format, search, type, summary}
     * @param {Object} context - Execution context
     * @returns {Object} Success/error result
     */
    execute(input, context = {}) {
      const think = context.think || function(msg) { log(msg); };

      try {
        const format = input.format || 'markdown';
        const search = input.search || '';
        const type = input.type || '';
        const summary = input.summary || false;

        // Get knowledge from cache or sheet
        let knowledge = this._getKnowledge(think);

        // Apply filters (type first, then search)
        if (type) {
          knowledge = this._filterByType(knowledge, type);
        }
        if (search) {
          knowledge = this._filterBySearch(knowledge, search);
        }

        // Summary mode - return metadata about types
        if (summary) {
          const summaryData = this._summarizeKnowledge(knowledge);
          return this._successResult(summaryData, {
            mode: 'summary',
            filters: { type: type || null, search: search || null }
          });
        }

        // Format output
        let output;
        switch (format) {
          case 'json':
            output = knowledge;
            break;
          case 'text':
            output = this._formatAsText(knowledge);
            break;
          case 'markdown':
          default:
            output = this._formatAsMarkdown(knowledge);
            break;
        }

        const meta = {
          mode: 'entries',
          filters: { type: type || null, search: search || null },
          rowCount: knowledge.totalRows || 0,
          types: Object.keys(knowledge).filter(k => k !== 'totalRows' && k !== 'error')
        };

        // Help Claude when no results found
        if (knowledge.totalRows === 0 && (type || search)) {
          meta.noResults = true;
          meta.hint = "No entries matched filters. Try 'summary: true' to see available types.";
        }

        return this._successResult(output, meta);

      } catch (error) {
        return this._errorResult(error.toString(), error);
      }
    }
    
    /**
     * Get knowledge from cache or read from sheet
     * @private
     * @param {Function} think - Thinking/logging function
     * @returns {Object} Knowledge data organized by type
     */
    _getKnowledge(think) {
      const now = new Date().getTime();
      
      // Return cached data if caching is enabled and cache is still valid
      if (this.enableCache && this.cache && this.cacheTimestamp && (now - this.cacheTimestamp) < this.cacheTTL) {
        return this.cache;
      }
      
      // Read from sheet
      const knowledge = this._readKnowledgeSheet(think);
      
      // Update cache only if caching is enabled
      if (this.enableCache) {
        this.cache = knowledge;
        this.cacheTimestamp = now;
      }
      
      return knowledge;
    }
    
    /**
     * Read and parse the knowledge sheet
     * @private
     * @param {Function} think - Thinking/logging function
     * @returns {Object} Parsed knowledge organized by type
     */
    _readKnowledgeSheet(think) {
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ss.getSheetByName('knowledge');
        
        if (!sheet) {
          // No knowledge sheet - return empty structure
          return {
            general: [],
            url_pattern: [],
            config: [],
            totalRows: 0
          };
        }
        
        const data = sheet.getDataRange().getValues();
        
        if (data.length === 0) {
          return {
            general: [],
            url_pattern: [],
            config: [],
            totalRows: 0
          };
        }
        
        // Parse rows into structured format
        const knowledge = {
          general: [],
          url_pattern: [],
          config: [],
          totalRows: data.length
        };
        
        data.forEach((row, index) => {
          // Skip empty rows
          if (!row[0] && !row[1] && !row[2]) {
            return;
          }
          
          const type = (row[0] || 'general').toString().toLowerCase().trim();
          const key = (row[1] || '').toString().trim();
          const value = (row[2] || '').toString().trim();
          
          // Create entry
          const entry = {
            type: type,
            key: key,
            value: value,
            row: index + 1
          };
          
          // Add to appropriate type array
          if (knowledge[type]) {
            knowledge[type].push(entry);
          } else {
            // Create new type array if not exists
            knowledge[type] = [entry];
          }
        });
        
        return knowledge;
        
      } catch (error) {
        // If sheet reading fails, return empty structure
        think(`[KNOWLEDGE] Error reading sheet: ${error.message}`);
        return {
          general: [],
          url_pattern: [],
          config: [],
          error: error.message,
          totalRows: 0
        };
      }
    }
    
    /**
     * Format knowledge as markdown
     * @private
     * @param {Object} knowledge - Knowledge data
     * @returns {string} Markdown formatted string
     */
    _formatAsMarkdown(knowledge) {
      const sections = [];
      
      // Add each type as a section
      Object.keys(knowledge).forEach(type => {
        if (type === 'totalRows' || type === 'error') {
          return;
        }
        
        const entries = knowledge[type];
        if (!entries || entries.length === 0) {
          return;
        }
        
        sections.push(`## ${this._capitalize(type)}`);
        sections.push('');
        
        entries.forEach(entry => {
          if (type === 'url_pattern') {
            sections.push(`- **Pattern:** \`${entry.key}\``);
            sections.push(`  **Action:** ${entry.value}`);
          } else {
            sections.push(`- **${entry.key}:** ${entry.value}`);
          }
        });
        
        sections.push('');
      });
      
      if (sections.length === 0) {
        return 'No knowledge entries found.';
      }
      
      return sections.join('\n');
    }
    
    /**
     * Format knowledge as plain text
     * @private
     * @param {Object} knowledge - Knowledge data
     * @returns {string} Plain text formatted string
     */
    _formatAsText(knowledge) {
      const lines = [];
      
      Object.keys(knowledge).forEach(type => {
        if (type === 'totalRows' || type === 'error') {
          return;
        }
        
        const entries = knowledge[type];
        if (!entries || entries.length === 0) {
          return;
        }
        
        lines.push(`[${type.toUpperCase()}]`);
        
        entries.forEach(entry => {
          lines.push(`${entry.key}: ${entry.value}`);
        });
        
        lines.push('');
      });
      
      if (lines.length === 0) {
        return 'No knowledge entries found.';
      }
      
      return lines.join('\n');
    }
    
    /**
     * Capitalize first letter
     * @private
     */
    _capitalize(str) {
      return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * Create a matcher function for search filtering
     * Supports /regex/flags syntax or case-insensitive keyword matching
     * @private
     * @param {string} search - Search pattern (regex or keyword)
     * @returns {Function} Matcher function that tests strings
     */
    _createMatcher(search) {
      // Check for /pattern/flags format
      const regexMatch = search.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexMatch) {
        // Prevent ReDoS with length limit
        if (regexMatch[1].length > 500) {
          throw new Error('Regex pattern too long (max 500 chars)');
        }
        try {
          const regex = new RegExp(regexMatch[1], regexMatch[2] || 'i');
          return (str) => regex.test(String(str || ''));
        } catch (e) {
          throw new Error('Invalid regex pattern: ' + e.message);
        }
      }
      // Keyword: case-insensitive contains
      const lower = search.toLowerCase();
      return (str) => String(str || '').toLowerCase().includes(lower);
    }

    /**
     * Filter knowledge to a specific type
     * @private
     * @param {Object} knowledge - Full knowledge data
     * @param {string} type - Type to filter to (case-insensitive)
     * @returns {Object} Filtered knowledge with only matching type
     */
    _filterByType(knowledge, type) {
      if (!type) return knowledge;

      const typeLower = type.toLowerCase();
      const entries = knowledge[typeLower];
      if (!entries) {
        return { totalRows: 0 };
      }

      return {
        [typeLower]: entries,
        totalRows: entries.length
      };
    }

    /**
     * Filter knowledge by search pattern across all fields
     * @private
     * @param {Object} knowledge - Knowledge data (possibly pre-filtered by type)
     * @param {string} search - Search pattern (regex or keyword)
     * @returns {Object} Filtered knowledge with matching entries
     */
    _filterBySearch(knowledge, search) {
      if (!search || !search.trim()) return knowledge;

      const matcher = this._createMatcher(search);
      const filtered = {};
      let totalRows = 0;

      for (const [type, entries] of Object.entries(knowledge)) {
        if (type === 'totalRows' || type === 'error') continue;
        if (!Array.isArray(entries)) continue;

        const matches = entries.filter(e =>
          matcher(e.type) || matcher(e.key) || matcher(e.value)
        );
        if (matches.length) {
          filtered[type] = matches;
          totalRows += matches.length;
        }
      }
      filtered.totalRows = totalRows;
      return filtered;
    }

    /**
     * Generate summary metadata about available knowledge types
     * @private
     * @param {Object} knowledge - Knowledge data
     * @returns {Object} Summary with type counts and samples
     */
    _summarizeKnowledge(knowledge) {
      const types = [];

      for (const [type, entries] of Object.entries(knowledge)) {
        if (type === 'totalRows' || type === 'error') continue;
        if (!Array.isArray(entries) || entries.length === 0) continue;

        types.push({
          type: type,
          count: entries.length,
          sampleKeys: entries.slice(0, 5).map(e => e.key),
          sampleValues: entries.slice(0, 3).map(e => {
            const val = String(e.value || '');
            return val.substring(0, 80) + (val.length > 80 ? '...' : '');
          })
        });
      }

      return {
        types: types,
        totalTypes: types.length,
        totalRows: knowledge.totalRows || 0
      };
    }

    /**
     * Clear the cache (for testing)
     */
    clearCache() {
      this.cache = null;
      this.cacheTimestamp = null;
    }
  }

  module.exports = KnowledgeToolHandler;
}

__defineModule__(_main);