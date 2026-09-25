/**
 * Programmatically generated, known-good test files (no binary fixtures in the repo).
 */

/** Word-wrap text into lines that fit on a Letter page at 10pt (text outside the page is not extractable). */
function wrap(text, width = 90) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Build a minimal but spec-valid PDF; each array item is one page of word-wrapped text. */
export function makePdf(pages = ['Hello PDF']) {
  const objects = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const pageId = pageIds[i];
    const lines = wrap(text).map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join(' ');
    const stream = `BT /F1 10 Tf 12 TL 40 750 Td ${lines} ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  let body = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** 1x1 transparent PNG. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Minimal baseline JPEG header (SOI + APP0 + SOF0 1x1) followed by EOI. */
export const JPEG_1X1 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]);

/** Minimal lossless WEBP (1x1). */
export function makeWebp() {
  const vp8l = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x88, 0x88, 0x08, 0x00]); // header, 1x1
  const chunk = Buffer.concat([Buffer.from('VP8L'), le32(vp8l.length), vp8l, Buffer.alloc(vp8l.length % 2)]);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk]);
  return Buffer.concat([Buffer.from('RIFF'), le32(body.length), body]);
}

function le32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

export const b64 = (buf) => Buffer.from(buf).toString('base64');
