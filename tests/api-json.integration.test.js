"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milton-json-api-"));
process.env.STORAGE_BACKEND = "json";
process.env.JSON_DB_FILE = path.join(directory, "db.json");
const { startServer, server, closeStorage } = require("../server");

test("full HTTP API preserves CRM behavior through JSON storage", async (t) => {
  await startServer(0);
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await closeStorage();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  async function call(method, pathname, payload) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const type = response.headers.get("content-type") || "";
    return { response, body: type.includes("application/json") ? await response.json() : await response.text() };
  }

  let result = await call("GET", "/api/health");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { status:"ok", storage:"json" });

  result = await call("POST", "/api/login", { login:"admin@milton.kz", password:"demo123" });
  assert.equal(result.response.status, 200); token = result.body.token;

  result = await call("GET", "/api/bootstrap");
  assert.equal(result.response.status, 200);
  const slot = result.body.dashboard ? (await call("GET", "/api/slots?closerId=usr_closer")).body.find((item) => item.status === "FREE") : null;
  assert.ok(slot);

  result = await call("POST", "/api/clients", {
    name:"API JSON Client", phone:"+7 701 555 44 33", managerId:"usr_manager",
    closerId:"usr_closer", slotId:slot.id, statusId:"st_scheduled", leadSourceId:"src_1", tagIds:["tag_1"],
  });
  assert.equal(result.response.status, 201); const clientId=result.body.id;

  result = await call("POST", `/api/clients/${clientId}/notes`, { text:"API storage note" });
  assert.equal(result.response.status, 201);
  result = await call("POST", `/api/clients/${clientId}/status`, { statusId:"st_payment", amount:50000, paymentMethodId:"method_1", paymentDate:"2026-09-02" });
  assert.equal(result.response.status, 200);

  result = await call("GET", `/api/clients/${clientId}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.notes.length, 1);
  assert.equal(result.body.payments.length, 1);
  const paymentId=result.body.payments[0].id;

  result = await call("POST", `/api/payments/${paymentId}/correct`, { amount:51000, paymentMethodId:"method_1", paymentDate:"2026-09-02", reason:"API test" });
  assert.equal(result.response.status, 201);
  result = await call("POST", `/api/clients/${clientId}/archive`, { reason:"TEST" });
  assert.equal(result.response.status, 200);
  result = await call("POST", `/api/clients/${clientId}/restore`, {});
  assert.equal(result.response.status, 200);

  result = await call("PUT", "/api/admin/branding", { companyName:"Milton", accentColor:"#3157D5", logoUrl:"" });
  assert.equal(result.response.status, 200);
  assert.equal((await call("GET", "/api/analytics?from=2026-09-01&to=2026-09-30")).response.status, 200);
  assert.equal((await call("GET", "/api/export/clients.csv?from=2026-09-01&to=2026-09-30")).response.status, 200);

  result = await call("DELETE", `/api/clients/${clientId}`, { confirmation:"УДАЛИТЬ" });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.hardDeleted, true);
  assert.equal((await call("GET", "/api/audit")).response.status, 200);
});
