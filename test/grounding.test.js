import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSourceIndex, locateQuote, normaliseForMatch } from '../src/grounding.js';

const lease = { pages: ["4. SECURITY DEPOSIT. The Licensee shall pay an interest-free security deposit of Rs. 1,50,000.\nThe Licensor's decision on deductions shall be final."], paged: false };

describe('normaliseForMatch', () => {
  it('ignores case, whitespace, punctuation and quote styles', () => {
    assert.equal(normaliseForMatch('The “Licensor’s”  decision\n'), normaliseForMatch("the licensor's decision"));
  });

  it('keeps non-Latin scripts including combining marks', () => {
    assert.equal(normaliseForMatch('किराया देना होगा'), 'किरायादेनाहोगा');
  });
});

describe('locateQuote', () => {
  const index = buildSourceIndex(lease);

  it('verifies exact and lightly reformatted quotes', () => {
    assert.equal(locateQuote(index, "The Licensor's decision on deductions shall be final.").status, 'verified');
    assert.equal(locateQuote(index, 'security deposit of Rs 1,50,000').status, 'verified');
    assert.equal(locateQuote(index, 'SECURITY   DEPOSIT.\nThe Licensee').status, 'verified');
  });

  it('supports ellipses with segments in order', () => {
    assert.equal(locateQuote(index, 'The Licensee shall pay ... security deposit').status, 'verified');
    assert.equal(locateQuote(index, 'The Licensee shall pay … Rs. 1,50,000').status, 'verified');
    assert.equal(locateQuote(index, 'deductions shall be final ... The Licensee shall pay').status, 'not_found', 'segments out of order');
  });

  it('flags fabricated or altered quotes', () => {
    assert.equal(locateQuote(index, 'The Licensor may evict without notice').status, 'not_found');
    assert.equal(locateQuote(index, 'security deposit of Rs. 2,50,000').status, 'not_found');
    assert.equal(locateQuote(index, '...').status, 'not_found');
    assert.equal(locateQuote(index, 'a').status, 'not_found');
  });

  it('reports "unavailable" when there is no text to check against', () => {
    assert.deepEqual(locateQuote(null, 'anything'), { status: 'unavailable', page: null });
    assert.equal(buildSourceIndex({ pages: null }), null);
  });

  it('derives page numbers from the PDF text layer', () => {
    const pdf = buildSourceIndex({ pages: ['Clause 1. Rent is due.', 'Clause 2. Deposit is refundable.', 'Clause 3. Notice is two months.'], paged: true });
    assert.deepEqual(locateQuote(pdf, 'Notice is two months'), { status: 'verified', page: 3 });
    assert.deepEqual(locateQuote(pdf, 'Deposit is refundable'), { status: 'verified', page: 2 });
    assert.equal(locateQuote(pdf, 'Rent is due').page, 1);
  });

  it('does not invent page numbers for pasted text', () => {
    assert.equal(locateQuote(index, 'security deposit').page, null);
  });
});

describe('locateQuote: meaning-changing edits are not verified (regression)', () => {
  const doc = buildSourceIndex({
    paged: false,
    pages: [`5. INTEREST. Late payments carry interest at 1.5% per month. Rent is Rs. 1,50,000.
6. PAYMENT. The Licensee shall pay the maintenance. No deposit is payable for parking.
7. VACATING. The Licensee shall vacate by 01/10/2027 at 10:30 hrs.
8. TERMINATION. If the Licensee vacates early, the Licensee shall pay the fee. The Licensor may terminate this Agreement at any time.`],
  });

  it('keeps decimal points, thousands separators, dates and times significant', () => {
    assert.equal(locateQuote(doc, 'interest at 15% per month').status, 'not_found');
    assert.equal(locateQuote(doc, 'Rent is Rs. 150000').status, 'not_found');
    assert.equal(locateQuote(doc, 'vacate by 0110/2027').status, 'not_found');
    assert.equal(locateQuote(doc, 'at 1030 hrs').status, 'not_found');
    assert.equal(locateQuote(doc, 'interest at 1.5% per month').status, 'verified');
    assert.equal(locateQuote(doc, 'Rent is Rs 1,50,000').status, 'verified', 'the abbreviation dot may be dropped');
    assert.equal(locateQuote(doc, 'vacate by 01/10/2027 at 10:30 hrs').status, 'verified');
  });

  it('does not merge two sentences into one statement', () => {
    assert.equal(locateQuote(doc, 'The Licensee shall pay the maintenance no deposit is payable').status, 'not_found');
    assert.equal(locateQuote(doc, 'The Licensee shall pay the maintenance. No deposit is payable').status, 'verified');
  });

  it('does not let "..." stitch fragments of different sentences into a new claim', () => {
    assert.equal(locateQuote(doc, 'the Licensee ... may terminate this Agreement at any time').status, 'not_found');
    assert.equal(locateQuote(doc, 'The Licensor may ... at any time').status, 'verified', 'elision inside one sentence is fine');
  });

  it('rejects "..." quotes built from tiny fragments', () => {
    assert.equal(locateQuote(doc, 'the ... fee').status, 'not_found');
  });

  it('still verifies quotes that end with a full stop', () => {
    assert.equal(locateQuote(doc, 'The Licensor may terminate this Agreement at any time.').status, 'verified');
  });

  it('treats a quote ending in the next clause number the same way as the document (no false negative)', () => {
    assert.equal(locateQuote(doc, 'Rent is Rs. 1,50,000. 6.').status, 'verified');
  });

  it('finds a later occurrence when the first one does not complete the quote', () => {
    // "the Licensee shall" first appears in clause 6, but "pay the fee" only follows it (same sentence) in clause 8.
    assert.equal(locateQuote(doc, 'the Licensee shall ... pay the fee').status, 'verified');
  });
});
