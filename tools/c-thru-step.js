#!/usr/bin/env node
/**
 * c-thru-step v1: The Process Ledger
 * Records chronological decisions and act-transitions.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const JOURNAL_FILE = 'supervisor_journal.jsonl';
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

const text = process.argv.slice(2).join(' ');
if (!text) {
    console.error("Usage: node tools/c-thru-step.js \"<Decision text>\"");
    process.exit(1);
}

const record = {
    timestamp: new Date().toISOString(),
    context: getContext(),
    decision: text
};

fs.appendFileSync(JOURNAL_FILE, JSON.stringify(record) + '\n');
console.log(`[JOURNAL] Logged decision: ${text.substring(0, 50)}...`);
