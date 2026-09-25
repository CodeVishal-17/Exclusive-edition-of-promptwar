/**
 * Domain logic: analyse, answer questions about, and compare legal documents.
 * Orchestrates an injected `generateJson` function, then:
 *   1. validates the model output against the JSON schema (Ajv), retrying once;
 *   2. normalises it defensively so the UI never breaks;
 *   3. checks every quote against the document text (grounding.js).
 */
import Ajv from 'ajv';
import { hashKey, LruCache } from './cache.js';
import { AIServiceError } from './errors.js';
import { buildSourceIndex, groundingSummary, locateQuote } from './grounding.js';
import { analysisPrompt, comparisonPrompt, questionPrompt } from './prompts.js';
import { ANALYSIS_SCHEMA, ANSWER_SCHEMA, COMPARISON_SCHEMA } from './schemas.js';

const ajv = new Ajv({ allErrors: false, strict: false });
const validators = new Map([
  [ANALYSIS_SCHEMA, ajv.compile(ANALYSIS_SCHEMA)],
  [ANSWER_SCHEMA, ajv.compile(ANSWER_SCHEMA)],
  [COMPARISON_SCHEMA, ajv.compile(COMPARISON_SCHEMA)],
]);

const LEVEL_ORDER = { high: 3, medium: 2, low: 1 };
const asArray = (v) => (Array.isArray(v) ? v : []);
const asString = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const asLevel = (v) => (v === 'low' || v === 'medium' || v === 'high' ? v : 'medium');
const strings = (v, max = 20) => asArray(v).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, max);

