// Offline tests for the live-check scheduling logic. runOne and sleep are FAKES; no network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classify,
  LIVE_LIMITS,
  parseLiveOptions,
  parseRetryAfterHeader,
  runPlan,
  summarise,
  WORKFLOW_IDS,
} from '../scripts/live-check-lib.js';

const WORKFLOWS = WORKFLOW_IDS.map((id) => ({ id, name: id }));
const pass = { httpStatus: 200, code: null, checks: [{ label: 'ok', ok: true }] };

/** Fake runner: returns the scripted results per workflow id, in order; records every call. */
function scriptedRunner(script) {
  const calls = [];
  const runOne = async (wf) => {
    calls.push(wf.id);
    const queue = script[wf.id] ?? [pass];
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return { runOne, calls };
}

function fakeSleep() {
  const sleeps = [];
  return { sleep: async (ms) => { sleeps.push(ms); }, sleeps };
}

describe('parseLiveOptions', () => {
  it('defaults keep the previous behaviour: all six workflows, no delay', () => {
    assert.deepEqual(parseLiveOptions({}), { delayMs: 0, only: WORKFLOW_IDS, errors: [] });
  });

  it('reads LIVE_DELAY_MS', () => {
    assert.equal(parseLiveOptions({ LIVE_DELAY_MS: '20000' }).delayMs, 20_000);
    assert.equal(parseLiveOptions({ LIVE_DELAY_MS: '' }).delayMs, 0);
  });

  it('rejects invalid LIVE_DELAY_MS values', () => {
    for (const bad of ['-1', 'abc', '1.5', String(LIVE_LIMITS.maxDelayMs + 1)]) {
      assert.equal(parseLiveOptions({ LIVE_DELAY_MS: bad }).errors.length, 1, bad);
    }
  });

  it('LIVE_ONLY selects workflows, in canonical order, tolerant of spacing/case/duplicates', () => {
    const { only, errors } = parseLiveOptions({ LIVE_ONLY: ' compare, Ask-Present ,understand-text compare ' });
    assert.deepEqual(errors, []);
    assert.deepEqual(only, ['understand-text', 'ask-present', 'compare']);
  });

  it('LIVE_ONLY rejects unknown ids and lists the valid ones (before any request is made)', () => {
    const { errors } = parseLiveOptions({ LIVE_ONLY: 'compare,undrestand' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /undrestand/);
    assert.match(errors[0], /understand-text/);
  });

  it('LIVE_ONLY that selects nothing is an error; an empty value means all', () => {
    const { errors } = parseLiveOptions({ LIVE_ONLY: ' , ' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no workflows/);
    assert.deepEqual(parseLiveOptions({ LIVE_ONLY: '   ' }).only, WORKFLOW_IDS);
  });
});

describe('classify', () => {
  it('PASS only for HTTP 200 with every check passing', () => {
    assert.equal(classify(pass), 'PASS');
    assert.equal(classify({ httpStatus: 200, checks: [{ ok: true }, { ok: false }] }), 'FAIL');
  });

  it('INCONCLUSIVE for provider overload, quota or timeouts, and for skipped workflows', () => {
    for (const code of ['quota_daily', 'quota_minute', 'rate_limited', 'overloaded', 'upstream_timeout', 'timeout']) {
      assert.equal(classify({ httpStatus: 503, code }), 'INCONCLUSIVE', code);
    }
    assert.equal(classify({ skipped: true }), 'INCONCLUSIVE');
  });

  it('FAIL for app-side problems (schema failure, rejected input, misconfiguration, crashes)', () => {
    for (const [httpStatus, code] of [[502, 'schema_invalid'], [422, 'rejected'], [503, 'misconfigured'], [500, undefined], [400, undefined], [0, null]]) {
      assert.equal(classify({ httpStatus, code }), 'FAIL', `${httpStatus} ${code}`);
    }
  });
});

describe('runPlan', () => {
  it('runs sequentially with LIVE_DELAY_MS between workflows (not before the first)', async () => {
    const { runOne, calls } = scriptedRunner({});
    const { sleep, sleeps } = fakeSleep();
    const results = await runPlan(WORKFLOWS.slice(0, 3), { delayMs: 20_000, runOne, sleep });
    assert.deepEqual(calls, WORKFLOW_IDS.slice(0, 3));
    assert.deepEqual(sleeps, [20_000, 20_000]);
    assert.ok(results.every((r) => r.classification === 'PASS' && r.requests === 1));
  });

  it('no delay when LIVE_DELAY_MS is 0', async () => {
    const { runOne } = scriptedRunner({});
    const { sleep, sleeps } = fakeSleep();
    await runPlan(WORKFLOWS, { delayMs: 0, runOne, sleep });
    assert.deepEqual(sleeps, []);
  });

  it('after a daily-quota error, remaining workflows are skipped without any request', async () => {
    const { runOne, calls } = scriptedRunner({ 'ask-present': [{ httpStatus: 429, code: 'quota_daily', retryAfterSeconds: null }] });
    const { sleep, sleeps } = fakeSleep();
    const results = await runPlan(WORKFLOWS, { delayMs: 1_000, runOne, sleep });
    assert.deepEqual(calls, ['understand-text', 'understand-pdf', 'ask-present']);
    assert.deepEqual(results.map((r) => r.classification), ['PASS', 'PASS', 'INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE']);
    assert.ok(results.slice(3).every((r) => r.skipped && r.requests === 0 && /daily/.test(r.reason)));
    assert.deepEqual(sleeps, [1_000, 1_000], 'no waiting for skipped workflows');
  });

  it('a per-minute limit is retried once, after exactly the provider-suggested wait', async () => {
    const { runOne, calls } = scriptedRunner({ compare: [{ httpStatus: 429, code: 'quota_minute', retryAfterSeconds: 37 }, pass] });
    const { sleep, sleeps } = fakeSleep();
    const [result] = await runPlan([{ id: 'compare', name: 'compare' }], { runOne, sleep });
    assert.deepEqual(calls, ['compare', 'compare']);
    assert.deepEqual(sleeps, [37_000]);
    assert.equal(result.classification, 'PASS');
    assert.equal(result.requests, 2);
  });

  it('a per-minute limit is retried at most once', async () => {
    const limited = { httpStatus: 429, code: 'quota_minute', retryAfterSeconds: 10 };
    const { runOne, calls } = scriptedRunner({ compare: [limited, limited, pass] });
    const { sleep } = fakeSleep();
    const [result] = await runPlan([{ id: 'compare', name: 'compare' }], { runOne, sleep });
    assert.equal(calls.length, 2);
    assert.equal(result.classification, 'INCONCLUSIVE');
  });

  it('no automatic re-run without a valid provider wait, or when the wait is too long', async () => {
    for (const retryAfterSeconds of [null, 0, LIVE_LIMITS.maxQuotaWaitSeconds + 1]) {
      const { runOne, calls } = scriptedRunner({ compare: [{ httpStatus: 429, code: 'rate_limited', retryAfterSeconds }, pass] });
      const { sleep, sleeps } = fakeSleep();
      const [result] = await runPlan([{ id: 'compare', name: 'compare' }], { runOne, sleep });
      assert.equal(calls.length, 1, String(retryAfterSeconds));
      assert.deepEqual(sleeps, []);
      assert.equal(result.classification, 'INCONCLUSIVE');
    }
  });

  it('an overloaded model is retried once after a fixed pause', async () => {
    const { runOne, calls } = scriptedRunner({ 'ask-present': [{ httpStatus: 503, code: 'overloaded' }, pass] });
    const { sleep, sleeps } = fakeSleep();
    const [result] = await runPlan([{ id: 'ask-present', name: 'ask-present' }], { runOne, sleep });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [LIVE_LIMITS.overloadRetryDelayMs]);
    assert.equal(result.classification, 'PASS');
  });

  it('app failures are not retried', async () => {
    const { runOne, calls } = scriptedRunner({ compare: [{ httpStatus: 502, code: 'schema_invalid' }, pass] });
    const { sleep } = fakeSleep();
    const [result] = await runPlan([{ id: 'compare', name: 'compare' }], { runOne, sleep });
    assert.equal(calls.length, 1);
    assert.equal(result.classification, 'FAIL');
  });
});

describe('summarise and headers', () => {
  it('verdict: FAIL beats INCONCLUSIVE beats PASS; reports Gemini calls', () => {
    const r = (classification) => ({ classification });
    assert.deepEqual(summarise([r('PASS'), r('PASS')], 2), { total: 2, pass: 2, fail: 0, inconclusive: 0, geminiCalls: 2, verdict: 'PASS' });
    assert.equal(summarise([r('PASS'), r('INCONCLUSIVE')], 3).verdict, 'INCONCLUSIVE');
    assert.equal(summarise([r('PASS'), r('INCONCLUSIVE'), r('FAIL')], 3).verdict, 'FAIL');
    assert.equal(summarise([], 0).verdict, 'INCONCLUSIVE');
  });

  it('parses Retry-After headers (whole seconds only)', () => {
    assert.equal(parseRetryAfterHeader('37'), 37);
    for (const bad of [null, undefined, '', '0', '-1', '1.5', '3601', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      assert.equal(parseRetryAfterHeader(bad), null, String(bad));
    }
  });
});
