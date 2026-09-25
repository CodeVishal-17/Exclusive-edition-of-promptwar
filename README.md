# ⚖️ LegalLens — legal documents, explained in plain language

**PromptWars: Virtual — AI for Legal Assistance & Access**

- **Live demo:** `<add your Render URL after deploying>`
- **Demo video:** `<add your video link>`

> LegalLens gives legal **information**, not legal advice. It helps people understand documents and prepare better
> questions for a qualified lawyer. It can make mistakes, so always check important points against the original.

## The problem

Rental agreements, job offers, legal notices and privacy policies are written for lawyers but signed by everyone
else. People often agree to one-sided terms, miss deadlines or can't tell what a notice asks of them, and many can't
easily get professional help.

## What LegalLens does

Upload a **PDF**, a **phone photo** of a notice, or **paste text**. LegalLens uses Google Gemini to explain the
document in one of 13 languages at a reading level you choose. It then **checks the AI's quotes against your
document** so you can see which statements are backed by the text.

| Workflow | What you get |
|---|---|
| **Understand** | A plain-language summary and the key facts. The important clauses, each with an **exact quote**, what it says, why it may matter (labelled as interpretation), and a concern level. Obligations and deadlines **stated in the document**, with the text that supports them. Unclear or missing terms, protections the document doesn't mention, possible next steps, questions to ask a lawyer (copy with one click), a glossary, and a Markdown or print export. |
| **Ask** | Q&A about your document. Answers cite exact passages, say plainly when **the document doesn't answer the question**, separate interpretation from what the text says, flag when to consult a lawyer, and suggest follow-up questions. Earlier questions in the conversation are sent as context. |
| **Compare** | Two offers, or an original and a revised draft. A table of differences quoting both documents, showing which wording **appears more favourable to you on each single point** (or "unclear"). Also lists terms found in only one document and inconsistencies between them. It never says which contract is "better" overall. |

### Quote verification

Every quote the model returns is checked **in code** (`src/grounding.js`) against the document's text:

- ✔ **Found in your document.** The quote appears word for word. Case, spacing and most punctuation are ignored, but punctuation that changes meaning still counts:
  - separators inside numbers, dates and times, so "1.5%" doesn't match "15%" and "01/10/2027" doesn't match "0110/2027";
  - sentence boundaries, so two sentences can't be merged into one claim.

  `...` is allowed only within a single sentence, over a short gap, and with parts of at least 8 characters. This stops fragments of different clauses being stitched into a new statement.
- ⚠ **NOT found.** Shown prominently. Treat that point with caution.
- ℹ **Could not be checked.** Used for images and scanned PDFs, which have no text layer. LegalLens does not run OCR.

**Page numbers** are computed from the PDF's text layer, never taken from the model. Clause numbers are shown only if
the model reports one printed in the document.

### Concern level (not a risk score)

The earlier 0–100 "risk score" used an arbitrary formula and has been removed. LegalLens now shows how many clauses
it flagged at each concern level. The overall level is **high** if any clause was flagged high, otherwise
**medium** if any was flagged medium, otherwise **low**. If nothing was flagged it shows **none**, with a note that
this doesn't mean the document is risk-free. Clauses whose quote **could not be found** in the document are left out
of the level and counted separately, so an invented clause can't drive the headline. The UI explains this rule and
says it is a reading aid, **not a legal risk assessment**. The per-clause levels are the model's judgement.

## GenAI architecture

