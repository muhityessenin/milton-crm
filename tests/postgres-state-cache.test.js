"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PostgresStorage } = require("../storage/postgres/storage");

test("PostgreSQL read model cache coalesces concurrent reads and invalidates explicitly", async () => {
  const storage = new PostgresStorage({
    pool: null,
    db: {},
    ownsPool: false,
    stateCacheTtlMillis: 1_000,
  });
  let loads = 0;
  storage.state = {
    async load() {
      loads += 1;
      return { clients: [{ id: "client-1" }] };
    },
  };

  const read = () => storage.runState(async (state) => ({ clients: state.clients.length }), { readOnly: true });
  const burst = await Promise.all(Array.from({ length: 50 }, read));
  assert.equal(burst.length, 50);
  assert.ok(burst.every((result) => result.clients === 1));
  assert.equal(loads, 1);

  storage.invalidateStateCache();
  assert.deepEqual(await read(), { clients: 1 });
  assert.equal(loads, 2);
});
