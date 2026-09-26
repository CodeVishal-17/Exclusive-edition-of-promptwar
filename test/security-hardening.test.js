// Security hardening: origin checks, client-IP handling, AI concurrency limits and slot cleanup.
// The model is a MOCK (no network).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig, parseConfig } from '../src/config.js';
import { AIServiceError } from '../src/errors.js';
import { isAllowedOrigin } from '../src/guards.js';
import { createLegalService } from '../src/legal-service.js';
import { LEASE_TEXT, mockAnalysis, mockGenerator } from './helpers/mock-responses.js';

const doc = (n = 0) => ({ text: `${LEASE_TEXT}\n4. NOTE ${n}. Unique line for this request.` });

function captureLogger() {
  const lines = [];
  const push = (severity) => (message, fields) => lines.push(JSON.stringify({ severity, message, ...fields }));
  return { lines, info: push('INFO'), warn: push('WARNING'), error: push('ERROR') };
}

function makeApp({ generateJson = mockGenerator(), logger, bodyLimit, ...overrides } = {}) {
  const config = { ...loadConfig({}), rateLimitPerMinute: 1000, ...overrides };
  const legalService = createLegalService({ generateJson, logger });
  return createApp({ config, legalService, logger, bodyLimit });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A model whose calls wait until the test releases them. */
function heldGenerator() {
  const held = [];
  const generate = async () => {
    const d = deferred();
    held.push(d);
    await d.promise;
    return mockAnalysis();
  };
  generate.held = held;
  generate.releaseAll = () => held.forEach((d) => d.resolve());
  return generate;
}

const until = async (predicate, ms = 2000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('origin protection for AI endpoints', () => {
  it('allows same-origin browser requests (Origin matches Host)', async () => {
    const res = await request(makeApp()).post('/api/analyze')
      .set('Host', 'legallens.test').set('Origin', 'https://legallens.test')
      .send({ document: doc() });
    assert.equal(res.status, 200);
  });

  it('allows requests without an Origin header (curl, server-to-server)', async () => {
    const res = await request(makeApp()).post('/api/analyze').send({ document: doc() });
    assert.equal(res.status, 200);
  });

  it('rejects other browser origins with 403, before the body is parsed or the model is called', async () => {
    const generate = mockGenerator();
    const app = makeApp({ generateJson: generate });
    for (const origin of ['https://evil.example', 'null', 'https://legallens.test.evil.example', 'http://legallens.test:8080', 'file://x']) {
      const res = await request(app).post('/api/ask').set('Host', 'legallens.test').set('Origin', origin)
        .set('Content-Type', 'application/json').send('{ not even json');
      assert.equal(res.status, 403, origin);
      assert.equal(res.body.code, 'forbidden_origin');
    }
    assert.equal(generate.calls.length, 0);
  });

  it('allows explicitly configured origins (ALLOWED_ORIGINS / RENDER_EXTERNAL_URL)', async () => {
    const res = await request(makeApp({ allowedOrigins: ['https://partner.example'] })).post('/api/analyze')
      .set('Host', 'legallens.test').set('Origin', 'https://partner.example').send({ document: doc() });
    assert.equal(res.status, 200);
    const { config, errors } = parseConfig({ ALLOWED_ORIGINS: 'https://a.example, https://a.example/path ,http://b.example:8080', RENDER_EXTERNAL_URL: 'https://legallens.onrender.com' });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.allowedOrigins, ['https://a.example', 'http://b.example:8080', 'https://legallens.onrender.com']);
    assert.match(parseConfig({ ALLOWED_ORIGINS: 'javascript:alert(1)' }).errors.join(), /ALLOWED_ORIGINS/);
  });

  it('does not guard GET routes (page, health, config still load from anywhere)', async () => {
    const app = makeApp();
    for (const path of ['/', '/health', '/api/config']) {
      const res = await request(app).get(path).set('Origin', 'https://evil.example');
      assert.equal(res.status, 200, path);
    }
  });

  it('rejected cross-origin requests do not use up the visitor rate limit', async () => {
    const app = makeApp({ rateLimitPerMinute: 1 });
    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/api/analyze').set('Origin', 'https://evil.example').send({ document: doc() });
    }
    const res = await request(app).post('/api/analyze').send({ document: doc() });
    assert.equal(res.status, 200);
  });

  it('isAllowedOrigin handles malformed input safely', () => {
    assert.equal(isAllowedOrigin('not a url', 'a.test'), false);
    assert.equal(isAllowedOrigin(undefined, 'a.test'), false);
    assert.equal(isAllowedOrigin('https://a.test', undefined), false);
    assert.equal(isAllowedOrigin('https://a.test', 'a.test'), true);
  });
});

