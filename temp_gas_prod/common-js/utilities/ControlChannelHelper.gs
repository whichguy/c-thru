function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * ControlChannelHelper - Global convenience function for checking control messages
   * 
   * Provides checkControlMessages() global function that long-running operations
   * can call periodically to check for cancel/control messages.
   * 
   * Usage:
   *   function processLargeDataset(datasetId) {
   *     const rows = getRows(datasetId);
   *     for (let i = 0; i < rows.length; i++) {
   *       if (i % 100 === 0) {
   *         checkControlMessages(); // Throws CancelledError if cancelled
   *       }
   *       processRow(rows[i]);
   *     }
   *   }
   */

  /**
   * Check for control channel messages
   * Throws CancelledError if cancel message found
   * No-op if no control channel active
   * 
   * Call this periodically in long-running operations to enable cancellation.
   * Recommended frequency: every 100-1000 iterations or every 1-5 seconds.
   * 
   * @throws {Error} CancelledError if operation was cancelled
   * 
   * @example
   * // In a loop
   * for (let i = 0; i < 10000; i++) {
   *   if (i % 100 === 0) {
   *     checkControlMessages();
   *   }
   *   doWork(i);
   * }
   * 
   * @example
   * // Between expensive operations
   * fetchData();
   * checkControlMessages();
   * processData();
   * checkControlMessages();
   * saveResults();
   */
  function checkControlMessages() {
    const manager = globalThis.__currentControlManager;
    
    if (!manager) {
      // No control channel active - silently return (no-op)
      return;
    }
    
    // Check for messages - may throw CancelledError
    manager.check();
  }

  // Export for CommonJS
  module.exports = {
    checkControlMessages: checkControlMessages,
    __global__: {
      checkControlMessages: checkControlMessages
    }
  };
}

__defineModule__(_main);