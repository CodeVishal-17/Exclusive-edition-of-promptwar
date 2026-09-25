// HTTP-level tests. The model is a MOCK generator; no network calls are made.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { LIMITS, loadConfig } from '../src/config.js';
import { AIServiceError } from '../src/errors.js';
import { parseJson } from '../src/gemini.js';
import { createLegalService } from '../src/legal-service.js';
import { b64, JPEG_1X1, makePdf, PNG_1X1 } from './helpers/fixtures.js';
import { LEASE_TEXT, mockAnalysis, mockGenerator } from './helpers/mock-responses.js';

function captureLogger() {
  const lines = [];
  const push = (severity) => (message, fields) => lines.push(JSON.stringify({ severity, message, ...fields }));
  return { lines, info: push('INFO'), warn: push('WARNING'), error: push('ERROR') };
}

function makeApp({ generateJson = mockGenerator(), rateLimitPerMinute = 1000, logger, bodyLimit } = {}) {
  const config = { ...loadConfig({}), rateLimitPerMinute };
  const legalService = generateJson === null ? null : createLegalService({ generateJson, logger });
  return createApp({ config, legalService, logger, bodyLimit });
}

const pdfUpload = (pages = LEASE_TEXT.split('\n')) => ({ file: { data: b64(makePdf(pages)), mimeType: 'application/pdf', name: 'lease.pdf' } });

describe('static app and headers', () => {
  it('serves the app shell with security headers', async () => {
    const res = await request(makeApp()).get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /LegalLens/);
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS: same-origin only');
  });

  it('exposes /health (not /healthz, which Cloud Run reserves) and public config', async () => {
    const app = makeApp();
    const health = await request(app).get('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok', aiReady: true });
    const cfg = await request(app).get('/api/config');
    assert.equal(cfg.body.aiReady, true);
    assert.ok(cfg.body.languages.hi);
    assert.doesNotMatch(JSON.stringify(cfg.body), /apiKey|project/i);
  });
});

