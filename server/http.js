"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

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

function acceptsGzip(req) {
  return /(?:^|,)\s*gzip\s*(?:;|,|$)/i.test(String(req?.headers?.["accept-encoding"] || ""));
}

function sendBuffer(req, res, code, buffer, headers) {
  const compressible=/^(?:text\/|application\/(?:json|javascript)|image\/svg\+xml)/i.test(String(headers["Content-Type"]||""));
  const gzip = compressible && buffer.length >= 1024 && acceptsGzip(req);
  res.writeHead(code, {
    ...headers,
    ...(compressible?{Vary:"Accept-Encoding"}:{}),
    ...(gzip ? { "Content-Encoding":"gzip" } : { "Content-Length":String(buffer.length) }),
  });
  if (req?.method === "HEAD") return res.end();
  if (gzip) {
    const stream=zlib.createGzip({ level:zlib.constants.Z_BEST_SPEED });
    stream.on("error",()=>res.destroy());
    stream.pipe(res);
    stream.end(buffer);
    return stream;
  }
  res.end(buffer);
}

function sendJson(res, code, value, req = res.req) {
  if (res.writableEnded) return;
  const buffer=Buffer.from(JSON.stringify(value));
  return sendBuffer(req,res,code,buffer,{
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

async function readJsonBody(req, limitBytes = 7_000_000) {
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
  const stat=fs.statSync(file),etag=`W/\"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}\"`;
  const cacheControl=relative==="index.html"?"no-cache":"public, max-age=0, must-revalidate";
  if(req.headers["if-none-match"]===etag){res.writeHead(304,{ETag:etag,"Cache-Control":cacheControl,Vary:"Accept-Encoding"});return res.end();}
  const buffer=fs.readFileSync(file);
  return sendBuffer(req,res,200,buffer,{"Content-Type":type,"Cache-Control":cacheControl,ETag:etag,"Last-Modified":stat.mtime.toUTCString()});
}

module.exports = { applySecurityHeaders, attachRequestContext, readJsonBody, sendJson, serveStatic, acceptsGzip };
