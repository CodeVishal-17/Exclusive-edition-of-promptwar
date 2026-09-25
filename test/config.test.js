import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig, publicConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('uses safe defaults in development and warns about missing credentials', () => {
    const { config, errors, warnings } = parseConfig({});
    assert.deepEqual(errors, []);
    assert.match(warnings[0], /No Gemini credentials/);
    assert.equal(config.port, 8080);
    assert.equal(config.model, 'gemini-3.6-flash');
    assert.equal(config.location, 'global');
    assert.equal(config.temperature, undefined, 'Gemini 3+ default model keeps its own temperature');
  });

  it('uses the Gemini API (not Vertex AI) when only GEMINI_API_KEY is set, even in production', () => {
    const { config, errors, warnings } = parseConfig({ NODE_ENV: 'production', GEMINI_API_KEY: 'test-key' });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(config.useVertex, false);
    assert.equal(config.model, 'gemini-3.6-flash');
    assert.equal(publicConfig(config, true).provider, 'Gemini API');
  });

  it('prefers the API key over a project id when both are set', () => {
    assert.equal(parseConfig({ GEMINI_API_KEY: 'k', GOOGLE_CLOUD_PROJECT: 'p' }).config.useVertex, false);
  });

  it('has bounded retry and time-limit settings', () => {
    const { config } = parseConfig({});
    assert.equal(config.maxRetries, 2);
    assert.equal(config.requestTimeoutMs, 60_000);
    assert.equal(config.totalTimeoutMs, 110_000, 'below the browser 150 s timeout');
    assert.equal(parseConfig({ GEMINI_TOTAL_TIMEOUT_MS: '30000' }).config.totalTimeoutMs, 30_000);
    assert.match(parseConfig({ GEMINI_TOTAL_TIMEOUT_MS: '100' }).errors.join(), /GEMINI_TOTAL_TIMEOUT_MS/);
    assert.match(parseConfig({ GEMINI_MAX_RETRIES: '9' }).errors.join(), /GEMINI_MAX_RETRIES/);
  });

  it('honours a GEMINI_MODEL override', () => {
    assert.equal(parseConfig({ GEMINI_MODEL: 'gemini-3.5-flash' }).config.model, 'gemini-3.5-flash');
  });

  it('selects Vertex AI when a project is set', () => {
    const { config, errors } = parseConfig({ GOOGLE_CLOUD_PROJECT: 'p', NODE_ENV: 'production' });
    assert.deepEqual(errors, []);
    assert.equal(config.useVertex, true);
  });

  it('refuses to start in production without credentials', () => {
    const { errors } = parseConfig({ NODE_ENV: 'production' });
    assert.match(errors.join(), /No Gemini credentials/);
  });

  it('reports inconsistent or invalid settings', () => {
    assert.match(parseConfig({ GOOGLE_GENAI_USE_VERTEXAI: 'true' }).errors.join(), /GOOGLE_CLOUD_PROJECT/);
    assert.match(parseConfig({ GOOGLE_GENAI_USE_VERTEXAI: 'yes' }).errors.join(), /"true" or "false"/);
    assert.match(parseConfig({ PORT: 'abc' }).errors.join(), /PORT/);
    assert.match(parseConfig({ PORT: '70000' }).errors.join(), /PORT/);
    assert.match(parseConfig({ GEMINI_MODEL: 'bad model!' }).errors.join(), /GEMINI_MODEL/);
    assert.match(parseConfig({ GOOGLE_CLOUD_LOCATION: 'mars' }).errors.join(), /LOCATION/);
    assert.match(parseConfig({ GEMINI_TIMEOUT_MS: '10' }).errors.join(), /GEMINI_TIMEOUT_MS/);
  });

  it('leaves temperature at the model default for Gemini 3+ models', () => {
    assert.equal(parseConfig({ GEMINI_MODEL: 'gemini-3.6-flash' }).config.temperature, undefined);
    assert.equal(parseConfig({ GEMINI_MODEL: 'gemini-3.5-flash' }).config.temperature, undefined);
  });

  it('still uses a low temperature if an older Gemini 2.x model is configured', () => {
    assert.equal(parseConfig({ GEMINI_MODEL: 'gemini-2.5-flash' }).config.temperature, 0.2);
  });

  it('never exposes the project id or API key publicly', () => {
    const { config } = parseConfig({ GOOGLE_CLOUD_PROJECT: 'secret-project', GEMINI_API_KEY: 'secret-key', GOOGLE_GENAI_USE_VERTEXAI: 'true' });
    const json = JSON.stringify(publicConfig(config, true));
    assert.doesNotMatch(json, /secret-project|secret-key/);
  });
});
