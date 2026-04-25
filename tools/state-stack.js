#!/usr/bin/env node
/**
 * state-stack.js v3: LIFO Execution Stack Manager (P/Q Nomenclature)
 * P-Nodes (Pxxx): Root Postulations (Parent: NONE).
 * Q-Nodes (Qxxx): Truthy Questions (Parent: anything else).
 */
const fs = require('fs');
const { STATE_FILE, JOURNAL_FILE } = require('./lib-memory');

const args = process.argv.slice(2);
const command = args[0];

function generateId(parentIsNone) {
    const prefix = parentIsNone ? 'P' : 'Q';
    const content = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : '';
    const journal = fs.existsSync(JOURNAL_FILE) ? fs.readFileSync(JOURNAL_FILE, 'utf8') : '';
    const combined = content + journal;
    const regex = new RegExp(`\\[${prefix}(\\d{3})\\]`, 'g');
    const matches = combined.match(regex);
    if (!matches) return `${prefix}001`;
    const nums = matches.map(m => parseInt(m.match(/\d+/)[0]));
    return `${prefix}${String(Math.max(...nums) + 1).padStart(3, '0')}`;
}

function getActiveBlock() {
    if (!fs.existsSync(STATE_FILE)) return null;
    const content = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (!content) return null;
    const blocks = content.split('---').filter(b => b.trim());
    if (blocks.length === 0) return null;
    return blocks[blocks.length - 1].trim();
}

try {
    switch (command) {
        case 'push':
            const parentId = args[1] || 'NONE';
            const text = args[2];
            if (!text) throw new Error("Usage: push <parent_id> \"<text>\"");
            const id = generateId(parentId === 'NONE');
            const block = `\n---\n[${id}]\nPARENT: ${parentId}\nTEXT: "${text}"\n---\n`;
            fs.appendFileSync(STATE_FILE, block);
            console.log(`[STACK] Pushed: ${id} | PARENT: ${parentId}`);
            break;

        case 'conclude':
            const qid = args[1];
            const status = args[2];
            const evidence = args[3];
            if (!qid || !status || !evidence) throw new Error("Usage: conclude <qid> <V|I> \"<evidence>\"");
            
            if (!fs.existsSync(STATE_FILE)) throw new Error("State file missing.");
            let content = fs.readFileSync(STATE_FILE, 'utf8');
            const blocks = content.split('---').filter(b => b.trim());
            const targetIndex = blocks.findIndex(b => b.includes(`[${qid}]`));
            if (targetIndex === -1) throw new Error(`Node ${qid} not found in active stack.`);
            
            const targetBlock = blocks[targetIndex].trim();
            const parentMatch = targetBlock.match(/PARENT: (\w+)/);
            const parentIdRef = parentMatch ? parentMatch[1] : 'NONE';
            const textMatch = targetBlock.match(/TEXT: "(.+)"/);
            const questionText = textMatch ? textMatch[1] : 'Unknown';

            fs.appendFileSync(JOURNAL_FILE, `* [${new Date().toISOString()}] **CONCLUDED**: [${qid}] ${questionText} | STATUS: ${status} | EVIDENCE: ${evidence}\n`);

            const newBlocks = blocks.slice(0, targetIndex);
            fs.writeFileSync(STATE_FILE, newBlocks.length > 0 ? '\n---\n' + newBlocks.join('\n---\n') + '\n---\n' : '');

            console.log(`[STACK] Concluded: ${qid} | Popped to parent: ${parentIdRef}`);
            break;

        case 'active':
            const active = getActiveBlock();
            if (active) console.log("### ACTIVE NODE (Top of Stack)\n" + active);
            else console.log("STACK EMPTY. Transition to [STATE 1].");
            break;

        default:
            throw new Error("Invalid command. Use push, conclude, or active.");
    }
} catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
}
