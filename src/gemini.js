/**
 * Thin wrapper around the Google Gen AI SDK (@google/genai), using generateContent.
 * Default provider: the Gemini API (Google AI Studio) with GEMINI_API_KEY.
 * Vertex AI (Application Default Credentials) remains available as an option.
 *
 * Failure policy:
 *  - 429 (quota or rate limit): NEVER retried automatically. Classified as a
 *    per-minute limit, a daily limit or unknown; the provider's suggested wait
 *    (RetryInfo) is passed on as `retryAfterSeconds` only when it is valid.
 *  - 500 / 502 / 503 / 504 (temporary provider trouble) and unreadable/empty model
 *    output: retried with bounded exponential backoff plus jitter, at most
 *    `maxRetries` times and never beyond `totalTimeoutMs` for the whole request.
 *  - Our own attempt timeout, other 4xx errors and safety blocks: not retried.
 * Errors carry only redacted provider details (no keys, project IDs or document text).
 */
import { GoogleGenAI } from '@google/genai';
import { AIServiceError } from './errors.js';
import { redactForLog } from './logger.js';

export { AIServiceError };

const RETRYABLE_UPSTREAM_STATUS = new Set([500, 502, 503, 504]);
export const BACKOFF = Object.freeze({
  baseMs: 2_000, // first retry waits about 2 s
  factor: 3, // then about 6 s, then about 15 s (capped)
  maxMs: 15_000,
  jitter: 0.25, // +/- 25 % so many clients do not retry in lock-step
  minAttemptMs: 5_000, // do not start a retry with less time than this left
});
const MAX_RETRY_AFTER_SECONDS = 3_600;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Returns null when no credentials are configured (the app then reports AI as unavailable). */
export function createGeminiClient(config) {
  const httpOptions = { timeout: config.requestTimeoutMs };
  if (config.useVertex && config.project) {
    return new GoogleGenAI({ vertexai: true, project: config.project, location: config.location, httpOptions });
  }
  if (!config.useVertex && config.apiKey) {
    return new GoogleGenAI({ apiKey: config.apiKey, httpOptions });
  }
  return null;
}

/** Parse model output as JSON, tolerating accidental ```json fences. */
export function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new AIServiceError('The AI returned an empty response. Please try again.', { code: 'empty' });
  }
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (cause) {
    throw new AIServiceError('The AI response could not be read. Please try again.', { cause, code: 'bad_json' });
  }
}

/**
 * Convert a provider retry hint ("37s", "12.5s" or a number of seconds) into whole
 * seconds. Returns null for anything missing, malformed, non-positive or over an hour.
 */
export function parseRetryDelay(value) {
  let seconds;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'string' && /^\d+(\.\d+)?s$/.test(value.trim())) seconds = Number.parseFloat(value);
  else return null;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_RETRY_AFTER_SECONDS) return null;
  return Math.ceil(seconds);
}

/**
 * Extract structured, non-sensitive details from an SDK ApiError, whose `message`
 * is the provider's JSON error body and whose `status` is the HTTP status.
 */
export function parseProviderError(cause) {
  const statusNumber = Number(cause?.status);
  const httpStatus = Number.isInteger(statusNumber) && statusNumber > 0 ? statusNumber : null;
  const raw = typeof cause?.message === 'string' ? cause.message : '';
  let body = null;
  const start = raw.indexOf('{');
  if (start !== -1) {
    try {
      body = JSON.parse(raw.slice(start));
    } catch {
      body = null;
    }
  }
  const error = body && typeof body.error === 'object' && body.error ? body.error : {};
  const details = Array.isArray(error.details) ? error.details : [];
  const quotaIds = [];
  let retryDelay;
  for (const detail of details) {
    const type = String(detail?.['@type'] ?? '');
    if (type.endsWith('QuotaFailure') && Array.isArray(detail.violations)) {
      for (const violation of detail.violations) {
        const id = violation?.quotaId ?? violation?.quotaMetric;
        if (typeof id === 'string') quotaIds.push(redactForLog(id, 120));
      }
    }
    if (type.endsWith('RetryInfo')) retryDelay = detail.retryDelay;
  }
  const providerMessage = typeof error.message === 'string' ? error.message : raw;
  if (retryDelay === undefined) {
    const hint = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(providerMessage);
    if (hint) retryDelay = `${hint[1]}s`;
  }

  let quotaPeriod = null;
  if (httpStatus === 429 || error.status === 'RESOURCE_EXHAUSTED') {
    const ids = quotaIds.join(' ');
    if (/per ?day|daily/i.test(ids) || (!ids && /per day|daily/i.test(providerMessage))) quotaPeriod = 'day';
    else if (/per ?minute/i.test(ids) || (!ids && /per minute/i.test(providerMessage))) quotaPeriod = 'minute';
    else quotaPeriod = 'unknown';
  }

  return {
    httpStatus,
    providerStatus: typeof error.status === 'string' ? error.status : null,
    quotaIds,
    quotaPeriod,
    retryAfterSeconds: parseRetryDelay(retryDelay),
    message: redactForLog(providerMessage, 200),
  };
}

function isTimeout(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timed? ?out|aborted/i.test(err?.message ?? '');
}

