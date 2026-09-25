/**
 * Deterministic grounding checks: confirm that quotes returned by the model
 * really occur in the user's document, and find the PDF page they are on.
 *
 * Matching ignores case, whitespace and most punctuation (PDF text extraction
 * and the model both vary on those), but keeps the punctuation that changes
 * meaning:
 *   - separators inside numbers, dates and times ("1.5" ≠ "15", "01/10" ≠ "0110");
 *   - sentence boundaries ("pay. No deposit" ≠ "pay no deposit").
 * "..." elisions are supported, but the elided gap must be short and must not
 * cross a sentence boundary, so fragments of different sentences cannot be
 * stitched into a new claim.
 * Page numbers come from the PDF text layer - never from the model.
 *
 * Status values:
 *   'verified'    quote found in the document text
 *   'not_found'   document text available but the quote is not in it
 *   'unavailable' no machine-readable text (image / scanned PDF) - cannot check
 */

const ELLIPSIS_RE = /\.{3,}|…|\[\s*\.\.\.\s*\]/;
const MIN_QUOTE_CHARS = 4; // after normalisation
const MIN_ELIDED_SEGMENT_CHARS = 8; // each part of a quote that uses "..."
const MAX_ELISION_GAP = 200; // normalised characters that "..." may skip
const MAX_FIRST_SEGMENT_TRIES = 500;

// Private-use code points survive the "letters, marks and digits only" filter.
const NUMBER_SEPARATORS = { '.': '\uE000', ',': '\uE001', '/': '\uE002', ':': '\uE003', '-': '\uE004' };
const SENTENCE_BREAK = '\uE00F';

/**
 * Lower-case and keep only letters, combining marks and digits - plus markers
 * for numeric separators and sentence boundaries.
 */
export function normaliseForMatch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    // Separators between digits are meaningful (amounts, rates, dates, clause numbers).
    .replace(/(?<=\d)[.,/:-](?=\d)/g, (sep) => NUMBER_SEPARATORS[sep])
    // Sentence end: . ! ? ; । followed by whitespace and a capital letter or a numbered heading ("5. ").
    .replace(/[.!?;।](?=\s+(?:\p{Lu}|\d+[.)](?:\s|$)))/gu, SENTENCE_BREAK)
    .replace(/[;।]/g, SENTENCE_BREAK)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\uE000-\uE00F]+/gu, '');
}

/** Build a searchable index over the document's pages. */
export function buildSourceIndex(source) {
  if (!source?.pages) return null;
  const starts = [];
  let joined = '';
  for (const page of source.pages) {
    starts.push(joined.length);
    joined += `${normaliseForMatch(page)}${SENTENCE_BREAK}`;
  }
  return { joined, starts, paged: Boolean(source.paged) };
}

function pageAt(index, offset) {
  let page = 0;
  for (let i = 0; i < index.starts.length; i += 1) {
    if (index.starts[i] <= offset) page = i;
    else break;
  }
  return page + 1;
}

/** Trailing sentence marker on a quote ("...shall be final.") must not block a match at a page end. */
const trimBreaks = (s) => s.replace(new RegExp(`^${SENTENCE_BREAK}+|${SENTENCE_BREAK}+$`, 'g'), '');

/** Try to match the remaining segments after `segments[0]` was found at `start`. */
function matchRest(joined, segments, start) {
  let end = start + segments[0].length;
  for (let i = 1; i < segments.length; i += 1) {
    const at = joined.indexOf(segments[i], end);
    if (at === -1) return false;
    const gap = joined.slice(end, at);
    if (gap.length > MAX_ELISION_GAP || gap.includes(SENTENCE_BREAK)) return false;
    end = at + segments[i].length;
  }
  return true;
}

/**
 * @returns {{status:'verified'|'not_found'|'unavailable', page:number|null}}
 */
export function locateQuote(index, quote) {
  if (!index) return { status: 'unavailable', page: null };
  const segments = String(quote ?? '')
    .split(ELLIPSIS_RE)
    .map((s) => trimBreaks(normaliseForMatch(s)))
    .filter((s) => s.length > 0);
  const total = segments.reduce((n, s) => n + s.length, 0);
  if (segments.length === 0 || total < MIN_QUOTE_CHARS) return { status: 'not_found', page: null };
  if (segments.length > 1 && segments.some((s) => s.length < MIN_ELIDED_SEGMENT_CHARS)) {
    // Tiny fragments joined by "..." could match almost anything.
    return { status: 'not_found', page: null };
  }

  // Try each occurrence of the first segment; later segments must follow closely, within one sentence.
  let from = 0;
  for (let tries = 0; tries < MAX_FIRST_SEGMENT_TRIES; tries += 1) {
    const at = index.joined.indexOf(segments[0], from);
    if (at === -1) break;
    if (matchRest(index.joined, segments, at)) {
      return { status: 'verified', page: index.paged ? pageAt(index, at) : null };
    }
    from = at + 1;
  }
  return { status: 'not_found', page: null };
}

/** Summary counts for a list of located quotes. */
export function groundingSummary(items, sourceAvailable) {
  const checked = items.filter((i) => i.quote);
  return {
    sourceTextAvailable: sourceAvailable,
    quotesChecked: sourceAvailable ? checked.length : 0,
    quotesVerified: checked.filter((i) => i.quoteStatus === 'verified').length,
    quotesNotFound: checked.filter((i) => i.quoteStatus === 'not_found').length,
  };
}
