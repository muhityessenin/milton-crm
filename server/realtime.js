"use strict";

const crypto = require("node:crypto");

const RESOURCE_RULES = [
  [/^\/api\/clients(?:\/|$)/, ["clients", "trials", "schedule", "notifications", "analytics"]],
  [/^\/api\/slots(?:\/|$)/, ["schedule"]],
  [/^\/api\/payments(?:\/|$)/, ["payments", "clients", "notifications", "analytics"]],
  [/^\/api\/notifications(?:\/|$)/, ["notifications"]],
  [/^\/api\/admin\/config(?:\/|$)/, ["references", "clients", "analytics"]],
  [/^\/api\/trials(?:\/|$)/, ["trials","clients","schedule","notifications","analytics"]],
  [/^\/api\/admin\/(?:branding|users|roles)(?:\/|$)/, ["settings", "users", "clients", "schedule"]],
  [/^\/api\/profile$/, ["profile", "users"]],
];

function resourcesForMutation(method, pathname) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return [];
  return RESOURCE_RULES.find(([pattern]) => pattern.test(pathname))?.[1] || ["bootstrap"];
}

class RealtimeHub {
  constructor({ heartbeatMillis = 20_000 } = {}) {
    this.clients = new Map();
    this.heartbeat = setInterval(() => this.keepAlive(), heartbeatMillis);
    this.heartbeat.unref?.();
  }

  connect(req, res, userId) {
    const id = crypto.randomUUID();
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: ready\ndata: ${JSON.stringify({ revision: Date.now() })}\n\n`);
    this.clients.set(id, { res, userId });
    const close = () => this.clients.delete(id);
    req.once("close", close); res.once("close", close);
  }

  publish(resources) {
    const payload = JSON.stringify({ resources: [...new Set(resources)], revision: Date.now() });
    for (const [id, client] of this.clients) {
      try { client.res.write(`event: invalidate\ndata: ${payload}\n\n`); }
      catch { this.clients.delete(id); }
    }
  }

  keepAlive() { for (const { res } of this.clients.values()) res.write(": heartbeat\n\n"); }
  close() { clearInterval(this.heartbeat); for (const { res } of this.clients.values()) res.end(); this.clients.clear(); }
}

module.exports = { RealtimeHub, resourcesForMutation };
