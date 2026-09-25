import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../src/config.js';
import {
  ValidationError,
  base64ByteLength,
  cleanFileName,
  cleanText,
  validateDocument,
  validateHistory,
  validateLanguage,
  validateQuestion,
  validateReadingLevel,
} from '../src/validate.js';
import { b64, makePdf, PNG_1X1 } from './helpers/fixtures.js';

const LONG_TEXT = 'The tenant shall pay rent of Rs. 10,000 on the first day of every month.';

describe('validateDocument: pasted text', () => {
  it('accepts text and strips control characters', () => {
    const doc = validateDocument({ text: `  ${LONG_TEXT}\u0007\r\n` });
    assert.equal(doc.kind, 'text');
    assert.equal(doc.text, LONG_TEXT);
  });

  it('rejects missing, empty or ambiguous input', () => {
    assert.throws(() => validateDocument(undefined), /missing/);
    assert.throws(() => validateDocument(null), ValidationError);
    assert.throws(() => validateDocument([]), ValidationError);
    assert.throws(() => validateDocument({}), /empty/);
    assert.throws(() => validateDocument({ text: '   ' }), /empty/);
    assert.throws(() => validateDocument({ text: LONG_TEXT, file: { data: 'x', mimeType: 'application/pdf' } }), /not both/);
  });

  it('enforces text length bounds', () => {
    assert.throws(() => validateDocument({ text: 'too short' }), /too short/);
    assert.throws(() => validateDocument({ text: 'a'.repeat(LIMITS.maxTextChars + 1) }), /too long/);
  });

  it('uses the label in error messages', () => {
    assert.throws(() => validateDocument(null, 'first document'), /first document/);
  });
});

describe('validateDocument: files', () => {
  it('accepts a PDF and strips a matching data-URL prefix', () => {
    const data = b64(makePdf());
    const doc = validateDocument({ file: { data: `data:application/pdf;base64,${data}`, mimeType: 'application/pdf', name: 'lease.pdf' } });
    assert.equal(doc.kind, 'file');
    assert.equal(doc.data, data);
    assert.equal(doc.name, 'lease.pdf');
  });

  it('accepts an image', () => {
    const doc = validateDocument({ file: { data: b64(PNG_1X1), mimeType: 'image/png', name: 'notice.PNG' } });
    assert.equal(doc.mimeType, 'image/png');
  });

  it('decodes UTF-8 .txt uploads into the text path', () => {
    const text = `${LONG_TEXT} किराया`;
    const doc = validateDocument({ file: { data: b64(Buffer.from(text)), mimeType: 'text/plain', name: 'a.txt' } });
    assert.equal(doc.kind, 'text');
    assert.equal(doc.text, text);
  });

  it('rejects binary or invalid UTF-8 labelled as text', () => {
    assert.throws(() => validateDocument({ file: { data: b64(PNG_1X1), mimeType: 'text/plain', name: 'a.txt' } }), /not a plain-text file/);
    const invalid = Buffer.concat([Buffer.from(LONG_TEXT), Buffer.from([0xc3, 0x28])]);
    assert.throws(() => validateDocument({ file: { data: b64(invalid), mimeType: 'text/plain' } }), /not valid UTF-8/);
  });

  it('rejects unsupported types', () => {
    for (const mimeType of ['application/x-msdownload', 'text/html', 'image/svg+xml', 'application/zip', '', undefined, 42]) {
      assert.throws(() => validateDocument({ file: { data: b64('x'), mimeType } }), /Unsupported file type/, String(mimeType));
    }
  });

  it('rejects extensions that do not match the declared type', () => {
    assert.throws(() => validateDocument({ file: { data: b64(makePdf()), mimeType: 'application/pdf', name: 'invoice.exe' } }), /does not match/);
    assert.throws(() => validateDocument({ file: { data: b64(PNG_1X1), mimeType: 'image/png', name: 'x.jpg' } }), /does not match/);
  });

  it('rejects a data-URL prefix that contradicts the declared type', () => {
    assert.throws(() => validateDocument({ file: { data: `data:text/html;base64,${b64(PNG_1X1)}`, mimeType: 'image/png' } }), /inconsistent/);
  });

  it('rejects malformed base64', () => {
    const bad = ['<<not base64>>', 'abc', 'ab=c', '====', 'QUJD\u0000', 'QU JD!'];
    for (const data of bad) {
      assert.throws(() => validateDocument({ file: { data, mimeType: 'image/png' } }), ValidationError, JSON.stringify(data));
    }
  });

  it('rejects empty files', () => {
    assert.throws(() => validateDocument({ file: { data: '', mimeType: 'image/png' } }), /empty/);
    assert.throws(() => validateDocument({ file: { mimeType: 'image/png' } }), /empty/);
  });

  it('rejects oversized files by decoded size', () => {
    const justOver = 'A'.repeat(Math.ceil((LIMITS.maxFileBytes + 3) / 3) * 4);
    assert.throws(() => validateDocument({ file: { data: justOver, mimeType: 'image/png' } }), /too large/);
  });

  it('rejects huge payloads before regex/decoding work', () => {
    // Not even valid base64: the cheap length guard must reject it before regex/decoding.
    const huge = '!'.repeat(Math.ceil(LIMITS.maxFileBytes * 1.45));
    assert.throws(() => validateDocument({ file: { data: huge, mimeType: 'image/png' } }), /too large/);
  });

  it('accepts a file exactly at the size limit', () => {
    const largest = 'A'.repeat(Math.floor(LIMITS.maxFileBytes / 3) * 4);
    assert.ok(base64ByteLength(largest) <= LIMITS.maxFileBytes);
    assert.ok(base64ByteLength(largest) > LIMITS.maxFileBytes - 3);
    assert.doesNotThrow(() => validateDocument({ file: { data: largest, mimeType: 'image/png' } }));
  });
});

