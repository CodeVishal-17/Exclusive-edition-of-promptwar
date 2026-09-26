/**
 * LIVE Gemini check: makes REAL model calls against your free-tier quota.
 * Separate from `npm test`, which never touches the network.
 *
 *   npm run test:live
 *   LIVE_DELAY_MS=20000 LIVE_ONLY=ask-present,compare npm run test:live
 *
 * Needs GEMINI_API_KEY (Google AI Studio) in .env or the environment. Model: GEMINI_MODEL
 * (default gemini-3.6-flash). Vertex AI (GOOGLE_CLOUD_PROJECT) is an optional alternative.
 *
 * Starts the real app in-process (same middleware, validation, schema checks and quote
 * verification as production) and calls it over HTTP, one workflow at a time.
 *   LIVE_DELAY_MS  pause between workflows in ms (default 0 = previous behaviour)
 *   LIVE_ONLY      comma-separated workflow ids to run (default: all six)
 * Each workflow is classified PASS / FAIL / INCONCLUSIVE (see live-check-lib.js), and the
 * number of real Gemini calls is reported. Results are written to live-check-report.json.
 */
import { writeFileSync } from 'node:fs';
import { SAMPLE_RENTAL_AGREEMENT, SAMPLE_RENTAL_AGREEMENT_REVISED } from '../public/samples.js';
import { createApp } from '../src/app.js';
import { LruCache } from '../src/cache.js';
import { parseConfig } from '../src/config.js';
import { createGeminiClient, createJsonGenerator } from '../src/gemini.js';
import { createLegalService } from '../src/legal-service.js';
import { makePdf } from '../test/helpers/fixtures.js';
import { parseLiveOptions, parseRetryAfterHeader, runPlan, summarise, WORKFLOW_IDS } from './live-check-lib.js';

try { process.loadEnvFile(); } catch { /* optional */ }

const live = parseLiveOptions(process.env);
const { config, errors } = parseConfig({ ...process.env, NODE_ENV: 'production' });
if (errors.length || live.errors.length) {
  console.error(`NOT LIVE-TESTED - configuration problem:\n- ${[...errors, ...live.errors].join('\n- ')}`);
  process.exit(2);
}

// Metadata-only log capture (never document text), used to report retries and provider details.
const logs = [];
const capture = (severity) => (message, fields) => logs.push({ severity, message, ...fields });
const logger = { info: capture('INFO'), warn: capture('WARNING'), error: capture('ERROR') };

// Count every real Gemini call, including automatic retries of temporary errors.
const client = createGeminiClient(config);
let geminiCalls = 0;
const countedClient = {
  models: {
    generateContent: (request) => {
      geminiCalls += 1;
      return client.models.generateContent(request);
    },
  },
};

const legalService = createLegalService({
  generateJson: createJsonGenerator(countedClient, config, { logger }),
  cache: new LruCache({ maxEntries: 0 }), // never serve cached results in a live check
  askCache: new LruCache({ maxEntries: 0 }),
  logger,
});
const app = createApp({ config: { ...config, rateLimitPerMinute: 1000 }, legalService, logger });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const provider = config.useVertex ? `Vertex AI (${config.location})` : 'Gemini API';
const options = { language: 'en', readingLevel: 'standard' };

function pdfFromText(text) {
  const clauses = text.split(/\n(?=\d+\. )/).map((s) => s.replace(/\s+/g, ' '));
  return makePdf([clauses.slice(0, 5).join(' '), clauses.slice(5, 9).join(' '), clauses.slice(9).join(' ')]);
}

const textDoc = { text: SAMPLE_RENTAL_AGREEMENT };
const pdfDoc = { file: { data: pdfFromText(SAMPLE_RENTAL_AGREEMENT).toString('base64'), mimeType: 'application/pdf', name: 'sample-lease.pdf' } };

