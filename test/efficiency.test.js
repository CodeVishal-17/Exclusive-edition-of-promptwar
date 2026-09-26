// Efficiency: result caching (Analyze / Compare / Ask) and single-flight request coalescing.
// The model is a MOCK that counts calls (no network).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { LruCache } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import { AIServiceError } from '../src/errors.js';
import { inspectDocument } from '../src/file-inspect.js';
import { createLegalService, MAX_CACHED_RESULT_CHARS } from '../src/legal-service.js';
import { validateDocument } from '../src/validate.js';
import { LEASE_TEXT, mockAnalysis, mockAnswer, mockComparison } from './helpers/mock-responses.js';

const opts = { language: 'en', readingLevel: 'standard' };
const silent = { warn() {} };
const docOf = (text) => inspectDocument(validateDocument({ text }));

/** Counting mock model; `delayMs` keeps calls in flight long enough to overlap. */
function countingModel({ delayMs = 25, fail = () => false } = {}) {
  let calls = 0;
  const generate = async ({ schema }) => {
    calls += 1;
    const n = calls;
    await new Promise((r) => setTimeout(r, delayMs));
    if (fail(n)) throw new AIServiceError('The AI service could not process this request.', { status: 502, code: 'upstream' });
    const req = schema.required;
    return structuredClone(req.includes('answer') ? mockAnswer() : req.includes('differences') ? mockComparison() : mockAnalysis());
  };
  generate.calls = () => calls;
  return generate;
}

describe('result caching', () => {
  it('identical Analyze, Ask and Compare requests twice -> one model call each', async () => {
    const [a, b] = [await docOf(LEASE_TEXT), await docOf(`${LEASE_TEXT} (revised)`)];
    for (const [name, run] of [
      ['analyze', (s) => s.analyze(a, opts)],
      ['ask', (s) => s.ask(a, 'Notice period?', [], opts)],
      ['compare', (s) => s.compare(a, b, opts)],
    ]) {
      const model = countingModel();
      const svc = createLegalService({ generateJson: model, logger: silent });
      const first = await run(svc);
      const second = await run(svc);
      assert.equal(model.calls(), 1, name);
      assert.equal(first.cached, false, name);
      assert.equal(second.cached, true, name);
    }
  });

  it('Ask: anything that can change the answer produces a new model call', async () => {
    const a = await docOf(LEASE_TEXT);
    const b = await docOf(`${LEASE_TEXT} Extra clause.`);
    const model = countingModel();
    const svc = createLegalService({ generateJson: model, logger: silent });
    const history = [{ role: 'user', text: 'What is the rent?' }, { role: 'assistant', text: 'Rs. 20,000.' }];
    await svc.ask(a, 'Notice period?', [], opts); // 1
    await svc.ask(a, 'Deposit amount?', [], opts); // 2 different question
    await svc.ask(b, 'Notice period?', [], opts); // 3 different document
    await svc.ask(a, 'Notice period?', [], { ...opts, language: 'hi' }); // 4 different language
    await svc.ask(a, 'Notice period?', [], { ...opts, readingLevel: 'simple' }); // 5 different reading level
    await svc.ask(a, 'Notice period?', history, opts); // 6 different history
    await svc.ask(a, 'Notice period?', [...history, { role: 'user', text: 'And more?' }], opts); // 7 longer history
    assert.equal(model.calls(), 7);
    await svc.ask(a, 'Notice period?', history, opts); // repeat of 6 -> cached
    assert.equal(model.calls(), 7);
  });

  it('Analyze / Compare: different documents or options are not shared', async () => {
    const a = await docOf(LEASE_TEXT);
    const b = await docOf(`${LEASE_TEXT} Extra clause.`);
    const model = countingModel();
    const svc = createLegalService({ generateJson: model, logger: silent });
    await svc.analyze(a, opts);
    await svc.analyze(b, opts);
    await svc.analyze(a, { ...opts, readingLevel: 'detailed' });
    await svc.compare(a, b, opts);
    await svc.compare(b, a, opts); // order matters (A vs B)
    assert.equal(model.calls(), 5);
  });

  it('cache entries expire after their TTL (Ask: short TTL)', async () => {
    let now = 0;
    const clock = () => now;
    const model = countingModel({ delayMs: 1 });
    const svc = createLegalService({
      generateJson: model,
      cache: new LruCache({ ttlMs: 15 * 60 * 1000, now: clock }),
      askCache: new LruCache({ ttlMs: 5 * 60 * 1000, now: clock }),
      logger: silent,
    });
    const a = await docOf(LEASE_TEXT);
    await svc.ask(a, 'Notice period?', [], opts);
    await svc.analyze(a, opts);
    now = 5 * 60 * 1000 - 1;
    await svc.ask(a, 'Notice period?', [], opts);
    assert.equal(model.calls(), 2, 'still cached just before the Ask TTL');
    now = 5 * 60 * 1000 + 1;
    await svc.ask(a, 'Notice period?', [], opts);
    await svc.analyze(a, opts);
    assert.equal(model.calls(), 3, 'Ask expired after 5 min; Analyze (15 min TTL) still cached');
  });

  it('does not cache oversized results (bounded cache memory)', async () => {
    let calls = 0;
    const svc = createLegalService({
      generateJson: async () => { calls += 1; return mockAnalysis({ plainSummary: 'x'.repeat(MAX_CACHED_RESULT_CHARS) }); },
      logger: silent,
    });
    const a = await docOf(LEASE_TEXT);
    await svc.analyze(a, opts);
    await svc.analyze(a, opts);
    assert.equal(calls, 2);
    assert.equal(svc.stats().cacheEntries, 0);
  });
});

