const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../agents/src');
const distDir = path.join(__dirname, '../agents');

if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

function compilePrompt(filename) {
    const srcPath = path.join(srcDir, filename);
    if (!fs.existsSync(srcPath)) {
        console.error(`Source prompt not found: ${srcPath}`);
        return;
    }

    let content = fs.readFileSync(srcPath, 'utf8');

    // 1. Generate DEBUG version (Full fidelity + Explicit Debug rules)
    let debugContent = content;
    fs.writeFileSync(path.join(distDir, filename.replace('.md', '-debug.md')), debugContent);

    // 2. Generate PROD version (Strip debug blocks + Add strict constraints)
    // Strip <debug_config> blocks
    let prodContent = content.replace(/<debug_config>[\s\S]*?<\/debug_config>\n*/g, '');
    
    // Add production-specific constraints to the end
    prodContent += '\n\n# STRICT PRODUCTION CONSTRAINT\nDo NOT output <thinking>, <debug_signal>, or conversational prose. Output ONLY the <state> and Decision block to minimize token latency.';
    
    fs.writeFileSync(path.join(distDir, filename), prodContent);
    console.log(`Successfully compiled: ${filename} -> agents/${filename} (PROD) & agents/${filename.replace('.md', '-debug.md')} (DEBUG)`);
}

// Automatically compile any .md files in the agents/src directory
fs.readdirSync(srcDir).forEach(file => {
    if (file.endsWith('.md')) {
        compilePrompt(file);
    }
});