/** The six workflows (ids match live-check-lib WORKFLOW_IDS), with their expectations. */
const WORKFLOWS = [
  {
    id: 'understand-text',
    name: 'Understand (pasted text)',
    path: '/api/analyze',
    body: { document: textDoc, ...options },
    expect: (a) => [
      ['returned clauses', a.clauses.length > 0],
      ['at least one quote verified', a.grounding.quotesVerified > 0],
      ['deposit clause flagged medium/high', a.clauses.some((c) => /deposit/i.test(c.heading) && c.concern !== 'low')],
    ],
  },
  {
    id: 'understand-pdf',
    name: 'Understand (PDF upload)',
    path: '/api/analyze',
    body: { document: pdfDoc, ...options },
    expect: (a) => [
      ['returned clauses', a.clauses.length > 0],
      ['verified quotes carry page numbers', a.clauses.filter((c) => c.quoteStatus === 'verified').every((c) => Number.isInteger(c.page))],
    ],
  },
  {
    id: 'ask-present',
    name: 'Ask (answer IS in document)',
    path: '/api/ask',
    body: { document: textDoc, question: 'How much is the security deposit and when is it refunded?', ...options },
    expect: (r) => [
      ['answeredFromDocument = true', r.answeredFromDocument === true],
      ['has a verified citation', r.citations.some((c) => c.quoteStatus === 'verified')],
      ['answer mentions 1,50,000 and 90 days', /1,?50,?000/.test(r.answer) && /90/.test(r.answer)],
    ],
  },
  {
    id: 'ask-absent',
    name: 'Ask (answer NOT in document)',
    path: '/api/ask',
    body: { document: textDoc, question: 'Am I allowed to keep a pet dog in the flat?', ...options },
    expect: (r) => [
      ['answeredFromDocument = false', r.answeredFromDocument === false],
      ['no citations', r.citations.length === 0],
    ],
  },
  {
    id: 'ask-followup',
    name: 'Ask (follow-up about a clause)',
    path: '/api/ask',
    body: {
      document: textDoc,
      question: 'And what happens to my deposit if I leave before it ends?',
      history: [{ role: 'user', text: 'What does clause 6 say about the lock-in?' }, { role: 'assistant', text: 'Clause 6 sets an 11-month lock-in period.' }],
      ...options,
    },
    expect: (r) => [
      ['answeredFromDocument = true', r.answeredFromDocument === true],
      ['mentions forfeiting the deposit', /forfeit/i.test(r.answer) || r.citations.some((c) => /forfeit/i.test(c.quote))],
    ],
  },
  {
    id: 'compare',
    name: 'Compare (original vs revised)',
    path: '/api/compare',
    body: { documentA: textDoc, documentB: { text: SAMPLE_RENTAL_AGREEMENT_REVISED }, ...options },
    expect: (c) => [
      ['found differences', c.differences.length > 0],
      ['deposit refund period difference found', c.differences.some((d) => /deposit|refund/i.test(`${d.topic} ${d.documentA} ${d.documentB}`))],
      ['quotes verified against the right document', c.grounding.quotesVerified > 0],
    ],
  },
];
if (WORKFLOWS.map((w) => w.id).join() !== WORKFLOW_IDS.join()) throw new Error('WORKFLOWS and WORKFLOW_IDS are out of sync');

function summariseBody(json) {
  if (json.clauses) {
    return {
      concern: json.concernSummary,
      clauses: json.clauses.map((c) => ({ heading: c.heading, reference: c.reference, concern: c.concern, quoteStatus: c.quoteStatus, page: c.page, quote: c.quote })),
      obligations: json.obligations.map((o) => ({ party: o.party, deadline: o.deadline, quoteStatus: o.quoteStatus })),
    };
  }
  if (json.answer) {
    return { answeredFromDocument: json.answeredFromDocument, answer: json.answer, citations: json.citations, groundingWarning: json.groundingWarning, consultLawyer: json.consultLawyer };
  }
  if (json.differences) {
    return { differences: json.differences.map((d) => ({ topic: d.topic, favourable: d.appearsMoreFavourable, quoteAStatus: d.quoteAStatus, quoteBStatus: d.quoteBStatus })) };
  }
  return undefined;
}

