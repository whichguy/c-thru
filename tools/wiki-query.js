#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const WIKI_FILE = 'supervisor_wiki.jsonl';
const CONTEXT_FILE = '.wiki-context.json';

function getContext() {
    if (fs.existsSync(CONTEXT_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')); } catch (e) {}
    }
    return {};
}

function contextMatches(recordContext, currentContext) {
    if (!recordContext || Object.keys(recordContext).length === 0) return true;
    for (const key in recordContext) {
        if (currentContext[key] && recordContext[key] !== currentContext[key]) return false;
    }
    return true;
}

// BPE-lite Heuristic for Exact Token Measurement
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
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function fuzzyMatch(queryTerms, text) {
    if (!queryTerms || queryTerms.length === 0) return true;
    if (!text) return false;
    const t = text.toLowerCase();
    for (const q of queryTerms) { if (t.includes(q)) return true; }
    const words = t.split(/\W+/);
    for (const q of queryTerms) {
        const maxDist = q.length <= 4 ? 1 : 2;
        for (const word of words) {
            if (Math.abs(word.length - q.length) > maxDist) continue;
            if (levenshtein(q, word) <= maxDist) return true;
        }
    }
    return false;
}

if (!fs.existsSync(WIKI_FILE)) {
    console.log("[BC] WIKI:EMPTY|Tokens:0");
    process.exit(0);
}

const args = process.argv.slice(2);
const queryTerms = [];
let verbose = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
    else if (args[i] === '--tag' && i + 1 < args.length) {
        args[i + 1].toLowerCase().split(/\s+/).forEach(t => queryTerms.push(t));
        i++;
    } else if (!args[i].startsWith('--')) {
        args[i].toLowerCase().split(/\s+/).forEach(t => queryTerms.push(t));
    }
}

const lines = fs.readFileSync(WIKI_FILE, 'utf8').trim().split('\n');
const currentContext = getContext();
const claims = {};
const events = [];

lines.forEach(line => {
    if (!line.trim()) return;
    try {
        const obj = JSON.parse(line);
        if (!obj.id || !obj.kind) return;
        if (obj.kind === 'claim') claims[obj.id] = { ...obj, score: 0, evidence: [], children: [] };
        else events.push(obj);
    } catch (e) {}
});

const weights = { 'live': 10, 'artifact': 6, 'doc': 3 };
const SUSPICION_MULTIPLIER = 5.0;

events.forEach(ev => {
    if (ev.kind === 'link') return;
    (ev.supports || []).forEach(id => {
        if (claims[id]) {
            let contrib = ev.kind === 'obs' ? weights[ev.etype] : (ev.confidence || 0.5) * SUSPICION_MULTIPLIER;
            if (ev.polarity === '-') contrib *= -1;
            claims[id].score += contrib;
            claims[id].evidence.push(ev);
        }
    });
});

events.forEach(ev => {
    if (ev.kind !== 'link') return;
    if (claims[ev.target] && claims[ev.source] && claims[ev.source].score >= 10) {
        let contrib = 10;
        if (ev.polarity === '-') contrib *= -1;
        claims[ev.target].score += contrib;
        claims[ev.target].evidence.push(ev);
    }
});

function getLabel(score, evidenceCount) {
    if (evidenceCount === 0) return '?';
    if (score >= 10) return 'S';
    if (score >= 5) return 'T';
    if (score <= -10) return 'D';
    if (score <= -5) return 'U';
    return 'C';
}

const stats = { S: 0, T: 0, U: 0, D: 0, C: 0, '?': 0 };

function renderClaim(id, depth = 0) {
    const c = claims[id];
    if (!c) return "";
    const applies = contextMatches(c.context, currentContext);
    const label = getLabel(c.score, c.evidence.length);
    if (applies && depth === 0) stats[label]++;
    
    // Wide-Net Fuzzy search across tags, text, resolves intent, AND evidence strings
    if (queryTerms.length > 0 && depth === 0) {
        const matchTags = (c.tags || []).some(t => fuzzyMatch(queryTerms, t));
        const matchText = fuzzyMatch(queryTerms, c.text);
        const matchResolves = c.resolves ? fuzzyMatch(queryTerms, c.resolves) : false;
        const matchEvidence = c.evidence.some(e => fuzzyMatch(queryTerms, e.text));
        if (!matchTags && !matchText && !matchResolves && !matchEvidence) return "";
    }

    const indent = "  ".repeat(depth);
    let output = `${indent}* **${c.id}** (${label}:${c.score.toFixed(0)}) ${c.text}`;
    if (c.resolves) output += `\n${indent}  ? ${c.resolves}`;
    
    if (verbose || ['D', 'U', '?', 'C'].includes(label)) {
        c.evidence.forEach(e => {
            const sym = e.polarity;
            const type = e.kind === 'obs' ? e.etype : `sus (${(e.confidence * SUSPICION_MULTIPLIER).toFixed(1)})`;
            output += `\n${indent}  ${sym}${type}: ${e.text || ""}`;
        });
    }

    c.children.forEach(childId => {
        const childOutput = renderClaim(childId, depth + 1);
        if (childOutput) output += "\n" + childOutput;
    });

    return output;
}

const rootClaims = Object.keys(claims).filter(id => !claims[id].isChild);
const outputGroups = { APPLIES: [], VETOES: [], CONJECTURES: [], OTHER: [] };

rootClaims.forEach(id => {
    const rendered = renderClaim(id);
    if (!rendered) return;
    const c = claims[id];
    const label = getLabel(c.score, c.evidence.length);
    const applies = contextMatches(c.context, currentContext);
    if (!applies) outputGroups.OTHER.push(rendered);
    else if (label === 'D' || label === 'U') outputGroups.VETOES.push(rendered);
    else if (label === '?' || (label === 'C' && c.evidence.length === 1)) outputGroups.CONJECTURES.push(rendered);
    else outputGroups.APPLIES.push(rendered);
});

let finalOutput = "";
if (outputGroups.APPLIES.length) finalOutput += "### 🟢 APPLIES\n" + outputGroups.APPLIES.join('\n\n') + '\n\n';
if (outputGroups.VETOES.length) finalOutput += "### 🔴 VETOES\n" + outputGroups.VETOES.join('\n\n') + '\n\n';
if (outputGroups.CONJECTURES.length) finalOutput += "### 🟡 CONJECTURES\n" + outputGroups.CONJECTURES.join('\n\n') + '\n\n';
if (outputGroups.OTHER.length) finalOutput += "### ⚪ OTHER CONTEXTS\n" + outputGroups.OTHER.join('\n\n');

const tokenWeight = countTokens(finalOutput);

console.log(`[BC] ${currentContext.environment || "unknown"}|S:${stats.S} T:${stats.T} U:${stats.U} D:${stats.D}|Tokens:${tokenWeight}${queryTerms.length > 0 ? `|Q:${queryTerms.join(',')}` : ''}\n`);
console.log(finalOutput);
