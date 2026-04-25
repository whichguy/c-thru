#!/usr/bin/env node
/**
 * c-thru-step v2: The Atomic Event Logger
 * Records discrete operational events on a single line.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const JOURNAL_FILE = 'supervisor_journal.md';
const CONTEXT_FILE = '.wiki-context.json';

function getContext() {
    let context = {};
    if (fs.existsSync(CONTEXT_FILE)) {
        try { context = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')); } catch (e) {}
    }
    try {
        context.branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e) {}
    return context;
}

const args = process.argv.slice(2);
let type = "STEP";
let text = "";

if (args[0] && args[0].startsWith('--')) {
    type = args[0].substring(2).toUpperCase();
    text = args.slice(1).join(' ');
} else {
    text = args.join(' ');
}

if (!text) {
    console.error("Usage: node tools/c-thru-step.js [--type] \"<Event text>\"");
    process.exit(1);
}

// [v88 SINGLE-LINE ATOMIC LOGGING]
const timestamp = new Date().toISOString();
fs.appendFileSync(JOURNAL_FILE, `* [${timestamp}] **${type}**: ${text.replace(/\n/g, ' ')}\n`);
console.log(`[JOURNAL] ${type}: ${text.substring(0, 60)}...`);
