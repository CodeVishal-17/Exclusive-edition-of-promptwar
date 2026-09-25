/**
 * Content-level checks for uploaded files. The declared MIME type is only a
 * claim; these checks confirm the bytes actually look like that type.
 *
 * - PDF:   "%PDF-" signature, then fully parsed with pdf.js (via unpdf) to
 *          reject damaged/encrypted files and enforce a page limit. The text
 *          layer is kept (in memory only) so quotes can be verified later.
 * - Image: magic-number check plus header parse with `image-size`.
 * - Text:  must be valid UTF-8 without NUL bytes.
 *
 * Nothing is written to disk.
 */
import { imageSize } from 'image-size';
import { extractText, getDocumentProxy } from 'unpdf';
import { LIMITS } from './config.js';
import { ValidationError } from './errors.js';

const SIGNATURES = {
  'image/png': (b) => b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  // The PDF spec allows the header anywhere in the first 1024 bytes.
  'application/pdf': (b) => b.subarray(0, 1024).includes(Buffer.from('%PDF-')),
};

export function hasValidSignature(mimeType, bytes) {
  const check = SIGNATURES[mimeType];
  return Boolean(check && check(bytes));
}

/** Decode strict UTF-8; throws ValidationError for binary or invalid text. */
export function decodeUtf8Text(bytes, label = 'document') {
  if (bytes.includes(0)) {
    throw new ValidationError(`The ${label} is not a plain-text file.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError(`The ${label} is not valid UTF-8 text.`);
  }
}

function inspectImage(mimeType, bytes, label) {
  let size;
  try {
    size = imageSize(new Uint8Array(bytes));
  } catch {
    throw new ValidationError(`The ${label} image appears to be damaged.`);
  }
  const expected = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mimeType];
  if (size.type !== expected || !size.width || !size.height) {
    throw new ValidationError(`The ${label} image content does not match its file type.`);
  }
  if (size.width * size.height > LIMITS.maxImagePixels) {
    throw new ValidationError(`The ${label} image resolution is too high.`);
  }
}

async function inspectPdf(bytes, label) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      isEvalSupported: false, // never compile code from font data
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: true,
      verbosity: 0,
    });
  } catch (err) {
    if (err?.name === 'PasswordException') {
      throw new ValidationError(`The ${label} PDF is password-protected. Please upload an unlocked copy.`);
    }
    throw new ValidationError(`The ${label} PDF could not be read. It may be damaged.`);
  }
  try {
    if (pdf.numPages < 1) throw new ValidationError(`The ${label} PDF has no pages.`);
    if (pdf.numPages > LIMITS.maxPdfPages) {
      throw new ValidationError(`The ${label} PDF has ${pdf.numPages} pages; the maximum is ${LIMITS.maxPdfPages}.`);
    }
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text ?? '')];
    return { pages, pageCount: pdf.numPages };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`The ${label} PDF could not be read. It may be damaged.`);
  } finally {
    // Release parser memory (pdf.js 6 exposes destroy() on the loading task, not the proxy).
    await pdf.loadingTask?.destroy?.().catch(() => {});
  }
}

/**
 * Verify a validated document's content and attach `source` text used for
 * quote verification: `{ pages: string[] | null, pageCount }`.
 * `pages` is null when no machine-readable text exists (images).
 */
export async function inspectDocument(doc, label = 'document') {
  if (doc.kind === 'text') {
    return { ...doc, source: { pages: [doc.text], pageCount: null, paged: false } };
  }
  const bytes = Buffer.from(doc.data, 'base64');
  if (!hasValidSignature(doc.mimeType, bytes)) {
    throw new ValidationError(`The ${label} file's content does not match its type. Please upload a genuine PDF, PNG, JPEG or WEBP file.`);
  }
  if (doc.mimeType === 'application/pdf') {
    const { pages, pageCount } = await inspectPdf(bytes, label);
    const hasText = pages.some((p) => p.trim().length > 0);
    return { ...doc, source: { pages: hasText ? pages : null, pageCount, paged: true } };
  }
  inspectImage(doc.mimeType, bytes, label);
  return { ...doc, source: { pages: null, pageCount: null, paged: false } };
}
