// LegalLens frontend. Model output is only ever inserted with textContent
// (never innerHTML) so a malicious document cannot inject markup.
import { SAMPLE_RENTAL_AGREEMENT, SAMPLE_RENTAL_AGREEMENT_REVISED } from './samples.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SVG_NS = 'http://www.w3.org/2000/svg';

const MAX_FILE_BYTES = 7 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 150_000; // server may retry once after a transient AI error
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How much attention a clause deserves (words + icon, never colour alone). */
const LEVEL = {
  high: { label: 'High attention', hint: 'Review carefully', icon: 'i-alert' },
  medium: { label: 'Moderate attention', hint: 'Worth discussing', icon: 'i-flag' },
  low: { label: 'Low attention', hint: 'Looks routine', icon: 'i-check-circle' },
};
const OVERALL = {
  high: { title: 'Some clauses need careful review', icon: 'i-alert' },
  medium: { title: 'A few points worth discussing', icon: 'i-flag' },
  low: { title: 'Nothing unusual flagged', icon: 'i-check-circle' },
  none: { title: 'No clauses were flagged', sub: 'That does not mean the document is risk-free.', icon: 'i-minus-circle' },
};
const QUOTE_STATUS = {
  verified: { icon: 'i-check-circle', text: 'Verified in your document', cls: 'q-verified' },
  not_found: { icon: 'i-alert', text: 'Not found in your document — check the original', cls: 'q-missing' },
  unavailable: { icon: 'i-info', text: 'Not checked automatically (image or scanned PDF)', cls: 'q-unknown' },
};
const DEFAULT_QUESTIONS = [
  'What are my obligations?',
  'Can the agreement be terminated early?',
  'What fees could apply?',
  'What should I ask a lawyer?',
];
const FILE_BADGE = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WEBP', 'text/plain': 'TXT' };

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

/** Decorative icon from the SVG sprite in index.html. */
function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

/** Give children a stagger index for the reveal animation (CSS reads --i). */
function stagger(nodes) {
  [...nodes].forEach((node, i) => node.style?.setProperty('--i', String(Math.min(i, 12))));
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, reducedMotion() ? 0 : ms); });

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

function setStatus(statusEl, message, { error = false } = {}) {
  statusEl.replaceChildren();
  statusEl.classList.toggle('error', error);
  if (!message) return;
  statusEl.append(icon(error ? 'i-alert' : 'i-info'), el('span', { text: message }));
}