| Aspect | Implementation |
|---|---|
| **Model / service** | **Gemini** via the Google Gen AI SDK (`@google/genai`) and the standard **Gemini API** (Google AI Studio, `generativelanguage.googleapis.com/v1beta`, `generateContent`), authenticated with `GEMINI_API_KEY`. The key is sent server-side in the `x-goog-api-key` header and never reaches the browser. Default model `gemini-3.6-flash` (override with `GEMINI_MODEL`). Vertex AI is supported as an optional alternative but is **not required**. |
| **Where Gemini is called** | Only in `src/gemini.js` → `createJsonGenerator()` → `client.models.generateContent()`. `src/legal-service.js` orchestrates the calls, and `server.js` wires in the real client. |
| **How documents are sent** | Pasted text and `.txt` files go in as text inside `<document>` tags (`src/prompts.js` → `documentParts`). PDFs and images go in as **multimodal `inlineData`** (base64), so Gemini reads the PDF or photo directly. PDFs are also parsed on the server with pdf.js, but only to validate them and to get text for quote checking. |
| **Prompt structure** | A **system instruction** with numbered rules: use only the document; quote exactly; never invent page numbers; separate facts from interpretation; give information, not advice; don't state what the law requires; treat everything inside `<document>` as untrusted data; point to lawyers or legal aid when stakes are high. Plus the language and reading level. The **user turn** contains the delimited document(s) and the task. For Ask, it also includes recent conversation history as a transcript and the question inside `<question>` tags. Any `<document>`/`<question>` tags inside user content are neutralised so they can't break out of the delimiters. |
| **Structured output** | Every call sets `responseMimeType: application/json` and `responseJsonSchema` (`src/schemas.js`: `ANALYSIS_SCHEMA`, `ANSWER_SCHEMA`, `COMPARISON_SCHEMA`). Each response is then **validated with Ajv**. If it doesn't match the schema it is retried once, then fails with a safe error. Finally it is normalised defensively and every quote is checked by `src/grounding.js`. |
| **Understand** | 1 Gemini call with `ANALYSIS_SCHEMA`. The result is cached in memory for 15 minutes, keyed by a SHA-256 hash of the document plus options. |
| **Ask** | 1 call per question with `ANSWER_SCHEMA`, including the last 8 turns. If `answeredFromDocument` is false, citations are dropped and the UI says "Not answered by the document". An answer without citations, or with citations that can't be found, gets a visible warning. |
| **Compare** | 1 call with `COMPARISON_SCHEMA`. Each document's quotes are checked against that document. Uses per-point wording (`appearsMoreFavourable: A \| B \| neither \| unclear`) and neutral "things to consider". |
| **Errors & unsupported questions** | See [Provider errors: overload vs quota](#provider-errors-overload-vs-quota). Temporary provider errors (500/502/503/504) and unreadable output are retried with bounded exponential backoff under an overall time limit. **429 quota errors are never retried automatically.** Safety blocks and output cut off at the token limit return 422. Credential or configuration errors (401/403/404, or 400 for an invalid key or unavailable model) return 503 without exposing details. Questions the document can't answer are reported as not answered rather than filled in from general knowledge. |

```
Browser (vanilla JS; all model text rendered with textContent)
  │  POST /api/analyze | /api/ask | /api/compare   (JSON; document as text or base64)
  ▼
Express (Docker host, e.g. Render): helmet CSP · rate limit · shape validation · file content inspection (pdf.js / image-size / UTF-8)
  │  system instruction + <document> data + JSON schema
  ▼
Gemini on Vertex AI ──► JSON ──► Ajv schema check (retry once) ──► normalise ──► quote verification + page lookup ──► UI
```

## Security & privacy

- **File uploads are checked by content, not just their declared type.** The MIME type must be on an allow-list, and the file-name extension must match it. The raw base64 length is checked before any decoding, which stops oversized payloads early. Base64 must be well-formed (valid characters, length a multiple of 4). Files are limited to 7 MB decoded and requests to 20 MB.
  - **PDF:** must start with the `%PDF-` signature and **parse successfully with pdf.js**. Font code execution is disabled (`isEvalSupported: false`). Encrypted or damaged PDFs and PDFs over 60 pages are rejected.
  - **Images:** the magic number (file signature) is checked and the header is **parsed with `image-size`**, which must report the same format as declared. Very high resolutions are rejected.
  - **Text:** must be strict UTF-8 with no NUL bytes.
  - These checks catch mislabelled and malformed files. They are **not** antivirus scanning or a guarantee that a file is harmless. Files are only ever parsed in memory, never written to disk, and no temporary files are created.
- **Storage.** Documents are never written to disk or kept in the browser. Analysis and comparison **results** (which can include short quotes) are cached **in server memory for up to 15 minutes** (`CACHE_TTL_MS`; set `CACHE_ENTRIES=0` to disable) so repeat requests don't call the model again. API responses send `Cache-Control: no-store`.
- **Logging.** Logs are structured JSON for Cloud Logging and contain metadata only: event, latency, cache hit, quote-check counts, error codes. A test (`never logs document text…`) checks that document text, questions and model output never reach the logs.
- **Prompt injection.** Documents are delimited and treated as untrusted data, and delimiter tags inside user content are neutralised. The model has no tools and can only return schema-shaped JSON.
- **Browser safety.** All model output is inserted with `textContent`, never `innerHTML`. This was tested with an injected `<img onerror>`/`<script>` payload, which rendered as plain text. There is a strict **CSP** (`default-src 'self'`, no inline scripts or styles, `frame-ancestors 'none'`) plus Helmet's other headers. No CORS headers are sent, so the API is same-origin only. The Markdown export escapes `<`, `>` and `|`.
- **Abuse limits.** Requests are rate-limited per IP (`RATE_LIMIT_PER_MINUTE`, default 20; this is in memory, per instance). Each model call has a time limit (`GEMINI_TIMEOUT_MS`, default 60 s) and so does each whole request (`GEMINI_TOTAL_TIMEOUT_MS`, default 110 s). Conversation history length is also limited. The per-IP limit does not protect the key's overall provider quota (see [Provider errors](#provider-errors-overload-vs-quota)).
- **Secrets.** There are none in code. On Vertex AI the service account is used. `/api/config` exposes only the model name, provider, languages and limits (tested). The container runs as a non-root user.

## Accessibility

- Semantic landmarks, a skip link, labelled inputs, ARIA tabs (arrow keys, Home and End), `aria-live` loading and result announcements, and focus moves to the results.
- Concern levels and quote status always use **icons and text as well as colour**.
- **Contrast:** all 32 text/background colour pairs in the light and dark themes were measured at ≥ 4.5:1 (lowest 5.72:1). This is a calculation over the design tokens, not a full WCAG audit.
- Buttons are at least 40 px tall, and chips and main buttons at least 44 px. Layout checked at 375 px wide with no horizontal scrolling (wide tables scroll inside their own container).
- The `lang` attribute is set on AI output so screen readers pronounce Hindi, Tamil and other languages correctly. Supports `prefers-reduced-motion`, dark mode and printing.

## Technology stack

Node.js (≥ 20.12; Docker image uses Node 24 LTS) · Express 5 · `@google/genai` · Ajv · unpdf (pdf.js) · image-size ·
helmet · express-rate-limit · compression · vanilla HTML/CSS/JS (no build step) · Node's built-in test runner + Supertest.

## Setup & local development

```bash
npm install
cp .env.example .env      # then set GEMINI_API_KEY (from https://aistudio.google.com/apikey)
npm run dev               # http://localhost:8080 (restarts on changes)
```

Without credentials the app still starts in development, shows a banner, and the AI endpoints return 503.
(Only if you use Vertex AI instead of a key: run `gcloud auth application-default login` first.)

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | **Required.** Gemini API key from Google AI Studio (no Google Cloud billing needed). Takes precedence over `GOOGLE_CLOUD_PROJECT`. |
| `GOOGLE_CLOUD_PROJECT` | — | Optional: GCP project for Vertex AI (used only when no API key is set) |
| `GOOGLE_CLOUD_LOCATION` | `global` | Optional: Vertex AI location |
| `GOOGLE_GENAI_USE_VERTEXAI` | auto | Force `true`/`false` |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Model ID (see Known limitations) |
| `GEMINI_TIMEOUT_MS` | `60000` | Time limit for one model call |
| `GEMINI_TOTAL_TIMEOUT_MS` | `110000` | Time limit for the whole request, including retries (kept below the browser's 150 s timeout) |
| `GEMINI_MAX_RETRIES` | `2` | Retries for temporary 500/502/503/504 errors and unreadable output only. 429 quota errors are never retried. |
| `RATE_LIMIT_PER_MINUTE` | `20` | Per-IP API limit |
| `CACHE_ENTRIES` / `CACHE_TTL_MS` | `100` / `900000` | Result cache size and lifetime (`0` entries disables it) |
| `PORT` | `8080` | HTTP port; the host sets it (Render uses 10000, Cloud Run 8080) |
| `TRUST_PROXY` | `1` | Number of proxy hops to trust (one for Render and Cloud Run) |

All of these are validated at startup. With `NODE_ENV=production` (set in the Docker image), the server **refuses to
start** if settings are invalid or credentials are missing.

## Tests

```bash
npm test            # unit + API tests, no network (mocked model)
npm run test:live   # REAL Gemini calls on the sample documents (uses your GEMINI_API_KEY quota)
```

`npm test` runs `scripts/run-tests.js`. It finds `test/*.test.js` explicitly and runs them one at a time, so it works
the same on Windows and Linux with Node 20 and 24, and fails if no test files are found. The tests cover:
- upload validation: signatures, damaged PDFs and images, page limits, base64 edge cases, size limits, extensions and UTF-8;
- quote verification and page lookup;
- schema validation and retries;
- all three workflows through HTTP, using **mock** model responses;
- provider errors: 429 classification (per-minute, daily, unknown), 500/503/504 retries, backoff limits, the overall time limit, `Retry-After`, and real-shaped Google error bodies through the real SDK with a stubbed network;
- live-check scheduling: `LIVE_DELAY_MS`, `LIVE_ONLY`, quota-based skipping and PASS/FAIL/INCONCLUSIVE classification;
- security headers, rate limiting, the 503 response when AI isn't configured, and checks that logs contain no document content, model output, keys or project IDs;
- config validation.

**The mock tests do not show that Gemini answers well. Only `npm run test:live` does.**

### Live Gemini test (`npm run test:live`)

It starts the real app in-process and sends real requests for six workflows, **one at a time**:

| id | Workflow |
|---|---|
| `understand-text` | Understand, pasted text |
| `understand-pdf` | Understand, PDF upload (checks page numbers) |
| `ask-present` | Ask, answer is in the document |
| `ask-absent` | Ask, answer is not in the document |
| `ask-followup` | Ask, follow-up question about a clause |
| `compare` | Compare, original vs revised agreement |

| Setting | Default | Purpose |
|---|---|---|
| `LIVE_DELAY_MS` | `0` | Pause between workflows, in milliseconds. On the free tier, use at least `60000 / your per-minute limit`, for example `20000`. |
| `LIVE_ONLY` | all | Comma-separated workflow ids, for example `ask-present,compare`, to re-run only what you need and save quota. |

Each workflow is reported as:

- **PASS**: HTTP 200, the response passed schema validation, and every expectation passed (for example, quotes found in the document).
- **FAIL**: the app itself went wrong: a failed expectation, an AI response that failed schema validation twice, rejected input, a configuration error, or a crash.
- **INCONCLUSIVE**: the provider couldn't serve the request (model overloaded, quota reached, timed out), or the workflow was skipped. This says nothing about whether LegalLens works; re-run it later.

The report also gives the number of **real Gemini calls** used (including automatic retries) and writes
`live-check-report.json` (git-ignored). The run exits with `0` = all PASS, `1` = any FAIL, `2` = configuration
error (no requests made), `3` = no failures but some INCONCLUSIVE.

The live test never works around quotas:
- A per-minute limit is retried **once**, only after the wait the provider suggests, and only if that wait is 120 s or less.
- An overloaded model is retried once after 30 s.
- After a **daily** quota error, the remaining workflows are skipped rather than spending more requests.

**Live-test status:** with `gemini-3.6-flash` on the free tier (19 Sept 2026), **all six workflows have passed at least
once, across separate runs** — for example `understand-pdf` with 15/15 quotes verified word-for-word, and `ask-absent`
correctly reporting that the document does not answer the question. No single run has had all six green: free-tier
per-minute limits and provider overloads (429/503) interrupt runs, which the report marks INCONCLUSIVE rather than
failed. Re-run with `LIVE_DELAY_MS` and `LIVE_ONLY` to confirm the set you need.

### Provider errors: overload vs quota

| Situation | Provider says | LegalLens does | User sees |
|---|---|---|---|
| **Temporary overload** | `503 UNAVAILABLE` ("high demand") | Retries up to `GEMINI_MAX_RETRIES` times with exponential backoff (about 2 s, then 6 s, with ±25 % jitter) while time remains | `503`: "The AI model is under heavy demand right now…" |
| Other temporary errors | `500`, `502`, `504` | Same bounded retries | `502` or `504` with a retry suggestion |
| **Per-minute quota** | `429 RESOURCE_EXHAUSTED`, a per-minute quota ID, usually a `retryDelay` | **No retry.** Passes on the provider's wait | `429` + `Retry-After: N`: "Please try again in about N seconds." |
| **Daily quota** | `429`, a per-day quota ID | **No retry** | `429`: "…reached its daily usage limit for this demo. Please try again tomorrow." |
| Unknown 429 | `429` without quota details | **No retry** | `429`: "…usage limit was reached. Please wait a minute…" |

`Retry-After` is sent only when the provider gave a valid wait between 1 and 3600 seconds. Error responses include a
machine-readable `code`, for example `overloaded`, `quota_minute`, `quota_daily` or `rate_limited`. Logs record the
status, code, quota IDs and suggested wait with keys, project IDs and e-mail addresses removed. They never record
document text, questions or model output.

**Free-tier limits.** The Gemini API free tier needs no billing account, but it has per-minute and per-day request
limits for each model. Google shows them in [AI Studio](https://aistudio.google.com/rate-limit) and they can change.
Each Understand, Ask or Compare action uses at least one request. The demo, the live test and any judges all share the
same key's quota, so pace testing with `LIVE_DELAY_MS`, and use `LIVE_ONLY` to avoid repeating workflows that
already passed. Free-tier inputs may be used by Google to improve its products, so use only fictional or
non-confidential documents.

## Deploy

LegalLens is a single Docker container that needs one secret, `GEMINI_API_KEY`. **No Google Cloud project, Vertex AI
or billing is required.** It reads `PORT` from the host and binds to `0.0.0.0`, exposes a `/health` check, and shuts
down cleanly on `SIGTERM`, so it runs on any Docker host.

### Render (free, recommended)

[`render.yaml`](render.yaml) defines the service: free plan, Docker runtime, `/health` health check, and
`GEMINI_API_KEY` as a secret you type in (it is never stored in the repository).

1. Push this repository to GitHub (public).
2. In Render: **New → Blueprint**, pick the repository, and paste your key when it asks for `GEMINI_API_KEY`.
   Without a Blueprint: **New → Web Service → Docker**, then set the same environment variables by hand.
3. Wait for the build, then check the service:

```bash
curl -s https://<your-service>.onrender.com/health      # {"status":"ok","aiReady":true}
```

4. Put the live URL at the top of this README.

Notes for the free plan:
- The service **sleeps after 15 minutes** without traffic and takes about a minute to wake. Open the URL before a demo or judging.
- One free-tier Gemini quota is shared by everyone who opens the link, so `render.yaml` sets `RATE_LIMIT_PER_MINUTE=6` and `GEMINI_MAX_RETRIES=1`.
- Render puts one proxy in front of the app, which matches the default `TRUST_PROXY=1` so per-visitor rate limiting sees real client IPs.

### Other Docker hosts

Any host that builds a Dockerfile and sets `PORT` works the same way; set `GEMINI_API_KEY` as a secret and point the
health check at `/health`. For **Cloud Run** (needs a billing account) you can either use the same key, or leave it
unset and use Vertex AI with `GOOGLE_CLOUD_PROJECT` plus the `roles/aiplatform.user` role on the service account.

## Known limitations

- **Model lifecycle:** the default is `gemini-3.6-flash`. The earlier default, `gemini-2.5-flash`, is no longer available to new Gemini API users: a live test returned `404` asking to use `gemini-3.6-flash`. For Gemini 3.x models LegalLens leaves the temperature at the model default (Google's guidance for Gemini 3); Gemini 2.x models get `0.2`. **Run `npm run test:live` after any model change.** It makes real calls and reports status, latency, schema validation and quote verification.
- **No OCR:** quotes from photos and scanned PDFs can't be checked automatically. They are clearly labelled as unchecked.
- **Quote matching** confirms that the quoted words appear in the document, not that the model's *interpretation* of them is correct. It has been tested on generated single-column PDFs and pasted text: 83/84 genuine quotes verified, and 0 of 9 meaning-changing edits were accepted. Real multi-column, hyphenated or low-quality PDFs may produce more "not found" results (a false negative, never a false "verified").
- **Ask** re-sends the document with every question (the app is stateless). Large PDFs make each question slower.
- **Rate limiting and caching are per instance and in memory.** Use Cloud Armor or Redis if you need them to be global.
- **No law is checked:** LegalLens explains the document only, not the law of any jurisdiction.

## Project structure

```
server.js                 entry: env validation, logger, Gemini client, graceful shutdown
src/app.js                Express app: security middleware, routes, error handling
src/config.js             config parsing and validation; public config
src/validate.js           request shape validation (base64, size, type, extension, text)
src/file-inspect.js       content checks: PDF (pdf.js), images (image-size), UTF-8 text
src/prompts.js            system instructions, delimiting, multimodal parts
src/schemas.js            JSON schemas for structured output
src/gemini.js             Google Gen AI SDK wrapper: retries, timeouts, error mapping
src/legal-service.js      Understand / Ask / Compare: Ajv validation, normalisation, concern summary, caching
src/grounding.js          quote verification and PDF page lookup
src/cache.js · logger.js · errors.js
public/                   accessible single-page UI (no framework)
Dockerfile · render.yaml  container image and free Render web service (Docker, /health, secret key)
scripts/run-tests.js      portable test runner
scripts/live-check.js     real Gemini checks (LIVE_DELAY_MS, LIVE_ONLY, PASS/FAIL/INCONCLUSIVE)
scripts/live-check-lib.js pure scheduling/classification logic for the live check (unit-tested)
test/                     unit and API tests (+ generated PDF/image fixtures)
```
