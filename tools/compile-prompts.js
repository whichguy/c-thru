const fs = require('fs');
const path = require('path');

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\n---\r?\n/);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: content.slice(m[0].length) };
}

function serializeFrontmatter(meta) {
  const entries = Object.entries(meta);
  if (entries.length === 0) return '';
  return '---\n' + entries.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n';
}

function compilePrompt(filename, srcDir, distDir) {
  const srcPath = path.join(srcDir, filename);
  if (!fs.existsSync(srcPath)) return;

  const raw = fs.readFileSync(srcPath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);

  const hasMeta = Object.keys(meta).length > 0;
  const baseName = filename.replace('.md', '');

  // Build debug frontmatter: name/model get -debug suffix; description swapped if debug_description present
  const debugMeta = { ...meta };
  if (hasMeta) {
    debugMeta.name  = baseName + '-debug';
    debugMeta.model = baseName + '-debug';
    if (meta.debug_description) debugMeta.description = meta.debug_description;
    delete debugMeta.debug_description;
  }

  // Build prod frontmatter: drop debug_description, all other fields verbatim
  const prodMeta = { ...meta };
  delete prodMeta.debug_description;

  // 1. DEBUG version: full fidelity body (no stripping), debug frontmatter
  const debugOut = serializeFrontmatter(debugMeta) + body;
  fs.writeFileSync(path.join(distDir, filename.replace('.md', '-debug.md')), debugOut);

  // 2. PROD version: strip <debug_config> blocks, append constraint, prod frontmatter
  let prodBody = body.replace(/<debug_config>[\s\S]*?<\/debug_config>\n*/g, '');
  prodBody += '\n\n# PRODUCTION CONSTRAINT\nFollow the THINKING_MODE rule strictly. If mode is RAW, emit ONLY the tool/decision result. Otherwise, keep <thinking> under 150 tokens.';
  fs.writeFileSync(path.join(distDir, filename), serializeFrontmatter(prodMeta) + prodBody);

  console.log(`Successfully compiled v98: ${filename}`);
}

function compileAll(srcDir, distDir) {
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
  fs.readdirSync(srcDir).forEach(file => {
    if (file.endsWith('.md')) compilePrompt(file, srcDir, distDir);
  });
}

module.exports = { parseFrontmatter, serializeFrontmatter, compilePrompt, compileAll };

if (require.main === module) {
  compileAll(
    path.join(__dirname, '../agents/src'),
    path.join(__dirname, '../agents')
  );
}
