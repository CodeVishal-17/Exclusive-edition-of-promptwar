import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../src/config.js';
import { ValidationError } from '../src/errors.js';
import { hasValidSignature, inspectDocument } from '../src/file-inspect.js';
import { validateDocument } from '../src/validate.js';
import { b64, JPEG_1X1, makePdf, makeWebp, PNG_1X1 } from './helpers/fixtures.js';

const fileDoc = (bytes, mimeType, name) => validateDocument({ file: { data: b64(bytes), mimeType, name } });

describe('file signatures', () => {
  it('recognises genuine files', () => {
    assert.ok(hasValidSignature('application/pdf', makePdf()));
    assert.ok(hasValidSignature('image/png', PNG_1X1));
    assert.ok(hasValidSignature('image/jpeg', JPEG_1X1));
    assert.ok(hasValidSignature('image/webp', makeWebp()));
  });

  it('rejects mismatched signatures', () => {
    assert.equal(hasValidSignature('image/png', makePdf()), false);
    assert.equal(hasValidSignature('application/pdf', PNG_1X1), false);
    assert.equal(hasValidSignature('image/jpeg', PNG_1X1), false);
    assert.equal(hasValidSignature('image/webp', Buffer.from('RIFF....AVI LIST')), false);
    assert.equal(hasValidSignature('text/html', Buffer.from('<html>')), false);
  });
});

describe('inspectDocument: PDFs', () => {
  it('parses a valid PDF and keeps per-page text for grounding', async () => {
    const doc = await inspectDocument(fileDoc(makePdf(['Clause 1. Rent is due monthly.', 'Clause 2. Deposit terms.']), 'application/pdf', 'a.pdf'));
    assert.equal(doc.source.pageCount, 2);
    assert.deepEqual(doc.source.pages, ['Clause 1. Rent is due monthly.', 'Clause 2. Deposit terms.']);
    assert.equal(doc.source.paged, true);
  });

  it('rejects a file that only claims to be a PDF', async () => {
    await assert.rejects(inspectDocument(fileDoc(Buffer.from('MZ\x90\x00 this is an exe'), 'application/pdf')), /does not match its type/);
    await assert.rejects(inspectDocument(fileDoc(PNG_1X1, 'application/pdf')), ValidationError);
  });

  it('rejects a damaged PDF that has a valid header', async () => {
    const damaged = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> garbage without xref or trailer');
    await assert.rejects(inspectDocument(fileDoc(damaged, 'application/pdf')), /could not be read/);
  });

  it('rejects PDFs over the page limit', async () => {
    const pages = Array.from({ length: LIMITS.maxPdfPages + 1 }, (_, i) => `Page ${i + 1}`);
    await assert.rejects(inspectDocument(fileDoc(makePdf(pages), 'application/pdf')), /maximum is/);
  });

  it('marks PDFs without a text layer as not verifiable', async () => {
    const doc = await inspectDocument(fileDoc(makePdf(['']), 'application/pdf'));
    assert.equal(doc.source.pages, null);
  });
});

describe('inspectDocument: images', () => {
  it('accepts valid PNG, JPEG and WEBP images', async () => {
    for (const [bytes, type] of [[PNG_1X1, 'image/png'], [JPEG_1X1, 'image/jpeg'], [makeWebp(), 'image/webp']]) {
      const doc = await inspectDocument(fileDoc(bytes, type));
      assert.equal(doc.source.pages, null, `${type} has no text layer to verify against`);
    }
  });

  it('rejects an image whose bytes are a different format', async () => {
    await assert.rejects(inspectDocument(fileDoc(JPEG_1X1, 'image/png')), /does not match its type/);
    await assert.rejects(inspectDocument(fileDoc(PNG_1X1, 'image/webp')), /does not match its type/);
  });

  it('rejects a truncated image with a valid signature', async () => {
    const truncated = Buffer.concat([PNG_1X1.subarray(0, 8), Buffer.alloc(20)]);
    await assert.rejects(inspectDocument(fileDoc(truncated, 'image/png')), ValidationError);
  });
});

describe('inspectDocument: text', () => {
  it('uses pasted text as the grounding source', async () => {
    const doc = await inspectDocument(validateDocument({ text: 'The tenant must give two months notice before leaving the flat.' }));
    assert.deepEqual(doc.source.pages, ['The tenant must give two months notice before leaving the flat.']);
    assert.equal(doc.source.paged, false);
  });
});
