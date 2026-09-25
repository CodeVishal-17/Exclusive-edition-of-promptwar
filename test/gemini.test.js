// Tests for the Gemini SDK wrapper using a FAKE client object (no network).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.js';
import { AIServiceError, createGeminiClient, createJsonGenerator, parseJson } from '../src/gemini.js';

const noWait = async () => {};
const fakeClient = (impl) => ({ models: { generateContent: impl } });
const apiError = (status, message = 'upstream') => Object.assign(new Error(message), { status });

describe('parseJson', () => {
  it('parses JSON, including fenced output', () => {
    assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.throws(() => parseJson(''), AIServiceError);
    assert.throws(() => parseJson(undefined), AIServiceError);
    assert.throws(() => parseJson('not json'), AIServiceError);
  });
});

describe('createJsonGenerator', () => {
  it('sends structured-output config with the configured model', async () => {
    let captured;
    const gen = createJsonGenerator(fakeClient(async (req) => { captured = req; return { text: '{"ok":true}' }; }), { model: 'm', temperature: 0.2 });
    assert.deepEqual(await gen({ systemInstruction: 's', contents: [], schema: { type: 'object' } }), { ok: true });
    assert.equal(captured.model, 'm');
    assert.equal(captured.config.responseMimeType, 'application/json');
    assert.deepEqual(captured.config.responseJsonSchema, { type: 'object' });
    assert.equal(captured.config.temperature, 0.2);
    assert.equal(captured.config.systemInstruction, 's');
  });

  it('omits temperature when not configured (Gemini 3+ defaults)', async () => {
    let captured;
    const gen = createJsonGenerator(fakeClient(async (req) => { captured = req; return { text: '{}' }; }), { model: 'gemini-3.6-flash' });
    await gen({ contents: [], schema: {} });
    assert.equal('temperature' in captured.config, false);
  });

  it('retries transient errors, then succeeds', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => {
      calls += 1;
      if (calls === 1) throw apiError(503);
      return { text: '{"ok":1}' };
    }), { maxRetries: 1 }, { wait: noWait });
    assert.deepEqual(await gen({ contents: [] }), { ok: 1 });
    assert.equal(calls, 2);
  });

  it('maps 429 to a friendly error and does NOT retry it (quota errors are never auto-retried)', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw apiError(429, 'quota exceeded for project secret-proj'); }), { maxRetries: 1 }, { wait: noWait });
    await assert.rejects(gen({ contents: [] }), (err) => err instanceof AIServiceError && err.status === 429 && !/secret-proj/.test(err.message));
    assert.equal(calls, 1, 'previously 2: a 429 used to be retried after 0.8 s, which could not succeed');
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; throw apiError(403, 'Permission denied'); }), { maxRetries: 3 }, { wait: noWait });
    await assert.rejects(gen({ contents: [] }), (err) => err.status === 503 && err.code === 'misconfigured');
    assert.equal(calls, 1);
  });

  it('maps model-not-found and bad requests', async () => {
    const notFound = createJsonGenerator(fakeClient(async () => { throw apiError(404); }), { maxRetries: 0 });
    await assert.rejects(notFound({ contents: [] }), (err) => err.code === 'misconfigured');
    const bad = createJsonGenerator(fakeClient(async () => { throw apiError(400); }), { maxRetries: 0 });
    await assert.rejects(bad({ contents: [] }), (err) => err.status === 422);
  });

  it('treats an invalid API key (HTTP 400) as server misconfiguration, not a bad document', async () => {
    // Message shape observed from the real Gemini API with an invalid key.
    const msg = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}';
    const gen = createJsonGenerator(fakeClient(async () => { throw apiError(400, msg); }), { maxRetries: 0 });
    await assert.rejects(gen({ contents: [] }), (err) => err.status === 503 && err.code === 'misconfigured' && !/API key/.test(err.message));
  });

  it('maps timeouts to 504', async () => {
    const gen = createJsonGenerator(fakeClient(async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }), { maxRetries: 0 });
    await assert.rejects(gen({ contents: [] }), (err) => err.status === 504 && err.code === 'timeout');
  });

  it('handles safety blocks and truncated output', async () => {
    const blocked = createJsonGenerator(fakeClient(async () => ({ candidates: [{ finishReason: 'SAFETY' }] })), {});
    await assert.rejects(blocked({ contents: [] }), (err) => err.status === 422 && err.code === 'blocked');
    const promptBlocked = createJsonGenerator(fakeClient(async () => ({ promptFeedback: { blockReason: 'OTHER' } })), {});
    await assert.rejects(promptBlocked({ contents: [] }), (err) => err.code === 'blocked');
    const truncated = createJsonGenerator(fakeClient(async () => ({ text: '{"a":', candidates: [{ finishReason: 'MAX_TOKENS' }] })), {});
    await assert.rejects(truncated({ contents: [] }), (err) => err.code === 'too_long');
  });

  it('retries once on unparseable output', async () => {
    let calls = 0;
    const gen = createJsonGenerator(fakeClient(async () => { calls += 1; return { text: calls === 1 ? 'oops' : '{"ok":true}' }; }), { maxRetries: 1 }, { wait: noWait });
    assert.deepEqual(await gen({ contents: [] }), { ok: true });
  });
});

describe('createGeminiClient', () => {
  it('returns null without credentials', () => {
    assert.equal(createGeminiClient(parseConfig({}).config), null);
  });

  it('creates a Vertex AI client from project config (no key needed)', () => {
    const client = createGeminiClient(parseConfig({ GOOGLE_CLOUD_PROJECT: 'demo-project' }).config);
    assert.ok(client?.models);
    assert.equal(client.vertexai, true);
  });

  it('creates a Gemini API client from an API key', () => {
    const client = createGeminiClient(parseConfig({ GEMINI_API_KEY: 'test-key' }).config);
    assert.ok(client?.models);
    assert.equal(client.vertexai, false);
  });

  it('sends the default model to the standard Gemini API generateContent endpoint (real SDK, stubbed network)', async () => {
    const { config } = parseConfig({ GEMINI_API_KEY: 'fake-test-key' });
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(init?.body ?? '{}') });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const generate = createJsonGenerator(createGeminiClient(config), config);
      const out = await generate({ systemInstruction: 's', contents: [{ role: 'user', parts: [{ text: 'hi' }] }], schema: { type: 'object' } });
      assert.deepEqual(out, { ok: true });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(seen.length, 1);
    const { url, headers, body } = seen[0];
    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.6-flash:generateContent/);
    assert.doesNotMatch(url, /aiplatform|fake-test-key/, 'not Vertex AI, and the key is not placed in the URL');
    assert.equal(headers.get('x-goog-api-key'), 'fake-test-key');
    assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object' });
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal('temperature' in body.generationConfig, false, 'Gemini 3.6 keeps its default temperature');
  });

  it('maps the "model no longer available" 404 (seen live for gemini-2.5-flash) to a safe 503', async () => {
    const msg = '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users.","status":"NOT_FOUND"}}';
    const gen = createJsonGenerator(fakeClient(async () => { throw apiError(404, msg); }), { maxRetries: 1 }, { wait: noWait });
    await assert.rejects(gen({ contents: [] }), (err) => err.status === 503 && err.code === 'misconfigured' && !/gemini-2\.5/.test(err.message));
  });
});
