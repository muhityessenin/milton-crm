"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LoginRateLimiter, clientIp } = require("../server/login-rate-limit");

test("login limiter blocks repeated failures and resets after success", () => {
  const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMillis: 10_000 });
  assert.equal(limiter.recordFailure("ip:user", 1_000), 0);
  assert.equal(limiter.recordFailure("ip:user", 1_000), 10);
  assert.equal(limiter.retryAfterSeconds("ip:user", 5_000), 6);
  limiter.reset("ip:user");
  assert.equal(limiter.retryAfterSeconds("ip:user", 5_000), 0);
});

test("proxy address is trusted only when explicitly enabled", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.2" }, socket: { remoteAddress: "10.0.0.3" } };
  assert.equal(clientIp(req, false), "10.0.0.3");
  assert.equal(clientIp(req, true), "203.0.113.10");
});
