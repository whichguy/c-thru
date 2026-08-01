#!/usr/bin/env node
'use strict';
// Stdlib-only, deterministic artifacts for the six agent-selection fixtures
// whose routing signal depends on a real image, PDF, or oversized context.
//
// This module deliberately generates one requested fixture at a time. It never
// reads credentials, performs network I/O, or writes outside the supplied cwd.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TOKEN_EQUIVALENT_DIVISOR = 4;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const LOG_NEEDLE = 'req-500-7f3a9c';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const FONT = Object.freeze({
  ' ': Object.freeze([0, 0, 0, 0, 0, 0, 0]),
  '0': Object.freeze([14, 17, 19, 21, 25, 17, 14]),
  '5': Object.freeze([31, 16, 16, 30, 1, 1, 30]),
  A: Object.freeze([14, 17, 17, 31, 17, 17, 17]),
  C: Object.freeze([14, 17, 16, 16, 16, 17, 14]),
  D: Object.freeze([30, 17, 17, 17, 17, 17, 30]),
  E: Object.freeze([31, 16, 16, 30, 16, 16, 31]),
  F: Object.freeze([31, 16, 16, 30, 16, 16, 16]),
  I: Object.freeze([31, 4, 4, 4, 4, 4, 31]),
  L: Object.freeze([16, 16, 16, 16, 16, 16, 31]),
  M: Object.freeze([17, 27, 21, 21, 17, 17, 17]),
  N: Object.freeze([17, 25, 21, 19, 17, 17, 17]),
  O: Object.freeze([14, 17, 17, 17, 17, 17, 14]),
  Q: Object.freeze([14, 17, 17, 17, 21, 18, 13]),
  R: Object.freeze([30, 17, 17, 30, 20, 18, 17]),
  S: Object.freeze([15, 16, 16, 14, 1, 1, 30]),
  T: Object.freeze([31, 4, 4, 4, 4, 4, 4]),
  U: Object.freeze([17, 17, 17, 17, 17, 17, 14]),
});

function canvas(width, height, background) {
  const pixels = Buffer.alloc(width * height * 3);

  function setPixel(x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
  }

  function fillRect(x, y, rectWidth, rectHeight, color) {
    for (let row = y; row < y + rectHeight; row += 1) {
      for (let column = x; column < x + rectWidth; column += 1) {
        setPixel(column, row, color);
      }
    }
  }

  function strokeRect(x, y, rectWidth, rectHeight, color, thickness = 2) {
    fillRect(x, y, rectWidth, thickness, color);
    fillRect(x, y + rectHeight - thickness, rectWidth, thickness, color);
    fillRect(x, y, thickness, rectHeight, color);
    fillRect(x + rectWidth - thickness, y, thickness, rectHeight, color);
  }

  function drawText(text, x, y, scale, color) {
    let cursor = x;
    for (const rawCharacter of text) {
      const character = rawCharacter.toUpperCase();
      const glyph = FONT[character];
      if (!glyph) throw new Error(`unsupported deterministic PNG glyph: ${character}`);
      for (let row = 0; row < glyph.length; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if ((glyph[row] & (1 << (4 - column))) === 0) continue;
          fillRect(
            cursor + column * scale,
            y + row * scale,
            scale,
            scale,
            color,
          );
        }
      }
      cursor += 6 * scale;
    }
  }

  function line(x1, y1, x2, y2, color, thickness = 2) {
    const dx = Math.abs(x2 - x1);
    const sx = x1 < x2 ? 1 : -1;
    const dy = -Math.abs(y2 - y1);
    const sy = y1 < y2 ? 1 : -1;
    let error = dx + dy;
    let x = x1;
    let y = y1;
    while (true) {
      fillRect(
        x - Math.floor(thickness / 2),
        y - Math.floor(thickness / 2),
        thickness,
        thickness,
        color,
      );
      if (x === x2 && y === y2) break;
      const doubled = 2 * error;
      if (doubled >= dy) {
        error += dy;
        x += sx;
      }
      if (doubled <= dx) {
        error += dx;
        y += sy;
      }
    }
  }

  fillRect(0, 0, width, height, background);
  return {
    width,
    height,
    pixels,
    fillRect,
    strokeRect,
    drawText,
    line,
  };
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

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function encodePng(scene, description) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(scene.width, 0);
  ihdr.writeUInt32BE(scene.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = scene.width * 3;
  const scanlines = Buffer.alloc(scene.height * (stride + 1));
  for (let row = 0; row < scene.height; row += 1) {
    const target = row * (stride + 1);
    scanlines[target] = 0;
    scene.pixels.copy(scanlines, target + 1, row * stride, (row + 1) * stride);
  }
  const compressed = zlib.deflateSync(scanlines, {
    level: 9,
    strategy: zlib.constants.Z_FIXED,
  });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk(
      'tEXt',
      Buffer.from(`Description\0${description}`, 'latin1'),
    ),
    pngChunk('IDAT', compressed),
    pngChunk('IEND'),
  ]);
}

