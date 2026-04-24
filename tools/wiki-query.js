#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const WIKI_FILE = 'supervisor_wiki.jsonl';
const CONTEXT_FILE = '.wiki-context.json';

function getContext() {
    if (fs.existsSync(CONTEXT_FILE)) {
        return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    }
    return {};
}

function contextMatches(recordContext, currentContext) {
    if (!recordContext || Object.keys(recordContext).length === 0) return true;
    for (const key in recordContext) {
        if (currentContext[key] && recordContext[key] !== currentContext[key]) {
            return false;
        }
    }
    return true;
}

if (!fs.existsSync(WIKI_FILE)) {
    console.log("Wiki is empty.");
    process.exit(0);
}

const lines = fs.readFileSync(WIKI_FILE, 'utf8').trim().split('\n');
const currentContext = getContext();

const claims = {};
const events = [];

lines.forEach(line => {
    try {
        if (!line.trim()) return;
        const obj = JSON.parse(line);
        if (obj.kind === 'claim') {
            claims[obj.id] = { ...obj, score: 0, evidence: [] };
        } else {
            events.push(obj);
        }
    } catch (e) {}
});

// v73 Weighted Epistemology
const weights = { 'live': 10, 'artifact': 6, 'doc': 3 };
const SUSPICION_MULTIPLIER = 5.0;

// Pass 1: Primary Evidence
events.forEach(ev => {
    if (ev.kind === 'link') return;
    (ev.supports || []).forEach(claimId => {
        if (claims[claimId]) {
            let contribution = 0;
            if (ev.kind === 'obs') {
                contribution = weights[ev.etype] || 0;
            } else if (ev.kind === 'sus') {
                // Confidence is 0.1 to 1.0, scaled by 5.0
                contribution = (ev.confidence || 0.5) * SUSPICION_MULTIPLIER;
            }
            if (ev.polarity === '-') contribution *= -1;
            
            claims[claimId].score += contribution;
            claims[claimId].evidence.push(ev);
        }
    });
});

// Pass 2: Causal Links
events.forEach(ev => {
    if (ev.kind !== 'link') return;
    const target = claims[ev.target];
    const source = claims[ev.source];
    if (target && source) {
        if (source.score >= 10) { // Threshold for S in v73
            let contribution = 10; // Acts as a Live observation
            if (ev.polarity === '-') contribution *= -1;
            target.score += contribution;
            target.evidence.push(ev);
        }
    }
});

function getLabel(score, evidenceCount) {
    if (evidenceCount === 0) return '?';
    if (score >= 10) return 'S'; // Supported
    if (score >= 5) return 'T';  // Tentative
    if (score <= -10) return 'D'; // Disproven
    if (score <= -5) return 'U';  // Undermined
    return 'C'; // Contested
}

const sections = { APPLIES: [], VETOES: [], CONJECTURES: [], OTHER_CONTEXTS: [] };

Object.values(claims).forEach(c => {
    const applies = contextMatches(c.context, currentContext);
    const label = getLabel(c.score, c.evidence.length);
    const formatted = `[${c.id} ${label} ${c.score.toFixed(1)}] ${c.text}`;
    const resLine = c.resolves ? [`  Resolves: ${c.resolves}`] : [];
    const evidenceLines = c.evidence.map(e => {
        if (e.kind === 'link') return `  ${e.polarity === '+' ? '+' : '-'}link     "From ${e.source}: ${e.text}"`;
        const type = e.kind === 'obs' ? e.etype : `sus (${(e.confidence * SUSPICION_MULTIPLIER).toFixed(1)})`;
        return `  ${e.polarity === '+' ? '+' : '-'}${type.padEnd(8)} "${e.text}"`;
    });
    const entry = [formatted, ...resLine, ...evidenceLines].join('\n');
    if (!applies) sections.OTHER_CONTEXTS.push(entry);
    else if (label === '?' || (label === 'C' && c.evidence.length === 1 && c.evidence[0].kind === 'sus')) sections.CONJECTURES.push(entry);
    else if (label === 'D' || label === 'U') sections.VETOES.push(entry);
    else sections.APPLIES.push(entry);
});

console.log(`ENV: ${currentContext.environment}/${currentContext.project}/${currentContext.branch}\n`);
if (sections.APPLIES.length > 0) console.log("APPLIES (this env)\n" + sections.APPLIES.join('\n\n') + '\n');
if (sections.VETOES.length > 0) console.log("VETOES (disproven)\n" + sections.VETOES.join('\n\n') + '\n');
if (sections.CONJECTURES.length > 0) console.log("CONJECTURES\n" + sections.CONJECTURES.join('\n\n') + '\n');
if (sections.OTHER_CONTEXTS.length > 0) console.log("OTHER CONTEXTS\n" + sections.OTHER_CONTEXTS.join('\n\n'));
