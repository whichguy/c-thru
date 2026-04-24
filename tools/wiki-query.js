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
        const obj = JSON.parse(line);
        if (obj.kind === 'claim') {
            claims[obj.id] = { ...obj, score: 0, evidence: [] };
        } else {
            events.push(obj);
        }
    } catch (e) {}
});

const weights = { 'live': 4, 'artifact': 3, 'doc': 2 };

events.forEach(ev => {
    (ev.supports || []).forEach(claimId => {
        if (claims[claimId]) {
            let contribution = 0;
            if (ev.kind === 'obs') {
                contribution = weights[ev.etype] || 0;
            } else if (ev.kind === 'sus') {
                contribution = 1 * (ev.confidence || 0.5);
            }
            if (ev.polarity === '-') contribution *= -1;
            
            claims[claimId].score += contribution;
            claims[claimId].evidence.push(ev);
        }
    });
});

function getLabel(score, evidenceCount) {
    if (evidenceCount === 0) return '?';
    if (score >= 6) return 'S';
    if (score >= 2) return 'T';
    if (score <= -6) return 'D';
    if (score <= -2) return 'U';
    return 'C';
}

const sections = {
    APPLIES: [],
    VETOES: [],
    CONJECTURES: [],
    OTHER_CONTEXTS: []
};

Object.values(claims).forEach(c => {
    const applies = contextMatches(c.context, currentContext);
    const label = getLabel(c.score, c.evidence.length);
    
    const formatted = `[${c.id} ${label} ${c.score.toFixed(1)}] ${c.text}`;
    const evidenceLines = c.evidence.map(e => {
        const type = e.kind === 'obs' ? e.etype : `sus (${e.confidence})`;
        return `  ${e.polarity === '+' ? '+' : '-'}${type.padEnd(8)} "${e.text}"`;
    });

    const entry = [formatted, ...evidenceLines].join('\n');

    if (!applies) {
        sections.OTHER_CONTEXTS.push(entry);
    } else if (label === '?' || (label === 'C' && c.evidence.length === 1 && c.evidence[0].kind === 'sus')) {
        sections.CONJECTURES.push(entry);
    } else if (label === 'D' || label === 'U') {
        sections.VETOES.push(entry);
    } else {
        sections.APPLIES.push(entry);
    }
});

console.log(`ENV: ${currentContext.environment}/${currentContext.project}/${currentContext.branch}\n`);

if (sections.APPLIES.length > 0) {
    console.log("APPLIES (this env)");
    console.log(sections.APPLIES.join('\n\n') + '\n');
}

if (sections.VETOES.length > 0) {
    console.log("VETOES (disproven in this env)");
    console.log(sections.VETOES.join('\n\n') + '\n');
}

if (sections.CONJECTURES.length > 0) {
    console.log("CONJECTURES (no external evidence)");
    console.log(sections.CONJECTURES.join('\n\n') + '\n');
}

if (sections.OTHER_CONTEXTS.length > 0) {
    console.log("OTHER CONTEXTS (reference)");
    console.log(sections.OTHER_CONTEXTS.join('\n\n'));
}