function screenshotPng() {
  const scene = canvas(320, 180, [18, 24, 36]);
  scene.fillRect(0, 0, 320, 28, [42, 54, 75]);
  scene.fillRect(18, 43, 284, 116, [32, 42, 58]);
  scene.strokeRect(18, 43, 284, 116, [81, 98, 122], 2);
  scene.fillRect(35, 56, 250, 58, [132, 35, 48]);
  scene.strokeRect(35, 56, 250, 58, [238, 86, 103], 3);
  scene.drawText('ERROR 500', 52, 69, 4, [255, 246, 247]);
  scene.drawText('REQUEST FAILED', 77, 129, 2, [247, 213, 218]);
  return encodePng(
    scene,
    'Rendered checkout failure UI with visible markers ERROR 500 and REQUEST FAILED',
  );
}

function diagramPng() {
  const scene = canvas(400, 180, [244, 248, 252]);
  const boxColor = [219, 234, 254];
  const borderColor = [37, 99, 235];
  const ink = [15, 23, 42];
  scene.fillRect(0, 0, 400, 20, [226, 232, 240]);
  for (const x of [15, 145, 275]) {
    scene.fillRect(x, 58, 110, 64, boxColor);
    scene.strokeRect(x, 58, 110, 64, borderColor, 3);
  }
  scene.drawText('CLIENT', 34, 80, 2, ink);
  scene.drawText('ROUTER', 164, 80, 2, ink);
  scene.drawText('MODEL', 300, 80, 2, ink);
  for (const [start, end] of [[125, 145], [255, 275]]) {
    scene.line(start, 90, end - 3, 90, borderColor, 3);
    scene.line(end - 10, 82, end - 2, 90, borderColor, 3);
    scene.line(end - 10, 98, end - 2, 90, borderColor, 3);
  }
  return encodePng(
    scene,
    'Rendered request flow CLIENT -> ROUTER -> MODEL',
  );
}

function pdfEscape(text) {
  return text.replace(/([\\()])/g, '\\$1');
}

function pdfText(x, y, size, text) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`;
}

function encodePdf(contentCommands) {
  const stream = `${contentCommands.join('\n')}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    [
      '<< /Type /Page /Parent 2 0 R',
      '/MediaBox [0 0 612 792]',
      '/Resources << /Font << /F1 5 0 R >> >>',
      '/Contents 4 0 R >>',
    ].join(' '),
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let document = '%PDF-1.4\n% c-thru deterministic artifact\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets[index + 1] = Buffer.byteLength(document, 'ascii');
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, 'ascii');
  document += `xref\n0 ${objects.length + 1}\n`;
  document += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    document += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  document += [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');
  return Buffer.from(document, 'ascii');
}

function pricingTablePdf() {
  return encodePdf([
    pdfText(54, 742, 18, 'C-THRU VENDOR PRICING'),
    pdfText(54, 708, 11, 'Plan | Monthly price | Included projects'),
    '54 700 m 558 700 l S',
    pdfText(54, 676, 11, 'Starter | 19 USD | 2 projects'),
    pdfText(54, 650, 11, 'Professional | 49 USD | 20 projects'),
    pdfText(54, 624, 11, 'Enterprise | 99 USD | unlimited projects'),
    '54 612 m 558 612 l S',
    pdfText(54, 580, 9, 'All prices are deterministic test facts, not commercial offers.'),
  ]);
}

