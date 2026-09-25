/**
 * Minimal structured logger. Cloud Run, Render and most hosts forward JSON lines on
 * stdout/stderr to their log viewers; Cloud Logging reads `severity` and `message`.
 * Callers must never pass document text, questions or model output here.
 */
export function createLogger({ write = (line, isError) => (isError ? process.stderr : process.stdout).write(`${line}\n`) } = {}) {
  const log = (severity) => (message, fields = {}) => {
    write(JSON.stringify({ severity, message, time: new Date().toISOString(), ...fields }), severity === 'ERROR' || severity === 'WARNING');
  };
  return { info: log('INFO'), warn: log('WARNING'), error: log('ERROR') };
}

export const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * Remove anything secret or identifying from provider error text before logging:
 * API keys, bearer tokens, project IDs/numbers, e-mail addresses and long numbers.
 */
export function redactForLog(text, maxLength = 300) {
  if (text === undefined || text === null) return undefined;
  return String(text)
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '<redacted-key>')
    .replace(/(key=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[\w.~+/-]+=*/gi, '$1<redacted>')
    .replace(/projects\/[^/\s"']+/gi, 'projects/<redacted>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<redacted-email>')
    .replace(/\b\d{6,}\b/g, '<n>')
    .slice(0, maxLength);
}
