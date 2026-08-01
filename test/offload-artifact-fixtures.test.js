#!/usr/bin/env node
'use strict';
// Deterministic artifact-habitat tests for the six real-session fixtures that
// need images, PDFs, or genuinely large context.
//
// Run: node test/offload-artifact-fixtures.test.js

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { assert, assertEq, summary } = require('./helpers');
const {
  ARTIFACT_FIXTURE_IDS,
  ARTIFACT_FIXTURE_REGISTRY,
  materializeOffloadArtifactFixture,
} = require('./offload-artifact-fixtures');

const EXPECTED_IDS = Object.freeze([
  'vision-screenshot',
  'vision-diagram',
  'pdf-table',
  'pdf-multicol',
  'longctx-needle',
  'longctx-bigdoc',
]);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const TOKEN_EQUIVALENT_DIVISOR = 4;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(buffer) {
  assert(buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
    'PNG has the standard eight-byte signature');
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    const recordedCrc = buffer.readUInt32BE(dataEnd);
    const computedCrc = crc32(Buffer.concat([
      Buffer.from(type, 'ascii'),
      data,
    ]));
    assertEq(recordedCrc, computedCrc, `PNG ${type} chunk CRC is valid`);
    chunks.push({ type, data });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  assertEq(offset, buffer.length, 'PNG chunk stream consumes the complete file');
  assertEq(chunks[0]?.type, 'IHDR', 'PNG starts with IHDR');
  assertEq(chunks.at(-1)?.type, 'IEND', 'PNG ends with IEND');
  return chunks;
}

function validatePng(file, expected) {
  const buffer = fs.readFileSync(file);
  const chunks = parsePng(buffer);
  const ihdr = chunks.find(chunk => chunk.type === 'IHDR')?.data;
  assert(ihdr?.length === 13, 'PNG IHDR has the required 13-byte payload');
  assertEq(ihdr.readUInt32BE(0), expected.width, 'PNG width matches registry');
  assertEq(ihdr.readUInt32BE(4), expected.height, 'PNG height matches registry');
  assertEq(ihdr[8], 8, 'PNG uses eight-bit channels');
  assertEq(ihdr[9], 2, 'PNG uses truecolor RGB');
  assertEq(ihdr[12], 0, 'PNG is non-interlaced');

  const compressed = Buffer.concat(
    chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data),
  );
  const pixels = zlib.inflateSync(compressed);
  const stride = 1 + expected.width * 3;
  assertEq(
    pixels.length,
    expected.height * stride,
    'PNG IDAT inflates to exactly one RGB scanline per row',
  );
  let rowsWithInvalidFilter = 0;
  const colors = new Set();
  for (let y = 0; y < expected.height; y += 1) {
    const rowStart = y * stride;
    if (pixels[rowStart] !== 0) rowsWithInvalidFilter += 1;
    for (let x = 0; x < expected.width; x += 1) {
      const pixelStart = rowStart + 1 + x * 3;
      colors.add(pixels.subarray(pixelStart, pixelStart + 3).toString('hex'));
    }
  }
  assertEq(rowsWithInvalidFilter, 0, 'PNG scanlines use the supported filter type 0');
  assert(colors.size >= 5, 'PNG contains a meaningful multi-color rendered scene');
  const description = chunks
    .filter(chunk => chunk.type === 'tEXt')
    .map(chunk => chunk.data.toString('latin1'))
    .join('\n');
  for (const marker of expected.textMarkers) {
    assert(description.includes(marker),
      `PNG metadata retains rendered marker ${JSON.stringify(marker)}`);
  }
}

function validatePdf(file, expected) {
  const buffer = fs.readFileSync(file);
  const text = buffer.toString('ascii');
  assert(text.startsWith('%PDF-1.4\n'),
    'PDF starts with a concrete PDF 1.4 header');
  assert(text.includes('\nxref\n'), 'PDF contains a cross-reference table');
  assert(text.includes('\ntrailer\n'), 'PDF contains a trailer dictionary');
  assert(text.includes('/Root 1 0 R'), 'PDF trailer points to the catalog');

  const startMatch = text.match(/startxref\n(\d+)\n%%EOF\n$/);
  assert(startMatch !== null, 'PDF ends with a numeric startxref and EOF marker');
  if (startMatch) {
    const start = Number(startMatch[1]);
    assertEq(text.slice(start, start + 4), 'xref',
      'PDF startxref byte offset points to the xref table');
  }

  const objectMatches = [...text.matchAll(/^(\d+) 0 obj$/gm)];
  assert(objectMatches.length >= 5, 'PDF contains catalog, pages, page, stream, and font objects');
  for (const match of objectMatches) {
    const objectNumber = Number(match[1]);
    const xrefLine = new RegExp(
      `^${String(match.index).padStart(10, '0')} 00000 n $`,
      'm',
    );
    assert(xrefLine.test(text),
      `PDF xref records the byte offset of object ${objectNumber}`);
  }

  const pageObjects = (text.match(/\/Type \/Page\b/g) || []).length;
  assertEq(pageObjects, expected.pageCount, 'PDF declares the expected page-object count');
  assert(/\/Type \/Pages\b/.test(text), 'PDF contains a Pages tree object');
  for (const fact of expected.facts) {
    assert(text.includes(fact), `PDF embeds known fact ${JSON.stringify(fact)}`);
  }
}

