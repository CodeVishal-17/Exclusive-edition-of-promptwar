import { createApp } from './src/app.js';
import { LruCache } from './src/cache.js';
import { parseConfig } from './src/config.js';
import { createGeminiClient, createJsonGenerator } from './src/gemini.js';
import { createLegalService } from './src/legal-service.js';
import { createLogger } from './src/logger.js';

try {
  process.loadEnvFile(); // optional local .env; hosts (Render, Cloud Run) pass real env vars
} catch {
  /* no .env file */
}

const logger = createLogger();
const { config, errors, warnings } = parseConfig();
warnings.forEach((w) => logger.warn(w, { event: 'config_warning' }));
if (errors.length > 0) {
  errors.forEach((e) => logger.error(e, { event: 'config_error' }));
  logger.error('Invalid configuration; refusing to start.', { event: 'startup_failed' });
  process.exit(1);
}

const client = createGeminiClient(config);
const legalService = client
  ? createLegalService({
      generateJson: createJsonGenerator(client, config, { logger }),
      cache: new LruCache({ maxEntries: config.cacheEntries, ttlMs: config.cacheTtlMs }),
      logger,
    })
  : null;

const app = createApp({ config, legalService, logger });
const server = app.listen(config.port, () => {
  logger.info(`LegalLens listening on :${config.port}`, {
    event: 'startup',
    provider: client ? (config.useVertex ? 'vertex' : 'gemini-api') : 'none',
    model: config.model,
    location: config.useVertex ? config.location : undefined,
  });
});
server.requestTimeout = 5 * 60 * 1000;

// Graceful shutdown when the host stops the container (Render and Cloud Run send SIGTERM).
process.on('SIGTERM', () => server.close(() => process.exit(0)));
