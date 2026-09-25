// Offline tests for Gemini error classification, retry/backoff and time limits.
// All provider responses are MOCKED (fake client or stubbed fetch); no network calls.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.js';
import {
  AIServiceError,
  BACKOFF,
  backoffDelay,
  createGeminiClient,
  createJsonGenerator,
  parseProviderError,
  parseRetryDelay,
} from '../src/gemini.js';
import { redactForLog } from '../src/logger.js';

const fakeClient = (impl) => ({ models: { generateContent: impl } });
const apiError = (status, message = 'upstream') => Object.assign(new Error(message), { status });

/** Google-style error bodies, shaped like the SDK's ApiError.message (JSON string). */
const googleError = (code, status, message, details = []) => JSON.stringify({ error: { code, status, message, details } });
const quotaFailure = (...quotaIds) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: quotaIds.map((quotaId) => ({ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId })),
});
const retryInfo = (retryDelay) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
const PER_MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
const minuteQuota429 = (delay = '37s') => apiError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota. Please retry in 37.2s.', [quotaFailure(PER_MINUTE), retryInfo(delay)]));
const dailyQuota429 = () => apiError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.', [quotaFailure(PER_DAY)]));
const overloaded503 = () => apiError(503, googleError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'));

/** Deterministic clock: wait() advances time instantly and records each delay. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const waits = [];
  return { now: () => t, wait: async (ms) => { waits.push(ms); t += ms; }, waits, advance: (ms) => { t += ms; } };
}

describe('429 quota errors are classified and never retried', () => {
  it('per-minute quota: quota_minute, provider wait passed on, exactly one call', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw minuteQuota429(); }), { maxRetries: 3 }, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => {
      assert.ok(err instanceof AIServiceError);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'quota_minute');
      assert.equal(err.retryAfterSeconds, 37);
      assert.match(err.message, /about 37 seconds/);
      assert.equal(err.upstream.quotaPeriod, 'minute');
      assert.deepEqual(err.upstream.quotaIds, [PER_MINUTE]);
      assert.equal(err.attempts, 1);
      return true;
    });
    assert.equal(calls, 1);
  });

  it('daily quota: quota_daily with a "try again tomorrow" message, exactly one call', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw dailyQuota429(); }), { maxRetries: 3 }, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => err.code === 'quota_daily' && err.status === 429 && /daily usage limit/.test(err.message) && err.retryAfterSeconds === null);
    assert.equal(calls, 1);
  });

  it('a daily violation wins over a per-minute one in the same error', () => {
    const info = parseProviderError(apiError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'quota', [quotaFailure(PER_MINUTE, PER_DAY)])));
    assert.equal(info.quotaPeriod, 'day');
  });

  it('unknown quota period: rate_limited, no invented wait', async () => {
    const gen = createJsonGenerator(fakeClient(async () => { throw apiError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted.')); }), {}, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => err.code === 'rate_limited' && err.retryAfterSeconds === null && /wait a minute/.test(err.message));
  });

  it('a bare 429 (non-JSON body) is still handled safely', async () => {
    const gen = createJsonGenerator(fakeClient(async () => { throw apiError(429, 'Too Many Requests'); }), {}, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => err.status === 429 && err.code === 'rate_limited');
  });

  it('reads the wait from the message text when RetryInfo is missing', () => {
    const info = parseProviderError(apiError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Per minute quota exceeded. Please retry in 12.3s.')));
    assert.equal(info.retryAfterSeconds, 13);
    assert.equal(info.quotaPeriod, 'minute');
  });
});

describe('parseRetryDelay', () => {
  it('accepts valid provider durations and rounds up', () => {
    assert.equal(parseRetryDelay('37s'), 37);
    assert.equal(parseRetryDelay('0.2s'), 1);
    assert.equal(parseRetryDelay(' 12.5s '), 13);
    assert.equal(parseRetryDelay(1.2), 2);
  });

  it('rejects missing, malformed, non-positive or excessive values', () => {
    for (const bad of [undefined, null, '', 'abc', '37', '-5s', '0s', '1e3s', '3601s', 99_999, -1, 0, Number.NaN, {}, []]) {
      assert.equal(parseRetryDelay(bad), null, JSON.stringify(bad));
    }
  });
});

describe('temporary 500 / 503 / 504 errors: bounded exponential backoff', () => {
  it('503 is retried up to maxRetries with growing delays, then reported as overloaded', async () => {
    const clock = fakeClock();
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw overloaded503(); }), { maxRetries: 2 }, { ...clock, random: () => 0.5 });
    await assert.rejects(gen({ contents: [] }), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'overloaded');
      assert.match(err.message, /heavy demand/);
      assert.equal(err.attempts, 3);
      assert.equal(err.upstream.providerStatus, 'UNAVAILABLE');
      return true;
    });
    assert.equal(calls, 3);
    assert.deepEqual(clock.waits, [BACKOFF.baseMs, BACKOFF.baseMs * BACKOFF.factor], 'about 2 s, then about 6 s');
  });

  it('503 then success returns the result', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; if (calls < 3) throw overloaded503(); return { text: '{"ok":true}' }; }), { maxRetries: 2 }, fakeClock());
    assert.deepEqual(await gen({ contents: [] }), { ok: true });
    assert.equal(calls, 3);
  });

  it('500 is retried and finally reported as a 502 upstream error', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw apiError(500, googleError(500, 'INTERNAL', 'Internal error')); }), { maxRetries: 1 }, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => err.status === 502 && err.code === 'upstream');
    assert.equal(calls, 2);
  });

  it('504 is retried and finally reported as upstream_timeout', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw apiError(504, googleError(504, 'DEADLINE_EXCEEDED', 'Deadline exceeded')); }), { maxRetries: 2 }, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => err.status === 504 && err.code === 'upstream_timeout');
    assert.equal(calls, 3);
  });

  it('maxRetries 0 means a single call', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw overloaded503(); }), { maxRetries: 0 }, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => err.code === 'overloaded');
    assert.equal(calls, 1);
  });

  it('our own attempt timeout is not retried (it would blow the overall time budget)', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }); }), { maxRetries: 2 }, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => err.status === 504 && err.code === 'timeout');
    assert.equal(calls, 1);
  });

  it('backoff delays are capped and jittered within +/-25 %', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const nominal = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * BACKOFF.factor ** attempt);
      assert.equal(backoffDelay(attempt, () => 0), Math.round(nominal * 0.75));
      assert.equal(backoffDelay(attempt, () => 1), Math.round(nominal * 1.25));
      assert.ok(backoffDelay(attempt, Math.random) <= BACKOFF.maxMs * 1.25);
    }
  });

  it('a valid provider wait is respected as the minimum delay', () => {
    assert.equal(backoffDelay(0, () => 0.5, 20), 20_000);
    assert.equal(backoffDelay(0, () => 0.5, null), BACKOFF.baseMs);
  });
});

describe('overall time limit', () => {
  it('stops retrying when the next attempt would not fit in totalTimeoutMs', async () => {
    const clock = fakeClock();
    const warnings = [];
    let calls = 0;
    const gen = createJsonGenerator(
      fakeClient(async () => { calls += 1; throw overloaded503(); }),
      { maxRetries: 3, totalTimeoutMs: 8_000 },
      { ...clock, random: () => 0.5, logger: { warn: (msg, fields) => warnings.push(fields) } },
    );
    await assert.rejects(gen({ contents: [] }), (err) => err.code === 'overloaded');
    // 1st retry: 2 s wait + 5 s minimum attempt fits in 8 s; 2nd retry (6 s more) does not.
    assert.equal(calls, 2);
    assert.deepEqual(clock.waits, [2_000]);
    assert.deepEqual(warnings.map((w) => w.event), ['ai_retry', 'ai_retry_skipped']);
  });

  it('gives each attempt only the time that is left (capped by requestTimeoutMs)', async () => {
    const clock = fakeClock();
    const timeouts = [];
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
    try {
      let calls = 0;
      const gen = createJsonGenerator(
        fakeClient(async (req) => {
          calls += 1;
          assert.ok(req.config.abortSignal instanceof AbortSignal);
          clock.advance(20_000); // each failed attempt takes 20 s
          if (calls < 3) throw overloaded503();
          return { text: '{"ok":true}' };
        }),
        { maxRetries: 2, requestTimeoutMs: 60_000, totalTimeoutMs: 100_000 },
        { ...clock, random: () => 0.5 },
      );
      assert.deepEqual(await gen({ contents: [] }), { ok: true });
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    // attempt 1: 60 s (cap); attempt 2: 100-(20+2)=78 -> 60 s (cap); attempt 3: 100-(20+2+20+6)=52 s left
    assert.deepEqual(timeouts, [60_000, 60_000, 52_000]);
  });

  it('shares one deadline across calls via startedAt (e.g. the schema re-try)', async () => {
    const clock = fakeClock();
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; return { text: '{}' }; }), { totalTimeoutMs: 10_000 }, clock);
    const startedAt = clock.now() - 10_001; // the budget is already used up
    await assert.rejects(gen({ contents: [], startedAt }), (err) => err.status === 504 && err.code === 'timeout');
    assert.equal(calls, 0, 'no model call once the overall time limit has passed');
  });
});

describe('no secrets or document text in errors and logs', () => {
  // Built at run time so this fixture cannot be mistaken for a real key by secret scanners.
  const FAKE_KEY = ['AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'].join('');

  it('redacts keys, project ids, e-mails and long numbers', () => {
    const raw = `key=${FAKE_KEY} projects/my-secret-proj-123 consumer projects/987654321 owner a.b@example.com id 123456789`;
    const out = redactForLog(raw);
    assert.doesNotMatch(out, /AIza|my-secret-proj|987654321|example\.com|123456789/);
    assert.equal(redactForLog('x'.repeat(500)).length, 300);
    assert.equal(redactForLog(undefined), undefined);
  });

  it('provider details attached to errors are redacted', async () => {
    const body = googleError(429, 'RESOURCE_EXHAUSTED', `Quota exceeded for consumer projects/123456789 using key ${FAKE_KEY}`, [quotaFailure(PER_MINUTE)]);
    const gen = createJsonGenerator(fakeClient(async () => { throw apiError(429, body); }), {}, fakeClock());
    await assert.rejects(gen({ contents: [] }), (err) => {
      const serialised = JSON.stringify({ message: err.message, upstream: err.upstream });
      assert.doesNotMatch(serialised, /AIza|123456789/);
      return true;
    });
  });

  it('retry logs contain metadata only, never the document', async () => {
    const lines = [];
    const logger = { warn: (msg, fields) => lines.push(JSON.stringify({ msg, ...fields })) };
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; if (calls === 1) throw overloaded503(); return { text: '{}' }; }), {}, { ...fakeClock(), logger });
    await gen({ systemInstruction: 'SECRET-SYSTEM', contents: [{ role: 'user', parts: [{ text: 'SECRET-DOCUMENT-TEXT' }] }], schema: {} });
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines.join('\n'), /SECRET-/);
  });
});

describe('real SDK with stubbed network (no real requests)', () => {
  async function withStubbedFetch(responses, fn) {
    const realFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      const next = responses.shift();
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
    };
    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
    return urls;
  }
  const { config } = parseConfig({ GEMINI_API_KEY: 'fake-test-key' });
  const ok = { status: 200, body: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] } };

  it('a real-shaped 429 from the API surfaces as quota_minute after exactly one HTTP request', async () => {
    const body = JSON.parse(googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [quotaFailure(PER_MINUTE), retryInfo('41s')]));
    const urls = await withStubbedFetch([{ status: 429, body }, ok], async () => {
      const gen = createJsonGenerator(createGeminiClient(config), config, fakeClock());
      await assert.rejects(gen({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], schema: {} }), (err) => err.code === 'quota_minute' && err.retryAfterSeconds === 41);
    });
    assert.equal(urls.length, 1, 'neither the SDK nor LegalLens retried the 429');
  });

  it('a real-shaped 503 is retried by LegalLens (not the SDK) and can then succeed', async () => {
    const body = JSON.parse(googleError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.'));
    const urls = await withStubbedFetch([{ status: 503, body }, ok], async () => {
      const gen = createJsonGenerator(createGeminiClient(config), config, fakeClock());
      assert.deepEqual(await gen({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], schema: {} }), { ok: true });
    });
    assert.equal(urls.length, 2);
    assert.ok(urls.every((u) => u.includes('generativelanguage.googleapis.com') && u.includes('gemini-3.6-flash') && !u.includes('fake-test-key')));
  });
});
