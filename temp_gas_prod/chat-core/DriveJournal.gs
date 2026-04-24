function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const ConfigManager = require('common-js/ConfigManager');

    // ============================================================================
    // DIRECT FILE ACCESS
    // conversationId IS the Drive file ID (single-ID model)
    // DriveApp.getFileById() = 1 API call vs folder lookup + file search = 3 API calls
    // ============================================================================

    /**
     * Get journal file by conversationId (which IS the Drive file ID).
     * @param {string} conversationId - Drive file ID
     * @returns {GoogleAppsScript.Drive.File|null}
     */
    function _resolveJournalFile(conversationId) {
      try {
        return DriveApp.getFileById(conversationId);
      } catch (e) {
        log(`[DriveJournal] File not found: ${conversationId}`);
        return null;
      }
    }

    /**
     * Get journal folder from configuration
     * Creates folder if it doesn't exist
     * Journaling is always enabled - no opt-out
     * @returns {GoogleAppsScript.Drive.Folder|null} Journal folder or null if not accessible
     */
    function getJournalFolder() {
      try {
        const config = new ConfigManager('CLAUDE_CHAT');
        const folderId = config.get('JOURNAL_FOLDER_ID');
        
        if (folderId) {
          // Use configured folder
          try {
            return DriveApp.getFolderById(folderId);
          } catch (e) {
            log(`[DriveJournal] Configured folder not accessible: ${folderId}`);
            return null;
          }
        } else {
          // Create or get "Sheets Chat Conversations" folder as default
          const folderName = 'SheetChat-Journal';
          const existingFolders = DriveApp.getFoldersByName(folderName);
          
          if (existingFolders.hasNext()) {
            // Folder exists, use it
            return existingFolders.next();
          } else {
            // Create the folder
            const newFolder = DriveApp.createFolder(folderName);
            log(`[DriveJournal] Created default folder: ${folderName}`);
            return newFolder;
          }
        }
      } catch (error) {
        log(`[DriveJournal] Error getting journal folder: ${error.message}`);
        return null;
      }
    }

    /**
     * Extract and validate folder ID from URL or raw ID
     * @param {string} urlOrId - Drive URL or folder ID
     * @returns {Object} {success, folderId, folderName, error}
     */
    function extractAndValidateFolderId(urlOrId) {
      if (!urlOrId || typeof urlOrId !== 'string') {
        return { success: false, error: 'No folder URL or ID provided' };
      }
      
      const trimmed = urlOrId.trim();
      
      // Empty string = use default folder
      if (trimmed === '') {
        return { success: true, folderId: '', useDefault: true };
      }
      
      let folderId = null;
      
      // Just an ID (no slashes or query params)
      if (!trimmed.includes('/') && !trimmed.includes('?')) {
        folderId = trimmed;
      } else {
        // Remove query parameters first
        const withoutQuery = trimmed.split('?')[0];
        
        // Modern format: /folders/{ID}
        let match = withoutQuery.match(/\/folders\/([a-zA-Z0-9_-]+)/);
        if (match) {
          folderId = match[1];
        } else {
          // Legacy format: ?id={ID}
          match = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
          if (match) {
            folderId = match[1];
          }
        }
      }
      
      if (!folderId) {
        return {
          success: false,
          error: 'Invalid Drive folder URL. Please paste the full URL from your browser address bar.'
        };
      }
      
      // Validate folder exists and is accessible
      try {
        const folder = DriveApp.getFolderById(folderId);
        const name = folder.getName();
        
        return {
          success: true,
          folderId: folderId,
          folderName: name,
          validated: true
        };
      } catch (error) {
        return {
          success: false,
          error: 'Cannot access this folder. It may have been deleted or you may not have permission.',
          folderId: folderId
        };
      }
    }

    /**
     * Get Drive URL for folder ID
     * @param {string} folderId - Folder ID
     * @returns {string} Drive URL
     */
    function getFolderUrl(folderId) {
      if (!folderId) return '';
      return `https://drive.google.com/drive/folders/${folderId}`;
    }

    /**
     * Get journal file name for conversation
     * Format: journal-{conversationId}.json
     * @param {string} conversationId - Conversation ID
     * @returns {string} File name
     */
    function getJournalFileName(conversationId) {
      return `journal-${conversationId}.json`;
    }

    /**
     * Create new journal file in Drive
     * The Drive file ID becomes the conversationId (single-ID model).
     * @param {string} userEmail - User email for metadata
     * @returns {Object} {success, data: {fileId, url}, error}
     */
    function createJournal(userEmail) {
      const startTime = Date.now();

      try {
        const folder = getJournalFolder();

        if (!folder) {
          return {
            success: false,
            error: 'Journaling is disabled or folder not accessible',
            disabled: true
          };
        }

        // Filename is for human readability in Drive only - not used for lookup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `journal-${timestamp}.json`;

        // Create initial journal structure (conversationId set after file creation)
        const journalData = {
          conversationId: null,
          createdAt: new Date().toISOString(),
          userEmail: userEmail,
          messages: [],
          title: null  // null until renamed by LLM
        };

        // Create file
        const blob = Utilities.newBlob(
          JSON.stringify(journalData, null, 2),
          'application/json',
          fileName
        );

        const file = folder.createFile(blob);
        const fileId = file.getId();

        // Set conversationId to the Drive file ID
        journalData.conversationId = fileId;
        file.setContent(JSON.stringify(journalData, null, 2));

        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Created journal in ${elapsed}ms: ${fileId}`);

        return {
          success: true,
          data: {
            fileId: fileId,
            url: file.getUrl(),
            created: true
          }
        };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Error creating journal (${elapsed}ms): ${error.message}`);
        return {
          success: false,
          error: error.message
        };
      }
    }

    /**
     * Append messages to journal
     * Reads existing file, appends messages, writes back
     * Uses LockService to prevent race conditions during read-modify-write
     * @param {string} conversationId - Conversation ID
     * @param {Array} messages - Messages to append
     * @returns {Object} {success, data: {messageCount}, error}
     */
    function appendToJournal(conversationId, messages) {
      const startTime = Date.now();
      
      // Validate messages parameter
      if (!messages || !Array.isArray(messages)) {
        return {
          success: false,
          error: 'Invalid messages parameter: must be a non-empty array'
        };
      }
      
      if (messages.length === 0) {
        return {
          success: true,
          data: { messageCount: 0 },
          skipped: 'empty array'
        };
      }
      
      // P2 Bug Fix: Acquire lock for atomic read-modify-write operation
      // Prevents race conditions when multiple tabs/requests append simultaneously
      const lock = LockService.getUserLock();
      
      try {
        if (!lock.tryLock(10000)) {  // 10 second timeout
          log('[DriveJournal] Could not acquire lock for appendToJournal');
          return {
            success: false,
            error: 'Could not acquire journal lock - please retry'
          };
        }
        
        const file = _resolveJournalFile(conversationId);
        if (!file) {
          return {
            success: false,
            error: `Journal file not found: ${conversationId}`
          };
        }

        // Read current content
        const content = file.getBlob().getDataAsString();
        const journalData = JSON.parse(content);
        
        // Append new messages
        journalData.messages = journalData.messages.concat(messages);
        
        // Write back to Drive
        file.setContent(JSON.stringify(journalData, null, 2));

        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Appended ${messages.length} messages in ${elapsed}ms: ${conversationId}`);
        
        return {
          success: true,
          data: {
            messageCount: journalData.messages.length
          }
        };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Error appending to journal (${elapsed}ms): ${error.message}`);
        return {
          success: false,
          error: error.message
        };
      } finally {
        // Always release lock
        lock.releaseLock();
      }
    }

    /**
     * Read full journal from Drive
     * @param {string} conversationId - Drive file ID (conversationId IS the fileId)
     * @returns {Object} {success, data: {messages, createdAt, userEmail}, error}
     */
    function readJournal(conversationId) {
      const startTime = Date.now();

      try {
        const file = _resolveJournalFile(conversationId);
        if (!file) {
          return {
            success: false,
            error: `Journal file not found: ${conversationId}`
          };
        }

        const content = file.getBlob().getDataAsString();
        const journalData = JSON.parse(content);

        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Read journal in ${elapsed}ms: ${conversationId}`);

        return {
          success: true,
          data: {
            messages: journalData.messages,
            createdAt: journalData.createdAt,
            userEmail: journalData.userEmail
          }
        };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Error reading journal (${elapsed}ms): ${error.message}`);
        return {
          success: false,
          error: error.message
        };
      }
    }

    /**
     * Get Drive URL for journal file
     * @param {string} conversationId - Conversation ID
     * @returns {Object} {success, data: {url}, error}
     */
    function getJournalUrl(conversationId) {
      try {
        const file = _resolveJournalFile(conversationId);
        if (!file) {
          return { success: false, error: `Journal file not found: ${conversationId}` };
        }

        return {
          success: true,
          data: {
            url: file.getUrl(),
            fileId: conversationId
          }
        };
      } catch (error) {
        log(`[DriveJournal] Error getting journal URL: ${error.message}`);
        return { success: false, error: error.message };
      }
    }

    /**
     * Delete journal file from Drive
     * Used for cleanup in error scenarios
     * @param {string} conversationId - Conversation ID
     * @returns {Object} {success, error}
     */
    function deleteJournal(conversationId) {
      try {
        const file = _resolveJournalFile(conversationId);
        if (!file) {
          return { success: true, notFound: true };
        }

        file.setTrashed(true);
        log(`[DriveJournal] Deleted journal: ${conversationId}`);
        return { success: true };
      } catch (error) {
        log(`[DriveJournal] Error deleting journal: ${error.message}`);
        return { success: false, error: error.message };
      }
    }

    /**
     * Clean up old journal files based on retention policy
     * Moves files older than retentionDays to trash (recoverable)
     * @param {number} retentionDays - Days to retain journals (0 = keep forever)
     * @returns {Object} {success, deleted, cutoffDate, error}
     */
    function cleanupOldJournals(retentionDays) {
      const startTime = Date.now();
      
      // Skip if retention disabled or invalid
      if (!retentionDays || retentionDays <= 0) {
        return {
          success: true,
          deleted: 0,
          skipped: true,
          reason: 'Retention disabled (0 days)'
        };
      }
      
      try {
        const folder = getJournalFolder();
        
        if (!folder) {
          return {
            success: false,
            error: 'Journal folder not accessible'
          };
        }
        
        const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const files = folder.getFiles();
        let deleted = 0;
        let checked = 0;
        
        while (files.hasNext()) {
          const file = files.next();
          const fileName = file.getName();
          
          // Only process journal files
          if (!fileName.startsWith('journal-') || !fileName.endsWith('.json')) {
            continue;
          }
          
          checked++;
          
          // Check file age by last updated date
          if (file.getLastUpdated() < cutoffDate) {
            file.setTrashed(true);  // Soft delete - recoverable from trash
            deleted++;
            log(`[DriveJournal] Trashed old journal: ${fileName}`);
          }
        }
        
        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Cleanup complete in ${elapsed}ms: checked ${checked}, deleted ${deleted}`);
        
        return {
          success: true,
          deleted: deleted,
          checked: checked,
          cutoffDate: cutoffDate.toISOString(),
          retentionDays: retentionDays
        };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Error during cleanup (${elapsed}ms): ${error.message}`);
        return {
          success: false,
          error: error.message
        };
      }
    }

    /**
     * Update journal title (for LLM-generated names)
     * @param {string} conversationId - Conversation ID
     * @param {string} newTitle - New title (max 27 chars, sanitized)
     * @returns {Object} {success, error}
     */
    function updateJournalTitle(conversationId, newTitle) {
      const lock = LockService.getUserLock();

      try {
        if (!lock.tryLock(10000)) {
          return { success: false, error: 'Could not acquire lock' };
        }

        const file = _resolveJournalFile(conversationId);
        if (!file) {
          return { success: false, error: 'Journal not found' };
        }

        const content = JSON.parse(file.getBlob().getDataAsString());
        content.title = newTitle;
        file.setContent(JSON.stringify(content, null, 2));

        log(`[DriveJournal] Updated title: ${conversationId} → ${newTitle}`);
        return { success: true };
      } catch (error) {
        log(`[DriveJournal] Error updating title: ${error.message}`);
        return { success: false, error: error.message };
      } finally {
        lock.releaseLock();
      }
    }

    /**
     * Get journal title (reads file to get custom title if set)
     * @param {string} conversationId - Conversation ID
     * @returns {Object} {success, title, error}
     */
    function getJournalTitle(conversationId) {
      try {
        const file = _resolveJournalFile(conversationId);
        if (!file) return { success: false, error: 'Not found' };

        const content = JSON.parse(file.getBlob().getDataAsString());
        return {
          success: true,
          title: content.title || conversationId
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

    /**
     * LLM-FIX-2026-01-13: Added to support conversation list population.
     * Previously: listConversations read from "Conversations" sheet which was never populated.
     * Now: listJournals iterates Drive journal files for actual saved conversations.
     * Rationale: Architecture mismatch - sendMessage saves to Drive, list read from sheet.
     * 
     * LLM-FIX-2026-01-16: Performance optimization - metadata only.
     * Previously: Read and parsed every file (23s for 50 files).
     * Now: Uses file metadata only - getName() and getLastUpdated() (expected <1s).
     * Trade-off: No preview or messageCount in list (available on load).
     * 
     * List all journal files from the Drive folder
     * Returns conversation metadata without reading file content
     * @returns {Object} {success: boolean, journals: [{id, title, savedAt, preview, messageCount}]}
     */
    function listJournals() {
      const startTime = Date.now();

      try {
        const folder = getJournalFolder();
        if (!folder) {
          return { success: false, error: 'Journal folder not accessible', journals: [] };
        }

        const files = folder.getFiles();
        const journals = [];

        while (files.hasNext()) {
          const file = files.next();
          const fileName = file.getName();

          // Only process journal files
          if (!fileName.startsWith('journal-') || !fileName.endsWith('.json')) {
            continue;
          }

          // conversationId IS the Drive file ID (single-ID model)
          const conversationId = file.getId();

          // Read file to get title (LLM-generated names)
          // Trade-off: Slightly slower but provides meaningful thread names
          let title = conversationId;  // Fallback to ID
          try {
            const content = JSON.parse(file.getBlob().getDataAsString());
            if (content.title) {
              title = content.title;
            }
          } catch (e) {
            // Silent - use conversationId as fallback
          }

          journals.push({
            id: conversationId,
            title: title,
            savedAt: file.getLastUpdated().toISOString(),
            preview: '',            // Skip - requires file read (available on conversation load)
            messageCount: 0         // Skip - requires file read (available on conversation load)
          });
        }

        // Sort by savedAt descending (newest first)
        journals.sort(function(a, b) { return new Date(b.savedAt) - new Date(a.savedAt); });

        const elapsed = Date.now() - startTime;
        log(`[DriveJournal] Listed ${journals.length} journals in ${elapsed}ms`);

        return { success: true, journals: journals };
      } catch (error) {
        log(`[DriveJournal] Error listing journals: ${error.message}`);
        return { success: false, error: error.message, journals: [] };
      }
    }

    // Export functions as CommonJS module
    module.exports = {
      createJournal,
      appendToJournal,
      readJournal,
      getJournalUrl,
      deleteJournal,
      getJournalFolder,
      getJournalFileName,
      extractAndValidateFolderId,
      getFolderUrl,
      cleanupOldJournals,
      listJournals,
      updateJournalTitle,
      getJournalTitle
    };
}

__defineModule__(_main);