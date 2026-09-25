// LegalLens frontend. Model output is only ever inserted with textContent
// (never innerHTML) so a malicious document cannot inject markup.
import { SAMPLE_RENTAL_AGREEMENT, SAMPLE_RENTAL_AGREEMENT_REVISED } from './samples.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MAX_FILE_BYTES = 7 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 150_000; // server may retry once after a transient AI error
const RISK_LABEL = { high: 'High concern', medium: 'Medium concern', low: 'Low concern' };
const RISK_ICON = { high: '⛔', medium: '⚠️', low: '✅' };
const LEVEL_SUMMARY = {
  high: 'Some clauses deserve close review',
  medium: 'A few points worth checking',
  low: 'No major concerns flagged',
  none: 'No clauses were flagged. That does not mean the document is risk-free.',
};
const QUOTE_STATUS = {
  verified: { icon: '✔', text: 'Quote found in your document', cls: 'q-verified' },
  not_found: { icon: '⚠', text: 'Quote NOT found in your document — check the original', cls: 'q-missing' },
  unavailable: { icon: 'ℹ', text: 'Could not be checked automatically (image or scanned PDF) — compare with your original', cls: 'q-unknown' },
};
const DEFAULT_QUESTIONS = [
  'What happens if I want to end this early?',
  'What are all the payments and fees I must make?',
  'What are my deadlines?',
  'Can the other party change the terms later?',
];

const state = {
  analysisDoc: null, // document payload last analysed
  analysis: null,
  askDoc: null,
  askDocName: '',
  history: [],
};

/* ---------------------------------------------------------------- helpers */

/** Create an element with attributes and children (strings become text nodes). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function prefs() {
  return { language: $('#language').value, readingLevel: $('#readingLevel').value };
}

async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The request took too long. Please try a shorter document.');
    if (err instanceof TypeError) throw new Error('Could not reach the server. Check your connection and try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(statusEl, message, { busy = false, error = false } = {}) {
  statusEl.replaceChildren();
  statusEl.classList.toggle('error', error);
  if (!message) return;
  if (busy) statusEl.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  statusEl.append(el('span', { text: message }));
}

async function withBusy(button, statusEl, message, task) {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Working…';
  setStatus(statusEl, message, { busy: true });
  try {
    await task();
    setStatus(statusEl, '');
  } catch (err) {
    setStatus(statusEl, err.message || 'Something went wrong.', { error: true });
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

function mimeFor(file) {
  if (file.type) return file.type;
  if (/\.txt$/i.test(file.name)) return 'text/plain';
  if (/\.pdf$/i.test(file.name)) return 'application/pdf';
  return '';
}

/* ---------------------------------------------------- document input widget */

let inputCounter = 0;
const docInputs = {};

class DocInput {
  constructor(container) {
    this.container = container;
    this.file = null;
    const id = `doc${++inputCounter}`;
    container.append($('#doc-input-template').content.cloneNode(true));

    $$('input[type="radio"]', container).forEach((radio) => {
      radio.name = `${id}-mode`;
      radio.addEventListener('change', () => this.setMode(radio.value));
    });

    this.fileInput = $('.file-input', container);
    this.fileInput.id = `${id}-file`;
    this.fileInput.setAttribute('aria-describedby', `${id}-fname`);
    this.fileInput.setAttribute('aria-label', 'Choose a document file (PDF, image or text)');
    this.fileName = $('.file-name', container);
    this.fileName.id = `${id}-fname`;
    this.textInput = $('.text-input', container);
    this.charCount = $('.char-count', container);
    const zone = $('.dropzone', container);

    this.fileInput.addEventListener('change', () => this.setFile(this.fileInput.files[0]));
    this.textInput.addEventListener('input', () => {
      this.charCount.textContent = `${this.textInput.value.length.toLocaleString()} / 60,000 characters`;
    });
    ['dragenter', 'dragover'].forEach((evt) => zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach((evt) => zone.addEventListener(evt, () => zone.classList.remove('dragover')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.[0]) this.setFile(e.dataTransfer.files[0]);
    });
  }

  setMode(mode) {
    $('.mode-file', this.container).hidden = mode !== 'file';
    $('.mode-text', this.container).hidden = mode !== 'text';
    $$('input[type="radio"]', this.container).forEach((r) => { r.checked = r.value === mode; });
  }

