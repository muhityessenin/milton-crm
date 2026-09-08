"use strict";

const { storageConfig } = require("./config");
const { JsonStorage } = require("./json-storage");
const { PostgresStorage } = require("./postgres/storage");

async function createStorage(options = {}) {
  const config = options.config || storageConfig(options);
  if (config.backend === "postgres") {
    const storage = PostgresStorage.connect(config.databaseUrl, { ssl: config.ssl, ...options.postgres });
    await storage.assertSchema();
    return storage;
  }
  if (!options.json) throw new Error("JSON storage options are required for the JSON backend");
  const storage = new JsonStorage(options.json);
  storage.load();
  return storage;
}

module.exports = { createStorage, storageConfig, JsonStorage, PostgresStorage };
