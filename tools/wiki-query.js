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

if (!fs.existsSync(WIKI_FILE)) {
    console.log("[BC] WIKI:EMPTY");
    process.exit(0);
}

const args = process.argv.slice(2);
let targetQuery = null;
let verbose = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose' || args[i] === '-v') {
        verbose = true;
    } else if (args[i] === '--tag' && i + 1 < args.length) {
        args[i + 1].toLowerCase().split(/\s+/).forEach(t => targetQuery = t); // Take last for now
        i++;
    } else if (!args[i].startsWith('--')) {
        targetQuery = args[i].toLowerCase();
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
        if (obj.kind === 'claim') {
            claims[obj.id] = { ...obj, score: 0, evidence: [], children: [] };
        } else {
            events.push(obj);
        }
    } catch (e) {}
});

const weights = { 'live': 10, 'artifact': 6, 'doc': 3 };
const SUSPICION_MULTIPLIER = 5.0;

// Pass 1: Primary Evidence
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

// Pass 2: Causal Links & Graph Construction
events.forEach(ev => {
    if (ev.kind !== 'link') return;
    const target = claims[ev.target];
    const source = claims[ev.source];
    if (target && source) {
        // Record child relationship for tree rendering
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
    
    const applies = contextMatches(c.context, currentContext);
    const label = getLabel(c.score, c.evidence.length);
    if (applies && depth === 0) stats[label]++;

    // Tag/Query Filter
    if (targetQuery && depth === 0) {
        const match = c.tags.some(t => t.toLowerCase().includes(targetQuery)) || c.text.toLowerCase().includes(targetQuery);
        if (!match) return "";
    }

    const indent = "  ".repeat(depth);
    let output = `${indent}[${c.id} ${label} ${c.score.toFixed(1)}] ${c.text}`;
    if (c.resolves) output += `\n${indent}  Resolves: ${c.resolves}`;
    
    if (verbose || ['D', 'U', '?', 'C'].includes(label)) {
        c.evidence.forEach(e => {
            const sym = e.polarity;
            const type = e.kind === 'obs' ? e.etype : `sus (${(e.confidence * SUSPICION_MULTIPLIER).toFixed(1)})`;
            output += `\n${indent}  ${sym}${type.padEnd(8)} "${e.text || ""}"`;
        });
    }

    // Recursively render children
    c.children.forEach(childId => {
        const childOutput = renderClaim(childId, depth + 1);
        if (childOutput) output += "\n" + childOutput;
    });

    return output;
}

const rootClaims = Object.keys(claims).filter(id => !claims[id].isChild);
const outputGroups = { APPLIES: [], VETOES: [], CONJECTURES: [], OTHER: [] };

rootClaims.forEach(id => {
    const c = claims[id];
    const applies = contextMatches(c.context, currentContext);
    const label = getLabel(c.score, c.evidence.length);
    const rendered = renderClaim(id);
    if (!rendered) return;

    if (!applies) outputGroups.OTHER.push(rendered);
    else if (label === 'D' || label === 'U') outputGroups.VETOES.push(rendered);
    else if (label === '?' || (label === 'C' && c.evidence.length === 1)) outputGroups.CONJECTURES.push(rendered);
    else outputGroups.APPLIES.push(rendered);
});

console.log(`[BC] ${currentContext.environment || "unknown"}|S:${stats.S} T:${stats.T} U:${stats.U} D:${stats.D} C:${stats.C}${targetQuery ? `|Q:${targetQuery}` : ''}\n`);

if (outputGroups.APPLIES.length) console.log("APPLIES (this env)\n" + outputGroups.APPLIES.join('\n\n') + '\n');
if (outputGroups.VETOES.length) console.log("VETOES (disproven)\n" + outputGroups.VETOES.join('\n\n') + '\n');
if (outputGroups.CONJECTURES.length) console.log("CONJECTURES\n" + outputGroups.CONJECTURES.join('\n\n') + '\n');
if (outputGroups.OTHER.length) console.log("OTHER CONTEXTS\n" + outputGroups.OTHER.join('\n\n'));
