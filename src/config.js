/**
 * Central, environment-driven configuration.
 * Nothing secret is ever sent to the browser; see `publicConfig()`.
 */

export const LANGUAGES = Object.freeze({
  en: 'English',
  hi: 'Hindi (हिन्दी)',
  bn: 'Bengali (বাংলা)',
  ta: 'Tamil (தமிழ்)',
  te: 'Telugu (తెలుగు)',
  mr: 'Marathi (मराठी)',
  gu: 'Gujarati (ગુજરાતી)',
  kn: 'Kannada (ಕನ್ನಡ)',
  ml: 'Malayalam (മലയാളം)',
  pa: 'Punjabi (ਪੰਜਾਬੀ)',
  ur: 'Urdu (اردو)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
});

export const READING_LEVELS = Object.freeze({
  simple: 'Very simple words, short sentences, as if explaining to someone reading their first contract (about 6th-grade level).',
  standard: 'Clear everyday language for an educated adult who is not a lawyer.',
  detailed: 'Precise and thorough, keeping important legal terms but always explaining them.',
});

/** Allowed upload types and the file-name extensions accepted for each. */
export const FILE_TYPES = Object.freeze({
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt', '.text'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
});
export const ALLOWED_MIME_TYPES = Object.freeze(Object.keys(FILE_TYPES));

export const LIMITS = Object.freeze({
  minTextChars: 40,
  maxTextChars: 60_000,
  maxFileBytes: 7 * 1024 * 1024, // kept small so two files still fit in one inline Gemini request
  maxPdfPages: 60,
  maxImagePixels: 40_000_000,
  maxQuestionChars: 1_000,
  maxHistoryTurns: 8,
  maxHistoryChars: 2_000,
  jsonBodyLimit: '20mb', // Compare: two 7 MB files, base64-encoded (~4/3 overhead), plus JSON framing
  singleDocBodyLimit: '10mb', // Analyze / Ask: one 7 MB file (~9.4 MB base64) plus question and history
});

export const DEFAULT_MODEL = 'gemini-3.6-flash';
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,63}$/;
const LOCATION_RE = /^(global|[a-z]+-[a-z]+\d)$/;

function readInt(env, name, fallback, { min, max }, errors) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
    return fallback;
  }
  return n;
}

/**
 * Parse and validate configuration.
 * @returns {{config: object, errors: string[], warnings: string[]}}
 */