  setFile(file) {
    this.file = null;
    if (!file) { this.fileName.textContent = ''; return; }
    const type = mimeFor(file);
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain'].includes(type)) {
      this.fileName.textContent = `⚠️ ${file.name}: unsupported type. Use PDF, PNG, JPEG, WEBP or TXT.`;
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      this.fileName.textContent = `⚠️ ${file.name} is larger than 7 MB.`;
      return;
    }
    this.file = file;
    this.fileName.textContent = `Selected: ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
  }

  setText(text) {
    this.setMode('text');
    this.textInput.value = text;
    this.textInput.dispatchEvent(new Event('input'));
  }

  get mode() {
    return $('input[type="radio"]:checked', this.container).value;
  }

  get label() {
    return this.mode === 'file' ? this.file?.name || '' : 'Pasted text';
  }

  /** Returns the API document payload or throws a friendly error. */
  async payload(what = 'a document') {
    if (this.mode === 'text') {
      const text = this.textInput.value.trim();
      if (text.length < 40) throw new Error(`Please paste the text of ${what} (at least 40 characters).`);
      return { text, name: 'Pasted text' };
    }
    if (!this.file) throw new Error(`Please choose a file for ${what}.`);
    return { file: { data: await readFileAsBase64(this.file), mimeType: mimeFor(this.file), name: this.file.name } };
  }
}

/* ------------------------------------------------------------------- tabs */

function initTabs() {
  const tabs = $$('[role="tab"]');
  const select = (tab, focus = true) => {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      $(`#${t.getAttribute('aria-controls')}`).hidden = !selected;
    });
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      select(tabs[(keys[e.key] + tabs.length) % tabs.length]);
    });
  });
  return (id) => select($(`#tab-${id}`), false);
}

/* --------------------------------------------------------------- analysis */

function riskBadge(risk, noun) {
  const label = noun ? `${risk[0].toUpperCase()}${risk.slice(1)} ${noun}` : RISK_LABEL[risk];
  return el('span', { class: `risk-badge risk-${risk}` }, el('span', { 'aria-hidden': 'true', text: RISK_ICON[risk] }), label);
}

function listCard(title, icon, items, { ordered = false, empty = 'None found.', note } = {}) {
  const list = items.length
    ? el(ordered ? 'ol' : 'ul', { class: 'list' }, items.map((t) => el('li', { text: t })))
    : el('p', { class: 'muted', text: empty });
  return el('section', { class: 'card' },
    el('h3', {}, el('span', { 'aria-hidden': 'true', text: icon }), title),
    note ? el('p', { class: 'small muted', text: note }) : null,
    list);
}

/** "Clause 4 · page 2" — page numbers come only from the PDF text layer, never from the model. */
function locationText(reference, page) {
  return [reference, page ? `page ${page}` : ''].filter(Boolean).join(' · ');
}

/** A quote with a visible (not colour-only) verification status. */
function quoteBlock(quote, status, page) {
  if (!quote) return null;
  const s = QUOTE_STATUS[status];
  return el('figure', { class: 'quote' },
    el('blockquote', { text: `“${quote}”` }),
    s ? el('figcaption', { class: `q-status ${s.cls}` },
      el('span', { 'aria-hidden': 'true', text: `${s.icon} ` }),
      s.text,
      status === 'verified' && page ? ` (page ${page})` : '') : null);
}

function groundingNote(g) {
  if (!g) return null;
  if (!g.sourceTextAvailable) {
    return el('p', { class: 'small muted' }, el('span', { 'aria-hidden': 'true', text: 'ℹ️ ' }),
      'This file has no machine-readable text (image or scanned PDF), so quotes could not be checked automatically. Compare them with your original.');
  }
  return el('p', { class: 'small muted' }, el('span', { 'aria-hidden': 'true', text: '🔎 ' }),
    `Quote check: ${g.quotesVerified} of ${g.quotesChecked} quotes were found word-for-word in your document.`,
    g.quotesNotFound ? ` ${g.quotesNotFound} could not be found — treat those points with caution.` : '');
}