function listRegularFiles(root) {
  const found = [];
  function visit(current, relative) {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const childRelative = relative ? path.join(relative, name) : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute, childRelative);
      } else {
        found.push(childRelative.split(path.sep).join('/'));
      }
    }
  }
  visit(root, '');
  return found.sort();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validateMaterialization(id, first, second) {
  const registry = ARTIFACT_FIXTURE_REGISTRY[id];
  assertEq(first.id, id, `${id}: returned metadata preserves fixture id`);
  assertEq(first.kind, registry.kind, `${id}: returned metadata preserves fixture kind`);
  assert(Object.isFrozen(first) && Object.isFrozen(first.files) &&
    first.files.every(Object.isFrozen) && Object.isFrozen(first.expected),
  `${id}: returned metadata is deeply immutable`);
  assertEq(
    first.files.map(file => file.relativePath).sort().join(','),
    registry.relativePaths.join(','),
    `${id}: materializes exactly its registered files`,
  );
  assertEq(
    listRegularFiles(first.root).join(','),
    registry.relativePaths.join(','),
    `${id}: supplied cwd contains no other generated fixture files`,
  );

  for (const firstFile of first.files) {
    const secondFile = second.files.find(
      candidate => candidate.relativePath === firstFile.relativePath,
    );
    const firstBytes = fs.readFileSync(firstFile.absolutePath);
    const secondBytes = fs.readFileSync(secondFile.absolutePath);
    assertEq(sha256(firstBytes), sha256(secondBytes),
      `${id}: ${firstFile.relativePath} is byte-identical across roots`);
    assertEq(firstFile.sha256, sha256(firstBytes),
      `${id}: metadata SHA-256 matches file bytes`);
    assertEq(firstFile.bytes, firstBytes.length,
      `${id}: metadata byte count matches file bytes`);
    const stat = fs.lstatSync(firstFile.absolutePath);
    assert(stat.isFile() && !stat.isSymbolicLink(),
      `${id}: ${firstFile.relativePath} is a regular non-symlink file`);
    assertEq(stat.mode & 0o777, 0o600,
      `${id}: ${firstFile.relativePath} has mode 0600`);
    assert(
      firstFile.absolutePath.startsWith(`${first.root}${path.sep}`),
      `${id}: ${firstFile.relativePath} stays under the supplied cwd`,
    );
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'c-thru-artifact-fixtures-'));
let unexpected = null;