/** Disable a button and swap its label while `task` runs; show errors in `statusEl`. */
async function withBusy(button, statusEl, busyLabel, task) {
  const label = $('.btn-label', button) || button;
  const original = label.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  label.textContent = busyLabel;
  setStatus(statusEl, '');
  try {
    await task();
  } catch (err) {
    setStatus(statusEl, err.message || 'Something went wrong.', { error: true });
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    label.textContent = original;
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

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ----------------------------------------------------- processing progress */

/**
 * Honest progress: each stage maps to a real step in the request
 * (preparing the file in the browser, waiting for Gemini, checking the
 * returned quotes). No percentages, no invented intermediate work.
 */
function createProgress(container, { title, hint, stages }) {
  const items = stages.map((text) => el('li', { class: 'stage', 'data-state': 'pending' },
    el('span', { class: 'mark' }, icon('i-check')), el('span', { text })));
  const elapsed = el('span', { class: 'elapsed', text: '0 s' });
  const announcer = el('span', { class: 'sr-only', 'aria-live': 'polite' });
  container.replaceChildren(
    el('div', { class: 'scan-wrap', 'aria-hidden': 'true' },
      el('div', { class: 'scan' }, ...Array.from({ length: 6 }, () => el('span', { class: 'line' })), el('span', { class: 'beam' }))),
    el('div', {},
      el('p', { class: 'progress-title', text: title }),
      el('p', { class: 'progress-sub' }, el('span', { text: hint }), el('span', { 'aria-hidden': 'true' }, ' · ', elapsed)),
      el('ol', { class: 'stages' }, items),
      announcer),
  );
  container.hidden = false;
  const started = Date.now();
  const timer = setInterval(() => { elapsed.textContent = `${Math.round((Date.now() - started) / 1000)} s`; }, 1000);

  const step = (index) => {
    items.forEach((li, i) => li.setAttribute('data-state', i < index ? 'done' : i === index ? 'active' : 'pending'));
    announcer.textContent = stages[index] ? `${stages[index]}…` : '';
  };
  return {
    step,
    async finish() {
      clearInterval(timer);
      step(stages.length);
      announcer.textContent = 'Done.';
      await wait(420);
      container.hidden = true;
    },
    fail() {
      clearInterval(timer);
      container.hidden = true;
    },
  };
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
    this.zone = $('.dropzone', container);

    this.fileInput.addEventListener('change', () => this.setFile(this.fileInput.files[0]));
    this.textInput.addEventListener('input', () => {
      this.charCount.textContent = `${this.textInput.value.length.toLocaleString()} / 60,000 characters`;
    });
    ['dragenter', 'dragover'].forEach((evt) => this.zone.addEventListener(evt, (e) => {
      e.preventDefault();
      this.zone.classList.add('dragover');
    }));
    this.zone.addEventListener('dragleave', (e) => {
      if (!this.zone.contains(e.relatedTarget)) this.zone.classList.remove('dragover');
    });
    this.zone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.zone.classList.remove('dragover');
      if (e.dataTransfer?.files?.[0]) this.setFile(e.dataTransfer.files[0]);
    });
  }

  setMode(mode) {
    $('.mode-file', this.container).hidden = mode !== 'file';
    $('.mode-text', this.container).hidden = mode !== 'text';
    $$('input[type="radio"]', this.container).forEach((r) => { r.checked = r.value === mode; });
  }

  showFileError(message) {
    this.fileName.replaceChildren(el('div', { class: 'file-error', role: 'alert' }, icon('i-alert'), el('span', { text: message })));
  }

  setFile(file) {
    this.file = null;
    this.zone.classList.remove('has-file');
    if (!file) { this.fileName.replaceChildren(); return; }
    const type = mimeFor(file);
    if (!FILE_BADGE[type]) {
      this.fileInput.value = '';
      this.showFileError(`${file.name}: unsupported type. Use PDF, PNG, JPEG, WEBP or TXT.`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      this.fileInput.value = '';
      this.showFileError(`${file.name} is larger than 7 MB.`);
      return;
    }
    this.file = file;
    this.zone.classList.add('has-file');
    this.fileName.replaceChildren(el('div', { class: 'file-chip' },
      el('span', { class: 'ficon', 'aria-hidden': 'true', text: FILE_BADGE[type] }),
      el('div', { class: 'fmeta' },
        el('p', { class: 'fname', text: file.name, title: file.name }),
        el('p', { class: 'fsub' },
          el('span', { text: `${FILE_BADGE[type]} · ${formatSize(file.size)}` }),
          el('span', { class: 'ready' }, icon('i-check'), el('span', { class: 'ready-text', text: 'Ready' })))),
      el('button', {
        type: 'button',
        class: 'icon-btn',
        'aria-label': `Remove ${file.name}`,
        onclick: () => this.clearFile(),
      }, icon('i-x'))));
  }

  clearFile() {
    this.fileInput.value = '';
    this.setFile(null);
    this.fileInput.focus();
  }

  /** Visual "processing" state on the selected file while a request runs. */
  setBusy(busy) {
    const ready = $('.ready-text', this.container);
    if (ready) ready.textContent = busy ? 'Processing…' : 'Ready';
    this.container.classList.toggle('is-busy', busy);
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
  const navLinks = $$('[data-goto]');
  const select = (tab, focus = true) => {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      $(`#${t.getAttribute('aria-controls')}`).hidden = !selected;
    });
    const id = tab.id.replace('tab-', '');
    navLinks.forEach((a) => {
      if (a.dataset.goto === id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
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
  navLinks.forEach((link) => link.addEventListener('click', () => {
    select($(`#tab-${link.dataset.goto}`), false);
    $('#workspace').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    $(`#tab-${link.dataset.goto}`).focus({ preventScroll: true });
  }));
  return (id) => select($(`#tab-${id}`), false);
}

/* ------------------------------------------------------- shared renderers */

function levelBadge(level, noun) {
  const info = LEVEL[level] || LEVEL.medium;
  const text = noun ? `${level[0].toUpperCase()}${level.slice(1)} ${noun}` : info.label;
  return el('span', { class: `level lvl-${level}` }, icon(info.icon), text);
}

function sectionLabel(text, count, id) {
  return el('h2', { class: 'section-label', id },
    el('span', { text }),
    count === undefined ? null : el('span', { class: 'count', text: String(count) }));
}

function listCard(title, iconName, items, { ordered = false, empty = 'Nothing found.', note, cls = '' } = {}) {
  const list = items.length
    ? el(ordered ? 'ol' : 'ul', { class: 'clean-list' }, items.map((t) => el('li', { text: t })))
    : el('p', { class: 'empty', text: empty });
  return el('section', { class: `card list-card ${cls}` },
    el('h3', {}, el('span', { class: 'ico' }, icon(iconName)), title),
    note ? el('p', { class: 'note', text: note }) : null,
    list);
}

/** A quote with a visible (not colour-only) verification status and its location. */
function quoteBlock(quote, status, page, reference) {
  if (!quote) return null;
  const s = QUOTE_STATUS[status];
  return el('figure', { class: 'quote' },
    el('blockquote', { text: `“${quote}”` }),
    el('figcaption', {},
      status === 'verified' && page ? el('span', { class: 'cite page' }, icon('i-file'), `Page ${page}`) : null,
      reference ? el('span', { class: 'cite ref', text: reference }) : null,
      s ? el('span', { class: `cite ${s.cls}` }, icon(s.icon), s.text) : null));
}

function groundingCallout(g) {
  if (!g) return null;
  if (!g.sourceTextAvailable) {
    return el('div', { class: 'callout' }, icon('i-info'),
      el('p', { text: 'This file has no machine-readable text (image or scanned PDF), so quotes could not be checked automatically. Compare them with your original.' }));
  }
  return el('div', { class: `callout${g.quotesNotFound ? ' warn' : ''}` }, icon(g.quotesNotFound ? 'i-alert' : 'i-shield'),
    el('p', {},
      el('strong', { text: `${g.quotesVerified} of ${g.quotesChecked} quotes verified` }),
      ' — found word-for-word in your document.',
      g.quotesNotFound ? ` ${g.quotesNotFound} could not be found; treat those points with caution.` : ''));
}

/* --------------------------------------------------------------- analysis */

function renderClauses(clauses) {
  const wrap = el('div');
  const listEl = el('div', { class: 'clauses' });
  const draw = (filter) => {
    const shown = clauses.filter((c) => filter === 'all' || c.concern === filter);
    listEl.replaceChildren(...(shown.length ? shown.map((c) => el('article', { class: `clause ${c.concern}` },
      el('div', { class: 'clause-head' },
        el('h3', {}, c.heading, c.reference ? el('span', { class: 'ref', text: c.reference }) : null),
        levelBadge(c.concern)),
      quoteBlock(c.quote, c.quoteStatus, c.page),
      el('dl', { class: 'kv' },
        el('dt', { text: 'What it says' }), el('dd', { text: c.plainMeaning }),
        c.whyItMatters ? el('dt', { text: 'Why it may matter' }) : null,
        c.whyItMatters ? el('dd', {}, c.whyItMatters, el('span', { class: 'subtle small', text: ' (interpretation)' })) : null)))
      : [el('p', { class: 'empty', text: 'No clauses at this level.' })]));
    stagger(listEl.children);
  };
  const count = (f) => clauses.filter((c) => c.concern === f).length;
  const bar = el('div', { class: 'filters no-print', role: 'group', 'aria-label': 'Filter clauses by attention level' },
    ['all', 'high', 'medium', 'low'].map((f) => el('button', {
      type: 'button',
      class: 'filter',
      'aria-pressed': String(f === 'all'),
      onclick: (e) => {
        $$('button', bar).forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        draw(f);
      },
    }, f === 'all' ? null : el('span', { class: `dot ${f}`, 'aria-hidden': 'true' }),
    f === 'all' ? `All · ${clauses.length}` : `${LEVEL[f].label} · ${count(f)}`)));
  draw('all');
  wrap.append(bar, listEl);
  return wrap;
}

function concernGauge(cs) {
  const overall = OVERALL[cs.level] || OVERALL.none;
  const max = Math.max(1, cs.counts.high, cs.counts.medium, cs.counts.low);
  const bar = (lvl) => {
    const fill = el('span', { class: `fill lvl-${lvl}` });
    fill.style.setProperty('--w', `${Math.round((cs.counts[lvl] / max) * 100)}%`);
    return el('li', {},
      el('span', { text: LEVEL[lvl].label.replace(' attention', '') }),
      el('span', { class: 'track', 'aria-hidden': 'true' }, fill),
      el('span', { class: 'num', text: String(cs.counts[lvl]) }));
  };
  return el('section', { class: 'card gauge', 'aria-label': 'Clauses flagged by attention level' },
    el('div', { class: 'gauge-level' },
      el('span', { class: `lvl-icon lvl-${cs.level}` }, icon(overall.icon)),
      el('div', {},
        el('p', { class: 'gauge-title', text: overall.title }),
        el('p', { class: 'gauge-sub', text: overall.sub || (cs.level === 'high' ? LEVEL.high.hint : cs.level === 'medium' ? LEVEL.medium.hint : 'Still read the key clauses yourself.') }))),
    el('ul', { class: 'bars' }, bar('high'), bar('medium'), bar('low')),
    cs.excludedUnverified ? el('p', { class: 'fine' }, icon('i-alert'),
      `${cs.excludedUnverified} flagged clause(s) left out because their quote was not found in your document.`) : null,
    el('details', {},
      el('summary', { text: 'How is this worked out?' }),
      el('p', { text: cs.method })));
}

function renderAnalysis(a) {
  const root = $('#analysis-results');
  const cs = a.concernSummary;

  const overview = el('section', { class: 'overview', 'aria-labelledby': 'result-title' },
    el('div', { class: 'card overview-main' },
      el('div', { class: 'meta-row' },
        el('span', { class: 'tag brand' }, icon('i-file'), a.documentType),
        el('span', { class: 'tag' }, icon('i-globe'), `Governing law: ${a.governingLawStated}`),
        a.cached ? el('span', { class: 'tag' }, icon('i-clock'), 'Instant (cached)') : null),
      el('h2', { id: 'result-title', text: a.title }),
      el('p', { class: 'summary', text: a.plainSummary }),
      a.mainConcerns ? el('div', { class: 'callout warn' }, icon('i-flag'),
        el('p', {}, el('strong', { text: 'Worth a closer look: ' }), a.mainConcerns)) : null,
      groundingCallout(a.grounding),
      a.parties.length ? el('p', { class: 'fine' }, icon('i-users'),
        el('span', {}, el('strong', { text: 'Parties: ' }), a.parties.map((p) => `${p.name} — ${p.role}`).join('; '))) : null,
      el('p', { class: 'fine' }, icon('i-globe'),
        'LegalLens does not check the law of any country or state. Rules differ by place, so ask a lawyer where you live how they apply.'),
      el('div', { class: 'toolbar no-print' },
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => goAsk() }, icon('i-message'), 'Ask about this document'),
        el('button', { type: 'button', class: 'btn btn-sm btn-quiet', onclick: () => downloadReport(a) }, icon('i-download'), 'Download report'),
        el('button', { type: 'button', class: 'btn btn-sm btn-quiet', onclick: () => window.print() }, icon('i-print'), 'Print'))),
    concernGauge(cs));

  if (!a.isLegalDocument) {
    root.replaceChildren(overview);
    stagger(root.children);
    return;
  }

  const copyBtn = el('button', {
    type: 'button',
    class: 'btn btn-sm no-print',
    onclick: async (e) => {
      const btn = e.currentTarget;
      const label = $('.btn-label', btn);
      try {
        await navigator.clipboard.writeText(a.questionsForLawyer.map((q, i) => `${i + 1}. ${q}`).join('\n'));
        label.textContent = 'Copied';
      } catch {
        label.textContent = 'Copy failed';
      }
      setTimeout(() => { label.textContent = 'Copy questions'; }, 2000);
    },
  }, icon('i-copy'), el('span', { class: 'btn-label', text: 'Copy questions' }));
  const lawyerCard = listCard('Questions for your lawyer', 'i-briefcase', a.questionsForLawyer, { ordered: true, cls: 'lawyer-card' });
  if (a.questionsForLawyer.length) lawyerCard.append(el('div', { class: 'toolbar' }, copyBtn));

  const obligations = a.obligations.length
    ? el('ol', { class: 'obligations' }, a.obligations.map((o) => el('li', { class: 'obligation' },
      el('div', { class: 'when' },
        el('span', { class: 'd' }, icon('i-calendar'), o.deadline),
        el('span', { class: 'who', text: o.party })),
      el('div', {},
        el('p', { class: 'what', text: o.action }),
        quoteBlock(o.quote, o.quoteStatus, o.page)))))
    : el('p', { class: 'empty', text: 'No specific obligations or deadlines were found in the document.' });
  if (a.obligations.length) stagger(obligations.children);

  root.replaceChildren(
    overview,
    el('section', { 'aria-labelledby': 'sec-takeaways' },
      sectionLabel('Key takeaways', a.keyPoints.length, 'sec-takeaways'),
      a.keyPoints.length
        ? el('ul', { class: 'takeaways' }, a.keyPoints.map((t, i) => el('li', { class: 'takeaway' },
          el('span', { class: 'n', 'aria-hidden': 'true', text: String(i + 1).padStart(2, '0') }), el('span', { text: t }))))
        : el('p', { class: 'empty', text: 'No key facts were extracted.' })),
    el('section', { 'aria-labelledby': 'sec-clauses' },
      sectionLabel('Clauses to review', a.clauses.length, 'sec-clauses'),
      renderClauses(a.clauses)),
    el('section', { 'aria-labelledby': 'sec-deadlines' },
      sectionLabel('Deadlines & obligations', a.obligations.length, 'sec-deadlines'),
      obligations),
    el('section', { 'aria-labelledby': 'sec-lawyer' },
      sectionLabel('Questions for your lawyer', undefined, 'sec-lawyer'),
      el('div', { class: 'grid-2' },
        lawyerCard,
        listCard('Possible next steps', 'i-bulb', a.nextSteps, { ordered: true }))),
    el('section', { 'aria-labelledby': 'sec-gaps' },
      sectionLabel('Gaps to be aware of', undefined, 'sec-gaps'),
      el('div', { class: 'grid-2' },
        listCard('Unclear or missing terms', 'i-help', a.unclearOrMissing, { empty: 'Nothing obviously unclear was flagged.' }),
        listCard('Protections not mentioned', 'i-shield', a.missingProtections, {
          empty: 'Nothing obvious was flagged.',
          note: 'Things often found in this kind of document that this one does not mention.',
        }))),
    a.glossary.length ? el('section', { 'aria-labelledby': 'sec-glossary' },
      sectionLabel('Glossary', a.glossary.length, 'sec-glossary'),
      el('dl', { class: 'glossary' }, a.glossary.map((g) => el('div', {}, el('dt', { text: g.term }), el('dd', { text: g.meaning }))))) : null,
  );
  stagger(root.children);
}

/** Keep model text from breaking Markdown structure or becoming live HTML in a viewer. */
function md(text) {
  return String(text ?? '').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const QUOTE_MD = { verified: 'found in document', not_found: 'NOT found in document', unavailable: 'not checked' };

function locationText(reference, page) {
  return [reference, page ? `page ${page}` : ''].filter(Boolean).join(' · ');
}

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
  await withBusy($('#analyze-btn'), $('#analysis-status'), 'Analyzing…', async () => {
    const progress = createProgress($('#analysis-progress'), {
      title: 'Analyzing your document',
      hint: 'This usually takes 10–30 seconds',
      stages: ['Preparing your document', 'Reading and analyzing with Gemini', 'Checking every quote against your document'],
    });
    docInputs.main.setBusy(true);
    try {
      progress.step(0);
      const doc = await docInputs.main.payload('your document');
      progress.step(1);
      const analysis = await api('/api/analyze', { document: doc, ...prefs() });
      progress.step(2); // the server has verified the quotes; show it before revealing results
      state.analysisDoc = doc;
      state.analysis = analysis;
      setAskDocument(doc, docInputs.main.label || analysis.title);
      results.lang = prefs().language;
      renderAnalysis(analysis);
      await progress.finish();
      results.hidden = false;
      results.focus({ preventScroll: true });
      results.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } catch (err) {
      progress.fail();
      throw err;
    } finally {
      docInputs.main.setBusy(false);
    }
  });
}

/* -------------------------------------------------------------------- ask */

let selectTab;

function setAskDocument(doc, name) {
  state.askDoc = doc;
  state.askDocName = name;
  state.history = [];
  $('#chat-log').replaceChildren();
  $('#chat-empty').hidden = false;
  $('#ask-doc-label').replaceChildren(icon('i-file'), el('span', { text: 'Asking about' }), el('strong', { text: name }));
  renderSuggestions(DEFAULT_QUESTIONS);
}

function goAsk() {
  selectTab('ask');
  $('#workspace').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  $('#question').focus({ preventScroll: true });
}

function renderSuggestions(questions) {
  $('#suggestions').replaceChildren(...questions.map((q) => el('button', {
    type: 'button',
    class: 'chip',
    text: q,
    onclick: () => { $('#question').value = q; ask(); },
  })));
}

function aiAvatar() {
  return el('span', { class: 'avatar', 'aria-hidden': 'true' }, icon('mark'));
}

function renderAnswer(ans) {
  return el('li', { class: 'msg msg-ai', lang: prefs().language },
    aiAvatar(),
    el('div', { class: 'bubble' },
      el('span', { class: 'sr-only', text: 'LegalLens: ' }),
      el('p', { text: ans.answer }),
      ans.citations.map((c) => el('div', { class: 'citation' }, quoteBlock(c.quote, c.quoteStatus, c.page, c.reference))),
      ans.interpretationNote ? el('p', { class: 'msg-note' }, el('strong', { text: 'Interpretation: ' }), ans.interpretationNote) : null,
      ans.groundingWarning ? el('p', { class: 'msg-warn' }, icon('i-alert'), ans.groundingWarning) : null,
      el('div', { class: 'msg-meta' },
        ans.answeredFromDocument
          ? el('span', { class: 'tag brand' }, icon('i-file'), 'Answered from your document')
          : el('span', { class: 'tag' }, icon('i-help'), 'Not answered by the document'),
        el('span', { class: 'tag', text: `Confidence: ${ans.confidence}` }),
        ans.consultLawyer ? el('span', { class: 'tag lvl-medium' }, icon('i-briefcase'), 'Worth asking a lawyer') : null)));
}

function scrollChat() {
  const body = $('#chat-body');
  body.scrollTo({ top: body.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

let asking = false;

async function ask() {
  if (asking) return; // one question at a time (chips, Enter and the button all call this)
  const input = $('#question');
  const question = input.value.trim();
  const statusEl = $('#ask-status');
  if (!state.askDoc) {
    setStatus(statusEl, 'Please load a document first — analyze one in Understand, or use “Load a different document”.', { error: true });
    return;
  }
  if (question.length < 3) {
    setStatus(statusEl, 'Please type a question.', { error: true });
    input.focus();
    return;
  }
  const log = $('#chat-log');
  $('#chat-empty').hidden = true;
  const userMsg = el('li', { class: 'msg msg-user' }, el('span', { class: 'sr-only', text: 'You: ' }), question);
  const typing = el('li', { class: 'msg msg-ai' }, aiAvatar(),
    el('span', { class: 'typing' }, el('i'), el('i'), el('i'), el('span', { class: 'sr-only', text: 'LegalLens is reading your document…' })));
  log.append(userMsg, typing);
  scrollChat();
  input.value = '';
  autoGrow(input);
  asking = true;
  $$('#suggestions .chip').forEach((c) => { c.disabled = true; });
  try {
    await withBusy($('#ask-btn'), statusEl, '…', async () => {
      try {
        const ans = await api('/api/ask', { document: state.askDoc, question, history: state.history, ...prefs() });
        state.history.push({ role: 'user', text: question }, { role: 'assistant', text: ans.answer });
        typing.replaceWith(renderAnswer(ans));
        renderSuggestions(ans.followUpQuestions.length ? ans.followUpQuestions : DEFAULT_QUESTIONS);
        scrollChat();
      } catch (err) {
        typing.remove();
        userMsg.remove(); // keep the conversation consistent with what the server saw
        if (!log.children.length) $('#chat-empty').hidden = false;
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

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
}

/* ---------------------------------------------------------------- compare */

function renderComparison(c) {
  const favourNote = { neither: 'No clear difference in how favourable this is to you.', unclear: 'Which wording suits you better depends on your situation.' };
  const column = (side, text, quote, status, page, favoured) => el('div', { class: `diff-col${favoured ? ' favoured' : ''}` },
    el('p', { class: 'who' },
      el('span', { class: `slot-badge${side === 'B' ? ' b' : ''}`, 'aria-hidden': 'true', text: side }),
      `Document ${side}`,
      favoured ? el('span', { class: 'fav' }, icon('i-check-circle'), 'Appears more favourable to you') : null),
    el('p', { text }),
    quoteBlock(quote, status, page));

  const diffs = c.differences.length
    ? el('div', { class: 'diffs' }, c.differences.map((d) => el('article', { class: 'diff' },
      el('div', { class: 'diff-head' }, el('h3', { text: d.topic }), levelBadge(d.significance, 'significance')),
      el('div', { class: 'diff-cols' },
        column('A', d.documentA, d.quoteA, d.quoteAStatus, d.pageA, d.appearsMoreFavourable === 'A'),
        column('B', d.documentB, d.quoteB, d.quoteBStatus, d.pageB, d.appearsMoreFavourable === 'B')),
      el('div', { class: 'diff-foot' }, icon('i-bulb'),
        el('span', {}, d.explanation, favourNote[d.appearsMoreFavourable] ? ` ${favourNote[d.appearsMoreFavourable]}` : '')))))
    : el('p', { class: 'empty', text: 'No meaningful differences were found.' });
  if (c.differences.length) stagger(diffs.children);

  const root = $('#compare-results');
  root.replaceChildren(
    el('section', { class: 'card', 'aria-labelledby': 'compare-title' },
      el('div', { class: 'meta-row' },
        el('span', { class: 'tag brand' }, icon('i-columns'), 'Comparison'),
        c.cached ? el('span', { class: 'tag' }, icon('i-clock'), 'Instant (cached)') : null),
      el('h2', { id: 'compare-title', class: 'overview-title', text: 'How the two documents differ' }),
      el('p', { class: 'summary', text: c.summary }),
      groundingCallout(c.grounding),
      el('p', { class: 'fine' }, icon('i-info'),
        '“Appears more favourable to you” compares the wording of each single point only. It is not a legal judgement of which document is better overall.')),
    el('section', { 'aria-labelledby': 'sec-diffs' },
      sectionLabel('Key differences', c.differences.length, 'sec-diffs'),
      diffs),
    el('section', { 'aria-labelledby': 'sec-only' },
      sectionLabel('Only in one document', undefined, 'sec-only'),
      el('div', { class: 'grid-2' },
        listCard('Only in document A', 'i-file', c.onlyInA),
        listCard('Only in document B', 'i-file', c.onlyInB))),
    el('section', { 'aria-labelledby': 'sec-consider' },
      sectionLabel('Before you decide', undefined, 'sec-consider'),
      el('div', { class: 'grid-2' },
        listCard('Inconsistencies', 'i-alert', c.inconsistencies, { empty: 'No inconsistencies found.' }),
        listCard('Things to consider or clarify', 'i-bulb', c.thingsToConsider, { empty: 'Nothing specific flagged.' }))),
  );
  stagger(root.children);
}

async function compare() {
  const results = $('#compare-results');
  results.hidden = true;
  await withBusy($('#compare-btn'), $('#compare-status'), 'Comparing…', async () => {
    const progress = createProgress($('#compare-progress'), {
      title: 'Comparing your documents',
      hint: 'This usually takes 15–40 seconds',
      stages: ['Preparing both documents', 'Comparing them with Gemini', 'Checking quotes against each document'],
    });
    docInputs.A.setBusy(true);
    docInputs.B.setBusy(true);
    try {
      progress.step(0);
      const documentA = await docInputs.A.payload('document A');
      const documentB = await docInputs.B.payload('document B');
      progress.step(1);
      const comparison = await api('/api/compare', { documentA, documentB, ...prefs() });
      progress.step(2);
      renderComparison(comparison);
      results.lang = prefs().language;
      await progress.finish();
      results.hidden = false;
      results.focus({ preventScroll: true });
      results.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } catch (err) {
      progress.fail();
      throw err;
    } finally {
      docInputs.A.setBusy(false);
      docInputs.B.setBusy(false);
    }
  });
}

/* ------------------------------------------------------------------- init */

function setAIStatus(stateName, text) {
  const pill = $('#ai-status');
  pill.dataset.state = stateName;
  $('.status-text', pill).textContent = text;
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const select = $('#language');
    select.replaceChildren(...Object.entries(cfg.languages).map(([code, name]) => el('option', { value: code, text: name })));
    const browserLang = (navigator.language || 'en').slice(0, 2);
    if (cfg.languages[browserLang]) select.value = browserLang;
    $('#model-name').textContent = `(${cfg.model} via ${cfg.provider})`;
    if (cfg.aiReady) {
      setAIStatus('ready', 'AI ready');
    } else {
      setAIStatus('off', 'AI offline');
      const banner = $('#service-status');
      banner.replaceChildren(icon('i-alert'), el('span', { text: 'The AI service is not configured on this server yet, so analysis is unavailable.' }));
      banner.hidden = false;
    }
  } catch {
    setAIStatus('off', 'Status unknown'); // non-fatal: defaults remain usable
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
  const question = $('#question');
  question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  question.addEventListener('input', () => autoGrow(question));
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

  // Header gains a hairline border once the page scrolls.
  const header = $('#site-header');
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  loadConfig();
}

init();
