/** Error types that map to specific HTTP responses with user-safe messages. */

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export class AIServiceError extends Error {
  /**
   * @param {string} message  user-safe message (shown in the UI)
   * @param {object} [options]
   * @param {number} [options.status=502]  HTTP status returned to the browser
   * @param {Error}  [options.cause]  original error (never sent to the browser)
   * @param {string} [options.code='ai_error']  machine-readable reason
   * @param {number|null} [options.retryAfterSeconds]  provider-suggested wait, if known and valid
   * @param {object|null} [options.upstream]  sanitised provider error details, for logs only
   * @param {number} [options.attempts]  model calls made for this request
   */
  constructor(message, { status = 502, cause, code = 'ai_error', retryAfterSeconds = null, upstream = null, attempts } = {}) {
    super(message, { cause });
    this.name = 'AIServiceError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.upstream = upstream;
    this.attempts = attempts;
  }
}