try {
  console.log('offload artifact fixture tests\n');

  console.log('1. registry and corpus carry the exact six artifact fixtures');
  assertEq(
    ARTIFACT_FIXTURE_IDS.join(','),
    EXPECTED_IDS.join(','),
    'fixture id list is stable and complete',
  );
  assertEq(
    Object.keys(ARTIFACT_FIXTURE_REGISTRY).join(','),
    EXPECTED_IDS.join(','),
    'registry has no missing or extra fixture ids',
  );
  assert(Object.isFrozen(ARTIFACT_FIXTURE_IDS) &&
    Object.isFrozen(ARTIFACT_FIXTURE_REGISTRY) &&
    Object.values(ARTIFACT_FIXTURE_REGISTRY).every(entry =>
      Object.isFrozen(entry) &&
      Object.isFrozen(entry.relativePaths) &&
      Object.isFrozen(entry.expected)),
  'public registry is deeply immutable');
  for (const entry of Object.values(ARTIFACT_FIXTURE_REGISTRY)) {
    for (const relativePath of entry.relativePaths) {
      assert(
        relativePath.startsWith('generated/') &&
        path.posix.normalize(relativePath) === relativePath &&
        !path.posix.isAbsolute(relativePath) &&
        !relativePath.split('/').includes('..'),
        `${entry.id}: ${relativePath} is a safe generated-relative path`,
      );
    }
  }
  const corpus = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'agent-selection-corpus.json'),
    'utf8',
  ));
  const corpusArtifactIds = corpus.prompts
    .filter(entry => entry.prompt.includes('{{DIR}}/generated/'))
    .map(entry => entry.id);
  assertEq(
    corpusArtifactIds.join(','),
    EXPECTED_IDS.join(','),
    'corpus generated-path prompts match the exact registry id set',
  );

  console.log('\n2. every fixture is isolated, deterministic, immutable, and private');
  const results = new Map();
  for (const id of ARTIFACT_FIXTURE_IDS) {
    const firstRoot = path.join(scratch, 'first', id);
    const secondRoot = path.join(scratch, 'second', id);
    fs.mkdirSync(firstRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(secondRoot, { recursive: true, mode: 0o700 });
    const first = materializeOffloadArtifactFixture(id, firstRoot);
    const second = materializeOffloadArtifactFixture(id, secondRoot);
    validateMaterialization(id, first, second);
    results.set(id, first);
  }

  console.log('\n3. generated images are complete, decompressible PNGs');
  for (const id of ['vision-screenshot', 'vision-diagram']) {
    const result = results.get(id);
    validatePng(result.files[0].absolutePath, result.expected);
  }

  console.log('\n4. generated documents are structurally valid factual PDFs');
  for (const id of ['pdf-table', 'pdf-multicol']) {
    const result = results.get(id);
    validatePdf(result.files[0].absolutePath, result.expected);
  }

  console.log('\n5. log habitat is genuinely large and has exactly one needle');
  const logs = results.get('longctx-needle');
  assert(logs.files.length > 1, 'needle fixture spans multiple log files');
  const logText = logs.files
    .map(file => fs.readFileSync(file.absolutePath, 'utf8'))
    .join('');
  assert(
    Math.floor(Buffer.byteLength(logText) / TOKEN_EQUIVALENT_DIVISOR) >
      logs.expected.minimumEstimatedTokens,
    'log corpus exceeds 50K token-equivalent by the documented conservative estimate',
  );
  assertEq(
    countOccurrences(logText, logs.expected.needle),
    1,
    'unique request-id needle occurs exactly once across all logs',
  );
  assertEq(
    (logText.match(/status=500\b/g) || []).length,
    1,
    'exactly one log record carries status 500',
  );
  assert(
    logText.includes(
      `status=500 request_id=${logs.expected.needle}`,
    ),
    'the unique request-id needle belongs to the 500 record',
  );

  console.log('\n6. 200-page specification is genuinely oversized');
  const bigdoc = results.get('longctx-bigdoc');
  const spec = fs.readFileSync(bigdoc.files[0].absolutePath, 'utf8');
  const pageMarkers = spec.match(/^=== PAGE \d{3} OF 200 ===$/gm) || [];
  assertEq(pageMarkers.length, 200, 'spec contains exactly 200 page markers');
  assertEq(pageMarkers[0], '=== PAGE 001 OF 200 ===',
    'spec begins with page marker 001');
  assertEq(pageMarkers.at(-1), '=== PAGE 200 OF 200 ===',
    'spec ends with page marker 200');
  assert(
    Math.floor(Buffer.byteLength(spec) / TOKEN_EQUIVALENT_DIVISOR) >
      bigdoc.expected.minimumEstimatedTokens,
    'spec exceeds 50K token-equivalent by the documented conservative estimate',
  );
  for (const fact of bigdoc.expected.facts) {
    assert(spec.includes(fact), `spec embeds known fact ${JSON.stringify(fact)}`);
  }

  console.log('\n7. invalid, colliding, and symlinked targets fail closed');
  const invalidRoot = path.join(scratch, 'invalid');
  fs.mkdirSync(invalidRoot, { mode: 0o700 });
  let invalidRejected = false;
  try {
    materializeOffloadArtifactFixture('../vision-screenshot', invalidRoot);
  } catch (error) {
    invalidRejected = /unknown artifact fixture id/.test(error?.message || '');
  }
  assert(invalidRejected, 'unknown/traversal-shaped fixture id is rejected');
  assertEq(fs.readdirSync(invalidRoot).length, 0,
    'invalid fixture id creates no output');

  const collisionRoot = path.join(scratch, 'collision');
  const collisionFile = path.join(collisionRoot, 'generated', 'ui-failure.png');
  fs.mkdirSync(path.dirname(collisionFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(collisionFile, 'sentinel', { mode: 0o600 });
  let collisionRejected = false;
  try {
    materializeOffloadArtifactFixture('vision-screenshot', collisionRoot);
  } catch (error) {
    collisionRejected = error?.code === 'EEXIST';
  }
  assert(collisionRejected, 'existing target is never overwritten');
  assertEq(fs.readFileSync(collisionFile, 'utf8'), 'sentinel',
    'collision leaves prior file bytes intact');

  const symlinkRoot = path.join(scratch, 'symlink');
  const outsideRoot = path.join(scratch, 'outside');
  fs.mkdirSync(symlinkRoot, { mode: 0o700 });
  fs.mkdirSync(outsideRoot, { mode: 0o700 });
  fs.symlinkSync(outsideRoot, path.join(symlinkRoot, 'generated'));
  let symlinkRejected = false;
  try {
    materializeOffloadArtifactFixture('vision-screenshot', symlinkRoot);
  } catch (error) {
    symlinkRejected = /symlink|safe directory/i.test(error?.message || '');
  }
  assert(symlinkRejected, 'generated-directory symlink is rejected');
  assertEq(fs.readdirSync(outsideRoot).length, 0,
    'symlink rejection writes nothing outside the supplied cwd');
} catch (error) {
  unexpected = error;
  assert(false, `unexpected test exception: ${error?.stack || error}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

assert(!fs.existsSync(scratch), 'test scratch tree is completely cleaned up');
if (unexpected) process.exitCode = 1;
process.exit(summary() > 0 ? 1 : 0);