/** Validate against the schema; returns a list of short error descriptions (no content). */
export function schemaErrors(schema, data) {
  const validate = validators.get(schema) ?? ajv.compile(schema);
  return validate(data) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/**
 * Transparent, clearly-labelled heuristic - NOT a legal risk assessment.
 * Level = highest concern level among the flagged clauses whose quote was not
 * disproved. Clauses whose quote could not be found in the document are excluded
 * (a hallucinated clause must not drive the headline) and counted separately.
 * "none" means nothing was flagged - not that the document is safe.
 */
export function concernSummary(clauses) {
  const counts = { high: 0, medium: 0, low: 0 };
  let excludedUnverified = 0;
  for (const c of asArray(clauses)) {
    if (c?.quoteStatus === 'not_found') excludedUnverified += 1;
    else counts[asLevel(c?.concern)] += 1;
  }
  const level = counts.high > 0 ? 'high' : counts.medium > 0 ? 'medium' : counts.low > 0 ? 'low' : 'none';
  return {
    level,
    counts,
    excludedUnverified,
    method: 'Based only on the clauses LegalLens flagged: "high" if any was flagged high, otherwise "medium" if any was flagged medium. Clauses whose quote could not be found in your document are left out. This is a reading aid, not a legal risk assessment.',
  };
}

function withQuoteStatus(index, item, field = 'quote', statusField = 'quoteStatus', pageField = 'page') {
  const quote = item[field];
  if (!quote) return { ...item, [statusField]: 'none', [pageField]: null };
  const { status, page } = locateQuote(index, quote);
  return { ...item, [statusField]: status, [pageField]: page };
}

/** Defensive normalisation + grounding for analysis output. */
export function normaliseAnalysis(raw, source = null) {
  const index = buildSourceIndex(source);
  const clauses = asArray(raw?.clauses)
    .map((c) => ({
      heading: asString(c?.heading, 'Clause'),
      reference: asString(c?.reference),
      quote: asString(c?.quote),
      plainMeaning: asString(c?.plainMeaning),
      concern: asLevel(c?.concern),
      whyItMatters: asString(c?.whyItMatters),
    }))
    .map((c) => withQuoteStatus(index, c))
    .sort((a, b) => LEVEL_ORDER[b.concern] - LEVEL_ORDER[a.concern]);
  const obligations = asArray(raw?.obligations)
    .map((o) => ({
      party: asString(o?.party, 'Not stated'),
      action: asString(o?.action),
      deadline: asString(o?.deadline, 'Not stated'),
      quote: asString(o?.quote),
    }))
    .filter((o) => o.action)
    .map((o) => withQuoteStatus(index, o));

  return {
    isLegalDocument: raw?.isLegalDocument !== false,
    title: asString(raw?.title, 'Untitled document'),
    documentType: asString(raw?.documentType, 'Document'),
    governingLawStated: asString(raw?.governingLawStated, 'Not stated'),
    parties: asArray(raw?.parties).map((p) => ({ name: asString(p?.name), role: asString(p?.role) })).filter((p) => p.name),
    plainSummary: asString(raw?.plainSummary),
    keyPoints: strings(raw?.keyPoints),
    mainConcerns: asString(raw?.mainConcerns),
    concernSummary: concernSummary(clauses),
    clauses,
    obligations,
    unclearOrMissing: strings(raw?.unclearOrMissing),
    missingProtections: strings(raw?.missingProtections),
    nextSteps: strings(raw?.nextSteps),
    questionsForLawyer: strings(raw?.questionsForLawyer),
    glossary: asArray(raw?.glossary).map((g) => ({ term: asString(g?.term), meaning: asString(g?.meaning) })).filter((g) => g.term),
    grounding: groundingSummary([...clauses, ...obligations], Boolean(index)),
  };
}

export function normaliseAnswer(raw, source = null) {
  const index = buildSourceIndex(source);
  const answeredFromDocument = raw?.answeredFromDocument === true;
  const citations = answeredFromDocument
    ? asArray(raw?.citations)
      .map((c) => ({ reference: asString(c?.reference), quote: asString(c?.quote) }))
      .filter((c) => c.quote)
      .map((c) => withQuoteStatus(index, c))
    : [];
  const grounding = groundingSummary(citations, Boolean(index));
  let groundingWarning = '';
  if (answeredFromDocument && citations.length === 0) {
    groundingWarning = 'The AI did not quote the document for this answer. Check it against your document.';
  } else if (grounding.quotesNotFound > 0) {
    groundingWarning = 'Some quoted text could not be found in your document. Check those parts against the original.';
  }
  return {
    answeredFromDocument,
    answer: asString(raw?.answer, 'Sorry, I could not find an answer.'),
    citations,
    interpretationNote: asString(raw?.interpretationNote),
    confidence: asLevel(raw?.confidence),
    consultLawyer: raw?.consultLawyer === true,
    followUpQuestions: strings(raw?.followUpQuestions, 3),
    grounding,
    groundingWarning,
  };
}

export function normaliseComparison(raw, sourceA = null, sourceB = null) {
  const indexA = buildSourceIndex(sourceA);
  const indexB = buildSourceIndex(sourceB);
  const favourable = (v) => (['A', 'B', 'neither', 'unclear'].includes(v) ? v : 'unclear');
  const differences = asArray(raw?.differences)
    .map((d) => ({
      topic: asString(d?.topic, 'Difference'),
      documentA: asString(d?.documentA, 'Not covered'),
      quoteA: asString(d?.quoteA),
      documentB: asString(d?.documentB, 'Not covered'),
      quoteB: asString(d?.quoteB),
      appearsMoreFavourable: favourable(d?.appearsMoreFavourable),
      explanation: asString(d?.explanation),
      significance: asLevel(d?.significance),
    }))
    .map((d) => withQuoteStatus(indexA, d, 'quoteA', 'quoteAStatus', 'pageA'))
    .map((d) => withQuoteStatus(indexB, d, 'quoteB', 'quoteBStatus', 'pageB'))
    .sort((a, b) => LEVEL_ORDER[b.significance] - LEVEL_ORDER[a.significance]);

  const statuses = differences.flatMap((d) => [
    d.quoteA ? d.quoteAStatus : null,
    d.quoteB ? d.quoteBStatus : null,
  ]).filter(Boolean);
  return {
    summary: asString(raw?.summary),
    differences,
    onlyInA: strings(raw?.onlyInA),
    onlyInB: strings(raw?.onlyInB),
    inconsistencies: strings(raw?.inconsistencies),
    thingsToConsider: strings(raw?.thingsToConsider),
    grounding: {
      sourceTextAvailable: Boolean(indexA && indexB),
      quotesChecked: statuses.filter((s) => s !== 'unavailable').length,
      quotesVerified: statuses.filter((s) => s === 'verified').length,
      quotesNotFound: statuses.filter((s) => s === 'not_found').length,
    },
  };
}

const docFingerprint = (doc) => (doc.kind === 'text' ? doc.text : `${doc.mimeType}:${doc.data}`);

export function createLegalService({ generateJson, cache = new LruCache(), logger }) {
  /** Call the model and require schema-valid output, retrying once if it is not. */
  async function generateValid(request) {
    // Both attempts share one overall deadline (see createJsonGenerator's totalTimeoutMs).
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const data = await generateJson({ ...request, startedAt });
      const errors = schemaErrors(request.schema, data);
      if (errors.length === 0) return data;
      logger?.warn?.('Model output failed schema validation', { event: 'schema_invalid', attempt, errors: errors.slice(0, 5) });
    }
    throw new AIServiceError('The AI returned an incomplete answer. Please try again.', { status: 502, code: 'schema_invalid' });
  }

  async function cached(key, compute) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };
    const value = await compute();
    cache.set(key, value);
    return { ...value, cached: false };
  }

  return {
    analyze(doc, options) {
      const key = hashKey('analyze:v2', docFingerprint(doc), options);
      return cached(key, async () => {
        const raw = await generateValid({ ...analysisPrompt(doc, options), schema: ANALYSIS_SCHEMA });
        return normaliseAnalysis(raw, doc.source);
      });
    },

    async ask(doc, question, history, options) {
      const raw = await generateValid({ ...questionPrompt(doc, question, history, options), schema: ANSWER_SCHEMA });
      return normaliseAnswer(raw, doc.source);
    },

    compare(docA, docB, options) {
      const key = hashKey('compare:v2', docFingerprint(docA), docFingerprint(docB), options);
      return cached(key, async () => {
        const raw = await generateValid({ ...comparisonPrompt(docA, docB, options), schema: COMPARISON_SCHEMA });
        return normaliseComparison(raw, docA.source, docB.source);
      });
    },
  };
}
