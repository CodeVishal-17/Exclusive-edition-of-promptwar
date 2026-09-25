/**
 * Request shape validation. Every function either returns a normalised value
 * or throws a ValidationError (mapped to HTTP 400 by the app).
 * File *content* checks live in file-inspect.js.
 */
import { FILE_TYPES, LANGUAGES, LIMITS, READING_LEVELS } from './config.js';
import { ValidationError } from './errors.js';
import { decodeUtf8Text } from './file-inspect.js';

export { ValidationError };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL_PREFIX_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,/;
// Largest base64 string that can decode to maxFileBytes (plus room for a data-URL prefix and line breaks).
const MAX_BASE64_CHARS = Math.ceil(LIMITS.maxFileBytes / 3) * 4;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strip control characters (keeps tabs/newlines) and trim. */
export function cleanText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function cleanFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  const cleaned = cleanText(base).replace(/[^\p{L}\p{N}._\- ()]/gu, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'document';
}

/** Exact decoded byte length of a canonical base64 string. */
export function base64ByteLength(b64) {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

function extensionOf(name) {
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(name ?? '');
  return match ? match[0].toLowerCase() : '';
}

function validateText(rawText, label, name) {
  const text = cleanText(rawText);
  if (text.length < LIMITS.minTextChars) {
    throw new ValidationError(`The ${label} text is too short to analyse (minimum ${LIMITS.minTextChars} characters).`);
  }
  if (text.length > LIMITS.maxTextChars) {
    throw new ValidationError(`The ${label} text is too long (maximum ${LIMITS.maxTextChars.toLocaleString('en-US')} characters).`);
  }
  return { kind: 'text', text, name: cleanFileName(name || 'Pasted text') };
}

/**
 * A document is either pasted text or an uploaded file (PDF / image / .txt).
 * @returns {{kind:'text', text:string, name:string} | {kind:'file', data:string, mimeType:string, name:string}}
 */
export function validateDocument(input, label = 'document') {
  if (!isPlainObject(input)) {
    throw new ValidationError(`The ${label} is missing. Paste text or upload a file.`);
  }
  const hasText = typeof input.text === 'string' && input.text.trim().length > 0;
  const hasFile = isPlainObject(input.file);

  if (hasText && hasFile) {
    throw new ValidationError(`Provide either pasted text or one file for the ${label}, not both.`);
  }
  if (!hasText && !hasFile) {
    throw new ValidationError(`The ${label} is empty. Paste text or upload a file.`);
  }
  if (hasText) return validateText(input.text, label, input.name);

  const { data, mimeType, name } = input.file;
  if (typeof mimeType !== 'string' || !Object.hasOwn(FILE_TYPES, mimeType)) {
    throw new ValidationError(`Unsupported file type for the ${label}. Use PDF, PNG, JPEG, WEBP or TXT.`);
  }
  if (name !== undefined && typeof name !== 'string') {
    throw new ValidationError(`Invalid file name for the ${label}.`);
  }
  const ext = extensionOf(name);
  if (ext && !FILE_TYPES[mimeType].includes(ext)) {
    throw new ValidationError(`The ${label} file name "${cleanFileName(name)}" does not match its type (${mimeType}).`);
  }
  if (typeof data !== 'string' || data.length === 0) {
    throw new ValidationError(`The ${label} file is empty.`);
  }
  // Cheap length guard before any regex/decoding work on a large string.
  if (data.length > MAX_BASE64_CHARS + 256 + Math.ceil(MAX_BASE64_CHARS / 64) * 2) {
    throw new ValidationError(`The ${label} file is too large (maximum ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} MB).`);
  }

  const prefix = DATA_URL_PREFIX_RE.exec(data);
  if (prefix && prefix[1] !== mimeType) {
    throw new ValidationError(`The ${label} file type is inconsistent.`);
  }
  const b64 = (prefix ? data.slice(prefix[0].length) : data).replace(/[\r\n ]/g, '');
  if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new ValidationError(`The ${label} file could not be read (invalid encoding).`);
  }
  const bytes = base64ByteLength(b64);
  if (bytes > LIMITS.maxFileBytes) {
    throw new ValidationError(`The ${label} file is too large (maximum ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} MB).`);
  }
  if (bytes === 0) throw new ValidationError(`The ${label} file is empty.`);

  if (mimeType === 'text/plain') {
    // Decode strictly so binary files labelled as text are rejected, then use the text path.
    return validateText(decodeUtf8Text(Buffer.from(b64, 'base64'), label), label, name);
  }
  return { kind: 'file', data: b64, mimeType, name: cleanFileName(name || 'document') };
}

export function validateLanguage(code) {
  if (code === undefined || code === null || code === '') return 'en';
  if (typeof code !== 'string' || !Object.hasOwn(LANGUAGES, code)) {
    throw new ValidationError('Unsupported language.');
  }
  return code;
}

export function validateReadingLevel(level) {
  if (level === undefined || level === null || level === '') return 'standard';
  if (typeof level !== 'string' || !Object.hasOwn(READING_LEVELS, level)) {
    throw new ValidationError('Unsupported reading level.');
  }
  return level;
}

export function validateQuestion(question) {
  if (typeof question !== 'string') throw new ValidationError('Please type a question.');
  const q = cleanText(question);
  if (q.length < 3) throw new ValidationError('Your question is too short.');
  if (q.length > LIMITS.maxQuestionChars) {
    throw new ValidationError(`Your question is too long (maximum ${LIMITS.maxQuestionChars} characters).`);
  }
  return q;
}

/** Conversation history: [{role:'user'|'assistant', text}] — trimmed to the most recent turns. */
export function validateHistory(history) {
  if (history === undefined || history === null) return [];
  if (!Array.isArray(history)) throw new ValidationError('Invalid conversation history.');
  return history
    .slice(-LIMITS.maxHistoryTurns)
    .filter((turn) => isPlainObject(turn) && typeof turn.text === 'string')
    .map((turn) => ({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      text: cleanText(turn.text).slice(0, LIMITS.maxHistoryChars),
    }))
    .filter((turn) => turn.text.length > 0);
}

export function validateOptions(body) {
  return {
    language: validateLanguage(body?.language),
    readingLevel: validateReadingLevel(body?.readingLevel),
  };
}
