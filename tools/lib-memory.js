/**
 * lib-memory.js v1: Sovereign Chronicler Memory Library
 * Unified logic for Context, Matching, ID Gen, and Search.
 * Strictly Node.js stdlib-only.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const WIKI_FILE = 'supervisor_wiki.jsonl';
const JOURNAL_FILE = 'supervisor_journal.md';
const CONTEXT_FILE = '.wiki-context.json';
const STATE_FILE = 'supervisor_state.md';

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

function contextMatches(recordContext, currentContext) {
    if (!recordContext || Object.keys(recordContext).length === 0) return { match: true, exact: true };
    let exact = true;
    for (const key in recordContext) {
        if (currentContext[key] !== recordContext[key]) return { match: false, exact: false };
    }
    if (Object.keys(currentContext).length > Object.keys(recordContext).length) exact = false;
    return { match: true, exact: exact };
}

function generateId(kind) {
    const prefix = kind === 'question' ? 'Q' : (kind === 'step' ? 'S' : kind.toUpperCase().charAt(0));
    const lines = fs.existsSync(WIKI_FILE) ? fs.readFileSync(WIKI_FILE, 'utf8').trim().split('\n') : [];
    const journal = fs.existsSync(JOURNAL_FILE) ? fs.readFileSync(JOURNAL_FILE, 'utf8') : '';
    const state = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : '';
    
    const combined = journal + state + lines.join('');
    const regex = new RegExp(`\\[${prefix}(\\d{3})\\]`, 'g');
    const matches = combined.match(regex);
    
    if (!matches) {
        // Fallback to wiki line scanning if regex fails
        let max = 0;
        lines.forEach(line => {
            try {
                const obj = JSON.parse(line);
                if (obj.id && obj.id.startsWith(prefix)) {
                    const num = parseInt(obj.id.substring(1));
                    if (!isNaN(num) && num > max) max = num;
                }
            } catch (e) {}
        });
        return `${prefix}${String(max + 1).padStart(3, '0')}`;
    }

    const nums = matches.map(m => parseInt(m.match(/\d+/)[0]));
    return `${prefix}${String(Math.max(...nums) + 1).padStart(3, '0')}`;
}

function countTokens(text) {
    if (!text) return 0;
    const matches = text.match(/[\w]+|[^\s\w]|[\s]+/g);
    return matches ? matches.length : 0;
}

function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
            else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
        }
    }
    return matrix[b.length][a.length];
}

function fuzzyMatch(queryTerms, text) {
    if (!queryTerms || queryTerms.length === 0) return true;
    if (!text) return false;
    const t = text.toLowerCase();
    for (const q of queryTerms) if (t.includes(q)) return true;
    return false;
}

module.exports = {
    WIKI_FILE, JOURNAL_FILE, CONTEXT_FILE, STATE_FILE,
    getContext, contextMatches, generateId, countTokens, fuzzyMatch, levenshtein
};
