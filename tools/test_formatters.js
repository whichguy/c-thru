#!/usr/bin/env node
const fs = require('fs');
const WIKI_FILE = 'test_wiki.jsonl';

if (!fs.existsSync(WIKI_FILE)) {
    console.error("Run generate_mock_wiki.js first.");
    process.exit(1);
}

const lines = fs.readFileSync(WIKI_FILE, 'utf8').trim().split('\n');
const claims = {};
const events = [];

lines.forEach(line => {
    const obj = JSON.parse(line);
    if (obj.kind === 'claim') claims[obj.id] = { ...obj, score: 0, evidence: [] };
    else events.push(obj);
});

const weights = { 'live': 10, 'artifact': 6, 'doc': 3 };
const SUSPICION_MULTIPLIER = 5.0;

events.forEach(ev => {
    (ev.supports || [ev.target]).forEach(id => {
        if (claims[id]) {
            let contrib = ev.kind === 'obs' ? weights[ev.etype] : (ev.confidence || 0.5) * SUSPICION_MULTIPLIER;
            if (ev.polarity === '-') contrib *= -1;
            claims[id].score += contrib;
            claims[id].evidence.push(ev);
        }
    });
});

function getLabel(score, evidenceCount) {
    if (evidenceCount === 0) return '?';
    if (score >= 10) return 'S';
    if (score >= 5) return 'T';
    if (score <= -10) return 'D';
    if (score <= -5) return 'U';
    return 'C';
}

function measure(name, text) {
    const chars = text.length;
    const words = text.split(/\s+/).length;
    const estTokens = Math.ceil(chars / 4); // Standard heuristic
    console.log(`${name.padEnd(20)} | Chars: ${String(chars).padStart(5)} | Words: ${String(words).padStart(4)} | Est. Tokens: ${String(estTokens).padStart(4)}`);
    return text;
}

// FORMAT A: ASCII Padded (Current)
let formatA = "";
Object.values(claims).forEach(c => {
    const label = getLabel(c.score, c.evidence.length);
    formatA += `[${c.id} ${label} ${c.score.toFixed(1)}] ${c.text}\n`;
    if (c.resolves) formatA += `  Resolves: ${c.resolves}\n`;
    c.evidence.forEach(e => {
        const type = e.kind === 'obs' ? e.etype : `sus (${(e.confidence * SUSPICION_MULTIPLIER).toFixed(1)})`;
        formatA += `  ${e.polarity}${type.padEnd(8)} "${e.text}"\n`;
    });
    formatA += "\n";
});

// FORMAT B: Markdown Semantic (Proposed)
let formatB = "### APPLIES\n";
Object.values(claims).forEach(c => {
    const label = getLabel(c.score, c.evidence.length);
    if (label === 'D' || label === 'U') return;
    formatB += `* **${c.id}** (${label}:${c.score.toFixed(0)}) ${c.text}\n`;
    if (c.resolves) formatB += `  ? ${c.resolves}\n`;
    if (['D', 'U', '?', 'C'].includes(label)) {
        c.evidence.forEach(e => {
            formatB += `  ${e.polarity}${e.etype || 'sus'}: ${e.text}\n`;
        });
    }
});

// FORMAT C: Ultra-Minimal
let formatC = "";
Object.values(claims).forEach(c => {
    const label = getLabel(c.score, c.evidence.length);
    formatC += `${c.id}|${label}|${c.score.toFixed(0)}|${c.text}\n`;
});

// FORMAT D: Minified JSON
const formatD = JSON.stringify(Object.values(claims).map(c => ({
    id: c.id,
    l: getLabel(c.score, c.evidence.length),
    s: Math.round(c.score),
    t: c.text,
    r: c.resolves,
    e: c.evidence.map(e => `${e.polarity}${e.etype || 's'}:${e.text}`)
})));

console.log("FORMAT EFFICIENCY REPORT\n" + "=".repeat(60));
measure("A: ASCII Padded", formatA);
measure("B: Markdown Svelte", formatB);
measure("C: Pipe-Delimited", formatC);
measure("D: Minified JSON", formatD);

fs.writeFileSync('format_a.txt', formatA);
fs.writeFileSync('format_b.txt', formatB);
fs.writeFileSync('format_c.txt', formatC);
fs.writeFileSync('format_d.txt', formatD);
