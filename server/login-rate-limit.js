"use strict";

class LoginRateLimiter {
  constructor({ maxAttempts = 10, windowMillis = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMillis = windowMillis;
    this.entries = new Map();
  }

  retryAfterSeconds(key, currentTime = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= currentTime) {
      if (entry) this.entries.delete(key);
      return 0;
    }
    return entry.attempts >= this.maxAttempts ? Math.ceil((entry.expiresAt - currentTime) / 1000) : 0;
  }

  recordFailure(key, currentTime = Date.now()) {
    const current = this.entries.get(key);
    const entry = !current || current.expiresAt <= currentTime
      ? { attempts: 0, expiresAt: currentTime + this.windowMillis }
      : current;
    entry.attempts += 1;
    this.entries.set(key, entry);
    if (this.entries.size > 10_000) this.prune(currentTime);
    return this.retryAfterSeconds(key, currentTime);
  }

  reset(key) { this.entries.delete(key); }

  prune(currentTime = Date.now()) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= currentTime) this.entries.delete(key);
  }
}

function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || "unknown";
}

module.exports = { LoginRateLimiter, clientIp };
