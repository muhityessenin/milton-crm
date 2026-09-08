"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { storageConfig } = require("../storage/config");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const files = fs.readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
  .sort();

async function main() {
  const config = storageConfig({ rootDir: ROOT });
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    application_name: `${config.applicationName}-migrate`,
  });
  const client = await pool.connect();
  const applied = [];
  const skipped = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('milton_crm_schema_migrations'))");
    for (const file of files) {
      const version = file.slice(0, 3);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      const hasTable = (await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present")).rows[0].present;
      if (hasTable) {
        const existing = await client.query("SELECT checksum_sha256 FROM public.schema_migrations WHERE version=$1", [version]);
        if (existing.rowCount) {
          const recorded = existing.rows[0].checksum_sha256;
          if (recorded && recorded !== checksum) throw new Error(`Migration ${version} checksum mismatch`);
          if (!recorded) await client.query("UPDATE public.schema_migrations SET checksum_sha256=$2 WHERE version=$1", [version, checksum]);
          skipped.push(version);
          continue;
        }
      }
      try {
        await client.query(sql);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      await client.query("UPDATE public.schema_migrations SET checksum_sha256=$2 WHERE version=$1", [version, checksum]);
      applied.push(version);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('milton_crm_schema_migrations'))").catch(() => {});
    client.release();
    await pool.end();
  }
  console.log(JSON.stringify({ migrations: files.length, applied, skipped }));
}

main().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
