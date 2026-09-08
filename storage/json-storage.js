"use strict";

const fs = require("node:fs");

class JsonCollectionRepository {
  constructor(storage, collection) {
    this.storage = storage;
    this.collection = collection;
  }

  rows() {
    const rows = this.storage.state[this.collection];
    if (!Array.isArray(rows)) throw new Error(`JSON collection is unavailable: ${this.collection}`);
    return rows;
  }

  all() { return this.rows(); }
  findById(id) { return this.rows().find((row) => row.id === id) || null; }
  find(predicate) { return this.rows().find(predicate) || null; }
  filter(predicate) { return this.rows().filter(predicate); }
  insert(value) { this.rows().push(value); return value; }
  update(id, changes) {
    const target = this.findById(id);
    if (!target) return null;
    Object.assign(target, changes);
    return target;
  }
  removeWhere(predicate) {
    const before = this.rows().length;
    this.storage.state[this.collection] = this.rows().filter((row) => !predicate(row));
    return before - this.storage.state[this.collection].length;
  }
}

class MemorySessionRepository {
  constructor() { this.tokens = new Map(); }
  set(token, userId) { this.tokens.set(token, userId); }
  get(token) { return this.tokens.get(token); }
  getUserId(token) { return this.tokens.get(token) || null; }
  createToken(token, userId) { this.tokens.set(token, userId); return token; }
  delete(token) { return this.tokens.delete(token); }
  deleteByUserId(userId) {
    for (const [token, storedUserId] of this.tokens) if (storedUserId === userId) this.tokens.delete(token);
  }
  clear() { this.tokens.clear(); }
  [Symbol.iterator]() { return this.tokens[Symbol.iterator](); }
}

class JsonSettingsRepository {
  constructor(storage) { this.storage = storage; }
  get() { return this.storage.state.meta; }
  update(changes) { Object.assign(this.storage.state.meta, changes); return this.storage.state.meta; }
}

class JsonPermissionsRepository {
  constructor(catalog = {}) { this.catalog = catalog; }
  all() {
    return Object.entries(this.catalog).flatMap(([module, actions]) =>
      actions.map((action) => ({ key: `${module}.${action}`, module, action }))
    );
  }
  list() { return this.all(); }
}

class JsonStorage {
  constructor({ filePath, seed, migrate, permissionCatalog = {} }) {
    this.filePath = filePath;
    this.seed = seed;
    this.migrate = migrate;
    this.permissionCatalog = permissionCatalog;
    this.state = null;
    this.sessions = new MemorySessionRepository();
    this.queue = Promise.resolve();
  }

  load() {
    fs.mkdirSync(require("node:path").dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(this.seed(), null, 2));
    }
    const loaded = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    loaded.paymentCorrections ||= [];
    if (this.migrate?.(loaded)) fs.writeFileSync(this.filePath, JSON.stringify(loaded, null, 2));
    this.state = loaded;
    this.bindRepositories();
    return this.state;
  }

  bindRepositories() {
    const collections = {
      users: "users", roles: "roles", clients: "clients", trials: "trials",
      availabilitySlots: "availabilitySlots", payments: "payments", statuses: "statuses",
      leadSources: "leadSources", tags: "tags", refusalReasons: "refusalReasons",
      paymentMethods: "paymentMethods", notes: "notes", history: "history",
      notifications: "notifications", auditLogs: "auditLogs", savedFilters: "savedFilters",
    };
    for (const [property, collection] of Object.entries(collections)) {
      this[property] = new JsonCollectionRepository(this, collection);
    }
    this.settings = new JsonSettingsRepository(this);
    this.permissions = new JsonPermissionsRepository(this.permissionCatalog);
  }

  replaceState(next) {
    this.state = next;
    this.bindRepositories();
  }

  save() {
    if (!this.state) throw new Error("JSON storage has not been loaded");
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  async runState(work) {
    const execute = async () => {
      const result = await work(this.state, this);
      if (result?.dirty) this.save();
      return result;
    };
    const pending = this.queue.then(execute, execute);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async close() {}
}

module.exports = { JsonStorage, JsonCollectionRepository, JsonPermissionsRepository, MemorySessionRepository };
