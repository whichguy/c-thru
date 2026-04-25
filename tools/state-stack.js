#!/usr/bin/env node
/**
 * state-stack.js v1: LIFO Execution Stack Manager
 * Implements traditional push/pop for recursive questions.
 * Volatile memory: supervisor_state.md (Open questions only)
 * Permanent memory: supervisor_journal.md (Historical conclusions)
 */
const fs = require('fs');

const STATE_FILE = 'supervisor_state.md';
const JOURNAL_FILE = 'supervisor_journal.md';

const args = process.argv.slice(2);
const command = args[0];

function generateId() {
    if (!fs.existsSync(STATE_FILE)) return 'Q001';
    const content = fs.readFileSync(STATE_FILE, 'utf8');
    const journal = fs.existsSync(JOURNAL_FILE) ? fs.readFileSync(JOURNAL_FILE, 'utf8') : '';
    const combined = content + journal;
    const matches = combined.match(/\[Q(\d{3})\]/g);
    if (!matches) return 'Q001';
    const max = Math.max(...matches.map(m => parseInt(m.substring(2, 5))));
    return `Q${String(max + 1).padStart(3, '0')}`;
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
            const id = generateId();
            const block = `\n---\n[${id}]\nPARENT: ${parentId}\nTEXT: "${text}"\n---\n`;
            fs.appendFileSync(STATE_FILE, block);
            console.log(`[STACK] Pushed: ${id} | PARENT: ${parentId}`);
            break;

        case 'conclude':
            const qid = args[1];
            const status = args[2]; // V or I
            const evidence = args[3];
            if (!qid || !status || !evidence) throw new Error("Usage: conclude <qid> <V|I> \"<evidence>\"");
            
            // Read state file
            if (!fs.existsSync(STATE_FILE)) throw new Error("State file missing.");
            let content = fs.readFileSync(STATE_FILE, 'utf8');
            const blocks = content.split('---').filter(b => b.trim());
            
            // Find target block
            const targetIndex = blocks.findIndex(b => b.includes(`[${qid}]`));
            if (targetIndex === -1) throw new Error(`Question ${qid} not found in active stack.`);
            
            const targetBlock = blocks[targetIndex].trim();
            const parentMatch = targetBlock.match(/PARENT: (\w+)/);
            const parentIdRef = parentMatch ? parentMatch[1] : 'NONE';
            const textMatch = targetBlock.match(/TEXT: "(.+)"/);
            const questionText = textMatch ? textMatch[1] : 'Unknown';

            // 1. Archive to Journal
            const journalEntry = `* [${new Date().toISOString()}] **CONCLUDED**: [${qid}] ${questionText} | STATUS: ${status} | EVIDENCE: ${evidence}\n`;
            fs.appendFileSync(JOURNAL_FILE, journalEntry);

            // 2. Pop (Trim) from State
            // The user requested trimming from the bottom. If qid matches the last block, it's a simple pop.
            // If it matches an internal block (falsify cascade), we remove that block and all below it.
            const newBlocks = blocks.slice(0, targetIndex);
            fs.writeFileSync(STATE_FILE, newBlocks.length > 0 ? '\n---\n' + newBlocks.join('\n---\n') + '\n---\n' : '');

            console.log(`[STACK] Concluded: ${qid} | Popped to parent: ${parentIdRef}`);
            
            if (status === 'I' && parentIdRef !== 'NONE') {
                console.log(`[ABLATION] ABLATION_REQUIRED for parent: ${parentIdRef}`);
            }
            break;

        case 'active':
            const active = getActiveBlock();
            if (active) {
                console.log("### ACTIVE QUESTION (Top of Stack)\n" + active);
            } else {
                console.log("STACK EMPTY. Return to Root Shot.");
            }
            break;

        default:
            throw new Error("Invalid command. Use push, conclude, or active.");
    }
} catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
}
