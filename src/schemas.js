/**
 * JSON Schemas passed to Gemini as `responseJsonSchema` (constrained decoding)
 * and re-checked with Ajv on every response (see legal-service.js).
 * Fields separate what the document SAYS (facts, with quotes) from what it may
 * MEAN for the reader (interpretation, hedged).
 */

const str = (description) => ({ type: 'string', description });
const strList = (description, maxItems = 10) => ({ type: 'array', description, maxItems, items: { type: 'string' } });
const level = (description) => ({ type: 'string', enum: ['low', 'medium', 'high'], description });
const quote = str('EXACT words copied from the document (max ~40 words, may shorten with "..."). Empty string if there is no supporting text. Never paraphrase here.');
const reference = str('Clause/section number exactly as printed in the document (e.g. "Clause 4", "7.2"), or "" if the document has none. Never guess and never give page numbers.');

export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    isLegalDocument: { type: 'boolean', description: 'False if the input is clearly not a legal or official document.' },
    title: str('Short descriptive title of the document.'),
    documentType: str('e.g. Rental agreement, Employment contract, Legal notice, Privacy policy, Court summons.'),
    governingLawStated: str('Governing law / jurisdiction exactly as stated in the document, or "Not stated". Do not infer from addresses or currency.'),
    parties: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: { name: str('Party name or label as written.'), role: str('Role in plain words, e.g. "Landlord (receives rent)".') },
        required: ['name', 'role'],
      },
    },
    plainSummary: str('3-6 sentence plain-language summary of what the document says, preserving its meaning. Facts only.'),
    keyPoints: strList('Key facts explicitly stated: amounts, dates, duration, termination terms.', 8),
    mainConcerns: str('One or two sentences on the main points a reader may want to look at closely. Use hedged language ("may", "could").'),
    clauses: {
      type: 'array',
      maxItems: 14,
      description: 'Most important clauses, greatest concern first.',
      items: {
        type: 'object',
        properties: {
          heading: str('Short clause name, e.g. "Security deposit".'),
          reference,
          quote,
          plainMeaning: str('What the clause says, in plain words, without changing its meaning.'),
          concern: level('How closely a reader may want to review this clause: high = one-sided, unusual, or could cost significant money/rights; low = standard.'),
          whyItMatters: str('Interpretation: why this could matter to the reader. Hedged, not a legal conclusion.'),
        },
        required: ['heading', 'reference', 'quote', 'plainMeaning', 'concern', 'whyItMatters'],
      },
    },
    obligations: {
      type: 'array',
      maxItems: 12,
      description: 'Only obligations explicitly stated in the document.',
      items: {
        type: 'object',
        properties: {
          party: str('Who must do it.'),
          action: str('What they must do.'),
          deadline: str('Deadline exactly as stated, or "Not stated". Never calculate or invent dates.'),
          quote,
        },
        required: ['party', 'action', 'deadline', 'quote'],
      },
    },
    unclearOrMissing: strList('Terms that are vague, ambiguous, blank or referenced but missing (e.g. an annexure that is not attached).', 8),
    missingProtections: strList('Protections commonly found in this type of document that do not appear. Phrase as "The document does not mention ...".', 6),
    nextSteps: strList('Practical, safe next steps (e.g. ask for a clause to be clarified, keep records). Never tell the reader to break the agreement.', 6),
    questionsForLawyer: strList('Specific questions to ask a qualified lawyer about this document.', 8),
    glossary: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: { term: str('Legal term used in the document.'), meaning: str('Simple explanation.') },
        required: ['term', 'meaning'],
      },
    },
  },
  required: [
    'isLegalDocument', 'title', 'documentType', 'governingLawStated', 'parties', 'plainSummary', 'keyPoints',
    'mainConcerns', 'clauses', 'obligations', 'unclearOrMissing', 'missingProtections', 'nextSteps',
    'questionsForLawyer', 'glossary',
  ],
};

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answeredFromDocument: { type: 'boolean', description: 'True only if the document itself contains the information that answers the question.' },
    answer: str('Plain-language answer based only on the document. If the document does not answer it, say so and state what information is missing.'),
    citations: {
      type: 'array',
      maxItems: 4,
      description: 'Supporting passages. Empty if answeredFromDocument is false.',
      items: {
        type: 'object',
        properties: { reference, quote },
        required: ['reference', 'quote'],
      },
    },
    interpretationNote: str('If any part of the answer is an interpretation rather than something the document states directly, explain which part and why it is uncertain. Otherwise "".'),
    confidence: level('Confidence that the answer correctly reflects the document.'),
    consultLawyer: { type: 'boolean', description: 'True if the question depends on law outside the document, or involves deadlines, disputes, court, eviction, arrest or significant money.' },
    followUpQuestions: strList('2-3 useful follow-up questions about this document.', 3),
  },
  required: ['answeredFromDocument', 'answer', 'citations', 'interpretationNote', 'confidence', 'consultLawyer', 'followUpQuestions'],
};

export const COMPARISON_SCHEMA = {
  type: 'object',
  properties: {
    summary: str('Plain-language overview of how the two documents differ. Facts only.'),
    differences: {
      type: 'array',
      maxItems: 14,
      items: {
        type: 'object',
        properties: {
          topic: str('e.g. Notice period, Rent increase, Liability cap.'),
          documentA: str('What document A says, or "Not covered".'),
          quoteA: quote,
          documentB: str('What document B says, or "Not covered".'),
          quoteB: quote,
          appearsMoreFavourable: {
            type: 'string',
            enum: ['A', 'B', 'neither', 'unclear'],
            description: 'On this single point only, which wording appears more favourable to the reader. Use "unclear" when it depends on circumstances or law.',
          },
          explanation: str('Why this difference could matter to the reader. Hedged interpretation, not a legal conclusion.'),
          significance: level('How much this difference could affect money, rights or obligations.'),
        },
        required: ['topic', 'documentA', 'quoteA', 'documentB', 'quoteB', 'appearsMoreFavourable', 'explanation', 'significance'],
      },
    },
    onlyInA: strList('Important terms present only in document A.', 6),
    onlyInB: strList('Important terms present only in document B.', 6),
    inconsistencies: strList('Contradictions or mismatches between the two (names, dates, amounts).', 6),
    thingsToConsider: strList('Neutral points to think about or clarify before choosing or signing. Do not say which document to choose.', 5),
  },
  required: ['summary', 'differences', 'onlyInA', 'onlyInB', 'inconsistencies', 'thingsToConsider'],
};
