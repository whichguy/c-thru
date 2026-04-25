#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const WIKI_FILE = process.env.WIKI_FILE || 'supervisor_wiki.jsonl';
const CONTEXT_FILE = '.wiki-context.json';

function getContext() {
    if (fs.existsSync(CONTEXT_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')); } catch (e) {}
    }
    return {};
}

function contextMatches(recordContext, currentContext) {
    if (!recordContext || Object.keys(recordContext).length === 0) return { match: true, exact: true };
    let exact = true;
    for (const key in recordContext) {
        if (currentContext[key] !== recordContext[key]) {
            return { match: false, exact: false };
        }
    }
    // Check if currentContext has extra specific tags the record doesn't have
    if (Object.keys(currentContext).length > Object.keys(recordContext).length) exact = false;
    return { match: true, exact: exact };
}

function countTokens(text) {
    if (!text) return 0;
    const matches = text.match(/[\w]+|[^\s\w]|[\s]+/g);
    return matches ? matches.length : 0;
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
    else if (args[i] === '--tag' && i + 1 < args.length) { queryTerms.push(args[i + 1].toLowerCase()); i++; }
    else if (!args[i].startsWith('--')) queryTerms.push(args[i].toLowerCase());
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
    const target = claims[ev.target];
    const source = claims[ev.source];
    if (target && source) {
        source.isChild = true;
        target.children.push(source.id);
        if (source.score >= 10) {
            let contrib = 10;
            if (ev.polarity === '-') contrib *= -1;
            target.score += contrib;
            target.evidence.push(ev);
        }
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
    const ctxResult = contextMatches(c.context, currentContext);
    const label = getLabel(c.score, c.evidence.length);
    if (ctxResult.match && depth === 0) stats[label]++;
    
    if (queryTerms.length > 0 && depth === 0) {
        const match = (c.tags || []).some(t => queryTerms.includes(t)) || c.text.toLowerCase().includes(queryTerms[0]);
        if (!match) return "";
    }

    const indent = "  ".repeat(depth);
    let output = `${indent}* **${c.id}** (${label}:${c.score.toFixed(0)}) ${c.text}`;
    if (c.resolves) output += `\n${indent}  ? ${c.resolves}`;
    
    // [v81.3 DYNAMIC VERBOSITY]
    // Only hide evidence if it's an EXACT context match and Supported.
    // Show evidence if it's from another context or is a Veto/Grave.
    const showEvidence = verbose || !ctxResult.exact || ['D', 'U', '?', 'C'].includes(label);

    if (showEvidence) {
        c.evidence.forEach(e => {
            const type = e.kind === 'obs' ? e.etype : `sus (${(e.confidence * SUSPICION_MULTIPLIER).toFixed(1)})`;
            output += `\n${indent}  ${e.polarity}${type}: ${e.text || ""}`;
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
    const ctxResult = contextMatches(c.context, currentContext);
    if (!ctxResult.match) outputGroups.OTHER.push(rendered);
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
process.stdout.write(`[BC] ${currentContext.environment || "unknown"}|S:${stats.S} T:${stats.T} U:${stats.U} D:${stats.D}|Tokens:${tokenWeight}${queryTerms.length > 0 ? `|Q:${queryTerms.join(',')}` : ''}\n\n`);
process.stdout.write(finalOutput);
