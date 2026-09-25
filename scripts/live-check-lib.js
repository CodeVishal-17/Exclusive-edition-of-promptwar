/**
 * Pure helpers for scripts/live-check.js (no network, no app imports) so the
 * scheduling, filtering, quota handling and classification can be unit-tested.
 *
 * Quota policy: requests always run one at a time. A per-minute limit is retried at
 * most once, and only after the provider's own suggested wait. After a daily-limit
 * error, the remaining workflows are skipped instead of spending more requests.
 * Nothing here works around provider quotas.
 */

/** Workflow ids, in the order they run by default. */
export const WORKFLOW_IDS = Object.freeze([
  'understand-text',
  'understand-pdf',
  'ask-present',
  'ask-absent',
  'ask-followup',
  'compare',
]);

/** Error codes that mean "the provider was unavailable", not "the app is wrong". */
export const INCONCLUSIVE_CODES = new Set(['quota_daily', 'quota_minute', 'rate_limited', 'overloaded', 'upstream_timeout', 'timeout']);

export const LIVE_LIMITS = Object.freeze({
  maxDelayMs: 600_000,
  maxQuotaWaitSeconds: 120, // longer suggested waits are not worth blocking the run for
  overloadRetryDelayMs: 30_000,
});

/**
 * Read LIVE_DELAY_MS and LIVE_ONLY.
 * @returns {{ delayMs: number, only: string[], errors: string[] }}
 */
export function parseLiveOptions(env = {}) {
  const errors = [];
  let delayMs = 0;
  const rawDelay = env.LIVE_DELAY_MS;
  if (rawDelay !== undefined && String(rawDelay).trim() !== '') {
    const n = Number(rawDelay);
    if (!Number.isInteger(n) || n < 0 || n > LIVE_LIMITS.maxDelayMs) {
      errors.push(`LIVE_DELAY_MS must be a whole number of milliseconds between 0 and ${LIVE_LIMITS.maxDelayMs} (got "${rawDelay}").`);
    } else {
      delayMs = n;
    }
  }

  let only = [...WORKFLOW_IDS];
  const rawOnly = env.LIVE_ONLY;
  if (rawOnly !== undefined && String(rawOnly).trim() !== '') {
    const requested = String(rawOnly).split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = requested.filter((id) => !WORKFLOW_IDS.includes(id));
    if (unknown.length) {
      errors.push(`LIVE_ONLY has unknown workflow id(s): ${unknown.join(', ')}. Valid ids: ${WORKFLOW_IDS.join(', ')}.`);
    }
    only = WORKFLOW_IDS.filter((id) => requested.includes(id)); // keep canonical order, drop duplicates
    if (!unknown.length && only.length === 0) errors.push('LIVE_ONLY selected no workflows.');
  }
  return { delayMs, only, errors };
}

/**
 * PASS: HTTP 200 and every check passed.
 * FAIL: the app answered wrongly (a check failed, schema failure, 4xx/5xx from the app itself).
 * INCONCLUSIVE: the provider was overloaded, out of quota or timed out, or the workflow was skipped.
 */
export function classify(result) {
  if (result.skipped) return 'INCONCLUSIVE';
  if (result.httpStatus === 200) {
    const checks = result.checks ?? [];
    return checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  }
  if (INCONCLUSIVE_CODES.has(result.code)) return 'INCONCLUSIVE';
  return 'FAIL';
}

const validWait = (seconds) => Number.isInteger(seconds) && seconds >= 1 && seconds <= LIVE_LIMITS.maxQuotaWaitSeconds;

/**
 * Run workflows sequentially.
 * @param {Array<{id: string, name: string}>} workflows
 * @param {object} opts
 * @param {number} opts.delayMs  pause between workflows (not before the first)
 * @param {(wf) => Promise<object>} opts.runOne  performs one HTTP request; returns
 *        { httpStatus, code, retryAfterSeconds, checks, ... }
 * @param {(ms:number) => Promise<void>} opts.sleep
 * @param {(line:string) => void} [opts.log]
 */
export async function runPlan(workflows, { delayMs = 0, runOne, sleep, log = () => {} }) {
  const results = [];
  let dailyQuotaReached = false;
  let ranAny = false;

  for (const wf of workflows) {
    if (dailyQuotaReached) {
      results.push({
        id: wf.id,
        name: wf.name,
        skipped: true,
        reason: 'Skipped: the daily Gemini quota was reached earlier in this run.',
        requests: 0,
        classification: 'INCONCLUSIVE',
      });
      continue;
    }
    if (ranAny && delayMs > 0) {
      log(`waiting ${delayMs} ms before "${wf.id}" (LIVE_DELAY_MS)`);
      await sleep(delayMs);
    }
    ranAny = true;

    let result = await runOne(wf);
    let requests = 1;
    if ((result.code === 'quota_minute' || result.code === 'rate_limited') && validWait(result.retryAfterSeconds)) {
      log(`"${wf.id}" hit a per-minute limit; waiting the provider's suggested ${result.retryAfterSeconds} s, then retrying once`);
      await sleep(result.retryAfterSeconds * 1000);
      result = await runOne(wf);
      requests += 1;
    } else if (result.code === 'overloaded') {
      log(`"${wf.id}": model overloaded; waiting ${LIVE_LIMITS.overloadRetryDelayMs / 1000} s, then retrying once`);
      await sleep(LIVE_LIMITS.overloadRetryDelayMs);
      result = await runOne(wf);
      requests += 1;
    }
    if (result.code === 'quota_daily') {
      dailyQuotaReached = true;
      log('Daily Gemini quota reached: remaining workflows will be skipped to avoid wasting requests.');
    }
    results.push({ ...result, id: wf.id, name: wf.name, requests, classification: classify(result) });
  }
  return results;
}

/** Overall verdict: FAIL if anything failed, PASS only if everything passed, otherwise INCONCLUSIVE. */
export function summarise(results, geminiCalls) {
  const count = (c) => results.filter((r) => r.classification === c).length;
  const pass = count('PASS');
  const fail = count('FAIL');
  const inconclusive = count('INCONCLUSIVE');
  const verdict = fail > 0 ? 'FAIL' : pass === results.length && results.length > 0 ? 'PASS' : 'INCONCLUSIVE';
  return { total: results.length, pass, fail, inconclusive, geminiCalls, verdict };
}

/** Parse a Retry-After response header (whole seconds only). */
export function parseRetryAfterHeader(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= 1 && n <= 3600 ? n : null;
}