describe('file names', () => {
  it('removes paths and unsafe characters', () => {
    assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
    assert.equal(cleanFileName('C:\\Users\\me\\lease.pdf'), 'lease.pdf');
    assert.doesNotMatch(cleanFileName('<script>alert(1)</script>.png'), /[<>/]/);
    assert.equal(cleanFileName('.hidden'), 'hidden');
    assert.equal(cleanFileName(''), 'document');
  });
});

describe('option validators', () => {
  it('defaults and validates language', () => {
    assert.equal(validateLanguage(undefined), 'en');
    assert.equal(validateLanguage('hi'), 'hi');
    assert.throws(() => validateLanguage('xx'), ValidationError);
    assert.throws(() => validateLanguage('__proto__'), ValidationError);
    assert.throws(() => validateLanguage({}), ValidationError);
  });

  it('defaults and validates reading level', () => {
    assert.equal(validateReadingLevel(''), 'standard');
    assert.equal(validateReadingLevel('simple'), 'simple');
    assert.throws(() => validateReadingLevel('expert'), ValidationError);
  });

  it('validates questions', () => {
    assert.equal(validateQuestion('  Can I leave early? '), 'Can I leave early?');
    assert.throws(() => validateQuestion(''), ValidationError);
    assert.throws(() => validateQuestion(42), ValidationError);
    assert.throws(() => validateQuestion('x'.repeat(1001)), /too long/);
  });

  it('normalises and truncates history', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'hacker', text: `turn ${i}` }));
    const out = validateHistory([...history, { text: 5 }, null]);
    assert.ok(out.length <= LIMITS.maxHistoryTurns);
    assert.ok(out.every((t) => t.role === 'user' || t.role === 'assistant'));
    assert.deepEqual(validateHistory(undefined), []);
    assert.throws(() => validateHistory('nope'), ValidationError);
  });
});

describe('helpers', () => {
  it('computes exact base64 byte length', () => {
    assert.equal(base64ByteLength(b64('hello')), 5);
    assert.equal(base64ByteLength(b64('hell')), 4);
    assert.equal(base64ByteLength(b64('hel')), 3);
  });

  it('cleans text', () => {
    assert.equal(cleanText('a\r\nb\u0000'), 'a\nb');
  });
});
