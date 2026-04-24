function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * AnchorExtractor - Deterministic extraction of structural facts from messages
   * 
   * Part of the Historical Anchors feature for thread continuation.
   * Extracts URLs, file paths, error patterns, and code artifacts using regex
   * (no LLM calls, 100% reliable).
   */

  /**
   * Convert messages array to plain text for regex extraction
   */
  function messagesToText(messages) {
    return messages.map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map(block => {
          if (typeof block === 'string') return block;
          if (block.type === 'text') return block.text || '';
          if (block.type === 'tool_result') {
            const content = block.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
              return content.map(c => c.text || '').join('\n');
            }
          }
          return JSON.stringify(block);
        }).join('\n');
      }
      return JSON.stringify(m.content);
    }).join('\n');
  }

  /**
   * Extract all anchors from a messages array
   */
  function extractAnchors(messages) {
    const text = messagesToText(messages);
    return {
      urls: extractUrls(text),
      files: extractFilePaths(text),
      errors: extractErrorPatterns(text),
      artifacts: extractCodeArtifacts(text)
    };
  }

  /**
   * Extract URLs from text (max 10, deduplicated)
   */
  function extractUrls(text) {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const matches = text.match(urlRegex) || [];
    const cleaned = matches.map(url => url.replace(/[.,;:!?)]+$/, ''));
    return [...new Set(cleaned)].slice(0, 10);
  }

  /**
   * Extract file paths from text (max 10, deduplicated)
   */
  function extractFilePaths(text) {
    const fileRegex = /(?:[\w-]+\/)+[\w.-]+\.(js|ts|gs|html|css|json|md|py|go|rs|java|rb|php)(?::\d+)?/gi;
    return [...new Set(text.match(fileRegex) || [])].slice(0, 10);
  }

  /**
   * Extract error patterns from text (max 5, deduplicated)
   */
  function extractErrorPatterns(text) {
    const patterns = [];
    const errorRegex = /(?:Error|Exception|Failed|Unauthorized|Forbidden|NotFound|TypeError|ReferenceError|SyntaxError):\s*[^\n]{5,100}/gi;
    const errorMatches = text.match(errorRegex) || [];
    patterns.push(...errorMatches);
    const httpRegex = /\b[45]\d{2}\s+(?:error|not found|unauthorized|forbidden|bad request|internal server)[^\n]{0,50}/gi;
    const httpMatches = text.match(httpRegex) || [];
    patterns.push(...httpMatches);
    return [...new Set(patterns.map(p => p.trim()))].slice(0, 5);
  }

  /**
   * Extract code artifacts from text (max 10, deduplicated)
   */
  function extractCodeArtifacts(text) {
    const artifacts = [];
    const funcRegex = /\b([A-Z][a-zA-Z]*(?:\.[a-zA-Z]+)*)\s*\([^)]{0,50}\)/g;
    let match;
    while ((match = funcRegex.exec(text)) !== null) {
      artifacts.push(match[1] + '()');
    }
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(text)) !== null) {
      artifacts.push('require:' + match[1]);
    }
    return [...new Set(artifacts)].slice(0, 10);
  }

  /**
   * Extract purpose from a summary (first sentence)
   */
  function extractPurposeFromSummary(summary) {
    if (!summary) return 'Conversation continuation';
    const firstSentence = summary.split(/[.!?]/)[0];
    return firstSentence.slice(0, 100) + (firstSentence.length > 100 ? '...' : '');
  }

  /**
   * Extract decisions from memory facts
   */
  function extractDecisionsFromFacts(facts) {
    if (!Array.isArray(facts)) return [];
    const decisionKeywords = ['decided', 'chose', 'switched', 'selected', 'opted', 'will use', 'using', 'changed to'];
    return facts
      .filter(f => decisionKeywords.some(kw => f.toLowerCase().includes(kw)))
      .slice(0, 5);
  }

  /**
   * Create a complete anchor entry for a thread
   */
  function createAnchorEntry(threadId, messages, summary, memoryFacts) {
    const anchors = extractAnchors(messages);
    anchors.decisions = extractDecisionsFromFacts(memoryFacts);
    return {
      threadId: threadId,
      createdAt: new Date().toISOString(),
      purpose: extractPurposeFromSummary(summary),
      anchors: anchors
    };
  }

  module.exports = {
    extractAnchors,
    extractUrls,
    extractFilePaths,
    extractErrorPatterns,
    extractCodeArtifacts,
    extractPurposeFromSummary,
    extractDecisionsFromFacts,
    createAnchorEntry,
    messagesToText
  };
}
__defineModule__(_main);