function renderClauses(clauses) {
  const wrap = el('div');
  const listEl = el('div');
  const draw = (filter) => {
    const shown = clauses.filter((c) => filter === 'all' || c.concern === filter);
    listEl.replaceChildren(...(shown.length ? shown.map((c) => {
      const where = locationText(c.reference, c.quoteStatus === 'verified' ? c.page : null);
      return el('article', { class: `clause ${c.concern}` },
        el('div', { class: 'clause-head' },
          el('h4', { text: where ? `${c.heading} (${where})` : c.heading }),
          riskBadge(c.concern)),
        quoteBlock(c.quote, c.quoteStatus, null),
        el('p', {}, el('strong', { text: 'What it says: ' }), c.plainMeaning),
        c.whyItMatters ? el('p', { class: 'small' }, el('strong', { text: 'Why it may matter (interpretation): ' }), c.whyItMatters) : null);
    }) : [el('p', { class: 'muted', text: 'No clauses at this level.' })]));
  };
  const filters = ['all', 'high', 'medium', 'low'];
  const bar = el('div', { class: 'filter-bar', role: 'group', 'aria-label': 'Filter clauses by concern level' },
    filters.map((f) => el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-small',
      'aria-pressed': String(f === 'all'),
      text: f === 'all' ? `All (${clauses.length})` : `${RISK_LABEL[f]} (${clauses.filter((c) => c.concern === f).length})`,
      onclick: (e) => {
        $$('button', bar).forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        draw(f);
      },
    })));
  draw('all');
  wrap.append(bar, listEl);
  return wrap;
}