describe('client IP handling (trust proxy)', () => {
  it('defaults to trusting no proxy, except on Render / Cloud Run', () => {
    assert.equal(parseConfig({}).config.trustProxy, 0);
    assert.equal(parseConfig({ RENDER: 'true' }).config.trustProxy, 1);
    assert.equal(parseConfig({ K_SERVICE: 'legallens' }).config.trustProxy, 1);
    assert.equal(parseConfig({ RENDER: 'true', TRUST_PROXY: '0' }).config.trustProxy, 0);
    assert.equal(parseConfig({ TRUST_PROXY: '2' }).config.trustProxy, 2);
  });

  it('without a trusted proxy, a spoofed X-Forwarded-For cannot create new rate-limit buckets', async () => {
    const app = makeApp({ rateLimitPerMinute: 2, trustProxy: 0 });
    const send = (ip) => request(app).post('/api/analyze').set('X-Forwarded-For', ip).send({ document: doc() });
    assert.equal((await send('1.1.1.1')).status, 200);
    assert.equal((await send('2.2.2.2')).status, 200);
    assert.equal((await send('3.3.3.3')).status, 429);
  });

  it('behind one proxy (Render), only the proxy-appended address counts; prepended values are ignored', async () => {
    const app = makeApp({ rateLimitPerMinute: 2, trustProxy: 1 });
    const send = (xff) => request(app).post('/api/analyze').set('X-Forwarded-For', xff).send({ document: doc() });
    assert.equal((await send('1.1.1.1, 9.9.9.9')).status, 200);
    assert.equal((await send('2.2.2.2, 9.9.9.9')).status, 200);
    assert.equal((await send('3.3.3.3, 9.9.9.9')).status, 429, 'same real client 9.9.9.9 despite spoofed prefixes');
    assert.equal((await send('8.8.8.8')).status, 200, 'a genuinely different client is unaffected');
  });
});

