"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function attachRequestContext(req, res) {
  const incoming = String(req.headers["x-request-id"] || "").trim();
  const requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  applySecurityHeaders(res);
  return requestId;
}

function sendJson(res, code, value) {
  if (res.writableEnded) return;
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

async function readJsonBody(req, limitBytes = 2_000_000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > limitBytes) {
      const error = new Error("Слишком большой запрос");
      error.statusCode = 413;
      throw error;
    }
  }
  return raw ? JSON.parse(raw) : {};
}

function serveStatic(publicDir, req, res, url) {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const root = path.resolve(publicDir);
  const file = path.resolve(root, relative);
  if ((file !== root && !file.startsWith(`${root}${path.sep}`)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Не найдено");
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }).pipe(res);
}

module.exports = { applySecurityHeaders, attachRequestContext, readJsonBody, sendJson, serveStatic };