function renderAnalysis(a) {
  const root = $('#analysis-results');
  const cs = a.concernSummary;

  const concernPanel = el('div', { class: 'concern-panel' },
    cs.level === 'none' ? null : el('p', { class: 'concern-title' }, riskBadge(cs.level)),
    el('p', { class: 'concern-headline', text: LEVEL_SUMMARY[cs.level] }),
    el('ul', { class: 'counts', 'aria-label': 'Clauses flagged by concern level' },
      ['high', 'medium', 'low'].map((l) => el('li', {},
        el('span', { 'aria-hidden': 'true', text: `${RISK_ICON[l]} ` }), `${cs.counts[l]} ${l}`))),
    cs.excludedUnverified ? el('p', { class: 'small q-missing' },
      el('span', { 'aria-hidden': 'true', text: '⚠ ' }),
      `${cs.excludedUnverified} flagged clause(s) left out because their quote was not found in your document.`) : null,
    el('details', { class: 'small' },
      el('summary', { text: 'How is this worked out?' }),
      el('p', { text: cs.method })));

  const summary = el('section', { class: 'card' },
    el('div', { class: 'result-head' },
      el('div', {},
        el('h2', { id: 'result-title', text: a.title }),
        el('div', { class: 'doc-meta' },
          el('span', { class: 'pill', text: a.documentType }),
          el('span', { class: 'pill', text: `Governing law stated: ${a.governingLawStated}` }),
          a.cached ? el('span', { class: 'pill', text: 'Instant (cached)' }) : null),
        el('p', { text: a.plainSummary }),
        a.mainConcerns ? el('p', {}, el('strong', { text: 'Worth a closer look: ' }), a.mainConcerns) : null,
        a.parties.length ? el('p', { class: 'small' }, el('strong', { text: 'Parties: ' }),
          a.parties.map((p) => `${p.name} — ${p.role}`).join('; ')) : null,
        el('p', { class: 'small muted' }, el('span', { 'aria-hidden': 'true', text: '🌐 ' }),
          'LegalLens does not check the law of any country or state. Rules differ by place, so ask a lawyer where you live how they apply.'),
        groundingNote(a.grounding)),
      concernPanel),
    el('div', { class: 'actions no-print' },
      el('button', { type: 'button', class: 'btn btn-secondary', text: '💬 Ask about this document', onclick: () => goAsk() }),
      el('button', { type: 'button', class: 'btn btn-ghost', text: '⬇️ Download report', onclick: () => downloadReport(a) }),
      el('button', { type: 'button', class: 'btn btn-ghost', text: '🖨️ Print', onclick: () => window.print() })),
  );

  if (!a.isLegalDocument) {
    root.replaceChildren(summary);
    return;
  }

  const obligations = el('section', { class: 'card' },
    el('h3', {}, el('span', { 'aria-hidden': 'true', text: '📅' }), 'Obligations & deadlines stated in the document'),
    a.obligations.length
      ? el('div', { class: 'table-wrap' }, el('table', {},
        el('caption', { class: 'sr-only', text: 'Who must do what, and by when, with the supporting text' }),
        el('thead', {}, el('tr', {}, ['Who', 'Must do', 'By when', 'Document says'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, a.obligations.map((o) => el('tr', {},
          el('td', { text: o.party }),
          el('td', { text: o.action }),
          el('td', { text: o.deadline }),
          el('td', {}, quoteBlock(o.quote, o.quoteStatus, o.page) || el('span', { class: 'muted', text: 'No quote given' })))))))
      : el('p', { class: 'muted', text: 'No specific obligations found.' }));

  const lawyerCard = listCard('Questions to ask a lawyer', '👩‍⚖️', a.questionsForLawyer, { ordered: true });
  lawyerCard.append(el('button', {
    type: 'button',
    class: 'btn btn-ghost btn-small no-print',
    text: '📋 Copy questions',
    onclick: async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(a.questionsForLawyer.map((q, i) => `${i + 1}. ${q}`).join('\n'));
        btn.textContent = '✔ Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = '📋 Copy questions'; }, 2000);
    },
  }));

  root.replaceChildren(
    summary,
    listCard('Key facts', '📌', a.keyPoints),
    el('section', { class: 'card' },
      el('h3', {}, el('span', { 'aria-hidden': 'true', text: '🔍' }), 'Important clauses'),
      renderClauses(a.clauses)),
    obligations,
    el('div', { class: 'grid-2' },
      listCard('Unclear or missing terms', '❓', a.unclearOrMissing, { empty: 'Nothing obviously unclear was flagged.' }),
      listCard('Protections not mentioned', '🛡️', a.missingProtections, {
        empty: 'Nothing obvious was flagged.',
        note: 'Things often found in this kind of document that this one does not mention.',
      })),
    el('div', { class: 'grid-2' },
      listCard('Possible next steps', '➡️', a.nextSteps, { ordered: true }),
      lawyerCard),
    a.glossary.length ? el('section', { class: 'card' },
      el('h3', {}, el('span', { 'aria-hidden': 'true', text: '📖' }), 'Glossary'),
      el('dl', { class: 'glossary' }, a.glossary.flatMap((g) => [el('dt', { text: g.term }), el('dd', { text: g.meaning })]))) : null,
  );
}

/** Keep model text from breaking Markdown structure or becoming live HTML in a viewer. */
function md(text) {
  return String(text ?? '').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const QUOTE_MD = { verified: 'found in document', not_found: 'NOT found in document', unavailable: 'not checked' };

function toMarkdown(a) {
  const bullets = (items) => (items.length ? items.map((t) => `- ${md(t)}`).join('\n') : '- None');
  const cs = a.concernSummary;
  return [
    `# ${md(a.title)}`,
    `*${md(a.documentType)} · Governing law stated: ${md(a.governingLawStated)} · Concern level: ${cs.level} (${cs.counts.high} high, ${cs.counts.medium} medium, ${cs.counts.low} low${cs.excludedUnverified ? `; ${cs.excludedUnverified} unverified clause(s) excluded` : ''})*`,
    '', '> Generated by LegalLens with Google Gemini. This is legal information, not legal advice, and may contain mistakes.',
    `> Concern level method: ${md(cs.method)}`, '',
    '## Summary', md(a.plainSummary), '',
    a.mainConcerns ? `**Worth a closer look:** ${md(a.mainConcerns)}\n` : '',
    '## Key facts', bullets(a.keyPoints), '',
    '## Important clauses',
    ...a.clauses.map((c) => {
      const where = locationText(c.reference, c.quoteStatus === 'verified' ? c.page : null);
      return `### ${md(c.heading)}${where ? ` (${md(where)})` : ''} — ${c.concern} concern\n> ${md(c.quote)} *(${QUOTE_MD[c.quoteStatus] || 'no quote'})*\n\n**What it says:** ${md(c.plainMeaning)}\n\n**Why it may matter:** ${md(c.whyItMatters)}\n`;
    }),
    '## Obligations & deadlines',
    '| Who | Must do | By when |', '|---|---|---|',
    ...a.obligations.map((o) => `| ${md(o.party)} | ${md(o.action)} | ${md(o.deadline)} |`), '',
    '## Unclear or missing terms', bullets(a.unclearOrMissing), '',
    '## Protections not mentioned', bullets(a.missingProtections), '',
    '## Possible next steps', bullets(a.nextSteps), '',
    '## Questions for a lawyer', a.questionsForLawyer.map((q, i) => `${i + 1}. ${md(q)}`).join('\n'), '',
    '## Glossary', ...a.glossary.map((g) => `- **${md(g.term)}**: ${md(g.meaning)}`), '',
  ].join('\n');
}

function downloadReport(a) {
  const blob = new Blob([toMarkdown(a)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `${a.title.replace(/[^\w-]+/g, '_').slice(0, 60) || 'legallens'}_report.md` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function analyse() {
  const results = $('#analysis-results');
  // Hide previous results so an error is never shown next to another document's analysis.
  results.hidden = true;
  await withBusy($('#analyze-btn'), $('#analysis-status'), 'Reading your document with Gemini… this usually takes 10–30 seconds.', async () => {
    const doc = await docInputs.main.payload('your document');
    const analysis = await api('/api/analyze', { document: doc, ...prefs() });
    state.analysisDoc = doc;
    state.analysis = analysis;
    setAskDocument(doc, docInputs.main.label || analysis.title);
    results.lang = prefs().language;
    renderAnalysis(analysis);
    results.hidden = false;
    results.focus();
  });
}

/* -------------------------------------------------------------------- ask */

let selectTab;

function setAskDocument(doc, name) {
  state.askDoc = doc;
  state.askDocName = name;
  state.history = [];
  $('#chat-log').replaceChildren();
  const label = $('#ask-doc-label');
  label.replaceChildren('Asking about: ', el('strong', { text: name }));
  renderSuggestions(DEFAULT_QUESTIONS);
}

function goAsk() {
  selectTab('ask');
  $('#question').focus();
}

function renderSuggestions(questions) {
  $('#suggestions').replaceChildren(...questions.map((q) => el('button', {
    type: 'button',
    class: 'chip',
    text: q,
    onclick: () => { $('#question').value = q; ask(); },
  })));
}

function renderAnswer(ans) {
  return el('li', { class: 'msg msg-ai', lang: prefs().language },
    el('span', { class: 'sr-only', text: 'LegalLens: ' }),
    el('p', { text: ans.answer }),
    ans.citations.map((c) => el('div', { class: 'citation' },
      c.reference ? el('p', { class: 'small', text: c.reference }) : null,
      quoteBlock(c.quote, c.quoteStatus, c.page))),
    ans.interpretationNote ? el('p', { class: 'small' }, el('strong', { text: 'Interpretation: ' }), ans.interpretationNote) : null,
    ans.groundingWarning ? el('p', { class: 'small q-missing' }, el('span', { 'aria-hidden': 'true', text: '⚠ ' }), ans.groundingWarning) : null,
    el('div', { class: 'msg-meta' },
      el('span', { class: 'pill', text: ans.answeredFromDocument ? '📄 Answered from your document' : '❔ Not answered by the document' }),
      el('span', { class: 'pill', text: `Confidence: ${ans.confidence}` }),
      ans.consultLawyer ? el('span', { class: 'pill risk-high', text: '👩‍⚖️ Worth asking a lawyer' }) : null));
}

let asking = false;

async function ask() {
  if (asking) return; // one question at a time (chips, Enter and the button all call this)
  const input = $('#question');
  const question = input.value.trim();
  const statusEl = $('#ask-status');
  if (!state.askDoc) {
    setStatus(statusEl, 'Please load a document first (Understand tab, or “Load a different document” above).', { error: true });
    return;
  }
  if (question.length < 3) {
    setStatus(statusEl, 'Please type a question.', { error: true });
    input.focus();
    return;
  }
  const log = $('#chat-log');
  const userMsg = el('li', { class: 'msg msg-user' }, el('span', { class: 'sr-only', text: 'You: ' }), question);
  log.append(userMsg);
  input.value = '';
  asking = true;
  $$('#suggestions .chip').forEach((c) => { c.disabled = true; });
  try {
    await withBusy($('#ask-btn'), statusEl, 'Finding the answer in your document…', async () => {
      try {
        const ans = await api('/api/ask', { document: state.askDoc, question, history: state.history, ...prefs() });
        state.history.push({ role: 'user', text: question }, { role: 'assistant', text: ans.answer });
        log.append(renderAnswer(ans));
        renderSuggestions(ans.followUpQuestions.length ? ans.followUpQuestions : DEFAULT_QUESTIONS);
      } catch (err) {
        userMsg.remove(); // keep the conversation consistent with what the server saw
        input.value = question; // let the user retry without retyping
        throw err;
      }
    });
  } finally {
    asking = false;
    $$('#suggestions .chip').forEach((c) => { c.disabled = false; });
    input.focus();
  }
}

/* ---------------------------------------------------------------- compare */

function renderComparison(c) {
  const favourLabel = { A: 'Document A', B: 'Document B', neither: 'No clear difference', unclear: 'Unclear — depends on your situation' };
  const docCell = (text, quote, status, page) => el('td', {}, el('p', { text }), quoteBlock(quote, status, page));
  $('#compare-results').replaceChildren(
    el('section', { class: 'card' },
      el('h2', { id: 'compare-title', text: 'Comparison' }),
      c.cached ? el('span', { class: 'pill', text: 'Instant (cached)' }) : null,
      el('p', { text: c.summary }),
      groundingNote(c.grounding)),
    el('section', { class: 'card' },
      el('h3', {}, el('span', { 'aria-hidden': 'true', text: '↔️' }), 'Key differences'),
      el('p', { class: 'small muted', text: '“Appears more favourable to you” compares the wording of each single point only. It is not a legal judgement of which document is better overall.' }),
      c.differences.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'compare-table' },
        el('caption', { class: 'sr-only', text: 'Differences between document A and document B' }),
        el('thead', {}, el('tr', {}, ['Topic', 'Document A', 'Document B', 'Appears more favourable to you', 'Why it may matter'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, c.differences.map((d) => el('tr', {},
          el('th', { scope: 'row' }, d.topic, el('br'), riskBadge(d.significance, 'significance')),
          docCell(d.documentA, d.quoteA, d.quoteAStatus, d.pageA),
          docCell(d.documentB, d.quoteB, d.quoteBStatus, d.pageB),
          el('td', { text: favourLabel[d.appearsMoreFavourable] }),
          el('td', { text: d.explanation }))))))
        : el('p', { class: 'muted', text: 'No meaningful differences were found.' })),
    el('div', { class: 'grid-2' },
      listCard('Only in document A', '🅰️', c.onlyInA),
      listCard('Only in document B', '🅱️', c.onlyInB)),
    listCard('Inconsistencies', '❗', c.inconsistencies, { empty: 'No inconsistencies found.' }),
    listCard('Things to consider or clarify', '🧭', c.thingsToConsider, { empty: 'Nothing specific flagged.' }),
  );
}

async function compare() {
  const results = $('#compare-results');
  results.hidden = true;
  await withBusy($('#compare-btn'), $('#compare-status'), 'Comparing both documents with Gemini…', async () => {
    const documentA = await docInputs.A.payload('document A');
    const documentB = await docInputs.B.payload('document B');
    renderComparison(await api('/api/compare', { documentA, documentB, ...prefs() }));
    results.lang = prefs().language;
    results.hidden = false;
    results.focus();
  });
}

/* ------------------------------------------------------------------- init */

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const select = $('#language');
    select.replaceChildren(...Object.entries(cfg.languages).map(([code, name]) => el('option', { value: code, text: name })));
    const browserLang = (navigator.language || 'en').slice(0, 2);
    if (cfg.languages[browserLang]) select.value = browserLang;
    $('#model-name').textContent = `(${cfg.model} via ${cfg.provider})`;
    if (!cfg.aiReady) {
      const banner = $('#service-status');
      banner.textContent = 'The AI service is not configured on this server yet, so analysis is unavailable.';
      banner.hidden = false;
    }
  } catch {
    /* Non-fatal: defaults remain usable. */
  }
}

function init() {
  $$('[data-doc-input]').forEach((node) => { docInputs[node.dataset.docInput] = new DocInput(node); });
  selectTab = initTabs();
  renderSuggestions(DEFAULT_QUESTIONS);

  $('#analyze-btn').addEventListener('click', analyse);
  $('#sample-btn').addEventListener('click', () => {
    docInputs.main.setText(SAMPLE_RENTAL_AGREEMENT);
    docInputs.main.textInput.focus();
  });
  $('#compare-btn').addEventListener('click', compare);
  $('#compare-sample-btn').addEventListener('click', () => {
    docInputs.A.setText(SAMPLE_RENTAL_AGREEMENT);
    docInputs.B.setText(SAMPLE_RENTAL_AGREEMENT_REVISED);
    docInputs.A.textInput.focus();
  });
  $('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
  $('#question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  $('#ask-use-doc').addEventListener('click', async () => {
    try {
      const doc = await docInputs.ask.payload('your document');
      setAskDocument(doc, docInputs.ask.label);
      $('#ask-doc-details').open = false;
      setStatus($('#ask-status'), '');
      $('#question').focus();
    } catch (err) {
      setStatus($('#ask-status'), err.message, { error: true });
    }
  });
  $('#prefs').addEventListener('submit', (e) => e.preventDefault());

  loadConfig();
}

init();