/** One HTTP request for one workflow. */
async function runOne(wf) {
  const logStart = logs.length;
  const callsBefore = geminiCalls;
  const started = Date.now();
  let httpStatus = 0;
  let json = {};
  let retryAfterSeconds = null;
  let error = null;
  try {
    const res = await fetch(`${base}${wf.path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wf.body) });
    httpStatus = res.status;
    retryAfterSeconds = parseRetryAfterHeader(res.headers.get('retry-after'));
    json = await res.json().catch(() => ({}));
    if (!res.ok) error = json.error || `HTTP ${httpStatus}`;
  } catch (err) {
    error = err.message;
  }
  const newLogs = logs.slice(logStart);
  const schemaRetries = newLogs.filter((l) => l.event === 'schema_invalid').length;
  const failure = newLogs.find((l) => l.event === 'error');
  const checks = httpStatus === 200 ? wf.expect(json).map(([label, ok]) => ({ label, ok: Boolean(ok) })) : [];
  return {
    httpStatus,
    code: httpStatus === 200 ? null : json.code ?? null,
    retryAfterSeconds,
    ms: Date.now() - started,
    geminiCallsForRequest: geminiCalls - callsBefore,
    automaticRetries: newLogs.filter((l) => l.event === 'ai_retry').length,
    schemaValidation: httpStatus === 200 ? (schemaRetries ? `passed after ${schemaRetries} retry` : 'passed') : (json.code === 'schema_invalid' ? 'FAILED' : 'not reached'),
    grounding: json.grounding ?? null,
    checks,
    error,
    upstream: failure?.upstream ?? null, // redacted provider details only
    sample: httpStatus === 200 ? summariseBody(json) : undefined,
  };
}

function printResult(r) {
  console.log(`\n[${r.classification}] ${r.name} (${r.id})`);
  if (r.skipped) {
    console.log(`  ${r.reason}`);
    return;
  }
  console.log(`  HTTP ${r.httpStatus} · ${config.model} via ${provider} · ${r.ms} ms · schema: ${r.schemaValidation} · Gemini calls: ${r.geminiCallsForRequest}${r.requests > 1 ? ` (workflow re-run once: ${r.requests} requests)` : ''}`);
  if (r.grounding) console.log(`  quotes: ${JSON.stringify(r.grounding)}`);
  r.checks.forEach((c) => console.log(`  ${c.ok ? 'PASS' : 'FAIL'}: ${c.label}`));
  if (r.error) console.log(`  error (${r.code ?? 'no code'}): ${r.error}${r.retryAfterSeconds ? ` [Retry-After: ${r.retryAfterSeconds}s]` : ''}`);
  if (r.upstream) {
    const u = r.upstream;
    console.log(`  provider: HTTP ${u.httpStatus} ${u.providerStatus ?? ''}${u.quotaPeriod ? ` · quota period: ${u.quotaPeriod}` : ''}${u.quotaIds?.length ? ` · quota: ${u.quotaIds.join(', ')}` : ''}`);
  }
}

const selected = WORKFLOWS.filter((w) => live.only.includes(w.id));
console.log(`LIVE check: ${config.model} via ${provider} · workflows: ${selected.map((w) => w.id).join(', ')} · LIVE_DELAY_MS=${live.delayMs}`);
if (live.delayMs === 0 && selected.length > 1) {
  console.log('Tip: on the free tier, set LIVE_DELAY_MS (e.g. 20000) to stay under the per-minute request limit.');
}

let results;
try {
  results = await runPlan(selected, {
    delayMs: live.delayMs,
    runOne,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    log: (line) => console.log(`  ... ${line}`),
  });
} finally {
  server.close();
}
results.forEach(printResult);

const summary = summarise(results, geminiCalls);
writeFileSync('live-check-report.json', JSON.stringify({
  when: new Date().toISOString(), model: config.model, provider, options: { delayMs: live.delayMs, only: live.only }, summary, results,
}, null, 2));
console.log(`\nSummary: ${summary.pass} PASS · ${summary.fail} FAIL · ${summary.inconclusive} INCONCLUSIVE · ${summary.geminiCalls} real Gemini call(s) · verdict: ${summary.verdict}`);
console.log('Report: live-check-report.json');
if (results.every((r) => r.httpStatus !== 200)) console.log('RESULT: NOT LIVE-TESTED - no request reached a working model.');
process.exit(summary.verdict === 'PASS' ? 0 : summary.verdict === 'FAIL' ? 1 : 3);
