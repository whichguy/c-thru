function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Thinking Channel Server-Side Tests
   * 
   * Tests the server-side thinking channel functionality in common-js/__mcp_exec:
   * - getCurrentThinkingChannel() - get current channel ID
   * - setCurrentThinkingChannel(channelId) - set channel ID (called by exec_api)
   * - clearCurrentThinkingChannel() - clear channel ID after execution
   * 
   * The thinking channel allows client-side code to poll for LLM thinking messages
   * that are stored server-side during exec_api calls.
   */

  const { describe, it, beforeEach, afterEach } = require('test-framework/mocha-adapter');
  const { expect } = require('test-framework/chai-assertions');

  describe('Thinking Channel - Server Side', () => {
    let mcpExec;
    
    beforeEach(() => {
      // Get fresh reference to mcp_exec module
      mcpExec = require('common-js/__mcp_exec');
      // Ensure clean state before each test
      mcpExec.clearCurrentThinkingChannel();
    });
    
    afterEach(() => {
      // Clean up after each test
      mcpExec.clearCurrentThinkingChannel();
    });
    
    describe('getCurrentThinkingChannel()', () => {
      it('should return null when no channel is set', () => {
        const result = mcpExec.getCurrentThinkingChannel();
        expect(result).to.be.null;
      });
      
      it('should return the channel ID after it is set', () => {
        mcpExec.setCurrentThinkingChannel('test-channel-123');
        
        const result = mcpExec.getCurrentThinkingChannel();
        
        expect(result).to.equal('test-channel-123');
      });
      
      it('should be accessible via globalThis for client-side google.script.run calls', () => {
        mcpExec.setCurrentThinkingChannel('global-test-456');
        
        // __global__ exports should make this available to client-side
        expect(typeof globalThis.getCurrentThinkingChannel).to.equal('function');
        expect(globalThis.getCurrentThinkingChannel()).to.equal('global-test-456');
      });
    });
    
    describe('setCurrentThinkingChannel()', () => {
      it('should set the channel ID', () => {
        mcpExec.setCurrentThinkingChannel('new-channel-789');
        
        expect(mcpExec.getCurrentThinkingChannel()).to.equal('new-channel-789');
      });
      
      it('should overwrite existing channel ID', () => {
        mcpExec.setCurrentThinkingChannel('first-channel');
        mcpExec.setCurrentThinkingChannel('second-channel');
        
        expect(mcpExec.getCurrentThinkingChannel()).to.equal('second-channel');
      });
      
      it('should accept various channel ID formats', () => {
        // UUID-like format
        mcpExec.setCurrentThinkingChannel('550e8400-e29b-41d4-a716-446655440000');
        expect(mcpExec.getCurrentThinkingChannel()).to.equal('550e8400-e29b-41d4-a716-446655440000');
        
        // Timestamp-based format
        mcpExec.setCurrentThinkingChannel('thinking_1701234567890');
        expect(mcpExec.getCurrentThinkingChannel()).to.equal('thinking_1701234567890');
        
        // Simple string format
        mcpExec.setCurrentThinkingChannel('my-channel');
        expect(mcpExec.getCurrentThinkingChannel()).to.equal('my-channel');
      });
    });
    
    describe('clearCurrentThinkingChannel()', () => {
      it('should clear the channel ID to null', () => {
        mcpExec.setCurrentThinkingChannel('channel-to-clear');
        
        mcpExec.clearCurrentThinkingChannel();
        
        expect(mcpExec.getCurrentThinkingChannel()).to.be.null;
      });
      
      it('should be safe to call when no channel is set', () => {
        // Should not throw
        expect(() => mcpExec.clearCurrentThinkingChannel()).to.not.throw();
        expect(mcpExec.getCurrentThinkingChannel()).to.be.null;
      });
      
      it('should be safe to call multiple times', () => {
        mcpExec.setCurrentThinkingChannel('some-channel');
        
        mcpExec.clearCurrentThinkingChannel();
        mcpExec.clearCurrentThinkingChannel();
        mcpExec.clearCurrentThinkingChannel();
        
        expect(mcpExec.getCurrentThinkingChannel()).to.be.null;
      });
    });
    
    describe('Module Exports', () => {
      it('should export all thinking channel functions via module.exports', () => {
        expect(typeof mcpExec.getCurrentThinkingChannel).to.equal('function');
        expect(typeof mcpExec.setCurrentThinkingChannel).to.equal('function');
        expect(typeof mcpExec.clearCurrentThinkingChannel).to.equal('function');
      });
      
      it('should export getCurrentThinkingChannel via __global__ for client access', () => {
        // The __global__ export allows google.script.run.getCurrentThinkingChannel() from client
        expect(typeof mcpExec.__global__).to.equal('object');
        expect(typeof mcpExec.__global__.getCurrentThinkingChannel).to.equal('function');
      });
    });
    
    describe('Integration Scenario', () => {
      it('should support the full exec_api thinking channel workflow', () => {
        // 1. Client generates channel name and passes to exec_api
        const clientChannelId = 'thinking_' + Date.now();
        
        // 2. exec_api sets the channel before executing user code
        mcpExec.setCurrentThinkingChannel(clientChannelId);
        
        // 3. During execution, code can read the channel ID
        const duringExecution = mcpExec.getCurrentThinkingChannel();
        expect(duringExecution).to.equal(clientChannelId);
        
        // 4. Client can poll for thinking messages (simulated by reading channel)
        const polledChannel = globalThis.getCurrentThinkingChannel();
        expect(polledChannel).to.equal(clientChannelId);
        
        // 5. exec_api clears the channel after execution
        mcpExec.clearCurrentThinkingChannel();
        
        // 6. Channel is now null
        expect(mcpExec.getCurrentThinkingChannel()).to.be.null;
      });
    });
  });

  // Tests auto-run via test framework - no exports needed
}

__defineModule__(_main);