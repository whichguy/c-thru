const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../agents/src');
const distDir = path.join(__dirname, '../agents');

if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

function compilePrompt(filename) {
    const srcPath = path.join(srcDir, filename);
    if (!fs.existsSync(srcPath)) return;

    let content = fs.readFileSync(srcPath, 'utf8');

    // 1. Generate DEBUG version (Full fidelity)
    fs.writeFileSync(path.join(distDir, filename.replace('.md', '-debug.md')), content);

    // 2. Generate PROD version
    let prodContent = content.replace(/<debug_config>[\s\S]*?<\/debug_config>\n*/g, '');
    
    // v60 Refinement: Strict Production Constraints
    prodContent += '\n\n# PRODUCTION CONSTRAINT\nFollow the THINKING_MODE rule strictly. If mode is RAW, emit ONLY the tool/decision result. Otherwise, keep <thinking> under 150 tokens.';
    
    fs.writeFileSync(path.join(distDir, filename), prodContent);
    console.log(`Successfully compiled v91: ${filename}`);
}

fs.readdirSync(srcDir).forEach(file => {
    if (file.endsWith('.md')) compilePrompt(file);
});
