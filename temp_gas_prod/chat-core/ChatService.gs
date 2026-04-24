/**
 * ChatService - Portable chat service functions extracted from UISupport
 * SpreadsheetApp-free: safe for use in Gmail add-ons and other contexts
 *
 * @module chat-core/ChatService
 */

function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {

// Import ConfigManager from gas-properties module
const ConfigManager = require('gas-properties/ConfigManager');
// Import QueueManager from gas-queue module
const QueueManager = require('gas-queue/QueueManager');

// Singleton queue instance for thinking messages (Cache-backed for performance)
let thinkingQueue = null;

// Optional knowledge provider (set by consuming project, e.g. SheetsKnowledgeProvider)
let _knowledgeProvider = null;

// Optional tool registry (set by consuming project, e.g. Sheets injects ToolRegistry with exec/search/knowledge)
let _toolRegistry = null;

// Optional inline (constructor) tools merged into every ClaudeConversation (e.g. read_range, get_sheet_info)
let _inlineTools = [];

/**
 * Get or create thinking queue singleton
 */
function getThinkingQueue() {
  if (!thinkingQueue) {
    const { getConfig } = require('chat-core/ChatConstants');
    thinkingQueue = new QueueManager({
      store: 'cache',
      namespace: 'CLAUDE_CHAT',
      scope: 'user',
      ttl: getConfig('QUEUE_MESSAGE_TTL_SECONDS'),
      debug: true  // Enable debug logging
    });
  }
  return thinkingQueue;
}

/**
 * Get API key from ConfigManager hierarchy
 * Priority: User+Doc → Doc → User → Domain → Script
 */
function getApiKey() {
  const config = new ConfigManager('CLAUDE_CHAT');
  const apiKey = config.get('API_KEY');

  // API key must be configured via ConfigManager - no hardcoded fallback
  if (!apiKey) {
    throw new Error('API key not configured. Set it in the Config tab or via ConfigManager.');
  }
  return apiKey;
}

/**
 * Get next persistent sequence ID
 * Uses PropertiesService with LockService for atomic operations
 * @returns {number} Next sequence ID
 */
function getNextSequenceId() {
  const lock = LockService.getUserLock();

  try {
    if (!lock.tryLock(5000)) {
      Logger.log('Could not acquire lock for sequence ID');
      return Date.now();  // Unique fallback instead of 1
    }

    try {
      const config = new ConfigManager('CLAUDE_CHAT');
      const currentId = parseInt(config.get('SEQUENCE_COUNTER') || '0', 10);
      const nextId = currentId + 1;
      config.setUser('SEQUENCE_COUNTER', nextId.toString());
      return nextId;
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    Logger.log(`Error getting sequence ID: ${error.message}`);
    return Date.now();  // Unique fallback instead of 1
  }
}

/**
 * Clear the persistent sequence counter
 */
function clearSequenceCounter() {
  const config = new ConfigManager('CLAUDE_CHAT');
  config.delete('SEQUENCE_COUNTER', 'user');
}

/**
 * Make object JSON-serializable for google.script.run
 * Includes null guards to prevent chrome-extension://invalid/ errors
 */
function makeSerializable(obj) {
  // Guard against null/undefined inputs
  if (obj === null || obj === undefined) {
    return { success: false, error: 'No response data', errorType: 'NULL_RESPONSE' };
  }
  try {
    const serialized = JSON.parse(JSON.stringify(obj));
    // Guard against serialization returning null
    if (serialized === null) {
      return { success: false, error: 'Serialization returned null', errorType: 'SERIALIZATION_NULL' };
    }
    return serialized;
  } catch (error) {
    return {
      success: false,
      error: `Serialization failed: ${error.message}`,
      errorType: 'SERIALIZATION_ERROR'
    };
  }
}

/**
 * Extract <suggested-actions> JSON block from Claude's response text.
 * Uses end-anchored regex to avoid false positives if Claude quotes the tag name mid-text.
 *
 * @param {string} responseText - Raw response text from Claude
 * @returns {{cleanText: string, actions: Array|null}} - Stripped text + parsed actions (null if absent/malformed)
 */
function extractSuggestedActions(responseText) {
  if (!responseText) return { cleanText: responseText, actions: null };

  const regex = /<suggested-actions>\s*([\s\S]*?)\s*<\/suggested-actions>\s*$/;
  const match = responseText.match(regex);

  if (!match) return { cleanText: responseText, actions: null };

  const cleanText = responseText.slice(0, match.index).trimEnd();
  let actions = null;

  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) {
      // Validate each action has required fields
      actions = parsed
        .filter(a => a && typeof a.label === 'string' && typeof a.prompt === 'string')
        .slice(0, 5);
      if (actions.length === 0) actions = null;
    }
  } catch (e) {
    Logger.log(`[extractSuggestedActions] Malformed JSON in <suggested-actions>: ${e.message}`);
  }

  return { cleanText, actions };
}

