// A minimal, dependency-free sliding-window rate limiter — no `express-rate-limit`
// package, matching this codebase's established style of hand-rolling small
// utilities (see utils/queryHelpers.js's own ReDoS-safe regex/clamping helpers)
// rather than pulling in a library for something this small. Single-process,
// in-memory by design: this app runs as one Node process (no cluster/PM2
// multi-instance setup anywhere in this codebase), so a Map is a real,
// correct limiter here, not a false sense of security.
//
// Built specifically to close two real gaps found in a security audit:
// unbounded calls to /api/auth/forgot-password (email-bombing any address,
// and — combined with its deliberate distinct-404-for-unregistered-email
// response — enumerating which emails have accounts) and to
// /api/auth/reset-password (brute-forcing a 6-digit OTP faster than the
// per-account attempt counter alone would stop, since that counter only
// limits guesses against ONE already-issued OTP, not how fast new
// forgot-password calls can be fired to begin with).
const buckets = new Map();

// Periodic sweep so `buckets` doesn't grow unboundedly across a long-running
// process — timers are unref'd so they never keep the process alive on their
// own (same convention as mailer.js's own keepalive timer).
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === "function") sweepTimer.unref();

/**
 * @param {object} opts
 * @param {number} opts.windowMs - size of the sliding window in milliseconds
 * @param {number} opts.max - max requests allowed per key within the window
 * @param {(req) => string} [opts.keyFn] - defaults to IP address alone
 * @param {string} [opts.message]
 */
function createRateLimiter({ windowMs, max, keyFn, message }) {
  return function rateLimit(req, res, next) {
    const key = (keyFn ? keyFn(req) : req.ip) || "unknown";
    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        message: message || "Too many requests — please try again later",
      });
    }

    entry.count += 1;
    next();
  };
}

module.exports = { createRateLimiter };
