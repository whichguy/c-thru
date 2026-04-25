#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');

const WIKI_FILE = 'supervisor_wiki.jsonl';
const CONTEXT_FILE = '.wiki-context.json';
const STATE_FILE = 'supervisor_state.md';

function getContext() {
    let context = {};
    if (fs.existsSync(CONTEXT_FILE)) {
        try { context = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')); } catch (e) {}
    }
    try {
        context.branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
        context.commit = execSync('git rev-parse --short HEAD').toString().trim();
    } catch (e) {}
    return context;
}

function updateStateMarker(qnId, marker) {
    if (!fs.existsSync(STATE_FILE)) return;
    let content = fs.readFileSync(STATE_FILE, 'utf8');
    const regex = new RegExp(`- \\[${qnId}\\]: \\[.[^\\]]*\\]`, 'g');
    const replacement = `- [${qnId}]: [${marker}]`;
    if (content.match(regex)) {
        fs.writeFileSync(STATE_FILE, content.replace(regex, replacement));
        return true;
    }
    return false;
}

function generateId(kind) {
    const prefix = kind === 'step' ? 'S' : kind.toUpperCase().charAt(0);
    if (!fs.existsSync(WIKI_FILE)) return `${prefix}001`;
    const lines = fs.readFileSync(WIKI_FILE, 'utf8').trim().split('\n');
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

const args = process.argv.slice(2);
let contextOverride = null;
let resolvesText = null;
let verifyQid = null;
let debtQid = null;
let killQid = null;
const cleanArgs = [];

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--context' && i + 1 < args.length) { contextOverride = args[i + 1]; i++; }
    else if (args[i] === '--resolves' && i + 1 < args.length) { resolvesText = args[i + 1]; i++; }
    else if (args[i] === '--verify' && i + 1 < args.length) { verifyQid = args[i + 1]; i++; }
    else if (args[i] === '--debt' && i + 1 < args.length) { debtQid = args[i + 1]; i++; }
    else if (args[i] === '--kill' && i + 1 < args.length) { killQid = args[i + 1]; i++; }
    else { cleanArgs.push(args[i]); }
}

const kind = cleanArgs[0];
const context = getContext();
if (contextOverride) context.environment = contextOverride;

const record = { id: null, kind: kind, timestamp: new Date().toISOString(), context: context };

try {
    if (kind === 'claim') {
        if (cleanArgs.length < 3) throw new Error("Usage: claim <tags> <text>");
        record.id = generateId('claim');
        record.tags = cleanArgs[1].split(',').map(t => t.trim());
        record.text = cleanArgs[2];
        if (resolvesText) record.resolves = resolvesText;
    } else if (kind === 'obs' || kind === 'sus') {
        if (cleanArgs.length < 4) throw new Error(`Usage: ${kind} <Target> <flag> <text>`);
        if (!/^C\d{3}$/.test(cleanArgs[1])) throw new Error(`Invalid Target: ${cleanArgs[1]}`);
        record.id = generateId(kind);
        record.supports = [cleanArgs[1]];
        const flag = cleanArgs[2];
        record.polarity = flag.startsWith('+') ? '+' : '-';
        if (kind === 'obs') {
            const typeMap = { 'l': 'live', 'a': 'artifact', 'd': 'doc' };
            record.etype = typeMap[flag.substring(1).toLowerCase()] || 'unknown';
        } else {
            record.confidence = parseFloat(flag.substring(1)) || 0.5;
        }
        record.text = cleanArgs[3];
    } else if (kind === 'link') {
        if (cleanArgs.length < 5) throw new Error("Usage: link <Target> <+/-> <Source> <text>");
        record.id = generateId('obs');
        record.target = cleanArgs[1];
        record.polarity = cleanArgs[2];
        record.source = cleanArgs[3];
        record.text = cleanArgs[4];
    } else if (kind === 'step') {
        if (cleanArgs.length < 2) throw new Error("Usage: step \"<instruction/transition text>\"");
        record.id = generateId('step');
        record.text = cleanArgs[1];
    }

    fs.appendFileSync(WIKI_FILE, JSON.stringify(record) + '\n');
    
    let markerMsg = "";
    if (verifyQid) { if (updateStateMarker(verifyQid, "V")) markerMsg = `|STATE:${verifyQid}➔V`; }
    else if (debtQid) { if (updateStateMarker(debtQid, "D")) markerMsg = `|STATE:${debtQid}➔D`; }
    else if (killQid) { if (updateStateMarker(killQid, "I")) markerMsg = `|STATE:${killQid}➔I`; }

    const target = record.supports ? record.supports[0] : (record.kind === 'step' ? 'COGNITION' : record.id);
    console.log(`[BC] ${target}|ADDED:${record.id}${markerMsg}`);

} catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
}
