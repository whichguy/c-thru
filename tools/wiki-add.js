#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WIKI_FILE = 'supervisor_wiki.jsonl';
const CONTEXT_FILE = '.wiki-context.json';

function getContext() {
    let context = {};
    if (fs.existsSync(CONTEXT_FILE)) {
        context = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    }
    try {
        context.branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
        context.commit = execSync('git rev-parse --short HEAD').toString().trim();
    } catch (e) {}
    return context;
}

function generateId(kind) {
    if (!fs.existsSync(WIKI_FILE)) return `${kind.toUpperCase().charAt(0)}001`;
    const lines = fs.readFileSync(WIKI_FILE, 'utf8').trim().split('\n');
    let max = 0;
    const prefix = kind.toUpperCase().charAt(0);
    lines.forEach(line => {
        try {
            const obj = JSON.parse(line);
            if (obj.id.startsWith(prefix)) {
                const num = parseInt(obj.id.substring(1));
                if (num > max) max = num;
            }
        } catch (e) {}
    });
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function extractLinks(text) {
    const regex = /[CGSO]\d{3}/g;
    const matches = text.match(regex);
    return matches ? [...new Set(matches)] : [];
}

const args = process.argv.slice(2);
const kind = args[0];

if (!['claim', 'obs', 'sus'].includes(kind)) {
    console.error("Usage: node tools/wiki-add.js <claim|obs|sus> [flags] <text>");
    process.exit(1);
}

const context = getContext();
const record = {
    id: generateId(kind),
    kind: kind,
    timestamp: new Date().toISOString(),
    context: context
};

if (kind === 'claim') {
    const tags = args[1].split(',');
    const text = args[2];
    record.tags = tags;
    record.text = text;
} else if (kind === 'obs') {
    const flag = args[1]; // +L, -d etc
    const text = args[2];
    record.polarity = flag.startsWith('+') ? '+' : '-';
    const typeCode = flag.substring(1).toLowerCase();
    const typeMap = { 'l': 'live', 'a': 'artifact', 'd': 'doc' };
    record.etype = typeMap[typeCode] || 'unknown';
    record.text = text;
    record.supports = extractLinks(text);
    if (record.supports.length === 0) {
        console.error("Error: Observations must link to a Claim (Cxxx) or Goal (Gxxx).");
        process.exit(1);
    }
} else if (kind === 'sus') {
    const flag = args[1]; // +strong, -weak etc
    const text = args[2];
    record.polarity = flag.startsWith('+') ? '+' : '-';
    const tier = flag.substring(1).toLowerCase();
    const confidenceMap = { 'strong': 0.8, 'moderate': 0.5, 'weak': 0.25 };
    record.confidence = confidenceMap[tier] || 0.5;
    record.text = text;
    record.supports = extractLinks(text);
    if (record.supports.length === 0) {
        console.error("Error: Suspicions must link to a Claim (Cxxx) or Goal (Gxxx).");
        process.exit(1);
    }
}

fs.appendFileSync(WIKI_FILE, JSON.stringify(record) + '\n');
console.log(`[WIKI] Appended ${record.id}: ${record.text.substring(0, 50)}...`);
