/**
 * Supervisor Benchmark Harness v3: THE ISOLATION PROTOCOL
 * 
 * Ensures that every prompt execution is 100% independent.
 * - ZERO persistent conversation history.
 * - ZERO shared state between variants.
 * - Each turn is a fresh instantiation of the System Prompt + Current Tool State.
 */

const fs = require('fs');
const path = require('path');

const BANK_PATH = path.join(__dirname, 'bank_1k.json');

/**
 * Executes a single scenario in total isolation.
 */
function runIsolatedTurn(variantPath, questionId, toolOutputs = []) {
  const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
  const scenario = bank.find(q => q.id === questionId);
  const systemPrompt = fs.readFileSync(variantPath, 'utf8');

  // THE ISOLATION CONTRACT:
  // 1. Start with fresh system prompt.
  // 2. Add the User's original question.
  // 3. Append ONLY the structured tool outputs from previous turns (if recursing).
  // 4. NO other context, pre-existing chat, or environmental leaks allowed.

  const context = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: scenario.prompt }
  ];

  if (toolOutputs.length > 0) {
    context.push({ role: 'assistant', content: 'RECURSION_STEP' }); // Placeholder for state mapping
    toolOutputs.forEach(out => {
      context.push({ role: 'user', content: `[TOOL_RESULT]: ${out}` });
    });
  }

  console.log(`[ISOLATION] Running ${questionId} against ${path.basename(variantPath)}`);
  return context; // This object would be sent to the LLM API
}

module.exports = { runIsolatedTurn };
