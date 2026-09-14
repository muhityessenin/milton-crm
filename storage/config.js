"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadLocalEnv(rootDir = path.resolve(__dirname, "..")) {
  const file = path.join(rootDir, ".env");
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function storageConfig(options = {}) {
  if (options.loadEnv !== false) loadLocalEnv(options.rootDir);
  const backend = String(process.env.STORAGE_BACKEND || "json").toLowerCase();
  if (!['json', 'postgres'].includes(backend)) {
    throw new Error(`Unsupported STORAGE_BACKEND: ${backend}`);
  }
  const positiveInteger = (name, fallback) => {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const nonNegativeInteger = (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  let databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl && process.env.PGHOST) {
    const url = new URL("postgresql://localhost");
    url.hostname = process.env.PGHOST;
    url.port = process.env.PGPORT || "5432";
    url.pathname = `/${process.env.PGDATABASE || "postgres"}`;
    url.username = process.env.PGUSER || "postgres";
    url.password = process.env.PGPASSWORD || "";
    databaseUrl = url.toString();
  }
  return {
    backend,
    databaseUrl,
    ssl: String(process.env.PG_SSL || "require").toLowerCase() !== "disable",
    poolMax: positiveInteger("PG_POOL_MAX", 10),
    connectionTimeoutMillis: positiveInteger("PG_POOL_CONNECTION_TIMEOUT_MS", 30000),
    idleTimeoutMillis: positiveInteger("PG_POOL_IDLE_TIMEOUT_MS", 30000),
    queryTimeoutMillis: positiveInteger("PG_QUERY_TIMEOUT_MS", 60000),
    applicationName: process.env.PG_APPLICATION_NAME || "milton-crm",
    stateCacheTtlMillis: nonNegativeInteger("PG_STATE_CACHE_TTL_MS", 5000),
  };
}

module.exports = { loadLocalEnv, storageConfig };