export function parseConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || '';
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const vertexFlag = (env.GOOGLE_GENAI_USE_VERTEXAI || '').toLowerCase();
  if (vertexFlag && vertexFlag !== 'true' && vertexFlag !== 'false') {
    errors.push('GOOGLE_GENAI_USE_VERTEXAI must be "true" or "false".');
  }
  const useVertex = vertexFlag ? vertexFlag === 'true' : Boolean(project) && !apiKey;
  if (useVertex && !project) {
    errors.push('Vertex AI mode needs GOOGLE_CLOUD_PROJECT to be set.');
  }

  // Default Flash model on the Gemini API (Google AI Studio). gemini-2.5-flash is no longer
  // offered to new API users; override with GEMINI_MODEL if needed.
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!MODEL_RE.test(model)) errors.push(`GEMINI_MODEL "${model}" is not a valid model id.`);
  const location = env.GOOGLE_CLOUD_LOCATION || 'global';
  if (!LOCATION_RE.test(location)) errors.push(`GOOGLE_CLOUD_LOCATION "${location}" is not a valid location.`);

  const production = env.NODE_ENV === 'production';
  const hasCredentials = (useVertex && Boolean(project)) || (!useVertex && Boolean(apiKey));
  if (!hasCredentials) {
    const msg = 'No Gemini credentials: set GEMINI_API_KEY (Google AI Studio) or GOOGLE_CLOUD_PROJECT (Vertex AI).';
    if (production) errors.push(msg);
    else warnings.push(`${msg} AI endpoints will return 503.`);
  }

  const config = Object.freeze({
    production,
    port: readInt(env, 'PORT', 8080, { min: 1, max: 65535 }, errors),
    model,
    useVertex,
    project,
    location,
    apiKey,
    // Gemini 3+ models are tuned for their default temperature; older models get a low one for consistency.
    temperature: /^gemini-(1|2)\./.test(model) ? 0.2 : undefined,
    // Per model call, and for the whole request including retries (kept below the browser's 150 s timeout).
    requestTimeoutMs: readInt(env, 'GEMINI_TIMEOUT_MS', 60_000, { min: 5_000, max: 300_000 }, errors),
    totalTimeoutMs: readInt(env, 'GEMINI_TOTAL_TIMEOUT_MS', 110_000, { min: 10_000, max: 600_000 }, errors),
    // Retries apply only to temporary 5xx errors and unreadable output; 429 quota errors are never retried.
    maxRetries: readInt(env, 'GEMINI_MAX_RETRIES', 2, { min: 0, max: 3 }, errors),
    rateLimitPerMinute: readInt(env, 'RATE_LIMIT_PER_MINUTE', 20, { min: 1, max: 10_000 }, errors),
    cacheEntries: readInt(env, 'CACHE_ENTRIES', 100, { min: 0, max: 10_000 }, errors),
    cacheTtlMs: readInt(env, 'CACHE_TTL_MS', 15 * 60 * 1000, { min: 0, max: 24 * 60 * 60 * 1000 }, errors),
    // Ask answers are cached briefly: follow-up conversations change quickly.
    askCacheTtlMs: readInt(env, 'ASK_CACHE_TTL_MS', 5 * 60 * 1000, { min: 0, max: 60 * 60 * 1000 }, errors),
    // Number of reverse-proxy hops to trust for the client IP (used by rate limiting). Trusting a
    // proxy that is not there lets any client spoof X-Forwarded-For, so the default is 0 unless we
    // know we run behind exactly one proxy (Render sets RENDER=true; Cloud Run sets K_SERVICE).
    trustProxy: readInt(env, 'TRUST_PROXY', env.RENDER === 'true' || env.K_SERVICE ? 1 : 0, { min: 0, max: 10 }, errors),
    // Browser origins allowed to call the AI endpoints, besides the page's own origin.
    allowedOrigins: parseOrigins([env.ALLOWED_ORIGINS, env.RENDER_EXTERNAL_URL].filter(Boolean).join(','), errors),
    // Simultaneous AI requests: per client IP, and for the whole instance.
    aiConcurrencyPerClient: readInt(env, 'AI_CONCURRENCY_PER_CLIENT', 2, { min: 1, max: 20 }, errors),
    aiConcurrencyTotal: readInt(env, 'AI_CONCURRENCY_TOTAL', 10, { min: 1, max: 200 }, errors),
  });
  return { config, errors, warnings };
}

/** Comma-separated list of origins ("https://host[:port]") -> normalised, de-duplicated array. */
function parseOrigins(raw, errors) {
  const out = new Set();
  for (const item of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const url = new URL(item);
      if (!/^https?:$/.test(url.protocol) || url.origin === 'null') throw new Error('not http(s)');
      out.add(url.origin);
    } catch {
      errors.push(`ALLOWED_ORIGINS entry "${item}" is not a valid http(s) origin.`);
    }
  }
  return Object.freeze([...out]);
}

/** Convenience wrapper used by tests: returns config, ignoring validation messages. */
export function loadConfig(env = process.env) {
  return parseConfig(env).config;
}

/** Safe subset of configuration exposed to the frontend (no project id, no keys). */
export function publicConfig(config, aiReady) {
  return {
    aiReady,
    model: config.model,
    provider: config.useVertex ? 'Vertex AI' : 'Gemini API',
    languages: LANGUAGES,
    readingLevels: Object.keys(READING_LEVELS),
    allowedMimeTypes: ALLOWED_MIME_TYPES,
    limits: {
      maxTextChars: LIMITS.maxTextChars,
      maxFileBytes: LIMITS.maxFileBytes,
      maxPdfPages: LIMITS.maxPdfPages,
      maxQuestionChars: LIMITS.maxQuestionChars,
    },
  };
}