function multiColumnPdf() {
  return encodePdf([
    pdfText(54, 742, 18, 'QUARTERLY OPERATIONS FINDINGS'),
    '306 692 m 306 510 l S',
    pdfText(54, 704, 12, 'PERFORMANCE'),
    pdfText(54, 678, 9, 'LEFT FACT: Median latency fell by 18 percent'),
    pdfText(54, 654, 9, 'LEFT FACT: Cache hit rate reached 83 percent'),
    pdfText(324, 704, 12, 'RELIABILITY'),
    pdfText(324, 678, 9, 'RIGHT FACT: Error rate held at 0.7 percent'),
    pdfText(324, 654, 9, 'RIGHT FACT: Adoption reached 64 teams'),
    pdfText(54, 560, 9, 'Read both columns to recover the complete finding set.'),
  ]);
}

function largeLogs() {
  const services = ['gateway', 'router', 'worker-a', 'worker-b'];
  return services.map((service, fileIndex) => {
    const lines = [];
    for (let index = 0; index < 720; index += 1) {
      const minute = String(Math.floor(index / 60) % 60).padStart(2, '0');
      const second = String(index % 60).padStart(2, '0');
      const sequence = String(index).padStart(4, '0');
      const isNeedle = fileIndex === 2 && index === 417;
      const requestId = isNeedle
        ? LOG_NEEDLE
        : `req-${String(fileIndex + 1).padStart(2, '0')}-${sequence}`;
      const status = isNeedle ? 500 : (index % 11 === 0 ? 204 : 200);
      const level = isNeedle ? 'ERROR' : 'INFO';
      const message = isNeedle
        ? 'upstream connection reset after headers'
        : 'request completed with deterministic fixture payload';
      lines.push(
        `2026-07-27T12:${minute}:${second}.000Z ` +
        `service=${service} shard=${fileIndex + 1} seq=${sequence} ` +
        `level=${level} status=${status} request_id=${requestId} ` +
        `latency_ms=${20 + ((fileIndex * 37 + index * 13) % 180)} ` +
        `message="${message}"`,
      );
    }
    return {
      relativePath: `generated/logs/service-${String(fileIndex + 1).padStart(2, '0')}.log`,
      mediaType: 'text/plain',
      content: Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
    };
  });
}

function oversizedSpecification() {
  const topics = [
    'validate signed work orders before accepting a regional update',
    'retain an immutable revision identifier in every audit record',
    'reject stale revisions without modifying the accepted document',
    'record the source office and deterministic receipt timestamp',
    'export a complete audit record before acknowledging completion',
    'preserve idempotency when a client retries the same revision',
    'surface a stable conflict code to every supported client',
    'verify regional access policy before returning document contents',
    'retain the prior revision until the replacement is fully durable',
    'produce the same ordered export for the same accepted revisions',
  ];
  const pages = [];
  for (let pageNumber = 1; pageNumber <= 200; pageNumber += 1) {
    const page = String(pageNumber).padStart(3, '0');
    const lines = [
      `=== PAGE ${page} OF 200 ===`,
      `ATLAS SYNCHRONIZATION SPECIFICATION - SECTION ${page}`,
    ];
    if (pageNumber === 1) {
      lines.push(
        'PURPOSE FACT: Atlas synchronizes signed work orders between regional offices.',
      );
    }
    if (pageNumber === 100) {
      lines.push(
        'MIDPOINT FACT: Conflict resolution always prefers the higher revision number.',
      );
    }
    if (pageNumber === 200) {
      lines.push(
        'FINAL FACT: A release is complete only after every audit record is exported.',
      );
    }
    for (let requirement = 0; requirement < topics.length; requirement += 1) {
      lines.push(
        `Requirement ${page}.${String(requirement + 1).padStart(2, '0')}: ` +
        `The Atlas service MUST ${topics[requirement]}. ` +
        `Verification uses region R${String((pageNumber + requirement) % 17).padStart(2, '0')}, ` +
        `revision V${String(pageNumber * 10 + requirement).padStart(5, '0')}, ` +
        'and an independently replayed audit export so the result is reproducible.',
      );
    }
    pages.push(`${lines.join('\n')}\n`);
  }
  return Buffer.from(pages.join('\n'), 'utf8');
}