describe('Understand: POST /api/analyze', () => {
  it('analyses pasted text and verifies quotes', async () => {
    const res = await request(makeApp()).post('/api/analyze').send({ document: { text: LEASE_TEXT }, language: 'en' });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Rental agreement');
    assert.equal(res.body.grounding.quotesVerified, 3);
    assert.equal(res.body.grounding.quotesNotFound, 1);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('analyses a valid PDF upload with page references', async () => {
    const res = await request(makeApp()).post('/api/analyze').send({ document: pdfUpload() });
    assert.equal(res.status, 200);
    const termination = res.body.clauses.find((c) => c.heading === 'Termination');
    assert.equal(termination.quoteStatus, 'verified');
    assert.equal(termination.page, 4);
  });

  it('analyses a valid image upload (quotes marked unverifiable)', async () => {
    for (const [bytes, mimeType, name] of [[PNG_1X1, 'image/png', 'notice.png'], [JPEG_1X1, 'image/jpeg', 'notice.jpg']]) {
      const res = await request(makeApp()).post('/api/analyze').send({ document: { file: { data: b64(bytes), mimeType, name } } });
      assert.equal(res.status, 200, mimeType);
      assert.equal(res.body.grounding.sourceTextAvailable, false);
      assert.ok(res.body.clauses.every((c) => c.quoteStatus === 'unavailable'));
    }
  });

  it('rejects files with an invalid signature before calling the model', async () => {
    const generate = mockGenerator();
    const app = makeApp({ generateJson: generate });
    const cases = [
      { data: b64(Buffer.from('<script>alert(1)</script>')), mimeType: 'image/png', name: 'x.png' },
      { data: b64(PNG_1X1), mimeType: 'application/pdf', name: 'x.pdf' },
      { data: b64(Buffer.from('%PDF-1.4 not really a pdf')), mimeType: 'application/pdf', name: 'x.pdf' },
    ];
    for (const file of cases) {
      const res = await request(app).post('/api/analyze').send({ document: { file } });
      assert.equal(res.status, 400, file.mimeType);
      assert.ok(res.body.error);
    }
    assert.equal(generate.calls.length, 0);
  });

  it('rejects unsupported types, malformed base64, empty and missing input', async () => {
    const app = makeApp();
    const bodies = [
      {},
      { document: {} },
      { document: { text: 'short' } },
      { document: { file: { data: '', mimeType: 'image/png' } } },
      { document: { file: { data: '%%%%', mimeType: 'image/png' } } },
      { document: { file: { data: b64('MZ'), mimeType: 'application/x-msdownload', name: 'a.exe' } } },
      { document: { file: { data: b64('<svg onload=alert(1)>'), mimeType: 'image/svg+xml' } } },
      { document: { text: LEASE_TEXT }, language: 'klingon' },
    ];
    for (const body of bodies) {
      const res = await request(app).post('/api/analyze').send(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(typeof res.body.error, 'string');
    }
  });

  it('rejects oversized files (by decoded size and by request size)', async () => {
    const app = makeApp();
    const overLimit = 'A'.repeat(Math.ceil((LIMITS.maxFileBytes + 3) / 3) * 4);
    const res = await request(app).post('/api/analyze').send({ document: { file: { data: overLimit, mimeType: 'image/png' } } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /too large/);

    // Same body-parser limit mechanism, exercised with a small limit to keep test memory low.
    const small = makeApp({ bodyLimit: '64kb' });
    const res2 = await request(small).post('/api/analyze').send({ document: { file: { data: 'A'.repeat(100 * 1024), mimeType: 'image/png' } } });
    assert.equal(res2.status, 413);
  });

  it('rejects malformed JSON', async () => {
    const res = await request(makeApp()).post('/api/analyze').set('Content-Type', 'application/json').send('{bad');
    assert.equal(res.status, 400);
  });
});

describe('Ask: POST /api/ask', () => {
  it('answers with verified citations', async () => {
    const res = await request(makeApp()).post('/api/ask').send({ document: { text: LEASE_TEXT }, question: 'Notice period?' });
    assert.equal(res.status, 200);
    assert.equal(res.body.answer, 'Two months written notice.');
    assert.equal(res.body.citations[0].quoteStatus, 'verified');
  });

  it('works for follow-up questions on a PDF', async () => {
    const res = await request(makeApp()).post('/api/ask').send({
      document: pdfUpload(),
      question: 'And after that?',
      history: [{ role: 'user', text: 'Notice period?' }, { role: 'assistant', text: 'Two months.' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.citations[0].page, 4);
  });

  it('requires a question and a document', async () => {
    const app = makeApp();
    assert.equal((await request(app).post('/api/ask').send({ document: { text: LEASE_TEXT } })).status, 400);
    assert.equal((await request(app).post('/api/ask').send({ question: 'Notice?' })).status, 400);
  });
});

describe('Compare: POST /api/compare', () => {
  it('compares two documents', async () => {
    const res = await request(makeApp()).post('/api/compare').send({ documentA: { text: LEASE_TEXT }, documentB: { text: LEASE_TEXT.replace("two months'", "one month's") } });
    assert.equal(res.status, 200);
    assert.equal(res.body.differences[0].appearsMoreFavourable, 'B');
    assert.equal(res.body.differences[0].quoteBStatus, 'verified');
  });

  it('names the missing document in the error', async () => {
    const res = await request(makeApp()).post('/api/compare').send({ documentA: { text: LEASE_TEXT } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /second document/);
  });
});

describe('errors, privacy and limits', () => {
  it('maps AI failures without leaking internals', async () => {
    const app = makeApp({ generateJson: async () => { throw new AIServiceError('The AI service is busy right now.', { status: 429, cause: new Error('secret internals') }); } });
    const res = await request(app).post('/api/analyze').send({ document: { text: LEASE_TEXT } });
    assert.equal(res.status, 429);
    assert.doesNotMatch(JSON.stringify(res.body), /secret internals/);
  });

  it('hides unexpected error details', async () => {
    const app = makeApp({ generateJson: async () => { throw new Error('db password=hunter2'); } });
    const res = await request(app).post('/api/analyze').send({ document: { text: LEASE_TEXT } });
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.text, /hunter2/);
  });

  it('never logs document text, questions or model output', async () => {
    const logger = captureLogger();
    const app = makeApp({ logger, generateJson: mockGenerator({ analysis: mockAnalysis({ title: 'MODEL-OUTPUT-MARKER' }) }) });
    await request(app).post('/api/analyze').send({ document: { text: `${LEASE_TEXT} SECRET-DOC-MARKER` } });
    await request(app).post('/api/ask').send({ document: { text: LEASE_TEXT }, question: 'SECRET-QUESTION-MARKER?' });
    await request(app).post('/api/analyze').send({ document: { text: 'SECRET-SHORT' } });
    const failing = makeApp({ logger, generateJson: async () => { throw new Error('boom'); } });
    await request(failing).post('/api/analyze').send({ document: { text: `${LEASE_TEXT} SECRET-DOC-MARKER` } });
    assert.ok(logger.lines.length >= 4);
    assert.doesNotMatch(logger.lines.join('\n'), /SECRET-|MODEL-OUTPUT-MARKER|Rs\. 20,000/);
  });

  it('returns 503 when AI is not configured, without parsing the body', async () => {
    const res = await request(makeApp({ generateJson: null })).post('/api/analyze').set('Content-Type', 'application/json').send('{not json');
    assert.equal(res.status, 503);
  });

  it('rate-limits API calls', async () => {
    const app = makeApp({ rateLimitPerMinute: 2 });
    await request(app).post('/api/analyze').send({ document: { text: LEASE_TEXT } });
    await request(app).post('/api/analyze').send({ document: { text: LEASE_TEXT } });
    const res = await request(app).post('/api/analyze').send({ document: { text: LEASE_TEXT } });
    assert.equal(res.status, 429);
    assert.match(res.body.error, /Too many requests/);
  });

  it('sets Retry-After only for a valid provider wait on 429/503, and returns a machine-readable code', async () => {
    const appThrowing = (err) => makeApp({ generateJson: async () => { throw err; } });
    const send = (app) => request(app).post('/api/analyze').send({ document: { text: LEASE_TEXT } });

    const minute = await send(appThrowing(new AIServiceError('Please try again in about 37 seconds.', { status: 429, code: 'quota_minute', retryAfterSeconds: 37 })));
    assert.equal(minute.status, 429);
    assert.equal(minute.headers['retry-after'], '37');
    assert.deepEqual(minute.body, { error: 'Please try again in about 37 seconds.', code: 'quota_minute' });

    const busy = await send(appThrowing(new AIServiceError('Heavy demand.', { status: 503, code: 'overloaded', retryAfterSeconds: 30 })));
    assert.equal(busy.status, 503);
    assert.equal(busy.headers['retry-after'], '30');

    for (const retryAfterSeconds of [null, undefined, 0, 2.5, 99_999, '37']) {
      const res = await send(appThrowing(new AIServiceError('Daily limit.', { status: 429, code: 'quota_daily', retryAfterSeconds })));
      assert.equal(res.headers['retry-after'], undefined, String(retryAfterSeconds));
      assert.equal(res.body.code, 'quota_daily');
    }
    const upstream = await send(appThrowing(new AIServiceError('Try again.', { status: 502, code: 'upstream', retryAfterSeconds: 10 })));
    assert.equal(upstream.headers['retry-after'], undefined, 'only 429/503 carry Retry-After');
  });

  it('keeps unexpected errors generic (no code, no Retry-After)', async () => {
    const res = await request(makeApp({ generateJson: async () => { throw Object.assign(new Error('internal detail'), { retryAfterSeconds: 5 }); } }))
      .post('/api/analyze').send({ document: { text: LEASE_TEXT } });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Something went wrong. Please try again.' });
    assert.equal(res.headers['retry-after'], undefined);
  });

  it('never logs raw cause messages (a JSON parse error can quote model output, and so the document)', async () => {
    const logger = captureLogger();
    const app = makeApp({ logger, generateJson: async () => parseJson('SECRET-MODEL-OUTPUT quoting "Rs. 20,000" from the lease') });
    const res = await request(app).post('/api/analyze').send({ document: { text: LEASE_TEXT } });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'bad_json');
    assert.ok(logger.lines.some((l) => l.includes('"code":"bad_json"')));
    assert.doesNotMatch(logger.lines.join('\n'), /SECRET-MODEL-OUTPUT|Rs\. 20,000/);
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await request(makeApp()).get('/api/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});
