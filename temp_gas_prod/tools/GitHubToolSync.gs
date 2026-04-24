function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * GitHubToolSync - Syncs tool definitions from GitHub to _Tools sheet
   * 
   * Architecture:
   * - _ToolSources sheet contains URLs to GitHub JSON files
   * - This module fetches tools and syncs to _Tools sheet (the cache)
   * - Sync metadata stored in Developer Metadata (invisible to users)
   * - Zero impact on ToolRegistry loading - just reads _Tools sheet
   * 
   * Supports two formats:
   * 
   * V1 Format (tools.json - array of tool objects):
   * [
   *   {"name": "tool1", "description": "...", "params": "id!", "implementation": "return input.id;"},
   *   {"name": "tool2", "description": "...", "params": "...", "implementation": "..."}
   * ]
   * 
   * V2 Format (manifest.json - file references):
   * {
   *   "version": "2.0",
   *   "files": ["tool1.gs", "tool1.test.gs", "tool2.gs"]
   * }
   * 
   * V2 files use module.exports pattern:
   * module.exports = { name, description, params, returns, enabled, execute: function(input) {...} }
   */

  class GitHubToolSync {
    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Sync all enabled sources from _ToolSources sheet
     * @param {Object} options
     * @param {boolean} options.force - Force re-sync even if SHA unchanged
     * @returns {Object} {success, sourceCount, toolCount, errors}
     */
    static syncAll(options = {}) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        return { success: false, error: 'No active spreadsheet' };
      }

      const sources = this._readToolSources(ss);
      const enabledSources = sources.filter(s => s.enabled);

      if (enabledSources.length === 0) {
        Logger.log('[GitHubToolSync] No enabled sources found');
        return { success: true, sourceCount: 0, toolCount: 0, testCount: 0, errors: [] };
      }

      Logger.log(`[GitHubToolSync] Syncing ${enabledSources.length} enabled source(s)`);

      // Parallel SHA check (fetchAll - much faster than sequential)
      const shas = this._fetchAllShas(enabledSources);

      let totalToolCount = 0;
      let totalTestCount = 0;
      const errors = [];
      let syncedCount = 0;

      for (let i = 0; i < enabledSources.length; i++) {
        const source = enabledSources[i];
        const currentSha = shas[i];
        const storedMeta = this._getMetadata(ss, source.url);
        const sourceTag = this._parseSourceTag(source.url);

        // Skip if SHA unchanged (unless force flag set)
        if (!options.force && currentSha && currentSha === storedMeta?.sha) {
          Logger.log(`[GitHubToolSync] Skipping ${sourceTag} - SHA unchanged`);
          continue;
        }

        // SHA changed or force - fetch and sync
        try {
          const result = this._syncSingleSource(ss, source, sourceTag, currentSha);
          if (result.success) {
            totalToolCount += result.toolCount || 0;
            totalTestCount += result.testCount || 0;
            syncedCount++;
          } else {
            errors.push({ url: source.url, error: result.error });
          }
        } catch (e) {
          Logger.log(`[GitHubToolSync] Error syncing ${sourceTag}: ${e.message}`);
          errors.push({ url: source.url, error: e.message });
        }
      }

      Logger.log(`[GitHubToolSync] Sync complete: ${syncedCount} sources, ${totalToolCount} tools, ${totalTestCount} tests`);
      return {
        success: errors.length === 0,
        sourceCount: syncedCount,
        toolCount: totalToolCount,
        testCount: totalTestCount,
        errors: errors
      };
    }

    /**
     * Sync a single source by URL
     * @param {string} url - GitHub raw URL
     * @param {Object} options
     * @param {boolean} options.force - Force re-sync even if SHA unchanged
     * @returns {Object} {success, toolCount, error}
     */
    static syncSource(url, options = {}) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        return { success: false, error: 'No active spreadsheet' };
      }

      const parsed = this._parseGitHubUrl(url);
      if (!parsed) {
        return { success: false, error: 'Invalid GitHub URL' };
      }

      const source = { url: url, enabled: true };
      const sourceTag = this._parseSourceTag(url);

      // Check SHA if not forcing
      if (!options.force) {
        const currentSha = this._fetchSha(parsed);
        const storedMeta = this._getMetadata(ss, url);
        if (currentSha && currentSha === storedMeta?.sha) {
          Logger.log(`[GitHubToolSync] Skipping ${sourceTag} - SHA unchanged`);
          return { success: true, toolCount: 0, skipped: true };
        }
      }

      const currentSha = this._fetchSha(parsed);
      return this._syncSingleSource(ss, source, sourceTag, currentSha);
    }

    /**
     * Check for updates without syncing
     * @returns {Object} {outdated: [{url, currentSha, storedSha}]}
     */
    static checkForUpdates() {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        return { success: false, error: 'No active spreadsheet' };
      }

      const sources = this._readToolSources(ss);
      const enabledSources = sources.filter(s => s.enabled);
      const shas = this._fetchAllShas(enabledSources);

      const outdated = [];
      for (let i = 0; i < enabledSources.length; i++) {
        const source = enabledSources[i];
        const currentSha = shas[i];
        const storedMeta = this._getMetadata(ss, source.url);

        if (currentSha && currentSha !== storedMeta?.sha) {
          outdated.push({
            url: source.url,
            name: this._parseSourceTag(source.url),
            currentSha: currentSha,
            storedSha: storedMeta?.sha || null
          });
        }
      }

      return { success: true, outdated: outdated };
    }

    /**
     * Invalidate all sync metadata and force reload
     * @returns {Object} {success, sourceCount, toolCount}
     */
    static invalidateAndReload() {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) {
        return { success: false, error: 'No active spreadsheet' };
      }

      // Clear all sync metadata
      const allMeta = ss.getDeveloperMetadata();
      let cleared = 0;
      allMeta.forEach(m => {
        if (m.getKey().startsWith('TOOL_SOURCE_')) {
          m.remove();
          cleared++;
        }
      });

      Logger.log(`[GitHubToolSync] Cleared ${cleared} metadata entries`);

      // Force sync all
      return this.syncAll({ force: true });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V2 MANIFEST SUPPORT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Check if URL points to a v2 manifest
     * @private
     */
    static _isV2ManifestUrl(url) {
      return url.endsWith('manifest.json');
    }

    /**
     * Check if fetched content is v2 format
     * @private
     */
    static _isV2Manifest(content) {
      return content && typeof content === 'object' && 
             content.version && content.version.startsWith('2.') &&
             Array.isArray(content.files);
    }

    /**
     * Sync a v2 manifest source
     * @private
     */
    static _syncV2Source(ss, source, sourceTag, manifest) {
      const ModuleLoader = require('tools/ModuleLoader');
      const ToolTestRunner = require('tools/ToolTestRunner');
      
      const baseUrl = source.url.replace(/manifest\.json$/, '');
      const files = manifest.files || [];
      
      Logger.log(`[GitHubToolSync] V2 manifest: ${files.length} files`);
      
      // Fetch all files in parallel
      const fileRequests = files.map(filename => ({
        url: baseUrl + filename,
        method: 'GET',
        muteHttpExceptions: true
      }));
      
      const responses = UrlFetchApp.fetchAll(fileRequests);
      
      const tools = [];
      const tests = [];
      const errors = [];
      
      responses.forEach((response, index) => {
        const filename = files[index];
        const code = response.getResponseCode();
        
        if (code !== 200) {
          Logger.log(`[GitHubToolSync] Failed to fetch ${filename}: HTTP ${code}`);
          errors.push({ file: filename, error: `HTTP ${code}` });
          return;
        }
        
        const content = response.getContentText();
        const isTest = ModuleLoader.isTestFile(filename);
        
        // Extract metadata by executing module
        const metaResult = ModuleLoader.extractMetadata(content, filename);
        
        if (!metaResult.success) {
          Logger.log(`[GitHubToolSync] Failed to parse ${filename}: ${metaResult.error}`);
          errors.push({ file: filename, error: metaResult.error });
          return;
        }
        
        const metadata = metaResult.metadata;
        
        if (isTest) {
          tests.push({
            name: metadata.name || ModuleLoader.getToolName(filename) + '_test',
            description: metadata.description || '',
            implementation: content,
            enabled: metadata.enabled !== false,
            examples: metadata.examples ? JSON.stringify(metadata.examples) : '',
            expects: metadata.expects || '',
            tool_name: ModuleLoader.getToolName(filename)
          });
        } else {
          tools.push({
            name: metadata.name,
            description: metadata.description,
            params: metadata.params || '',
            implementation: content,
            enabled: metadata.enabled !== false,
            returns: metadata.returns || ''
          });
        }
      });
      
      // Always call delete to clean orphans (even when source has zero tools)
      const toolNames = tools.map(t => t.name);
      this._deleteRemovedTools(ss, sourceTag, toolNames);
      
      // Sync tools to _Tools sheet
      if (tools.length > 0) {
        this._syncToToolsSheet(ss, tools, sourceTag);
      }
      
      // Always call delete to clean orphans (even when source has zero tests)
      const testNames = tests.map(t => t.name);
      this._deleteRemovedTests(ss, sourceTag, testNames);
      
      // Sync tests to _Tests sheet
      if (tests.length > 0) {
        ToolTestRunner.ensureTestsSheet(ss);
        this._syncToTestsSheet(ss, tests, sourceTag);
      }
      
      Logger.log(`[GitHubToolSync] V2 sync: ${tools.length} tools, ${tests.length} tests, ${errors.length} errors`);
      
      return {
        success: errors.length === 0,
        toolCount: tools.length,
        testCount: tests.length,
        errors: errors
      };
    }

    /**
     * Sync tests to _Tests sheet
     * @private
     */
    static _syncToTestsSheet(ss, tests, sourceTag) {
      const sheet = ss.getSheetByName('_Tests');
      if (!sheet) {
        throw new Error('_Tests sheet not found');
      }

      const data = sheet.getDataRange().getValues();
      if (data.length < 1) {
        throw new Error('_Tests sheet has no headers');
      }

      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const nameIdx = headers.indexOf('name');
      const descIdx = headers.indexOf('description');
      const implIdx = headers.indexOf('implementation');
      const enabledIdx = headers.indexOf('enabled');
      const examplesIdx = headers.indexOf('examples');
      const expectsIdx = headers.indexOf('expects');
      const toolNameIdx = headers.indexOf('tool_name');
      const sourceIdx = headers.indexOf('_source');

      // Build existing tests map
      const existingTests = new Map();
      for (let i = 1; i < data.length; i++) {
        const name = String(data[i][nameIdx] || '').trim();
        if (name) {
          existingTests.set(name, {
            rowIndex: i + 1,
            source: String(data[i][sourceIdx] || '').trim()
          });
        }
      }

      const updates = [];
      const adds = [];

      for (const test of tests) {
        const existing = existingTests.get(test.name);

        if (existing) {
          if (!existing.source || existing.source === sourceTag) {
            updates.push({ rowIndex: existing.rowIndex, test });
          }
        } else {
          adds.push(test);
        }
      }

      // Apply updates
      for (const update of updates) {
        const row = update.rowIndex;
        const t = update.test;
        
        const rowValues = [];
        for (let col = 0; col < headers.length; col++) {
          if (col === nameIdx) rowValues.push(t.name);
          else if (col === descIdx) rowValues.push(t.description || '');
          else if (col === implIdx) rowValues.push(t.implementation);
          else if (col === enabledIdx) rowValues.push(t.enabled !== false);
          else if (col === examplesIdx) rowValues.push(t.examples || '');
          else if (col === expectsIdx) rowValues.push(t.expects || '');
          else if (col === toolNameIdx) rowValues.push(t.tool_name || '');
          else if (col === sourceIdx) rowValues.push(sourceTag);
          else rowValues.push('');
        }
        
        sheet.getRange(row, 1, 1, rowValues.length).setValues([rowValues]);
      }

      // Append new tests
      for (const t of adds) {
        const rowValues = [];
        for (let col = 0; col < headers.length; col++) {
          if (col === nameIdx) rowValues.push(t.name);
          else if (col === descIdx) rowValues.push(t.description || '');
          else if (col === implIdx) rowValues.push(t.implementation);
          else if (col === enabledIdx) rowValues.push(t.enabled !== false);
          else if (col === examplesIdx) rowValues.push(t.examples || '');
          else if (col === expectsIdx) rowValues.push(t.expects || '');
          else if (col === toolNameIdx) rowValues.push(t.tool_name || '');
          else if (col === sourceIdx) rowValues.push(sourceTag);
          else rowValues.push('');
        }
        
        sheet.appendRow(rowValues);
      }

      Logger.log(`[GitHubToolSync] Tests: updated ${updates.length}, added ${adds.length}`);
    }

    /**
     * Delete tests from _Tests sheet that are no longer in source
     * @private
     */
    static _deleteRemovedTests(ss, sourceTag, currentTestNames) {
      const sheet = ss.getSheetByName('_Tests');
      if (!sheet) return 0;

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return 0;

      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const nameIdx = headers.indexOf('name');
      const sourceIdx = headers.indexOf('_source');
      if (nameIdx === -1 || sourceIdx === -1) return 0;

      const testNameSet = new Set(currentTestNames);
      const rowsToDelete = [];

      for (let i = data.length - 1; i >= 1; i--) {
        const name = String(data[i][nameIdx] || '').trim();
        const source = String(data[i][sourceIdx] || '').trim();

        if (source === sourceTag && !testNameSet.has(name)) {
          rowsToDelete.push(i + 1);
          Logger.log(`[GitHubToolSync] Deleting removed test: ${name}`);
        }
      }

      for (const row of rowsToDelete) {
        sheet.deleteRow(row);
      }

      return rowsToDelete.length;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SHEET OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Read enabled sources from _ToolSources sheet
     * @private
     */
    static _readToolSources(ss) {
      const sheet = ss.getSheetByName('_ToolSources');
      if (!sheet) {
        Logger.log('[GitHubToolSync] _ToolSources sheet not found');
        return [];
      }

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return [];

      // Expected headers: url, enabled, ttl
      const sources = [];
      for (let i = 1; i < data.length; i++) {
        const url = String(data[i][0] || '').trim();
        if (!url) continue;

        const enabledCell = data[i][1];
        const enabled = enabledCell !== false &&
                        enabledCell !== 'FALSE' &&
                        String(enabledCell).toUpperCase() !== 'FALSE';

        const ttl = parseInt(data[i][2], 10) || 0;

        sources.push({ url, enabled, ttl, row: i + 1 });
      }

      return sources;
    }

    /**
     * Get tools from _Tools sheet by source tag
     * @private
     */
    static _getToolsBySource(ss, sourceTag) {
      const sheet = ss.getSheetByName('_Tools');
      if (!sheet) return [];

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return [];

      // Find _source column (should be column G, index 6)
      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const sourceColIndex = headers.indexOf('_source');
      if (sourceColIndex === -1) return [];

      const tools = [];
      for (let i = 1; i < data.length; i++) {
        const source = String(data[i][sourceColIndex] || '').trim();
        if (source === sourceTag) {
          tools.push({
            name: String(data[i][0] || '').trim(),
            rowIndex: i + 1  // 1-indexed
          });
        }
      }

      return tools;
    }

    /**
     * Sync tools to _Tools sheet
     * @private
     */
    static _syncToToolsSheet(ss, tools, sourceTag) {
      const sheet = ss.getSheetByName('_Tools');
      if (!sheet) {
        throw new Error('_Tools sheet not found');
      }

      const data = sheet.getDataRange().getValues();
      if (data.length < 1) {
        throw new Error('_Tools sheet has no headers');
      }

      // Validate headers
      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const nameIdx = headers.indexOf('name');
      const descIdx = headers.indexOf('description');
      const paramsIdx = headers.indexOf('params');
      const implIdx = headers.indexOf('implementation');
      const enabledIdx = headers.indexOf('enabled');
      const returnsIdx = headers.indexOf('returns');
      const sourceIdx = headers.indexOf('_source');

      if (nameIdx === -1 || implIdx === -1) {
        throw new Error('_Tools sheet missing required columns (name, implementation)');
      }

      // Build existing tools map
      const existingTools = new Map();  // name -> {rowIndex, source}
      for (let i = 1; i < data.length; i++) {
        const name = String(data[i][nameIdx] || '').trim();
        if (name) {
          existingTools.set(name, {
            rowIndex: i + 1,
            source: String(data[i][sourceIdx] || '').trim()
          });
        }
      }

      // Track rows to update/add
      const updates = [];  // {rowIndex, values}
      const adds = [];     // {values}
      const localOverrides = [];

      for (const tool of tools) {
        const existing = existingTools.get(tool.name);

        if (existing) {
          if (!existing.source) {
            // Local override - skip but log
            localOverrides.push(tool.name);
            continue;
          } else if (existing.source === sourceTag) {
            // Same source - update
            updates.push({
              rowIndex: existing.rowIndex,
              tool: tool
            });
          } else {
            // Different source - overwrite (last source wins)
            Logger.log(`[GitHubToolSync] Overwriting '${tool.name}' from ${existing.source}`);
            updates.push({
              rowIndex: existing.rowIndex,
              tool: tool
            });
          }
        } else {
          // New tool - add
          adds.push(tool);
        }
      }

      // Log local overrides
      if (localOverrides.length > 0) {
        Logger.log(`[GitHubToolSync] WARNING: Local overrides exist for: ${localOverrides.join(', ')}`);
      }

      // Apply updates
      for (const update of updates) {
        const row = update.rowIndex;
        const t = update.tool;
        
        // Build row values maintaining column order
        const rowValues = [];
        for (let col = 0; col < headers.length; col++) {
          if (col === nameIdx) rowValues.push(t.name);
          else if (col === descIdx) rowValues.push(t.description || '');
          else if (col === paramsIdx) rowValues.push(t.params || '');
          else if (col === implIdx) rowValues.push(t.implementation);
          else if (col === enabledIdx) rowValues.push(t.enabled !== false);
          else if (col === returnsIdx) rowValues.push(t.returns || '');
          else if (col === sourceIdx) rowValues.push(sourceTag);
          else rowValues.push('');
        }
        
        sheet.getRange(row, 1, 1, rowValues.length).setValues([rowValues]);
      }

      // Append new tools
      for (const t of adds) {
        const rowValues = [];
        for (let col = 0; col < headers.length; col++) {
          if (col === nameIdx) rowValues.push(t.name);
          else if (col === descIdx) rowValues.push(t.description || '');
          else if (col === paramsIdx) rowValues.push(t.params || '');
          else if (col === implIdx) rowValues.push(t.implementation);
          else if (col === enabledIdx) rowValues.push(t.enabled !== false);
          else if (col === returnsIdx) rowValues.push(t.returns || '');
          else if (col === sourceIdx) rowValues.push(sourceTag);
          else rowValues.push('');
        }
        
        sheet.appendRow(rowValues);
      }

      Logger.log(`[GitHubToolSync] Updated ${updates.length}, added ${adds.length} tools`);
      return { updated: updates.length, added: adds.length, localOverrides };
    }

    /**
     * Delete tools from _Tools sheet that are no longer in source
     * @private
     */
    static _deleteRemovedTools(ss, sourceTag, currentToolNames) {
      const sheet = ss.getSheetByName('_Tools');
      if (!sheet) return 0;

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return 0;

      const headers = data[0].map(h => String(h).toLowerCase().trim());
      const nameIdx = headers.indexOf('name');
      const sourceIdx = headers.indexOf('_source');
      if (nameIdx === -1 || sourceIdx === -1) return 0;

      const toolNameSet = new Set(currentToolNames);
      const rowsToDelete = [];  // Collect from bottom-up

      for (let i = data.length - 1; i >= 1; i--) {
        const name = String(data[i][nameIdx] || '').trim();
        const source = String(data[i][sourceIdx] || '').trim();

        if (source === sourceTag && !toolNameSet.has(name)) {
          rowsToDelete.push(i + 1);  // 1-indexed
          Logger.log(`[GitHubToolSync] Deleting removed tool: ${name}`);
        }
      }

      // Delete from bottom-up to avoid index shifts
      for (const row of rowsToDelete) {
        sheet.deleteRow(row);
      }

      return rowsToDelete.length;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GITHUB OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Parse GitHub raw URL to components
     * @private
     */
    static _parseGitHubUrl(url) {
      // https://raw.githubusercontent.com/owner/repo/branch/path.json
      const match = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/);
      if (!match) {
        // Also support gist URLs
        const gistMatch = url.match(/^https:\/\/gist\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/raw\/(.+)$/);
        if (gistMatch) {
          return {
            type: 'gist',
            owner: gistMatch[1],
            gistId: gistMatch[2],
            path: gistMatch[3],
            rawUrl: url
          };
        }
        return null;
      }

      return {
        type: 'repo',
        owner: match[1],
        repo: match[2],
        branch: match[3],
        path: match[4],
        rawUrl: url
      };
    }

    /**
     * Parse source tag from URL (e.g., "github:owner/repo")
     * @private
     */
    static _parseSourceTag(url) {
      const parsed = this._parseGitHubUrl(url);
      if (!parsed) return 'github:unknown';

      if (parsed.type === 'gist') {
        return `gist:${parsed.owner}/${parsed.gistId.substring(0, 8)}`;
      }
      return `github:${parsed.owner}/${parsed.repo}`;
    }

    /**
     * Fetch SHA for a single source via GitHub API
     * @private
     */
    static _fetchSha(parsed) {
      if (parsed.type === 'gist') {
        // Gists don't have easy SHA access, use modified time as proxy
        return null;
      }

      const pat = PropertiesService.getScriptProperties().getProperty('GITHUB_PAT') || '';
      const headers = { 'User-Agent': 'GAS-ToolSync' };
      if (pat) {
        headers['Authorization'] = `token ${pat}`;
      }

      const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${parsed.branch}`;

      try {
        const response = UrlFetchApp.fetch(apiUrl, {
          method: 'GET',
          headers: headers,
          muteHttpExceptions: true
        });

        const code = response.getResponseCode();
        if (code !== 200) {
          Logger.log(`[GitHubToolSync] SHA fetch failed: ${code}`);
          return null;
        }

        const data = JSON.parse(response.getContentText());
        return data.sha;
      } catch (e) {
        Logger.log(`[GitHubToolSync] SHA fetch error: ${e.message}`);
        return null;
      }
    }

    /**
     * Fetch SHAs for multiple sources in parallel using fetchAll
     * @private
     */
    static _fetchAllShas(sources) {
      const pat = PropertiesService.getScriptProperties().getProperty('GITHUB_PAT') || '';
      const baseHeaders = { 'User-Agent': 'GAS-ToolSync' };
      if (pat) {
        baseHeaders['Authorization'] = `token ${pat}`;
      }

      const requests = sources.map(source => {
        const parsed = this._parseGitHubUrl(source.url);
        if (!parsed || parsed.type === 'gist') {
          return null;  // Can't get SHA for gists
        }

        return {
          url: `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${parsed.branch}`,
          method: 'GET',
          headers: baseHeaders,
          muteHttpExceptions: true
        };
      });

      // Filter out null requests and track indices
      const validRequests = [];
      const requestIndices = [];
      requests.forEach((req, i) => {
        if (req) {
          validRequests.push(req);
          requestIndices.push(i);
        }
      });

      if (validRequests.length === 0) {
        return sources.map(() => null);
      }

      // Parallel fetch
      const responses = UrlFetchApp.fetchAll(validRequests);

      // Map results back to original indices
      const shas = sources.map(() => null);
      responses.forEach((response, i) => {
        const originalIndex = requestIndices[i];
        try {
          if (response.getResponseCode() === 200) {
            const data = JSON.parse(response.getContentText());
            shas[originalIndex] = data.sha;
          }
        } catch (e) {
          // Keep null
        }
      });

      return shas;
    }

    /**
     * Fetch content from GitHub raw URL
     * @private
     */
    static _fetchContent(url) {
      try {
        const response = UrlFetchApp.fetch(url, {
          method: 'GET',
          muteHttpExceptions: true
        });

        const code = response.getResponseCode();
        if (code === 404) {
          throw new Error('File not found (404)');
        } else if (code === 401 || code === 403) {
          throw new Error('Access denied - check if repo is private');
        } else if (code >= 500) {
          throw new Error(`GitHub error (${code})`);
        } else if (code !== 200) {
          throw new Error(`HTTP ${code}`);
        }

        return response.getContentText();
      } catch (e) {
        if (e.message.includes('Timeout')) {
          throw new Error('Request timeout - file may be too large');
        }
        throw e;
      }
    }

    /**
     * Fetch and parse tools JSON from GitHub raw URL (V1 format)
     * @private
     */
    static _fetchTools(url) {
      const content = this._fetchContent(url);
      const parsed = JSON.parse(content);

      // Check if V2 manifest
      if (this._isV2Manifest(parsed)) {
        return { isV2: true, manifest: parsed };
      }

      // V1 format - array of tools
      if (!Array.isArray(parsed)) {
        throw new Error('Invalid format - expected array of tools or v2 manifest');
      }

      // Validate each tool
      const validTools = [];
      for (let i = 0; i < parsed.length; i++) {
        const tool = parsed[i];
        if (!tool.name) {
          Logger.log(`[GitHubToolSync] Skipping tool at index ${i}: missing name`);
          continue;
        }
        if (!tool.implementation) {
          Logger.log(`[GitHubToolSync] Skipping tool '${tool.name}': missing implementation`);
          continue;
        }
        // Validate implementation size (50KB limit)
        if (tool.implementation.length > 50000) {
          Logger.log(`[GitHubToolSync] ERROR: Tool '${tool.name}' exceeds 50KB limit (${tool.implementation.length} bytes) - skipping`);
          continue;
        }
        validTools.push(tool);
      }

      return { isV2: false, tools: validTools };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEVELOPER METADATA (sync state storage)
    // ═══════════════════════════════════════════��═══════════════════════════════

    /**
     * Hash URL to metadata key
     * @private
     */
    static _hashUrl(url) {
      // Simple hash for URL -> key
      let hash = 0;
      for (let i = 0; i < url.length; i++) {
        const char = url.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;  // Convert to 32bit integer
      }
      return Math.abs(hash).toString(36);
    }

    /**
     * Get sync metadata for a source URL
     * @private
     */
    static _getMetadata(ss, url) {
      const key = 'TOOL_SOURCE_' + this._hashUrl(url);
      try {
        const allMeta = ss.getDeveloperMetadata();
        const meta = allMeta.find(m => m.getKey() === key);
        if (meta) {
          return JSON.parse(meta.getValue());
        }
      } catch (e) {
        Logger.log(`[GitHubToolSync] Error reading metadata: ${e.message}`);
      }
      return null;
    }

    /**
     * Set sync metadata for a source URL
     * @private
     */
    static _setMetadata(ss, url, data) {
      const key = 'TOOL_SOURCE_' + this._hashUrl(url);
      try {
        // Remove existing
        const allMeta = ss.getDeveloperMetadata();
        const existing = allMeta.find(m => m.getKey() === key);
        if (existing) {
          existing.remove();
        }
        // Add new
        ss.addDeveloperMetadata(key, JSON.stringify(data));
      } catch (e) {
        Logger.log(`[GitHubToolSync] Error setting metadata: ${e.message}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Sync a single source (internal implementation)
     * Routes to V1 or V2 handler based on content
     * @private
     */
    static _syncSingleSource(ss, source, sourceTag, currentSha) {
      Logger.log(`[GitHubToolSync] Syncing ${sourceTag}...`);

      // Fetch content and detect format
      const fetchResult = this._fetchTools(source.url);
      
      if (fetchResult.isV2) {
        // V2 manifest - delegate to V2 handler
        Logger.log(`[GitHubToolSync] Detected V2 manifest format`);
        const v2Result = this._syncV2Source(ss, source, sourceTag, fetchResult.manifest);
        
        // Update metadata
        this._setMetadata(ss, source.url, {
          sha: currentSha,
          lastSync: new Date().toISOString(),
          toolCount: v2Result.toolCount,
          testCount: v2Result.testCount,
          version: 'v2',
          status: v2Result.success ? 'OK' : 'PARTIAL',
          name: sourceTag
        });
        
        return v2Result;
      }

      // V1 format - original logic
      const tools = fetchResult.tools;
      const toolNames = tools.map(t => t.name);

      // Delete removed tools first
      const deleted = this._deleteRemovedTools(ss, sourceTag, toolNames);

      // Sync tools to sheet
      const syncResult = this._syncToToolsSheet(ss, tools, sourceTag);

      // Update metadata
      this._setMetadata(ss, source.url, {
        sha: currentSha,
        lastSync: new Date().toISOString(),
        toolCount: tools.length,
        version: 'v1',
        status: 'OK',
        name: sourceTag
      });

      Logger.log(`[GitHubToolSync] ${sourceTag}: ${tools.length} tools (${deleted} deleted, ${syncResult.added} added, ${syncResult.updated} updated)`);

      return {
        success: true,
        toolCount: tools.length,
        testCount: 0,
        deleted: deleted,
        added: syncResult.added,
        updated: syncResult.updated
      };
    }

  }

  module.exports = GitHubToolSync;
}

__defineModule__(_main);