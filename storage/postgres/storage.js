"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createRepositories, camelRow } = require("./repositories");
const { PostgresStateRepository } = require("./state-repository");

const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();

class PostgresStorage {
  constructor({ pool, db = pool, ownsPool = true, stateCache, stateCacheTtlMillis = 250 }) {
    this.pool = pool;
    this.db = db;
    this.ownsPool = ownsPool;
    this.stateCache = stateCache || { value: null, expiresAt: 0, pending: null };
    this.stateCacheTtlMillis = stateCacheTtlMillis;
    this.stateWriteQueue = Promise.resolve();
    Object.assign(this, createRepositories(db));
    this.state = new PostgresStateRepository(this);
  }

  static connect(databaseUrl, options = {}) {
    if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL storage");
    let defaultSsl = true;
    try { defaultSsl = !["db", "localhost", "127.0.0.1", "::1"].includes(new URL(databaseUrl).hostname); } catch {}
    const useSsl = options.ssl === undefined ? defaultSsl : options.ssl !== false;
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 30000,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30000,
      query_timeout: options.queryTimeoutMillis ?? 60000,
      keepAlive: true,
      application_name: options.applicationName || "milton-crm",
    });
    pool.on("error", (error) => {
      pool.lastBackgroundError = { code: error.code || "PG_POOL_ERROR", at: new Date().toISOString() };
      console.error(`PostgreSQL pool background error: ${error.code || error.message}`);
    });
    return new PostgresStorage({ pool, stateCacheTtlMillis: options.stateCacheTtlMillis ?? 250 });
  }

  async healthCheck() {
    const result = await this.db.query("SELECT 1 AS ok, current_database() AS database_name");
    return { ok: result.rows[0].ok === 1, databaseName: result.rows[0].database_name };
  }

  async assertSchema() {
    const result = await this.db.query(`
      SELECT version FROM public.schema_migrations
      WHERE version IN ('001', '002', '003', '004') ORDER BY version
    `);
    if (result.rows.map((row) => row.version).join(",") !== "001,002,003,004") {
      throw new Error("Milton PostgreSQL migrations 001 through 004 are required");
    }
  }

  invalidateStateCache() {
    this.stateCache.value = null;
    this.stateCache.expiresAt = 0;
  }

  async transaction(work, options = {}) {
    if (!this.ownsPool) return work(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PostgresStorage({
        pool: this.pool,
        db: client,
        ownsPool: false,
        stateCache: this.stateCache,
        stateCacheTtlMillis: this.stateCacheTtlMillis,
      });
      const result = await work(tx);
      await client.query("COMMIT");
      if (options.invalidateCache !== false) this.invalidateStateCache();
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async runState(work, options = {}) {
    if (options.readOnly) {
      let state = this.stateCacheTtlMillis > 0 && this.stateCache.value && this.stateCache.expiresAt > Date.now()
        ? this.stateCache.value
        : null;
      if (!state) {
        if (!this.stateCache.pending) {
          this.stateCache.pending = this.transaction((tx) => tx.state.load(), { invalidateCache: false });
        }
        try {
          state = await this.stateCache.pending;
          if (this.stateCacheTtlMillis > 0) {
            this.stateCache.value = state;
            this.stateCache.expiresAt = Date.now() + this.stateCacheTtlMillis;
          }
        } finally {
          this.stateCache.pending = null;
        }
      }
      const result = await work(state, this);
      if (result?.dirty) throw new Error("Read-only API request attempted to mutate PostgreSQL state");
      return result;
    }
    const execute = () => this.transaction(async (tx) => {
      await tx.db.query("SELECT pg_advisory_xact_lock(hashtext('milton_crm_api_state'))");
      const state = await tx.state.load();
      const original = structuredClone(state);
      const result = await work(state, tx);
      if (result?.dirty) await tx.state.save(state, original);
      return result;
    });
    const pending = this.stateWriteQueue.then(execute, execute);
    this.stateWriteQueue = pending.catch(() => {});
    return pending;
  }

  async ensureOperationalNotificationsFor(userId) {
    if (!userId) return 0;
    const result = await this.db.query(`
      WITH candidates AS (
        SELECT t.id trial_id,t.client_id,c.name,
          CASE
            WHEN t.scheduled_at >= now() AND t.scheduled_at <= now() + make_interval(mins => s.reminder_minutes) THEN 'TRIAL_REMINDER'
            WHEN now() > t.scheduled_at + interval '1 hour' AND c.current_status_id=t.status_at_booking_id THEN 'TRIAL_OVERDUE'
          END type
        FROM trials t JOIN clients c ON c.id=t.client_id CROSS JOIN app_settings s
        WHERE t.active AND t.closer_id=$1 AND c.archived_at IS NULL
      )
      INSERT INTO notifications(id,user_id,client_id,trial_id,type,content)
      SELECT 'notif_'||substr(replace(gen_random_uuid()::text,'-',''),1,8),$1,client_id,trial_id,type,
        name||CASE type WHEN 'TRIAL_REMINDER' THEN ' · пробный урок скоро начнётся' ELSE ' · результат пробного урока просрочен' END
      FROM candidates WHERE type IS NOT NULL
      ON CONFLICT (user_id,type,trial_id) WHERE trial_id IS NOT NULL DO NOTHING
    `, [userId]);
    if (result.rowCount) this.invalidateStateCache();
    return result.rowCount;
  }

  async registerClientAndBookTrial(input) {
    return this.transaction(async (tx) => {
      const slot = await tx.availabilitySlots.lockById(input.slotId);
      if (!slot || slot.status !== "FREE") throw Object.assign(new Error("Это время больше недоступно"), { code: "SLOT_UNAVAILABLE" });
      if (slot.closerId !== input.closerId) throw Object.assign(new Error("Слот принадлежит другому клоузеру"), { code: "SLOT_CLOSER_MISMATCH" });
      const duplicate = await tx.clients.findByNormalizedPhone(input.normalizedPhone);
      if (duplicate) throw Object.assign(new Error(duplicate.archivedAt ? "Клиент с таким номером находится в архиве" : "Клиент с таким номером телефона уже существует"), { code: "DUPLICATE_PHONE", clientId: duplicate.id });

      const createdAt = input.createdAt || now();
      const clientValue = {
        id: input.clientId || id("cl"),
        name: input.name,
        normalizedPhone: input.normalizedPhone,
        originalPhone: input.originalPhone,
        originalManagerId: input.managerId,
        currentManagerId: input.managerId,
        currentCloserId: input.closerId,
        currentStatusId: input.statusId,
        leadSourceId: input.leadSourceId || null,
        registrationComment: input.registrationComment || "",
        tagIds: input.tagIds || [],
        createdAt,
        updatedAt: createdAt,
      };
      const client = await tx.clients.create(clientValue);
      const trial = await tx.trials.create({
        id: input.trialId || id("trial"),
        clientId: client.id,
        managerId: input.managerId,
        closerId: input.closerId,
        slotId: input.slotId,
        scheduledAt: slot.startAt,
        statusAtBookingId: input.statusId,
        active: true,
        createdAt,
      });
      await tx.history.append({ id: input.clientHistoryId || id("hist"), clientId: client.id, actorUserId: input.actorUserId, eventType: "CLIENT_CREATED", oldValue: null, newValue: { name: client.name, phone: client.normalizedPhone }, createdAt });
      await tx.history.append({ id: input.trialHistoryId || id("hist"), clientId: client.id, actorUserId: input.actorUserId, eventType: "TRIAL_SCHEDULED", oldValue: null, newValue: { scheduledAt: trial.scheduledAt, closerId: trial.closerId }, createdAt });
      await tx.notifications.create({ id: input.notificationId || id("notif"), userId: input.closerId, clientId: client.id, trialId: trial.id, type: "TRIAL_ASSIGNED", content: `${client.name} · ${trial.scheduledAt}`, createdAt });
      return { client, trial };
    });
  }

  async rescheduleTrial(input) {
    return this.transaction(async (tx) => {
      const clientResult = await tx.db.query("SELECT * FROM public.clients WHERE id = $1 FOR UPDATE", [input.clientId]);
      if (!clientResult.rowCount) throw Object.assign(new Error("Клиент не найден"), { code: "CLIENT_NOT_FOUND" });
      const client = camelRow(clientResult.rows[0]);
      const oldTrial = await tx.trials.findActiveByClient(input.clientId, { forUpdate: true });
      const newSlot = await tx.availabilitySlots.lockById(input.newSlotId);
      if (!newSlot || newSlot.status !== "FREE" || newSlot.closerId !== client.currentCloserId) {
        throw Object.assign(new Error("Выбранное время недоступно"), { code: "SLOT_UNAVAILABLE" });
      }
      const changedAt = input.changedAt || now();
      if (oldTrial) {
        await tx.trials.finish(oldTrial.id, {
          resultStatusId: input.statusId,
          resultAt: changedAt,
          resultActorUserId: input.actorUserId,
          attendanceOutcome: "RESCHEDULED",
        });
      }
      const trial = await tx.trials.create({
        id: input.trialId || id("trial"), clientId: client.id,
        managerId: client.currentManagerId, closerId: client.currentCloserId,
        slotId: newSlot.id, scheduledAt: newSlot.startAt,
        statusAtBookingId: input.statusId, active: true, createdAt: changedAt,
      });
      await tx.clients.updateStatus(client.id, input.statusId);
      await tx.history.append({ id: input.historyId || id("hist"), clientId: client.id, actorUserId: input.actorUserId, eventType: "TRIAL_RESCHEDULED", oldValue: oldTrial && { trialId: oldTrial.id, scheduledAt: oldTrial.scheduledAt }, newValue: { trialId: trial.id, scheduledAt: trial.scheduledAt }, createdAt: changedAt });
      for (const userId of new Set([client.currentManagerId, client.currentCloserId])) {
        await tx.notifications.create({ id: id("notif"), userId, clientId: client.id, trialId: trial.id, type: "TRIAL_RESCHEDULED", content: `${client.name} · ${trial.scheduledAt}`, createdAt: changedAt });
      }
      return trial;
    });
  }

  async recordPayment(input) {
    return this.transaction(async (tx) => {
      const result = await tx.db.query("SELECT * FROM public.clients WHERE id = $1 FOR UPDATE", [input.clientId]);
      if (!result.rowCount) throw Object.assign(new Error("Клиент не найден"), { code: "CLIENT_NOT_FOUND" });
      const client = camelRow(result.rows[0]);
      if (client.archivedAt) throw Object.assign(new Error("Оплаты архивного клиента доступны только для просмотра"), { code: "CLIENT_ARCHIVED" });
      const createdAt = input.createdAt || now();
      const payment = await tx.payments.create({
        id: input.paymentId || id("pay"), clientId: client.id,
        managerAttributionId: client.originalManagerId,
        closerAttributionId: input.closerAttributionId || client.currentCloserId,
        amount: input.amount, paymentMethodId: input.paymentMethodId,
        paymentDate: input.paymentDate, comment: input.comment || "",
        createdBy: input.actorUserId, createdAt,
        idempotencyKey: input.idempotencyKey || null,
      });
      if (input.statusId) await tx.clients.updateStatus(client.id, input.statusId);
      await tx.history.append({ id: input.historyId || id("hist"), clientId: client.id, actorUserId: input.actorUserId, eventType: "PAYMENT_CREATED", oldValue: null, newValue: { paymentId: payment.id, amount: Number(payment.amount), paymentDate: payment.paymentDate }, createdAt });
      await tx.notifications.create({ id: input.notificationId || id("notif"), userId: client.currentManagerId, clientId: client.id, type: "PAYMENT_RECORDED", content: `${client.name} · ${payment.amount} ₸`, createdAt });
      return payment;
    });
  }

  async correctPayment(input) {
    return this.transaction(async (tx) => {
      const oldPayment = await tx.payments.findActiveById(input.paymentId, { forUpdate: true });
      if (!oldPayment) throw Object.assign(new Error("Активная оплата не найдена"), { code: "PAYMENT_NOT_FOUND" });
      const correctedAt = input.correctedAt || now();
      await tx.payments.void(oldPayment.id, correctedAt);
      const replacement = await tx.payments.create({
        ...oldPayment,
        id: input.replacementPaymentId || id("pay"),
        amount: input.amount,
        paymentMethodId: input.paymentMethodId,
        paymentDate: input.paymentDate,
        comment: input.comment || "",
        createdBy: input.actorUserId,
        correctedFromPaymentId: oldPayment.id,
        idempotencyKey: null,
        voidedAt: null,
        createdAt: correctedAt,
      });
      await tx.payments.recordCorrection({
        id: input.correctionId || id("pcorr"),
        originalPaymentId: oldPayment.id,
        replacementPaymentId: replacement.id,
        correctedByUserId: input.actorUserId,
        reason: input.reason || "",
        oldValue: oldPayment,
        newValue: replacement,
        createdAt: correctedAt,
      });
      await tx.history.append({ id: input.historyId || id("hist"), clientId: oldPayment.clientId, actorUserId: input.actorUserId, eventType: "PAYMENT_CORRECTED", oldValue: { paymentId: oldPayment.id, amount: Number(oldPayment.amount), paymentMethodId: oldPayment.paymentMethodId, paymentDate: oldPayment.paymentDate }, newValue: { paymentId: replacement.id, amount: Number(replacement.amount), paymentMethodId: replacement.paymentMethodId, paymentDate: replacement.paymentDate }, createdAt: correctedAt });
      await tx.auditLogs.append({ id: input.auditId || id("audit"), actorUserId: input.actorUserId, entityType: "PAYMENT", entityId: oldPayment.id, action: "PAYMENT_CORRECTED", oldValue: oldPayment, newValue: replacement, createdAt: correctedAt });
      return replacement;
    });
  }

  async archiveClient(input) {
    return this.transaction(async (tx) => {
      if (!['DUPLICATE', 'TEST', 'ERROR'].includes(input.reason)) throw Object.assign(new Error("Выберите причину архивации"), { code: "ARCHIVE_REASON_REQUIRED" });
      const result = await tx.db.query("SELECT * FROM public.clients WHERE id = $1 FOR UPDATE", [input.clientId]);
      if (!result.rowCount) throw Object.assign(new Error("Клиент не найден"), { code: "CLIENT_NOT_FOUND" });
      const previous = camelRow(result.rows[0]);
      if (previous.archivedAt) throw Object.assign(new Error("Клиент уже находится в архиве"), { code: "ALREADY_ARCHIVED" });
      const archivedAt = input.archivedAt || now();
      const activeTrial = await tx.trials.findActiveByClient(input.clientId, { forUpdate: true });
      if (activeTrial) await tx.trials.finish(activeTrial.id, { archiveInterruptedAt: archivedAt });
      const client = await tx.clients.archive(input.clientId, input.actorUserId, input.reason, archivedAt);
      const newValue = { reason: input.reason, archivedAt, archivedByUserId: input.actorUserId };
      await tx.history.append({ id: input.historyId || id("hist"), clientId: input.clientId, actorUserId: input.actorUserId, eventType: "CLIENT_ARCHIVED", oldValue: { archivedAt: previous.archivedAt, archiveReason: previous.archiveReason }, newValue, createdAt: archivedAt });
      await tx.auditLogs.append({ id: input.auditId || id("audit"), actorUserId: input.actorUserId, entityType: "CLIENT", entityId: input.clientId, action: "CLIENT_ARCHIVED", oldValue: { archivedAt: previous.archivedAt, archiveReason: previous.archiveReason }, newValue, createdAt: archivedAt });
      return client;
    });
  }

  async restoreClient(input) {
    return this.transaction(async (tx) => {
      const result = await tx.db.query("SELECT * FROM public.clients WHERE id = $1 FOR UPDATE", [input.clientId]);
      if (!result.rowCount) throw Object.assign(new Error("Клиент в архиве не найден"), { code: "CLIENT_NOT_FOUND" });
      const previous = camelRow(result.rows[0]);
      if (!previous.archivedAt) throw Object.assign(new Error("Клиент не находится в архиве"), { code: "NOT_ARCHIVED" });
      const restoredAt = input.restoredAt || now();
      const client = await tx.clients.restore(input.clientId);
      await tx.history.append({ id: input.historyId || id("hist"), clientId: input.clientId, actorUserId: input.actorUserId, eventType: "CLIENT_RESTORED", oldValue: { archivedAt: previous.archivedAt, archivedByUserId: previous.archivedByUserId, archiveReason: previous.archiveReason }, newValue: { restoredAt }, createdAt: restoredAt });
      await tx.auditLogs.append({ id: input.auditId || id("audit"), actorUserId: input.actorUserId, entityType: "CLIENT", entityId: input.clientId, action: "CLIENT_RESTORED", oldValue: { archivedAt: previous.archivedAt, archiveReason: previous.archiveReason }, newValue: { restoredAt, restoredByUserId: input.actorUserId }, createdAt: restoredAt });
      return client;
    });
  }

  async permanentlyDeleteClient(input) {
    return this.transaction(async (tx) => {
      const result = await tx.db.query(
        "SELECT public.permanently_delete_client($1, $2, $3) AS result",
        [input.clientId, input.actorUserId, input.confirmation]
      );
      return result.rows[0].result;
    });
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

module.exports = { PostgresStorage };
