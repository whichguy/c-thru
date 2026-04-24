// email-campaign/content/SequenceEngine.gs
// Stub for LLM-evaluated multi-touch sequence logic (Phase 7+).
// Returns skip for all inputs — zero runtime cost until Phase 7 implements
// the Claude evaluation loop. Exists so require() callers work without errors.

function _main(module, exports, log) {

  /**
   * Evaluates the next step for a recipient in a multi-touch sequence.
   *
   * Phase 7 will replace this stub with a Claude API call that reads
   * campaign.contentStrategy.sequence and returns the appropriate action.
   *
   * @param {string} campaignId   - Campaign ID
   * @param {Object} recipientRow - Recipient data object from _Recipients
   * @returns {{ nextAction: string, reason: string }}
   */
  function evaluateNextStep(campaignId, recipientRow) {
    // Intentional stub — Phase 7 implements LLM-evaluated sequence logic here.
    // All callers must handle 'skip' gracefully (no-op continuation).
    return {
      nextAction: 'skip',
      reason:     'sequences_not_implemented',
    };
  }

  const SequenceEngine = { evaluateNextStep };
  module.exports = { evaluateNextStep, SequenceEngine };
}

__defineModule__(_main);
