/**
 * Deterministic, schema-valid MOCK model responses for unit tests.
 * These are NOT real Gemini output and prove nothing about model quality;
 * see scripts/live-check.js for real calls.
 */
export const LEASE_TEXT = `RENTAL AGREEMENT
1. RENT. The Tenant shall pay Rs. 20,000 per month on or before the 5th day of each month.
2. DEPOSIT. The Tenant shall pay a security deposit of Rs. 60,000, refundable within 30 days of vacating.
3. TERMINATION. Either party may terminate this agreement by giving two months' written notice.`;

export function mockAnalysis(overrides = {}) {
  return {
    isLegalDocument: true,
    title: 'Rental agreement',
    documentType: 'Rental agreement',
    governingLawStated: 'Not stated',
    parties: [{ name: 'Tenant', role: 'Pays rent' }],
    plainSummary: 'You rent a home for Rs 20,000 a month.',
    keyPoints: ['Rent is Rs. 20,000 per month'],
    mainConcerns: 'The notice period may be long.',
    clauses: [
      { heading: 'Rent', reference: 'Clause 1', quote: 'pay Rs. 20,000 per month on or before the 5th day', plainMeaning: 'Pay rent by the 5th.', concern: 'low', whyItMatters: 'Standard.' },
      { heading: 'Termination', reference: '3', quote: "giving two months' written notice", plainMeaning: 'Two months notice.', concern: 'high', whyItMatters: 'Could be costly.' },
      { heading: 'Invented', reference: '', quote: 'The landlord may evict without notice', plainMeaning: 'Not real.', concern: 'medium', whyItMatters: 'Hallucinated.' },
    ],
    obligations: [
      { party: 'Tenant', action: 'Pay rent', deadline: '5th of each month', quote: 'on or before the 5th day of each month' },
    ],
    unclearOrMissing: ['No maintenance clause'],
    missingProtections: ['The document does not mention repairs'],
    nextSteps: ['Keep rent receipts'],
    questionsForLawyer: ['Is two months notice usual?'],
    glossary: [{ term: 'Security deposit', meaning: 'Money held against damage' }],
    ...overrides,
  };
}

export function mockAnswer(overrides = {}) {
  return {
    answeredFromDocument: true,
    answer: 'Two months written notice.',
    citations: [{ reference: 'Clause 3', quote: "Either party may terminate this agreement by giving two months' written notice" }],
    interpretationNote: '',
    confidence: 'high',
    consultLawyer: false,
    followUpQuestions: ['What about the deposit?'],
    ...overrides,
  };
}

export function mockComparison(overrides = {}) {
  return {
    summary: 'B has a shorter notice period.',
    differences: [
      { topic: 'Notice', documentA: 'Two months', quoteA: "two months' written notice", documentB: 'One month', quoteB: "one month's written notice", appearsMoreFavourable: 'B', explanation: 'Less notice needed.', significance: 'high' },
    ],
    onlyInA: [],
    onlyInB: [],
    inconsistencies: [],
    thingsToConsider: ['Ask whether notice can be given by email.'],
    ...overrides,
  };
}

/** Generator that answers according to which schema is requested. */
export function mockGenerator({ analysis = mockAnalysis(), answer = mockAnswer(), comparison = mockComparison() } = {}) {
  const calls = [];
  const generate = async (request) => {
    calls.push(request);
    const req = request.schema.required;
    if (req.includes('answer')) return structuredClone(answer);
    if (req.includes('differences')) return structuredClone(comparison);
    return structuredClone(analysis);
  };
  generate.calls = calls;
  return generate;
}