describe('single-flight coalescing', () => {
  it('simultaneous identical Analyze, Ask and Compare -> one model call each, all callers get the result', async () => {
    const [a, b] = [await docOf(LEASE_TEXT), await docOf(`${LEASE_TEXT} (revised)`)];
    for (const [name, run] of [
      ['analyze', (s) => s.analyze(a, opts)],
      ['ask', (s) => s.ask(a, 'Notice period?', [], opts)],
      ['compare', (s) => s.compare(a, b, opts)],
    ]) {
      const model = countingModel();
      const svc = createLegalService({ generateJson: model, logger: silent });
      const results = await Promise.all([run(svc), run(svc), run(svc)]);
      assert.equal(model.calls(), 1, name);
      assert.equal(results.length, 3);
      assert.ok(results.every((r) => r.title === results[0].title && r.answer === results[0].answer), name);
      assert.notEqual(results[0], results[1], 'each caller gets its own object');
      assert.equal(svc.stats().inflight, 0, `${name}: in-flight entry removed`);
    }
  });

  it('different simultaneous requests are not coalesced', async () => {
    const a = await docOf(LEASE_TEXT);
    const b = await docOf(`${LEASE_TEXT} Extra clause.`);
    const model = countingModel();
    const svc = createLegalService({ generateJson: model, logger: silent });
    await Promise.all([
      svc.ask(a, 'Notice period?', [], opts),
      svc.ask(a, 'Deposit amount?', [], opts),
      svc.ask(b, 'Notice period?', [], opts),
      svc.ask(a, 'Notice period?', [], { ...opts, language: 'ta' }),
      svc.analyze(a, opts),
      svc.analyze(b, opts),
    ]);
    assert.equal(model.calls(), 6);
  });

  it('a failed call rejects every waiting caller, clears the in-flight entry and is not cached', async () => {
    const model = countingModel({ fail: (n) => n === 1 });
    const svc = createLegalService({ generateJson: model, logger: silent });
    const a = await docOf(LEASE_TEXT);
    const settled = await Promise.allSettled([svc.analyze(a, opts), svc.analyze(a, opts)]);
    assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected']);
    assert.equal(settled[0].reason.code, 'upstream');
    assert.equal(model.calls(), 1, 'the failure was shared, not retried per caller');
    assert.deepEqual(svc.stats(), { inflight: 0, cacheEntries: 0, askCacheEntries: 0 });
    const retry = await svc.analyze(a, opts);
    assert.equal(retry.cached, false, 'failure did not poison the cache');
    assert.equal(model.calls(), 2);
  });

  it('a timed-out call clears the in-flight entry', async () => {
    let calls = 0;
    const svc = createLegalService({
      generateJson: async () => {
        calls += 1;
        if (calls === 1) throw new AIServiceError('The AI took too long to respond.', { status: 504, code: 'timeout' });
        return mockAnswer();
      },
      logger: silent,
    });
    const a = await docOf(LEASE_TEXT);
    await assert.rejects(svc.ask(a, 'Notice period?', [], opts), (e) => e.code === 'timeout');
    assert.equal(svc.stats().inflight, 0);
    assert.equal((await svc.ask(a, 'Notice period?', [], opts)).answer, mockAnswer().answer);
  });
});

describe('end to end over HTTP', () => {
  const makeApp = (generateJson) => createApp({
    config: { ...loadConfig({}), rateLimitPerMinute: 1000 },
    legalService: createLegalService({ generateJson, logger: silent }),
  });

  it('identical Ask twice -> one model call; second response marked cached', async () => {
    const model = countingModel();
    const app = makeApp(model);
    const body = { document: { text: LEASE_TEXT }, question: 'Notice period?' };
    const first = await request(app).post('/api/ask').send(body);
    const second = await request(app).post('/api/ask').send(body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.cached, true);
    assert.equal(model.calls(), 1);
  });

  it('two simultaneous identical Analyze requests -> one model call', async () => {
    const model = countingModel({ delayMs: 60 });
    const app = makeApp(model);
    const send = () => request(app).post('/api/analyze').send({ document: { text: LEASE_TEXT } }).then((r) => r);
    const [r1, r2] = await Promise.all([send(), send()]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(model.calls(), 1);
  });
});
