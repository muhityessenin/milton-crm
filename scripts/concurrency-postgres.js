"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { storageConfig } = require("../storage/config");

process.env.STORAGE_BACKEND = "postgres";

const app = require("../server");
const levels = [5, 10, 25, 50];
const runId = `${String(Date.now()).slice(-7)}${crypto.randomBytes(2).toString("hex")}`;
const marker = `LOAD-${runId}`;
const password = "demo123";
const managerLogins = Array.from({ length: 5 }, (_, i) => `load.${runId}.manager${i}@milton.local`);
const closerLogin = `load.${runId}.closer@milton.local`;
const managerIds = managerLogins.map((_, i) => `load_${runId}_manager_${i}`);
const closerId = `load_${runId}_closer`;
const tempUserIds = [...managerIds, closerId];
const tokenHashes = [];
const trackedClientIds = new Set();
const metrics = [];
const report = { runId, pool: null, lockModel: null, races: {}, levels: [], database: {}, cleanup: null };
let base = "";
let serverStarted = false;
let controlPool;
let phoneSequence = Number(String(Date.now()).slice(-6));

const percentile = (values, p) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : 0;
const summarize = (rows) => {
  const times = rows.map((row) => row.ms);
  const statuses = {};
  for (const row of rows) statuses[row.status || row.errorCode || "NETWORK"] = (statuses[row.status || row.errorCode || "NETWORK"] || 0) + 1;
  return {
    requests: rows.length,
    successful: rows.filter((row) => row.status >= 200 && row.status < 300).length,
    failed: rows.filter((row) => !(row.status >= 200 && row.status < 300)).length,
    averageMs: Number((times.reduce((sum, value) => sum + value, 0) / Math.max(1, times.length)).toFixed(1)),
    p95Ms: Number(percentile(times, 0.95).toFixed(1)),
    worstMs: Number(Math.max(0, ...times).toFixed(1)),
    statuses,
  };
};

async function request(label, token, method, pathname, payload, extraHeaders = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const type = response.headers.get("content-type") || "";
    const body = type.includes("application/json") ? await response.json() : await response.text();
    const row = { label, status: response.status, ms: performance.now() - started, body };
    metrics.push(row);
    return row;
  } catch (error) {
    const row = { label, status: 0, errorCode: error.code || error.cause?.code || error.name, ms: performance.now() - started, body: null };
    metrics.push(row);
    return row;
  }
}

function expect(row, statuses, message) {
  if (!statuses.includes(row.status)) throw new Error(`${message}: HTTP ${row.status} ${JSON.stringify(row.body)}`);
  return row.body;
}

async function login(loginValue) {
  const row = await request("login", "", "POST", "/api/login", { login: loginValue, password });
  const body = expect(row, [200], `Login failed for temporary account`);
  tokenHashes.push(crypto.createHash("sha256").update(body.token).digest("hex"));
  return body.token;
}

async function startServer() {
  await app.startServer(0);
  serverStarted = true;
  base = `http://127.0.0.1:${app.server.address().port}`;
}

async function stopServer() {
  if (serverStarted && app.server.listening) await new Promise((resolve) => app.server.close(resolve));
  serverStarted = false;
}

