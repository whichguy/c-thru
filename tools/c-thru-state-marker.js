#!/usr/bin/env node
/**
 * c-thru-state-marker v1
 * Surgical update of question status in supervisor_state.md
 * 
 * Usage: node tools/c-thru-state-marker.js <QN_ID> <MARKER>
 */

const fs = require('fs');
const STATE_FILE = 'supervisor_state.md';

const qnId = process.argv[2];
const marker = process.argv[3]; // V, D, I, or [ ]

if (!fs.existsSync(STATE_FILE)) {
    console.error("State file not found.");
    process.exit(1);
}

let content = fs.readFileSync(STATE_FILE, 'utf8');

// Regex: Find the line starting with [QN_ID], then match the [ ] block
const regex = new RegExp(`- \\[${qnId}\\]: \\[.[^\\]]*\\]`, 'g');
const replacement = `- [${qnId}]: [${marker}]`;

if (content.match(regex)) {
    const updated = content.replace(regex, replacement);
    fs.writeFileSync(STATE_FILE, updated);
    console.log(`[STATE] Updated ${qnId} to [${marker}]`);
} else {
    console.error(`Question ${qnId} not found in state file.`);
    process.exit(1);
}