function mapError(cause, attempts) {
  if (cause instanceof AIServiceError) {
    if (cause.attempts === undefined) cause.attempts = attempts;
    return cause;
  }
  if (isTimeout(cause)) {
    return new AIServiceError('The AI took too long to respond. Try a shorter document or try again.', { status: 504, cause, code: 'timeout', attempts });
  }
  const upstream = parseProviderError(cause);
  const base = { cause, upstream, attempts };
  const status = upstream.httpStatus;

  if (status === 429) {
    const wait = upstream.retryAfterSeconds;
    if (upstream.quotaPeriod === 'day') {
      return new AIServiceError('The AI service has reached its daily usage limit for this demo. Please try again tomorrow.', {
        ...base, status: 429, code: 'quota_daily', retryAfterSeconds: wait,
      });
    }
    if (upstream.quotaPeriod === 'minute') {
      return new AIServiceError(
        wait ? `The AI service is receiving too many requests. Please try again in about ${wait} seconds.` : 'The AI service is receiving too many requests. Please wait a minute and try again.',
        { ...base, status: 429, code: 'quota_minute', retryAfterSeconds: wait },
      );
    }
    return new AIServiceError(
      wait ? `The AI service's usage limit was reached. Please try again in about ${wait} seconds.` : "The AI service's usage limit was reached. Please wait a minute and try again.",
      { ...base, status: 429, code: 'rate_limited', retryAfterSeconds: wait },
    );
  }
  if (status === 503) {
    return new AIServiceError('The AI model is under heavy demand right now. This is usually temporary. Please try again in a minute.', {
      ...base, status: 503, code: 'overloaded', retryAfterSeconds: upstream.retryAfterSeconds,
    });
  }
  if (status === 504) {
    return new AIServiceError('The AI service timed out. Please try again in a moment.', { ...base, status: 504, code: 'upstream_timeout' });
  }
  // Google returns 400 for some credential/setup problems (e.g. API_KEY_INVALID); those are
  // server misconfiguration, not a problem with the user's document.
  const setupProblem = /API_KEY|api key|FAILED_PRECONDITION|billing|location is not supported|PERMISSION_DENIED/i.test(cause?.message ?? '');
  if (status === 400 && !setupProblem) {
    return new AIServiceError('The AI service could not process this document. It may be unreadable or too complex.', { ...base, status: 422, code: 'rejected' });
  }
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    // Configuration problem on our side (permissions, API not enabled, wrong model/location).
    return new AIServiceError('The AI service is not available on this server right now.', { ...base, status: 503, code: 'misconfigured' });
  }
  return new AIServiceError('The AI service could not process this request. Please try again.', { ...base, status: 502, code: 'upstream' });
}

/**
 * Delay before retry number `attempt + 1`: exponential, capped, with +/- jitter.
 * A valid provider hint (Retry-After / RetryInfo) is respected as a minimum.
 */
export function backoffDelay(attempt, random = Math.random, retryAfterSeconds = null) {
  const exponential = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * BACKOFF.factor ** attempt);
  const jittered = Math.round(exponential * (1 - BACKOFF.jitter + 2 * BACKOFF.jitter * random()));
  return Math.max(jittered, retryAfterSeconds ? retryAfterSeconds * 1000 : 0);
}

/**
 * Build the `generateJson({systemInstruction, contents, schema, startedAt?})` function
 * used by the services. Injected into the app so tests can stub it.
 * `startedAt` lets several calls for one user request share a single overall deadline.
 */
export function createJsonGenerator(client, config, { wait = sleep, now = Date.now, random = Math.random, logger } = {}) {
  const maxRetries = config.maxRetries ?? 2;
  const perAttemptMs = config.requestTimeoutMs ?? 60_000;
  const totalMs = config.totalTimeoutMs ?? 110_000;

  async function callOnce({ systemInstruction, contents, schema }, attemptTimeoutMs) {
    const response = await client.models.generateContent({
      model: config.model,
      contents,
      config: {
        systemInstruction,
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
        // Caps this attempt so the whole request (including retries) stays within totalTimeoutMs.
        abortSignal: AbortSignal.timeout(attemptTimeoutMs),
      },
    });

    const blockReason = response?.promptFeedback?.blockReason;
    const finishReason = response?.candidates?.[0]?.finishReason;
    if (blockReason || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(finishReason)) {
      throw new AIServiceError('This document could not be processed because it was blocked by content safety filters.', { status: 422, code: 'blocked' });
    }
    if (finishReason === 'MAX_TOKENS') {
      throw new AIServiceError('The document is too long to analyse in one go. Try a shorter document or a single section.', { status: 422, code: 'too_long' });
    }
    return parseJson(response?.text);
  }

  return async function generateJson(request) {
    const deadline = (Number.isFinite(request?.startedAt) ? request.startedAt : now()) + totalMs;
    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new AIServiceError('The AI took too long to respond. Try a shorter document or try again.', { status: 504, code: 'timeout', attempts: attempt });
      }
      try {
        return await callOnce(request, Math.min(perAttemptMs, remaining));
      } catch (cause) {
        const err = mapError(cause, attempt + 1);
        const retryable = RETRYABLE_UPSTREAM_STATUS.has(err.upstream?.httpStatus) || err.code === 'bad_json' || err.code === 'empty';
        if (!retryable || attempt >= maxRetries) throw err;
        const delay = backoffDelay(attempt, random, err.retryAfterSeconds);
        if (now() + delay + BACKOFF.minAttemptMs > deadline) {
          logger?.warn?.('Not retrying AI call: overall time limit reached', { event: 'ai_retry_skipped', attempt: attempt + 1, code: err.code });
          throw err;
        }
        logger?.warn?.('Retrying AI call after a temporary error', {
          event: 'ai_retry', attempt: attempt + 1, code: err.code, httpStatus: err.upstream?.httpStatus ?? null, delayMs: delay,
        });
        await wait(delay);
      }
    }
  };
}
