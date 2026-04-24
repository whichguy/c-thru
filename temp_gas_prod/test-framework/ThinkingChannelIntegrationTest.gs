function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Integration test for thinking channel infrastructure (Chunks 1-3)
   */

  /**
   * Test function that simulates what sendMessageToClaude does:
   * - Gets the current thinking channel from global context
   * - Stores a thinking message to that channel
   */
  function testStoreThinking(testMessage, sequenceId, requestId) {
    const UISupport = require('sheets-chat/UISupport');
    
    // Call storeThinkingMessage (which will use getCurrentThinkingChannel internally)
    UISupport.storeThinkingMessage(testMessage, sequenceId, requestId);
    
    return {
      stored: true,
      message: testMessage,
      sequenceId: sequenceId,
      requestId: requestId
    };
  }

  module.exports = {
    testStoreThinking
  };
}

__defineModule__(_main);