async function setup() {
  const config = storageConfig();
  controlPool = new Pool({ connectionString: config.databaseUrl, ssl: config.ssl ? { rejectUnauthorized: false } : false, max: 3, connectionTimeoutMillis: 10000, application_name: `milton-load-control-${runId}` });
  controlPool.on("error", (error) => {
    report.database.controlPoolErrors ||= [];
    report.database.controlPoolErrors.push({ code: error.code || "PG_POOL_ERROR", at: new Date().toISOString() });
  });
  const client = await controlPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('milton_crm_load_setup'))");
    const business = (await client.query("SELECT (SELECT count(*)::int FROM clients) clients,(SELECT count(*)::int FROM trials) trials,(SELECT count(*)::int FROM payments) payments")).rows[0];
    if (business.clients || business.trials || business.payments) throw new Error(`Load test requires empty business tables; found ${JSON.stringify(business)}`);
    report.database.baselineConfiguration=(await client.query("SELECT (SELECT count(*)::int FROM availability_slots) slots,(SELECT count(*)::int FROM users WHERE NOT is_owner) employees,(SELECT count(*)::int FROM sessions) sessions,(SELECT count(*)::int FROM users WHERE is_owner) owners")).rows[0];
    const owner = (await client.query("SELECT password_hash FROM users WHERE id='usr_admin' AND is_owner AND active")).rows[0];
    if (!owner) throw new Error("Active seeded Owner usr_admin was not found");
    for (let i = 0; i < managerIds.length; i += 1) {
      await client.query("INSERT INTO users(id,name,login,password_hash,role_id,business_role,is_owner,active) VALUES($1,$2,$3,$4,'role_manager','MANAGER',false,true)", [managerIds[i], `${marker} Manager ${i + 1}`, managerLogins[i], owner.password_hash]);
    }
    await client.query("INSERT INTO users(id,name,login,password_hash,role_id,business_role,is_owner,active) VALUES($1,$2,$3,$4,'role_closer','CLOSER',false,true)", [closerId, `${marker} Closer`, closerLogin, owner.password_hash]);
    const start = new Date("2031-01-01T04:00:00.000Z");
    for (let i = 0; i < 120; i += 1) {
      const startAt = new Date(start.getTime() + i * 3600000).toISOString();
      const endAt = new Date(start.getTime() + (i + 1) * 3600000).toISOString();
      await client.query("INSERT INTO availability_slots(id,closer_id,start_at,end_at,status) VALUES($1,$2,$3,$4,'FREE')", [`load_${runId}_slot_${i}`, closerId, startAt, endAt]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const slotId = (index) => `load_${runId}_slot_${index}`;
const nextPhone = () => `+7777${String((phoneSequence += 1) % 10000000).padStart(7, "0")}`;
const clientPayload = (name, slot, phone = nextPhone()) => ({ name: `${marker} ${name}`, phone, closerId, slotId: slot, statusId: "st_scheduled", leadSourceId: "src_1", tagIds: ["tag_1"], comment: marker, trialType:"FREE" });

async function deleteTempClients() {
  const client = await controlPool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query("SELECT id FROM clients WHERE registration_comment=$1 FOR UPDATE", [marker]);
    for (const row of rows.rows) await client.query("SELECT permanently_delete_client($1,'usr_admin','УДАЛИТЬ')", [row.id]);
    await client.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::text[]) OR new_value::text LIKE $2", [[...trackedClientIds], `%${marker}%`]);
    await client.query("COMMIT");
    trackedClientIds.clear();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function createClient(token, name, slot, phone) {
  const row = await request("create-client", token, "POST", "/api/clients", clientPayload(name, slot, phone));
  if (row.status === 201 && row.body?.id) trackedClientIds.add(row.body.id);
  return row;
}

async function consistencySnapshot() {
  const result = await controlPool.query(`
    SELECT
      (SELECT count(*)::int FROM (SELECT normalized_phone FROM clients GROUP BY normalized_phone HAVING count(*)>1) x) duplicate_phones,
      (SELECT count(*)::int FROM (SELECT slot_id FROM trials WHERE active GROUP BY slot_id HAVING count(*)>1) x) double_booked_slots,
      (SELECT count(*)::int FROM (SELECT client_id FROM trials WHERE active GROUP BY client_id HAVING count(*)>1) x) multiple_active_trials,
      (SELECT count(*)::int FROM trials t JOIN availability_slots s ON s.id=t.slot_id WHERE t.active AND (s.status<>'BOOKED' OR s.booked_trial_id<>t.id)) slot_mismatches,
      (SELECT count(*)::int FROM availability_slots s WHERE s.status='BOOKED' AND NOT EXISTS(SELECT 1 FROM trials t WHERE t.id=s.booked_trial_id AND t.active)) orphan_bookings
  `);
  return result.rows[0];
}

async function monitorLocks(stopSignal) {
  const samples = { samples: 0, lockWaitSamples: 0, advisoryWaitSamples: 0, maxWaiting: 0, errors: [] };
  while (!stopSignal.done) {
    try {
      const result = await controlPool.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type IS NOT NULL");
      const waiting = result.rows.filter((row) => row.wait_event_type === "Lock");
      samples.samples += 1;
      samples.lockWaitSamples += waiting.length;
      samples.advisoryWaitSamples += waiting.filter((row) => row.wait_event === "advisory").length;
      samples.maxWaiting = Math.max(samples.maxWaiting, waiting.length);
    } catch (error) { samples.errors.push(error.code || error.message); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return samples;
}

async function runRaceTests(tokens) {
  const { managers, closers, owners } = tokens;
  let rows = await Promise.all(Array.from({ length: 5 }, (_, i) => createClient(managers[i], `unique-${i}`, slotId(i), nextPhone())));
  report.races.concurrentUniqueClients = { ...summarize(rows), expected: "5 created" };
  if (rows.some((row) => row.status !== 201)) throw new Error("Concurrent unique client creation failed");
  await deleteTempClients();

  const duplicatePhone = nextPhone();
  rows = await Promise.all(Array.from({ length: 5 }, (_, i) => createClient(managers[i], `duplicate-${i}`, slotId(10 + i), duplicatePhone)));
  report.races.duplicatePhone = { ...summarize(rows), expected: "1 created, 4 rejected" };
  if (rows.filter((row) => row.status === 201).length !== 1 || rows.filter((row) => row.status === 409).length !== 4) throw new Error("Duplicate normalized phone rule failed under concurrency");
  await deleteTempClients();

  rows = await Promise.all(Array.from({ length: 5 }, (_, i) => createClient(managers[i], `same-slot-${i}`, slotId(20), nextPhone())));
  report.races.sameSlot = { ...summarize(rows), expected: "1 booked, 4 rejected" };
  if (rows.filter((row) => row.status === 201).length !== 1 || rows.filter((row) => row.status === 409).length !== 4) throw new Error("Same-slot booking rule failed under concurrency");
  await deleteTempClients();

  const sharedRow = await createClient(managers[0], "shared", slotId(30), nextPhone());
  const shared = expect(sharedRow, [201], "Shared client creation failed");
  rows = await Promise.all([
    request("reschedule-manager", managers[0], "POST", `/api/clients/${shared.id}/status`, { statusId: "st_reschedule", newSlotId: slotId(31), version: shared.version }),
    request("reschedule-closer", closers[0], "POST", `/api/clients/${shared.id}/status`, { statusId: "st_reschedule", newSlotId: slotId(32), version: shared.version }),
  ]);
  report.races.simultaneousReschedule = { ...summarize(rows), expected: "1 reschedule, 1 optimistic conflict, 1 final active trial" };
  if (rows.filter((row) => row.status === 200).length !== 1 || rows.filter((row) => row.status === 409).length !== 1) throw new Error("Simultaneous reschedule did not enforce optimistic concurrency");

  const paymentKey = `${marker}-payment-retry`;
  rows = await Promise.all([
    request("payment-create", closers[0], "POST", `/api/clients/${shared.id}/status`, { statusId: "st_payment", amount: 41000, paymentMethodId: "method_1", paymentDate: "2031-01-02", paymentComment: marker }, { "Idempotency-Key": paymentKey }),
    request("payment-create", closers[1], "POST", `/api/clients/${shared.id}/status`, { statusId: "st_payment", amount: 41000, paymentMethodId: "method_1", paymentDate: "2031-01-02", paymentComment: marker }, { "Idempotency-Key": paymentKey }),
  ]);
  report.races.concurrentPaymentCreation = { ...summarize(rows), expected: "2 successful retry responses, 1 payment record" };
  if (rows.some((row) => row.status !== 200)) throw new Error("Concurrent payment creation failed");
  const drawer = expect(await request("client-drawer", owners[0], "GET", `/api/clients/${shared.id}`), [200], "Owner client drawer failed");
  if (drawer.payments.length !== 1) throw new Error(`Payment idempotency failed: ${drawer.payments.length} active payments`);
  const originalPayment = drawer.payments.find((payment) => !payment.voidedAt);
  rows = await Promise.all([
    request("payment-correction", owners[0], "POST", `/api/payments/${originalPayment.id}/correct`, { amount: 43000, paymentMethodId: "method_1", paymentDate: "2031-01-02", comment: marker, reason: marker }),
    request("payment-correction", owners[1], "POST", `/api/payments/${originalPayment.id}/correct`, { amount: 44000, paymentMethodId: "method_1", paymentDate: "2031-01-02", comment: marker, reason: marker }),
  ]);
  report.races.concurrentPaymentCorrection = { ...summarize(rows), expected: "1 correction, 1 stale correction rejected" };
  if (rows.filter((row) => row.status === 201).length !== 1 || rows.filter((row) => row.status === 404).length !== 1) throw new Error("Concurrent payment correction rule failed");

  rows = await Promise.all([
    request("archive", owners[0], "POST", `/api/clients/${shared.id}/archive`, { reason: "TEST" }),
    request("read-during-archive", managers[0], "GET", `/api/clients/${shared.id}`),
  ]);
  report.races.archiveWhileRead = { ...summarize(rows), expected: "consistent pre- or post-archive read" };
  if (rows[0].status !== 200 || ![200, 404].includes(rows[1].status)) throw new Error("Archive/read consistency failed");
  expect(await request("restore", owners[0], "POST", `/api/clients/${shared.id}/restore`, {}), [200], "Restore failed");

  const statusVersion = expect(await request("client-drawer", owners[0], "GET", `/api/clients/${shared.id}`), [200], "Status version read failed").client.version;
  rows = await Promise.all([
    request("status-update", managers[0], "POST", `/api/clients/${shared.id}/status`, { statusId: "st_no_show", version: statusVersion }),
    request("status-update", closers[0], "POST", `/api/clients/${shared.id}/status`, { statusId: "st_completed", version: statusVersion }),
  ]);
  report.races.simultaneousStatus = { ...summarize(rows), expected: "1 status update, 1 optimistic conflict" };
  if (rows.filter((row) => row.status === 200).length !== 1 || rows.filter((row) => row.status === 409).length !== 1) throw new Error(`Simultaneous status update failed: ${JSON.stringify(report.races.simultaneousStatus)}`);
  return shared;
}

async function runLoadLevels(tokens, shared) {
  let slotCursor = 40;
  for (const concurrency of levels) {
    const before = metrics.length;
    const createdThisRound = [];
    const calls = Array.from({ length: concurrency }, (_, i) => {
      const token = tokens.virtual[i];
      if (i % 5 === 0) return request(`level-${concurrency}-analytics`, token, "GET", "/api/analytics?from=2031-01-01&to=2031-01-10");
      if (i % 5 === 1) return request(`level-${concurrency}-bootstrap`, token, "GET", "/api/bootstrap");
      if (i % 5 === 2) {
        const managerToken = tokens.managers[i % tokens.managers.length];
        const promise = createClient(managerToken, `level-${concurrency}-${i}`, slotId(slotCursor++), nextPhone());
        promise.then((row) => { if (row.status === 201) createdThisRound.push(row.body.id); });
        return promise;
      }
      if (i % 5 === 3) return request(`level-${concurrency}-note`, tokens.closers[i % tokens.closers.length], "POST", `/api/clients/${shared.id}/notes`, { text: `${marker} level ${concurrency} note ${i}` });
      return request(`level-${concurrency}-slots`, tokens.closers[i % tokens.closers.length], "GET", `/api/slots?closerId=${closerId}`);
    });
    await Promise.all(calls);
    const rows = metrics.slice(before);
    const summary = { concurrency, ...summarize(rows), unexpectedFailures: rows.filter((row) => !(row.status >= 200 && row.status < 300)).map((row) => ({ label: row.label, status: row.status, error: row.body?.error || row.errorCode })) };
    report.levels.push(summary);
    if (summary.failed) throw new Error(`Unexpected failures at concurrency ${concurrency}: ${JSON.stringify(summary.unexpectedFailures)}`);
    for (const clientId of createdThisRound) trackedClientIds.add(clientId);
  }
}

async function cleanup() {
  await stopServer().catch(() => {});
  if (!controlPool) return;
  const client = await controlPool.connect();
  try {
    await client.query("BEGIN");
    const owner = (await client.query("SELECT id FROM users WHERE is_owner AND active ORDER BY id LIMIT 1")).rows[0];
    if (owner) {
      const clients = await client.query("SELECT id FROM clients WHERE registration_comment=$1 FOR UPDATE", [marker]);
      for (const row of clients.rows) await client.query("SELECT permanently_delete_client($1,$2,'УДАЛИТЬ')", [row.id, owner.id]);
    }
    await client.query("DELETE FROM sessions WHERE token_hash=ANY($1::text[]) OR user_id=ANY($2::text[])", [tokenHashes, tempUserIds]);
    await client.query("DELETE FROM notifications WHERE user_id=ANY($1::text[])", [tempUserIds]);
    await client.query("DELETE FROM saved_filters WHERE user_id=ANY($1::text[])", [tempUserIds]);
    await client.query("DELETE FROM availability_slots WHERE closer_id=$1", [closerId]);
    await client.query("DELETE FROM users WHERE id=ANY($1::text[])", [tempUserIds]);
    await client.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::text[]) OR new_value::text LIKE $2", [[...trackedClientIds, ...tempUserIds], `%${marker}%`]);
    await client.query("COMMIT");
    report.cleanup = (await client.query("SELECT (SELECT count(*)::int FROM clients) clients,(SELECT count(*)::int FROM trials) trials,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM availability_slots) slots,(SELECT count(*)::int FROM users WHERE NOT is_owner) employees,(SELECT count(*)::int FROM sessions) sessions,(SELECT count(*)::int FROM users WHERE is_owner) owners")).rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function main() {
  const config = storageConfig();
  report.pool = { max: config.poolMax, connectionTimeoutMillis: config.connectionTimeoutMillis, idleTimeoutMillis: config.idleTimeoutMillis, queryTimeoutMillis: config.queryTimeoutMillis, applicationName: config.applicationName };
  report.lockModel = { normalBusinessWrites: "targeted transactions with row locks and optimistic versions", administrativeStateWrites: "in-process queue plus pg_advisory_xact_lock", reads: "concurrent snapshot load", login: "targeted user lookup plus transactional session insert" };
  await setup();
  await startServer();
  const deadlocksBefore = Number((await controlPool.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks);
  const stopSignal = { done: false };
  const monitor = monitorLocks(stopSignal);
  try {
    const owners = await Promise.all([login("admin@milton.kz"), login("admin@milton.kz")]);
    const managers = await Promise.all(managerLogins.map(login));
    const closers = await Promise.all([login(closerLogin), login(closerLogin)]);
    const sessionBefore = metrics.length;
    const virtual = await Promise.all(Array.from({ length: 50 }, (_, i) => login(managerLogins[i % managerLogins.length])));
    report.races.activeSessions = { ...summarize(metrics.slice(sessionBefore)), expected: "50 distinct active sessions" };
    if (new Set(virtual).size !== 50) throw new Error("Active session tokens were not unique");
    const shared = await runRaceTests({ owners, managers, closers, virtual });
    await runLoadLevels({ owners, managers, closers, virtual }, shared);
    report.database.consistencyBeforeCleanup = await consistencySnapshot();
    if (Object.values(report.database.consistencyBeforeCleanup).some(Number)) throw new Error(`Data consistency violation: ${JSON.stringify(report.database.consistencyBeforeCleanup)}`);
  } finally {
    stopSignal.done = true;
    report.database.lockMonitoring = await monitor;
    const deadlocksAfter = Number((await controlPool.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks);
    report.database.deadlocksDuringRun = deadlocksAfter - deadlocksBefore;
    await cleanup();
    await app.closeStorage().catch(() => {});
    await controlPool.end();
  }
  const baseline=report.database.baselineConfiguration;
  const clean = report.cleanup && baseline && report.cleanup.clients === 0 && report.cleanup.trials === 0 && report.cleanup.payments === 0 && report.cleanup.slots === baseline.slots && report.cleanup.employees === baseline.employees && report.cleanup.sessions === baseline.sessions && report.cleanup.owners === baseline.owners;
  if (!clean) throw new Error(`Database cleanup verification failed: ${JSON.stringify(report.cleanup)}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); console.error(JSON.stringify({ partialReport: report }, null, 2)); process.exitCode = 1; });