describe('AI concurrency limit', () => {
  it('allows 2 simultaneous AI requests per client and rejects the 3rd with a clear 429', async () => {
    const generate = heldGenerator();
    const app = makeApp({ generateJson: generate });
    const first = request(app).post('/api/analyze').send({ document: doc(1) }).then((r) => r);
    const second = request(app).post('/api/analyze').send({ document: doc(2) }).then((r) => r);
    await until(() => generate.held.length === 2);
    const third = await request(app).post('/api/analyze').send({ document: doc(3) });
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'too_many_concurrent');
    assert.equal(third.headers['retry-after'], '5');
    assert.deepEqual(app.locals.aiGate.stats(), { total: 2, clients: 1 });

    // GET routes are never counted.
    assert.equal((await request(app).get('/health')).status, 200);
    assert.equal((await request(app).get('/api/config')).status, 200);

    generate.releaseAll();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.deepEqual(app.locals.aiGate.stats(), { total: 0, clients: 0 }, 'released after success');
    const fourth = request(app).post('/api/analyze').send({ document: doc(4) }).then((r) => r);
    await until(() => generate.held.length === 3);
    generate.releaseAll();
    assert.equal((await fourth).status, 200, 'client is not blocked afterwards');
  });

  it('counts clients separately, and caps the whole instance', async () => {
    const generate = heldGenerator();
    const app = makeApp({ generateJson: generate, trustProxy: 1, aiConcurrencyPerClient: 2, aiConcurrencyTotal: 3 });
    const send = (ip, n) => request(app).post('/api/analyze').set('X-Forwarded-For', ip).send({ document: doc(n) }).then((r) => r);
    const a1 = send('10.0.0.1', 1);
    const a2 = send('10.0.0.1', 2);
    const b1 = send('10.0.0.2', 3);
    await until(() => generate.held.length === 3);
    const c1 = await send('10.0.0.3', 4);
    assert.equal(c1.status, 429);
    assert.equal(c1.body.code, 'server_busy');
    generate.releaseAll();
    for (const p of [a1, a2, b1]) assert.equal((await p).status, 200);
    assert.deepEqual(app.locals.aiGate.stats(), { total: 0, clients: 0 });
  });

  it('releases the slot after a model failure', async () => {
    const app = makeApp({ generateJson: async () => { throw new Error('model crashed'); } });
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await request(app).post('/api/analyze').send({ document: doc(i) })).status, 500);
    }
    assert.deepEqual(app.locals.aiGate.stats(), { total: 0, clients: 0 });
  });

  it('releases the slot after an AI timeout', async () => {
    const app = makeApp({
      generateJson: async () => {
        await new Promise((r) => setTimeout(r, 20));
        throw new AIServiceError('The AI took too long to respond.', { status: 504, code: 'timeout' });
      },
    });
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/api/ask').send({ document: doc(i), question: 'Notice period?' });
      assert.equal(res.status, 504);
    }
    assert.deepEqual(app.locals.aiGate.stats(), { total: 0, clients: 0 });
  });

  it('releases the slot after validation errors, malformed JSON and oversized bodies', async () => {
    const app = makeApp({ bodyLimit: '64kb' });
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await request(app).post('/api/analyze').send({ document: { text: 'short' } })).status, 400);
      assert.equal((await request(app).post('/api/analyze').set('Content-Type', 'application/json').send('{bad')).status, 400);
      assert.equal((await request(app).post('/api/analyze').send({ document: { text: 'x'.repeat(100 * 1024) } })).status, 413);
      assert.equal((await request(app).post('/api/unknown').send({})).status, 404);
    }
    assert.deepEqual(app.locals.aiGate.stats(), { total: 0, clients: 0 });
  });

  it('releases the slot when the client disconnects mid-request (once the handler finishes)', async () => {
    const generate = heldGenerator();
    const app = makeApp({ generateJson: generate });
    const server = app.listen(0);
    try {
      const ac = new AbortController();
      const pending = fetch(`http://127.0.0.1:${server.address().port}/api/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: doc(9) }), signal: ac.signal,
      }).catch((e) => e);
      await until(() => generate.held.length === 1);
      ac.abort();
      await pending;
      assert.equal(app.locals.aiGate.stats().total, 1, 'still counted while the model call is running');
      generate.releaseAll();
      await until(() => app.locals.aiGate.stats().total === 0);
    } finally {
      server.close();
    }
  });
});

describe('request size, headers and logging', () => {
  it('Analyze and Ask accept one document (~10 MB); only Compare accepts two (~20 MB)', async () => {
    const app = makeApp();
    const big = { document: { file: { data: 'A'.repeat(10.6 * 1024 * 1024), mimeType: 'image/png' } } };
    assert.equal((await request(app).post('/api/analyze').send(big)).status, 413);
    assert.equal((await request(app).post('/api/ask').send({ ...big, question: 'Q?' })).status, 413);
    const cmp = await request(app).post('/api/compare').send({ documentA: big.document, documentB: { text: LEASE_TEXT } });
    assert.equal(cmp.status, 400, 'parsed (then rejected by validation), not refused as too large');
    assert.match(cmp.body.error, /too large/);
  });

  it('keeps the strict CSP and adds a restrictive Permissions-Policy', async () => {
    const res = await request(makeApp()).get('/');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.match(res.headers['permissions-policy'], /camera=\(\)/);
    assert.match(res.headers['permissions-policy'], /microphone=\(\)/);
  });

  it('new rejection paths log metadata only: no document text, questions, origins or IP addresses', async () => {
    const logger = captureLogger();
    const generate = heldGenerator();
    const app = makeApp({ generateJson: generate, logger });
    await request(app).post('/api/ask').set('Origin', 'https://evil.example').send({ document: { text: `${LEASE_TEXT} SECRET-DOC` }, question: 'SECRET-Q?' });
    const a = request(app).post('/api/analyze').send({ document: { text: `${LEASE_TEXT} SECRET-DOC-1` } }).then((r) => r);
    const b = request(app).post('/api/analyze').send({ document: { text: `${LEASE_TEXT} SECRET-DOC-2` } }).then((r) => r);
    await until(() => generate.held.length === 2);
    await request(app).post('/api/ask').send({ document: { text: `${LEASE_TEXT} SECRET-DOC-3` }, question: 'SECRET-Q2?' });
    generate.releaseAll();
    await a;
    await b;
    const all = logger.lines.join('\n');
    assert.match(all, /origin_rejected/);
    assert.match(all, /concurrency_rejected/);
    assert.doesNotMatch(all, /SECRET-|evil\.example|127\.0\.0\.1|::1|Rs\. 20,000/);
  });
});
