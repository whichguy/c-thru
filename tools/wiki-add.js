#!/usr/bin/env node
const fs = require('fs');
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
            if (!line.trim()) return;
            const obj = JSON.parse(line);
            if (obj.id.startsWith(prefix)) {
                const num = parseInt(obj.id.substring(1));
                if (num > max) max = num;
            }
        } catch (e) {}
    });
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

const args = process.argv.slice(2);
let contextOverride = null;
const cleanArgs = [];

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--context' && i + 1 < args.length) {
        contextOverride = args[i + 1];
        i++;
    } else {
        cleanArgs.push(args[i]);
    }
}

const kind = cleanArgs[0];

if (!['claim', 'obs', 'sus', 'link'].includes(kind)) {
    console.error("Usage: node tools/wiki-add.js <claim|obs|sus|link> [args] [--context <env>]");
    process.exit(1);
}

const context = getContext();
if (contextOverride) {
    context.environment = contextOverride;
}

const record = {
    id: generateId(kind === 'link' ? 'obs' : kind), // Links share ID space or get O? Let's use L? No, let's use O for links too or L. 
    // Wait, let's use O for links as they are evidence.
    kind: kind,
    timestamp: new Date().toISOString(),
    context: context
};

if (kind === 'claim') {
    const tags = cleanArgs[1].split(',');
    const text = cleanArgs[2];
    record.tags = tags;
    record.text = text;
} else if (kind === 'obs') {
    const target = cleanArgs[1];
    const flag = cleanArgs[2]; // +L, -d etc
    const text = cleanArgs[3];
    record.supports = [target];
    record.polarity = flag.startsWith('+') ? '+' : '-';
    const typeCode = flag.substring(1).toLowerCase();
    const typeMap = { 'l': 'live', 'a': 'artifact', 'd': 'doc' };
    record.etype = typeMap[typeCode] || 'unknown';
    record.text = text;
} else if (kind === 'sus') {
    const target = cleanArgs[1];
    const flag = cleanArgs[2]; // +strong, -weak etc
    const text = cleanArgs[3];
    record.supports = [target];
    record.polarity = flag.startsWith('+') ? '+' : '-';
    const tier = flag.substring(1).toLowerCase();
    const confidenceMap = { 'strong': 0.8, 'moderate': 0.5, 'weak': 0.25 };
    record.confidence = confidenceMap[tier] || 0.5;
    record.text = text;
} else if (kind === 'link') {
    const target = cleanArgs[1];
    const polarity = cleanArgs[2]; // + or -
    const source = cleanArgs[3];
    const text = cleanArgs[4];
    record.target = target;
    record.polarity = polarity;
    record.source = source;
    record.text = text;
}

// Generate real unique ID
if (kind === 'link') record.id = generateId('obs'); // Reuse O prefix for links as they are evidence

fs.appendFileSync(WIKI_FILE, JSON.stringify(record) + '\n');
console.log(`[WIKI] Appended ${record.id}: ${record.text.substring(0, 50)}...`);