const DEFINITIONS = deepFreeze({
  'vision-screenshot': {
    id: 'vision-screenshot',
    kind: 'image',
    relativePaths: ['generated/ui-failure.png'],
    expected: {
      width: 320,
      height: 180,
      textMarkers: ['ERROR 500', 'REQUEST FAILED'],
    },
  },
  'vision-diagram': {
    id: 'vision-diagram',
    kind: 'image',
    relativePaths: ['generated/request-flow.png'],
    expected: {
      width: 400,
      height: 180,
      textMarkers: ['CLIENT', 'ROUTER', 'MODEL'],
    },
  },
  'pdf-table': {
    id: 'pdf-table',
    kind: 'pdf',
    relativePaths: ['generated/vendor-pricing.pdf'],
    expected: {
      pageCount: 1,
      facts: [
        'Starter | 19 USD | 2 projects',
        'Professional | 49 USD | 20 projects',
        'Enterprise | 99 USD | unlimited projects',
      ],
    },
  },
  'pdf-multicol': {
    id: 'pdf-multicol',
    kind: 'pdf',
    relativePaths: ['generated/quarterly-findings.pdf'],
    expected: {
      pageCount: 1,
      facts: [
        'LEFT FACT: Median latency fell by 18 percent',
        'LEFT FACT: Cache hit rate reached 83 percent',
        'RIGHT FACT: Error rate held at 0.7 percent',
        'RIGHT FACT: Adoption reached 64 teams',
      ],
    },
  },
  'longctx-needle': {
    id: 'longctx-needle',
    kind: 'large-context',
    relativePaths: [
      'generated/logs/service-01.log',
      'generated/logs/service-02.log',
      'generated/logs/service-03.log',
      'generated/logs/service-04.log',
    ],
    expected: {
      minimumEstimatedTokens: 50_000,
      needle: LOG_NEEDLE,
    },
  },
  'longctx-bigdoc': {
    id: 'longctx-bigdoc',
    kind: 'large-context',
    relativePaths: ['generated/specification-200-pages.txt'],
    expected: {
      minimumEstimatedTokens: 50_000,
      pageMarkers: 200,
      facts: [
        'PURPOSE FACT: Atlas synchronizes signed work orders between regional offices.',
        'MIDPOINT FACT: Conflict resolution always prefers the higher revision number.',
        'FINAL FACT: A release is complete only after every audit record is exported.',
      ],
    },
  },
});

const ARTIFACT_FIXTURE_IDS = Object.freeze(Object.keys(DEFINITIONS));
const ARTIFACT_FIXTURE_REGISTRY = deepFreeze(Object.fromEntries(
  ARTIFACT_FIXTURE_IDS.map(id => {
    const definition = DEFINITIONS[id];
    return [id, {
      id: definition.id,
      kind: definition.kind,
      relativePaths: [...definition.relativePaths],
      expected: definition.expected,
    }];
  }),
));

function outputForFixture(id) {
  switch (id) {
    case 'vision-screenshot':
      return [{
        relativePath: 'generated/ui-failure.png',
        mediaType: 'image/png',
        content: screenshotPng(),
      }];
    case 'vision-diagram':
      return [{
        relativePath: 'generated/request-flow.png',
        mediaType: 'image/png',
        content: diagramPng(),
      }];
    case 'pdf-table':
      return [{
        relativePath: 'generated/vendor-pricing.pdf',
        mediaType: 'application/pdf',
        content: pricingTablePdf(),
      }];
    case 'pdf-multicol':
      return [{
        relativePath: 'generated/quarterly-findings.pdf',
        mediaType: 'application/pdf',
        content: multiColumnPdf(),
      }];
    case 'longctx-needle':
      return largeLogs();
    case 'longctx-bigdoc':
      return [{
        relativePath: 'generated/specification-200-pages.txt',
        mediaType: 'text/plain',
        content: oversizedSpecification(),
      }];
    default:
      throw new Error(`unknown artifact fixture id: ${id}`);
  }
}

function assertSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split('/').includes('..') ||
    !relativePath.startsWith('generated/')
  ) {
    throw new Error(`unsafe artifact relative path: ${JSON.stringify(relativePath)}`);
  }
}

function ensureDirectory(root, relativeDirectory, createdDirectories) {
  let current = root;
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`artifact path is not a safe directory: ${current}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      fs.chmodSync(current, 0o700);
      createdDirectories.push(current);
    }
  }
}

function existingTargetError(target) {
  const error = new Error(`artifact target already exists: ${target}`);
  error.code = 'EEXIST';
  return error;
}

function materializeOffloadArtifactFixture(id, cwd) {
  if (!Object.prototype.hasOwnProperty.call(DEFINITIONS, id)) {
    throw new Error(`unknown artifact fixture id: ${id}`);
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new TypeError('artifact fixture cwd must be a non-empty directory path');
  }
  const suppliedRoot = path.resolve(cwd);
  const rootStat = fs.lstatSync(suppliedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`artifact fixture cwd is not a safe directory: ${suppliedRoot}`);
  }
  const root = fs.realpathSync(suppliedRoot);
  const definition = DEFINITIONS[id];
  const outputs = outputForFixture(id);
  const outputPaths = outputs.map(output => output.relativePath);
  if (
    outputPaths.length !== definition.relativePaths.length ||
    outputPaths.some((relativePath, index) =>
      relativePath !== definition.relativePaths[index])
  ) {
    throw new Error(`artifact generator registry drift for ${id}`);
  }
  for (const output of outputs) {
    assertSafeRelativePath(output.relativePath);
    if (!Buffer.isBuffer(output.content) || output.content.length === 0) {
      throw new Error(`artifact generator produced empty bytes for ${output.relativePath}`);
    }
  }

  const createdDirectories = [];
  const createdFiles = [];
  try {
    for (const relativeDirectory of new Set(
      outputs.map(output => path.posix.dirname(output.relativePath)),
    )) {
      ensureDirectory(root, relativeDirectory, createdDirectories);
    }

    for (const output of outputs) {
      const target = path.resolve(root, ...output.relativePath.split('/'));
      if (!target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`artifact target escapes supplied cwd: ${output.relativePath}`);
      }
      try {
        fs.lstatSync(target);
        throw existingTargetError(target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    for (const output of outputs) {
      const target = path.resolve(root, ...output.relativePath.split('/'));
      fs.writeFileSync(target, output.content, {
        flag: 'wx',
        mode: 0o600,
      });
      createdFiles.push(target);
      fs.chmodSync(target, 0o600);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`artifact output is not a regular file: ${target}`);
      }
    }
  } catch (error) {
    for (const file of createdFiles.reverse()) {
      try { fs.unlinkSync(file); } catch {}
    }
    for (const directory of createdDirectories.reverse()) {
      try { fs.rmdirSync(directory); } catch {}
    }
    throw error;
  }

  const files = outputs.map(output => {
    const absolutePath = path.resolve(root, ...output.relativePath.split('/'));
    return {
      relativePath: output.relativePath,
      absolutePath,
      mediaType: output.mediaType,
      bytes: output.content.length,
      sha256: sha256(output.content),
    };
  });
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return deepFreeze({
    id,
    kind: definition.kind,
    root,
    generatedDirectory: path.join(root, 'generated'),
    files,
    totalBytes,
    estimatedTokenEquivalent: Math.floor(totalBytes / TOKEN_EQUIVALENT_DIVISOR),
    expected: definition.expected,
  });
}

module.exports = {
  ARTIFACT_FIXTURE_IDS,
  ARTIFACT_FIXTURE_REGISTRY,
  materializeOffloadArtifactFixture,
};
