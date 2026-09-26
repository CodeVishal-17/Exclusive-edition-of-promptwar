/**
 * Lightweight request guards for the AI endpoints (no new dependencies).
 *
 *  - originGuard: browsers always send an Origin header on cross-site POSTs. Requests
 *    from the page's own origin (or an explicitly allowed one) pass; any other browser
 *    origin, including the opaque "null" origin, is rejected before the body is read.
 *    Requests without an Origin header (curl, server-to-server, tests) are allowed:
 *    they cannot ride on a visitor's browser, and rate limits still apply to them.
 *
 *  - createConcurrencyGate: caps simultaneous AI requests per client IP and per instance,
 *    so one client cannot fan out many parallel Gemini calls or large uploads. Slots are
 *    released exactly once, when the handler finishes (success or error), when the
 *    response finishes, or by a backstop timer, so a slot can never leak.
 *
 * Neither guard logs IP addresses, headers or request content.
 */

/** Is `origin` the page's own origin (same Host) or explicitly allowed? */
export function isAllowedOrigin(origin, host, allowedOrigins = []) {
  if (typeof origin !== 'string' || origin === 'null') return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (host && url.host === host) return true;
  return allowedOrigins.includes(url.origin);
}

export function originGuard({ allowedOrigins = [], logger } = {}) {
  return function checkOrigin(req, res, next) {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    if (origin === undefined) return next();
    if (isAllowedOrigin(origin, req.get('host'), allowedOrigins)) return next();
    logger?.warn?.('Rejected cross-origin request', { event: 'origin_rejected', path: req.baseUrl + req.path });
    return res.status(403).json({ error: 'Requests from other websites are not allowed.', code: 'forbidden_origin' });
  };
}

export function createConcurrencyGate({ perClient = 2, total = 10, backstopMs = 180_000, logger } = {}) {
  const active = new Map(); // client key -> number of requests in progress
  let totalActive = 0;

  function gate(req, res, next) {
    if (req.method !== 'POST') return next();
    const key = req.ip || 'unknown';
    const current = active.get(key) || 0;
    const scope = current >= perClient ? 'client' : totalActive >= total ? 'instance' : null;
    if (scope) {
      logger?.warn?.('Rejected concurrent AI request', { event: 'concurrency_rejected', scope, path: req.baseUrl + req.path });
      res.set('Retry-After', '5');
      return res.status(429).json(scope === 'client'
        ? { error: 'You already have requests in progress. Please wait for them to finish, then try again.', code: 'too_many_concurrent' }
        : { error: 'LegalLens is busy right now. Please try again in a moment.', code: 'server_busy' });
    }

    active.set(key, current + 1);
    totalActive += 1;
    let released = false;
    const backstop = setTimeout(() => release(), backstopMs); // never hold a slot forever
    backstop.unref?.();
    function release() {
      if (released) return;
      released = true;
      clearTimeout(backstop);
      totalActive -= 1;
      const remaining = (active.get(key) || 1) - 1;
      if (remaining <= 0) active.delete(key);
      else active.set(key, remaining);
    }
    res.locals.releaseAiSlot = release;
    res.once('finish', release);
    return next();
  }

  gate.stats = () => ({ total: totalActive, clients: active.size });
  return gate;
}
