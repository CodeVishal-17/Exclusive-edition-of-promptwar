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
  jsonBodyLimit: '20mb', // two 7 MB files, base64-encoded (~4/3 overhead), plus JSON framing
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
    trustProxy: readInt(env, 'TRUST_PROXY', 1, { min: 0, max: 10 }, errors),
  });
  return { config, errors, warnings };
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
