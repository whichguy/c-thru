#!/usr/bin/env node
/**
 * c-thru Wiki Query Tool (Token Squeezer)
 * 
 * Parses a Karpathy-style Markdown file and extracts only the structural metadata:
 * Frontmatter, Headings, and [[Synapses]].
 * 
 * This allows the LLM to traverse the knowledge graph using ~50 tokens per node
 * instead of loading 2,000+ token raw Markdown files.
 * 
 * Usage: node tools/wiki-query.js <path/to/wiki/file.md>
 */

const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];

if (!filePath || !fs.existsSync(filePath)) {
  console.error(JSON.stringify({ error: `File not found: ${filePath}` }));
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

const result = {
  file: filePath,
  frontmatter: {},
  headings: [],
  synapses: []
};

let inFrontmatter = false;

for (let line of lines) {
  // 1. Parse Frontmatter (YAML-style)
  if (line.trim() === '---') {
    inFrontmatter = !inFrontmatter;
    continue;
  }
  
  if (inFrontmatter) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (match) {
      result.frontmatter[match[1]] = match[2].trim();
    }
    continue;
  }

  // 2. Parse Headings (Markdown)
  const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    result.headings.push(headingMatch[2].trim());
  }

  // 3. Parse Synapses (Karpathy-style [[links]])
  const synapseMatches = line.matchAll(/\[\[(.*?)\]\]/g);
  for (const match of synapseMatches) {
    const link = match[1].trim();
    if (!result.synapses.includes(link)) {
      result.synapses.push(link);
    }
  }
}

// Output highly compressed, machine-readable JSON
console.log(JSON.stringify(result, null, 2));
