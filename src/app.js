/**
 * Express application factory. Dependencies are injected so the whole HTTP
 * surface can be tested without calling Gemini.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { LIMITS, publicConfig } from './config.js';
import { AIServiceError, ValidationError } from './errors.js';
import { inspectDocument } from './file-inspect.js';
import { createConcurrencyGate, originGuard } from './guards.js';
import { silentLogger } from './logger.js';
import {
  validateDocument,
  validateHistory,
  validateOptions,
  validateQuestion,
} from './validate.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Shape + content validation for one document field of the request body. */
async function readDocument(input, label) {
  return inspectDocument(validateDocument(input, label), label);
}

/**
 * @param {object} deps
 * @param {string} [deps.bodyLimit] override for every AI route's JSON limit (tests use a small value)
 */
export function createApp({ config, legalService, logger = silentLogger, bodyLimit }) {
  const app = express();
  const aiReady = Boolean(legalService);

  app.disable('x-powered-by');
  // Hop count, not `true`: only the last proxy's X-Forwarded-For entry is trusted (see config.js).
  app.set('trust proxy', config.trustProxy ?? 0);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // The app needs no powerful browser features; deny them outright.
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });
  app.use(compression());

  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ['html'],
      setHeaders(res, filePath) {
        // HTML always revalidates; static assets can be cached briefly.
        res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
      },
    }),
  );

  // Health check for the host (Render's healthCheckPath, Cloud Run's startup probe).
  // Note: some hosts reserve paths ending in "z" (Cloud Run does), so this is /health.
  app.get('/health', (_req, res) => res.json({ status: 'ok', aiReady }));
  app.get('/api/config', (_req, res) => res.json(publicConfig(config, aiReady)));

  const api = express.Router();
  // Cross-site browser requests are refused first, so they never consume a visitor's rate limit.
  api.use(originGuard({ allowedOrigins: config.allowedOrigins ?? [], logger }));
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimitPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests. Please wait a minute and try again.' },
    }),
  );
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // documents may be sensitive
    if (!aiReady) {
      // Checked before body parsing so large uploads are not processed for nothing.
      return res.status(503).json({ error: 'The AI service is not configured on this server.' });
    }
    return next();
  });
  // Concurrency slot is taken before the body is read, so parallel large uploads are capped too.
  const aiGate = createConcurrencyGate({
    perClient: config.aiConcurrencyPerClient ?? 2,
    total: config.aiConcurrencyTotal ?? 10,
    backstopMs: (config.totalTimeoutMs ?? 110_000) + 60_000,
    logger,
  });
  app.locals.aiGate = aiGate;
  api.use(aiGate);
  // Analyze and Ask carry one document; only Compare needs room for two.
  const jsonSingle = express.json({ limit: bodyLimit ?? LIMITS.singleDocBodyLimit });
  const jsonDouble = express.json({ limit: bodyLimit ?? LIMITS.jsonBodyLimit });

  const timed = (event, handler) => async (req, res) => {
    const started = Date.now();
    try {
      const result = await handler(req);
      // Metadata only — never document text, questions or model output.
      logger.info(`${event} ok`, { event, ms: Date.now() - started, cached: result.cached ?? false, grounding: result.grounding });
      res.json(result);
    } finally {
      res.locals.releaseAiSlot?.();
    }
  };

  api.post('/analyze', jsonSingle, timed('analyze', async (req) => {
    const options = validateOptions(req.body);
    const doc = await readDocument(req.body?.document, 'document');
    return legalService.analyze(doc, options);
  }));

  api.post('/ask', jsonSingle, timed('ask', async (req) => {
    const question = validateQuestion(req.body?.question);
    const history = validateHistory(req.body?.history);
    const options = validateOptions(req.body);
    const doc = await readDocument(req.body?.document, 'document');
    return legalService.ask(doc, question, history, options);
  }));

  api.post('/compare', jsonDouble, timed('compare', async (req) => {
    const options = validateOptions(req.body);
    const docA = await readDocument(req.body?.documentA, 'first document');
    const docB = await readDocument(req.body?.documentB, 'second document');
    return legalService.compare(docA, docB, options);
  }));

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Centralised error handler: never leak stack traces or document content.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.locals.releaseAiSlot?.(); // e.g. body-parser errors that happen before the handler runs
    if (err instanceof ValidationError) {
      logger.info('Rejected request', { event: 'validation_error', path: req.path });
      return res.status(400).json({ error: err.message });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: `The upload is too large (maximum ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} MB per file).` });
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
      return res.status(400).json({ error: 'Malformed request.' });
    }
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const isAIError = err instanceof AIServiceError;
    // Log structured, redacted metadata only. Raw cause messages are never logged: a JSON
    // parse error can quote model output, which may quote the user's document.
    (status === 429 ? logger.warn : logger.error)('Request failed', {
      event: 'error',
      path: req.path,
      status,
      name: err?.name,
      code: err?.code,
      attempts: isAIError ? err.attempts : undefined,
      retryAfterSeconds: isAIError ? err.retryAfterSeconds ?? undefined : undefined,
      upstream: isAIError && err.upstream ? err.upstream : undefined,
    });
    if (!isAIError) {
      return res.status(status).json({ error: 'Something went wrong. Please try again.' });
    }
    // Retry-After only when the provider gave a valid, bounded wait (whole seconds, 1..3600).
    const retryAfter = err.retryAfterSeconds;
    if (Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 3600 && (status === 429 || status === 503)) {
      res.set('Retry-After', String(retryAfter));
    }
    return res.status(status).json({ error: err.message, code: err.code });
  });

  return app;
}