/**
 * Strip <suggested-actions> XML from assistant text content blocks in a snippet array.
 * Mutates the array in place to keep journal clean of ephemeral UI data.
 *
 * @param {Array} snippet - threadHistorySnippet content blocks
 */
function stripActionsFromSnippet(snippet) {
  if (!Array.isArray(snippet)) return;
  const regex = /<suggested-actions>[\s\S]*?<\/suggested-actions>\s*$/;

  for (var i = 0; i < snippet.length; i++) {
    var msg = snippet[i];
    if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (var j = 0; j < msg.content.length; j++) {
        var block = msg.content[j];
        if (block && block.type === 'text' && typeof block.text === 'string') {
          block.text = block.text.replace(regex, '').trimEnd();
        }
      }
    }
  }
}

/**
 * Send message to Claude API
 * Architecture: Client sends conversationId + text, server loads history from Drive journal
 * This eliminates payload bloat in both directions (fixes chrome-extension://invalid/ errors)
 */
function sendMessageToClaude(params) {
  try {
    // Accept both legacy (text, attachments) and new (message) formats
    // Also accept threadId as alias for conversationId (client sends threadId)
    let { conversationId, threadId, text, attachments, message, enableThinking, requestId } = params || {};

    // Use threadId if conversationId not provided
    conversationId = conversationId || threadId;

    // Handle unified 'message' format from client
    // Client sends either: string (text only) or array of content blocks (text + attachments)
    if (message !== undefined) {
      if (typeof message === 'string') {
        // Simple text message
        text = message;
        attachments = [];
      } else if (Array.isArray(message)) {
        // Content blocks array - extract text and attachments
        const textBlocks = message.filter(block => block && block.type === 'text');
        text = textBlocks.map(block => block.text || '').join('\n');

        // Extract attachment blocks and convert to ClaudeConversation's expected format
        attachments = [];
        message.forEach(block => {
          if (block && block.source && block.source.data) {
            if (block.type === 'image' || block.type === 'document') {
              attachments.push({
                data: block.source.data,
                mediaType: block.source.media_type
              });
            }
          }
        });
      }
    }

    // Ensure attachments is always an array
    attachments = attachments || [];

    const queue = getThinkingQueue();
    const channelName = `thinking-${requestId}`;
    queue.flush(channelName);

    // Set up control channel manager for this request
    const ControlChannelManager = require('gas-queue/ControlChannelManager');
    const controlManager = new ControlChannelManager({
      channelName: `control-${requestId}`,
      pollInterval: 500
    });
    globalThis.__currentControlManager = controlManager;

    const sequenceId = getNextSequenceId();

    // Load conversation history from Drive journal (already persisted)
    // conversationId IS the Drive file ID (single-ID model)
    const DriveJournal = require('chat-core/DriveJournal');
    let messages = [];

    if (!conversationId) {
      // New conversation - create journal first, fileId becomes conversationId
      const userEmail = getCurrentUserEmail();
      const createResult = DriveJournal.createJournal(userEmail);
      if (createResult.success && createResult.data) {
        conversationId = createResult.data.fileId;
        Logger.log(`[sendMessageToClaude] Created new conversation: ${conversationId}`);
      } else {
        Logger.log(`[sendMessageToClaude] Failed to create journal: ${createResult.error || 'unknown'}`);
        return makeSerializable({ success: false, error: 'Failed to create conversation' });
      }
    } else {
      // Existing conversation - load history (conversationId IS the Drive fileId)
      const journalResult = DriveJournal.readJournal(conversationId);
      if (journalResult.success) {
        messages = journalResult.data.messages || [];
        Logger.log(`[sendMessageToClaude] Loaded ${messages.length} messages from journal: ${conversationId}`);
      } else {
        Logger.log(`[sendMessageToClaude] Failed to load journal: ${journalResult.error}`);
        return makeSerializable({ success: false, error: `Failed to load conversation history: ${journalResult.error}` });
      }
    }

    const ClaudeConversation = require('chat-core/ClaudeConversation');
    const conversationOptions = {};
    if (_knowledgeProvider) conversationOptions.knowledgeProvider = _knowledgeProvider;
    if (_toolRegistry) conversationOptions.toolRegistry = _toolRegistry;
    if (_inlineTools && _inlineTools.length) conversationOptions.tools = [...(conversationOptions.tools || []), ..._inlineTools];
    const claude = new ClaudeConversation(null, null, conversationOptions);

    const onThinking = (thinkingText, msgSequenceId) => {
      // Check for cancellation on each thinking message
      // CRITICAL: This is OUTSIDE the try/catch - CancelledError must propagate
      if (typeof checkControlMessages === 'function') {
        checkControlMessages();  // May throw CancelledError - DO NOT catch
      }

      try {
        storeThinkingMessage(thinkingText, msgSequenceId, requestId);
      } catch (error) {
        // Never let thinking errors crash the main message flow
        Logger.log(`[onThinking] Error suppressed: ${error.message}`);
      }
    };

    const result = claude.sendMessage({
      messages: messages,
      text: text,
      attachments: attachments || [],
      enableThinking: enableThinking !== false,
      onThinking: onThinking,
      sequenceId: sequenceId,
      requestId: requestId
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTRACT INLINE ACTIONS — before journaling to keep journal clean
    // Always extract/strip regardless of config (prevents journal contamination)
    // ═══════════════════════════════════════════════════════════════════════════
    let responseText = result.response;
    let suggestedActions = null;
    if (responseText) {
      const extracted = extractSuggestedActions(responseText);
      responseText = extracted.cleanText;
      suggestedActions = extracted.actions;
      if (result.threadHistorySnippet) {
        stripActionsFromSnippet(result.threadHistorySnippet);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // JOURNAL PERSISTENCE - Append this turn's messages to Drive
    // ═══════════════════════════════════════════════════════════════════════════
    let journalingWarning = null;

    if (result.threadHistorySnippet && result.threadHistorySnippet.length > 0) {
      const appendResult = DriveJournal.appendToJournal(conversationId, result.threadHistorySnippet);
      if (appendResult.disabled) {
        Logger.log('[sendMessageToClaude] WARNING: Journaling disabled - Drive folder inaccessible');
        journalingWarning = 'Conversation not saved - configured Drive folder is inaccessible. Check Config tab.';
      } else if (!appendResult.success) {
        Logger.log(`[sendMessageToClaude] Warning: Failed to append to journal: ${appendResult.error}`);
      } else {
        Logger.log(`[sendMessageToClaude] Appended ${result.threadHistorySnippet.length} messages to journal`);
      }
    }

    // Determine if rename should happen (fast check, no blocking)
    let shouldRename = false;
    try {
      const isFirstMessage = messages.length <= 2;
      if (isFirstMessage) {
        shouldRename = true;
      } else {
        shouldRename = Math.floor(Math.random() * 11) === 0;  // ~9% chance
      }
    } catch (e) {
      // Silent - don't impact main flow
    }

    const returnValue = {
      response: responseText,
      conversationId: conversationId,
      usage: result.usage || { input_tokens: 0, output_tokens: 0 },
      sequenceId: result.sequenceId,
      shouldRename: shouldRename
    };

    // Config gates client delivery — inline actions only sent when enabled
    const { getConfig } = require('chat-core/ChatConstants');
    if (getConfig('INLINE_ACTIONS_ENABLED') && suggestedActions) {
      returnValue.suggestedActions = suggestedActions;
    }

    if (journalingWarning) {
      returnValue.journalingWarning = journalingWarning;
    }

    const serializedValue = makeSerializable(returnValue);
    if (serializedValue === null || serializedValue === undefined) {
      return { success: false, error: 'Serialization returned null/undefined', errorType: 'NULL_SERIALIZATION_ERROR' };
    }

    const payloadJson = JSON.stringify(serializedValue);
    const payloadSizeKB = (payloadJson.length / 1024).toFixed(2);
    Logger.log(`[sendMessageToClaude] SUCCESS - payload size: ${payloadSizeKB}KB (no threadHistorySnippet)`);

    _cleanupControlManager(controlManager);

    return serializedValue;
  } catch (error) {
    if (error.name === 'CancelledError') {
      Logger.log(`[sendMessageToClaude] Request cancelled: ${error.message}`);

      if (typeof controlManager !== 'undefined') {
        _cleanupControlManager(controlManager);
      }

      return makeSerializable({
        success: false,
        cancelled: true,
        error: error.message
      });
    }

    Logger.log(`Error in sendMessageToClaude: ${error.message}`);
    // Note: toast removed (SpreadsheetApp-free) - error logged instead
    Logger.log(`[sendMessageToClaude] Chat error toast would have shown: ${error.message}`);

    if (typeof controlManager !== 'undefined') {
      _cleanupControlManager(controlManager);
    }

    return makeSerializable({ success: false, error: error.message, errorName: error.name, errorStack: error.stack });
  }
}

/**
 * Helper to cleanup control channel manager
 * @private
 */
function _cleanupControlManager(controlManager) {
  globalThis.__currentControlManager = null;
  if (controlManager && controlManager.cleanup) {
    try {
      controlManager.cleanup();
    } catch (cleanupError) {
      Logger.log(`[sendMessageToClaude] Cleanup error: ${cleanupError.message}`);
    }
  }
}

function storeThinkingMessage(thinking, sequenceId, requestId) {
  if (!thinking || !thinking.trim()) return;
  try {
    const queue = getThinkingQueue();
    const channelName = `thinking-${requestId}`;
    queue.post(channelName, thinking, { sequenceId: sequenceId, requestId: requestId, type: 'thinking' });
  } catch (error) {
    Logger.log(`Error storing thinking message: ${error.message}`);
  }
}

function pollMessages(channelName, options) {
  const { maxWaitMs = 5000, checkIntervalMs = 300 } = options || {};
  const startTime = Date.now();
  const queue = getThinkingQueue();
  while (Date.now() - startTime < maxWaitMs) {
    const queueMessages = queue.pickup(channelName, 100, 0, false);
    if (queueMessages.length > 0) {
      const messages = queueMessages.map(msg => ({
        text: msg.data, sequenceId: msg.metadata.sequenceId, requestId: msg.metadata.requestId, timestamp: msg.timestamp
      }));
      return { messages: messages, waitedMs: Date.now() - startTime };
    }
    const remaining = maxWaitMs - (Date.now() - startTime);
    if (remaining > checkIntervalMs) Utilities.sleep(checkIntervalMs);
    else if (remaining > 0) { Utilities.sleep(remaining); break; }
    else break;
  }
  return { messages: [], timedOut: true, waitedMs: Date.now() - startTime };
}

function getCurrentUserEmail() {
  try { return Session.getActiveUser().getEmail() || 'unknown@user.com'; }
  catch (error) { return 'unknown@user.com'; }
}

/**
 * Load conversation with backward-compatible result format
 */
function loadConversation(conversationId) {
  try {
    const result = loadConversationFromJournal(conversationId);
    return { success: true, data: result };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    Logger.log(`[loadConversation] Error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Load conversation from Drive journal with message limit
 */
function loadConversationFromJournal(conversationId, maxTurns) {
  if (!conversationId || typeof conversationId !== 'string') {
    throw new Error('Invalid conversation ID');
  }

  const { getConfig } = require('chat-core/ChatConstants');

  maxTurns = parseInt(maxTurns, 10) || getConfig('MAX_LOAD_TURNS') || 50;
  if (maxTurns < 1) maxTurns = 1;
  if (maxTurns > 500) maxTurns = 500;

  const DriveJournal = require('chat-core/DriveJournal');
  const result = DriveJournal.readJournal(conversationId);

  if (!result.success) {
    throw new Error(result.error || 'Failed to load conversation');
  }

  let messages = (result.data && result.data.messages) || [];

  // Filter out thinking blocks from assistant messages
  messages = messages.map(function(msg) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      return {
        role: msg.role,
        content: msg.content.filter(function(block) {
          return block.type !== 'thinking';
        })
      };
    }
    return msg;
  });

  if (messages.length > maxTurns * 2) {
    messages = messages.slice(-maxTurns * 2);
    Logger.log(`[loadConversationFromJournal] Truncated to last ${maxTurns * 2} messages`);
  }

  return {
    messages: messages,
    savedAt: result.data.createdAt
  };
}

function listConversations() {
  const DriveJournal = require('chat-core/DriveJournal');
  const result = DriveJournal.listJournals();
  if (!result.success) {
    Logger.log(`[listConversations] Failed to list journals: ${result.error}`);
    return { conversations: [] };
  }
  const conversations = result.journals.map(function(journal) {
    return {
      id: journal.id,
      title: journal.title || journal.id,
      savedAt: journal.savedAt,
      preview: journal.preview || '',
      messageCount: journal.messageCount || 0
    };
  });
  return { conversations: conversations.slice(0, 100) };
}

function clearChat() {
  try { clearSequenceCounter(); return { success: true }; }
  catch (error) { return { success: false, error: error.message }; }
}

function getConfig() {
  const config = new ConfigManager('CLAUDE_CHAT');
  const apiKey = config.get('API_KEY');
  const modelName = config.get('MODEL_NAME') || 'claude-sonnet-4-6';
  const journalRetentionDays = parseInt(config.get('JOURNAL_RETENTION_DAYS') || '0', 10);
  const journalFolderId = config.get('JOURNAL_FOLDER_ID') || '';
  const apiUrlPrefix = config.get('CLAUDE_API_BASE_URL') || require('chat-core/ChatConstants').getConfig('CLAUDE_API_BASE_URL');
  return {
    config: {
      apiKey: apiKey || '',
      modelName: modelName,
      hasOverride: config.isOverridden('API_KEY'),
      enforcementSource: config.getEnforcementSource('API_KEY'),
      journalRetentionDays: journalRetentionDays,
      journalFolderId: journalFolderId,
      apiUrlPrefix: apiUrlPrefix
    }
  };
}

function saveConfig(params) {
  try {
    const { apiKey, modelName, journalRetentionDays, journalFolderId, apiUrlPrefix } = params || {};
    const config = new ConfigManager('CLAUDE_CHAT');
    if (apiKey) config.setUser('API_KEY', apiKey);
    if (modelName) config.setUser('MODEL_NAME', modelName);
    if (journalRetentionDays !== undefined) {
      config.setUser('JOURNAL_RETENTION_DAYS', String(journalRetentionDays));
    }
    if (journalFolderId !== undefined) {
      config.setUser('JOURNAL_FOLDER_ID', journalFolderId);
    }
    if (apiUrlPrefix) {
      config.setUser('CLAUDE_API_BASE_URL', apiUrlPrefix.replace(/\/+$/, ''));
    }
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
}

function getFontSize(defaultValue) {
  try {
    const config = new ConfigManager('CLAUDE_CHAT');
    const size = config.get('FONT_SIZE', defaultValue);
    return parseInt(size, 10) || defaultValue;
  } catch (error) { return defaultValue; }
}

function setFontSize(size) {
  try {
    const parsedSize = parseInt(size, 10);
    if (isNaN(parsedSize) || parsedSize < 8 || parsedSize > 16) return { success: false, error: 'Font size must be between 8 and 16' };
    const config = new ConfigManager('CLAUDE_CHAT');
    config.setUser('FONT_SIZE', parsedSize.toString());
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
}

function getSidebarWidth(defaultWidth) {
  try {
    const config = new ConfigManager('CLAUDE_CHAT');
    const stored = config.get('SIDEBAR_WIDTH');
    return stored ? parseInt(stored, 10) : (defaultWidth || 400);
  } catch (error) { return defaultWidth || 400; }
}

function setSidebarWidth(width) {
  try {
    const parsedWidth = parseInt(width, 10);
    const validWidths = [300, 400, 550];
    if (!validWidths.includes(parsedWidth)) {
      return { success: false, error: 'Width must be 300, 400, or 550' };
    }
    const config = new ConfigManager('CLAUDE_CHAT');
    config.setUser('SIDEBAR_WIDTH', parsedWidth.toString());
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
}

function getThemePreference() {
  try {
    const config = new ConfigManager('CLAUDE_CHAT');
    return config.get('THEME_PREFERENCE', 'system');
  } catch (error) {
    return 'system';
  }
}

function setThemePreference(theme) {
  try {
    const validThemes = ['light', 'dark', 'system'];
    if (!validThemes.includes(theme)) {
      return { success: false, error: 'Invalid theme. Must be light, dark, or system' };
    }
    const config = new ConfigManager('CLAUDE_CHAT');
    config.setUser('THEME_PREFERENCE', theme);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function loadCommandHistory() {
  try {
    const config = new ConfigManager('CLAUDE_CHAT');
    const historyJson = config.get('COMMAND_HISTORY', '[]');
    return JSON.parse(historyJson);
  } catch (error) {
    return [];
  }
}

function saveCommandToHistory(command, maxHistory) {
  try {
    if (!command || typeof command !== 'string') return { success: false, error: 'Invalid command' };
    maxHistory = maxHistory || 50;
    const config = new ConfigManager('CLAUDE_CHAT');
    const historyJson = config.get('COMMAND_HISTORY', '[]');
    const history = JSON.parse(historyJson);
    const filtered = history.filter(function(h) { return h !== command; });
    filtered.unshift(command);
    const trimmed = filtered.slice(0, maxHistory);
    config.setUser('COMMAND_HISTORY', JSON.stringify(trimmed));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getOAuthToken() {
  return ScriptApp.getOAuthToken();
}

function getScriptId() {
  return ScriptApp.getScriptId();
}

function formatHistoricalAnchors(anchors) {
  if (!anchors || anchors.length === 0) return '';
  const lines = ['## Historical Context (Past Threads)', '| Thread | Purpose | Key Artifacts |', '|--------|---------|---------------|'];
  anchors.forEach((a) => {
    const age = formatRelativeTime(a.createdAt);
    const artifacts = [...(a.anchors.urls || []).slice(0, 2), ...(a.anchors.files || []).slice(0, 2), ...(a.anchors.errors || []).slice(0, 1)].join(', ') || '-';
    lines.push(`| ${age} | ${(a.purpose || 'Unknown').slice(0, 50)} | ${artifacts.slice(0, 60)} |`);
  });
  return lines.join('\n');
}

function formatRelativeTime(isoTimestamp) {
  if (!isoTimestamp) return 'unknown';
  try {
    const diffMs = new Date() - new Date(isoTimestamp);
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    return `${Math.floor(diffDays / 30)}mo ago`;
  } catch (e) { return 'unknown'; }
}

function getJournalUrl(conversationId) {
  const DriveJournal = require('chat-core/DriveJournal');
  const result = DriveJournal.getJournalUrl(conversationId);
  if (result.success) {
    return { url: result.data.url };
  }
  throw new Error(result.error || 'Failed to get journal URL');
}

function getAutoSyncStatus() {
  try {
    var triggers = ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === 'checkAndSyncGitHubTools';
    });
    return { enabled: triggers.length > 0 };
  } catch (error) {
    return { enabled: false, error: error.message };
  }
}

function runJournalCleanup() {
  const config = new ConfigManager('CLAUDE_CHAT');
  const retentionDays = parseInt(config.get('JOURNAL_RETENTION_DAYS') || '0', 10);

  if (retentionDays <= 0) {
    return { deleted: 0, message: 'Retention disabled (0 days)' };
  }

  const DriveJournal = require('chat-core/DriveJournal');
  const result = DriveJournal.cleanupOldJournals(retentionDays);
  if (result.success) {
    return { deleted: result.deleted, message: result.message };
  }
  throw new Error(result.error || 'Failed to cleanup journals');
}

function renameThread(conversationId) {
  const startTime = Date.now();

  try {
    const DriveJournal = require('chat-core/DriveJournal');
    const ClaudeApiUtils = require('chat-core/ClaudeApiUtils');

    const journalResult = DriveJournal.readJournal(conversationId);
    if (!journalResult.success) {
      return { success: false, error: 'Failed to load journal' };
    }

    const messages = journalResult.data.messages || [];
    if (messages.length < 2) {
      return { success: false, error: 'Not enough messages' };
    }

    const recent = messages.slice(-10);
    const conversationText = recent.map(function(m) {
      const text = extractMessageText(m.content);
      return `${m.role}: ${text.substring(0, 300)}`;
    }).join('\n');

    const prompt = 'Generate a short, contextual name for this conversation thread.\n\n' +
      'Requirements:\n' +
      '- Maximum 27 characters\n' +
      '- Should identify WHAT the conversation is about\n' +
      '- Be specific (not generic like "Code Help" or "Chat")\n' +
      '- No special characters: < > : " / \\ | ? *\n\n' +
      'Examples of good names:\n' +
      '- "GAS OAuth Flow Debug"\n' +
      '- "React Table Component"\n' +
      '- "PDF Export Feature"\n' +
      '- "Sidebar CSS Fixes"\n\n' +
      `Conversation:\n${conversationText}\n\n` +
      'Thread name (≤27 chars):';

    const result = ClaudeApiUtils.complete(prompt, {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 50
    });

    if (!result.success) {
      Logger.log(`[renameThread] Haiku call failed: ${result.error}`);
      return { success: false, error: 'LLM call failed' };
    }

    const rawTitle = result.text.trim();
    const sanitized = rawTitle
      .replace(/[<>:"\/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 27);

    if (!sanitized) {
      return { success: false, error: 'Empty title after sanitization' };
    }

    const updateResult = DriveJournal.updateJournalTitle(conversationId, sanitized);

    const elapsed = Date.now() - startTime;
    Logger.log(`[renameThread] Completed in ${elapsed}ms: ${sanitized}`);

    return {
      success: updateResult.success,
      newTitle: sanitized,
      elapsed: elapsed
    };
  } catch (error) {
    Logger.log(`[renameThread] Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(function(b) { return b && b.type === 'text'; })
      .map(function(b) { return b.text || ''; })
      .join(' ');
  }
  return '';
}

/**
 * Post a cancel request to the control channel
 */
function postCancelRequest(requestId, reason) {
  reason = reason || 'Cancelled by user';

  if (!requestId) {
    Logger.log('[postCancelRequest] ERROR: No requestId provided');
    return { success: false, error: 'No requestId provided' };
  }

  try {
    const queue = new QueueManager({
      store: 'cache',
      namespace: 'CONTROL',
      ttl: 21600,
      debug: false
    });

    const channelName = `control-${requestId}`;
    Logger.log(`[postCancelRequest] Posting cancel to channel: ${channelName}, reason: ${reason}`);
    queue.post(channelName, { reason: reason }, { type: 'cancel', requestId: requestId });
    Logger.log(`[postCancelRequest] SUCCESS: Cancel posted to ${channelName}`);
    return { success: true, channelName: channelName };
  } catch (error) {
    Logger.log(`[postCancelRequest] ERROR: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Set the knowledge provider for ClaudeConversation instances
 * Called by consuming projects (e.g. sheets-chat/UISupport passes SheetsKnowledgeProvider)
 * @param {Object} provider - Knowledge provider with loadKnowledge, appendKnowledge, etc.
 */
function setKnowledgeProvider(provider) {
  _knowledgeProvider = provider;
}

/**
 * Set the tool registry for ClaudeConversation instances
 * Called by consuming projects (e.g. sheets-chat/UISupport passes ToolRegistry with exec/search tools)
 * @param {Object} registry - ToolRegistry instance with getEnabledTools, executeToolCall, etc.
 */
function setToolRegistry(registry) {
  _toolRegistry = registry;
}

/**
 * Set inline (constructor) tools to be merged into every ClaudeConversation instance
 * Called by consuming projects (e.g. sheets-chat/UISupport injects read_range, get_sheet_info)
 * @param {Array} tools - Array of tool objects with name, description, input_schema, execute
 */
function setInlineTools(tools) {
  _inlineTools = Array.isArray(tools) ? tools : [];
}

module.exports = {
  sendMessageToClaude, storeThinkingMessage, pollMessages, clearChat,
  getConfig, saveConfig, getFontSize, setFontSize, getSidebarWidth, setSidebarWidth, getOAuthToken, getScriptId, getApiKey,
  getThemePreference, setThemePreference, loadCommandHistory, saveCommandToHistory,
  getNextSequenceId, clearSequenceCounter, loadConversation, loadConversationFromJournal, listConversations,
  getCurrentUserEmail, formatHistoricalAnchors, formatRelativeTime,
  getJournalUrl, runJournalCleanup, getAutoSyncStatus, renameThread, postCancelRequest,
  makeSerializable, extractMessageText, getThinkingQueue, setKnowledgeProvider, setToolRegistry,
  setInlineTools
};
}

__defineModule__(_main);
