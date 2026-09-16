"use strict";

const crypto = require("node:crypto");

const camelKey = (key) => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const apiValue = (value) => value instanceof Date ? value.toISOString() : value;
const camelRow = (row) => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [camelKey(key), apiValue(value)]));
const rows = (result, mapper = camelRow) => result.rows.map(mapper);

function mapUser(row) {
  const value = camelRow(row);
  if (!value) return value;
  value.role = value.businessRole;
  delete value.businessRole;
  value.permissionOverrides ||= {};
  value.scopeOverrides ||= {};
  return value;
}

function mapPayment(row) {
  const value = camelRow(row);
  if (!value) return value;
  value.createdBy = value.createdByUserId;
  delete value.createdByUserId;
  return value;
}

class SqlRepository {
  constructor(db, table, mapper = camelRow) {
    this.db = db;
    this.table = table;
    this.mapper = mapper;
  }
  async list() { return rows(await this.db.query(`SELECT * FROM public.${this.table} ORDER BY id`), this.mapper); }
  async findById(id) {
    const result = await this.db.query(`SELECT * FROM public.${this.table} WHERE id = $1`, [id]);
    return result.rowCount ? this.mapper(result.rows[0]) : null;
  }
}

class UsersRepository extends SqlRepository {
  constructor(db) { super(db, "users", mapUser); }
  baseSelect() {
    return `
      SELECT u.*,
        COALESCE((SELECT jsonb_object_agg(permission_key, enabled)
                  FROM public.user_permission_overrides WHERE user_id = u.id), '{}'::jsonb) AS permission_overrides,
        COALESCE((SELECT jsonb_object_agg(resource, scope)
                  FROM public.user_scope_overrides WHERE user_id = u.id), '{}'::jsonb) AS scope_overrides
      FROM public.users u`;
  }
  async list() { return rows(await this.db.query(`${this.baseSelect()} ORDER BY u.created_at, u.id`), mapUser); }
  async findById(id) {
    const result = await this.db.query(`${this.baseSelect()} WHERE u.id = $1`, [id]);
    return result.rowCount ? mapUser(result.rows[0]) : null;
  }
  async findByLogin(login) {
    const result = await this.db.query(`${this.baseSelect()} WHERE lower(u.login) = lower($1)`, [login]);
    return result.rowCount ? mapUser(result.rows[0]) : null;
  }
  async avatarData(id) {
    const result=await this.db.query("SELECT avatar_url FROM public.users WHERE id=$1",[id]);
    return result.rowCount?result.rows[0].avatar_url||"":"";
  }
  async create(value) {
    const result = await this.db.query(`
      INSERT INTO public.users (
        id, name, login, password_hash, role_id, business_role, is_owner,
        avatar_url, profile_status, active, team_id, archived_at, trial_duration_minutes, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,now()),COALESCE($15,now()))
      RETURNING *
    `, [
      value.id, value.name, value.login, value.passwordHash, value.roleId, value.role,
      Boolean(value.isOwner), value.avatarUrl || "", value.profileStatus || "WORKING",
      value.active !== false, value.teamId || null, value.archivedAt || null,
      value.trialDurationMinutes || null, value.createdAt || null, value.updatedAt || null,
    ]);
    await this.replaceOverrides(value.id, value.permissionOverrides || {}, value.scopeOverrides || {});
    return mapUser(result.rows[0]);
  }
  async replaceOverrides(userId, permissions = {}, scopes = {}) {
    await this.db.query("DELETE FROM public.user_permission_overrides WHERE user_id = $1", [userId]);
    for (const [key, enabled] of Object.entries(permissions)) {
      await this.db.query(
        "INSERT INTO public.user_permission_overrides (user_id, permission_key, enabled) VALUES ($1,$2,$3)",
        [userId, key, enabled]
      );
    }
    await this.db.query("DELETE FROM public.user_scope_overrides WHERE user_id = $1", [userId]);
    for (const [resource, scope] of Object.entries(scopes)) {
      await this.db.query(
        "INSERT INTO public.user_scope_overrides (user_id, resource, scope) VALUES ($1,$2,$3)",
        [userId, resource, scope]
      );
    }
  }
  async archive(id, archivedAt = new Date().toISOString()) {
    const result = await this.db.query(
      "UPDATE public.users SET active = false, archived_at = $2 WHERE id = $1 RETURNING *",
      [id, archivedAt]
    );
    return result.rowCount ? mapUser(result.rows[0]) : null;
  }
  async restore(id) {
    const result = await this.db.query(
      "UPDATE public.users SET active = true, archived_at = NULL WHERE id = $1 RETURNING *",
      [id]
    );
    return result.rowCount ? mapUser(result.rows[0]) : null;
  }
}

class RolesRepository extends SqlRepository {
  constructor(db) { super(db, "roles"); }
  baseSelect() {
    return `
      SELECT r.*,
        COALESCE((SELECT jsonb_object_agg(permission_key, enabled)
                  FROM public.role_permissions WHERE role_id = r.id), '{}'::jsonb) AS permissions,
        COALESCE((SELECT jsonb_object_agg(resource, scope)
                  FROM public.role_scopes WHERE role_id = r.id), '{}'::jsonb) AS scopes
      FROM public.roles r`;
  }
  async list() { return rows(await this.db.query(`${this.baseSelect()} ORDER BY r.created_at, r.id`)); }
  async findById(id) {
    const result = await this.db.query(`${this.baseSelect()} WHERE r.id = $1`, [id]);
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async permissionsCatalog() { return rows(await this.db.query("SELECT * FROM public.permissions ORDER BY module, action")); }
}

class PermissionsRepository extends SqlRepository {
  constructor(db) { super(db, "permissions"); }
  async list() {
    return rows(await this.db.query(`
      SELECT permission_key AS key, module, action, description, created_at
      FROM public.permissions ORDER BY module, action, permission_key
    `));
  }
}

class ClientsRepository extends SqlRepository {
  constructor(db) { super(db, "clients"); }
  baseSelect() {
    return `
      SELECT c.*,
        COALESCE((SELECT array_agg(tag_id ORDER BY tag_id)
                  FROM public.client_tags WHERE client_id = c.id), '{}'::text[]) AS tag_ids
      FROM public.clients c`;
  }
  async list({ archived } = {}) {
    const where = archived === true ? "WHERE c.archived_at IS NOT NULL" : archived === false ? "WHERE c.archived_at IS NULL" : "";
    return rows(await this.db.query(`${this.baseSelect()} ${where} ORDER BY c.created_at DESC`));
  }
  async findById(id) {
    const result = await this.db.query(`${this.baseSelect()} WHERE c.id = $1`, [id]);
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async findByNormalizedPhone(phone) {
    const result = await this.db.query(`${this.baseSelect()} WHERE c.normalized_phone = $1`, [phone]);
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async create(value) {
    const result = await this.db.query(`
      INSERT INTO public.clients (
        id, name, normalized_phone, original_phone, original_manager_id, current_manager_id,
        current_closer_id, current_status_id, lead_source_id, registration_comment,
        archived_at, archived_by_user_id, archive_reason, current_reason_id,
        total_deal_amount, remaining_payment_due_date, prepayment_started_at, status_changed_at,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19,now()),COALESCE($20,now()))
      RETURNING *
    `, [
      value.id, value.name, value.normalizedPhone, value.originalPhone,
      value.originalManagerId, value.currentManagerId, value.currentCloserId,
      value.currentStatusId, value.leadSourceId || null, value.registrationComment || "",
      value.archivedAt || null, value.archivedByUserId || null, value.archiveReason || null, value.currentReasonId || null,
      value.totalDealAmount || null, value.remainingPaymentDueDate || null, value.prepaymentStartedAt || null, value.statusChangedAt || null,
      value.createdAt || null, value.updatedAt || null,
    ]);
    await this.replaceTags(value.id, value.tagIds || []);
    return { ...camelRow(result.rows[0]), tagIds: [...(value.tagIds || [])] };
  }
  async replaceTags(clientId, tagIds) {
    await this.db.query("DELETE FROM public.client_tags WHERE client_id = $1", [clientId]);
    for (const tagId of tagIds) {
      await this.db.query("INSERT INTO public.client_tags (client_id, tag_id) VALUES ($1,$2)", [clientId, tagId]);
    }
  }
  async updateStatus(clientId, statusId) {
    const result = await this.db.query(
      "UPDATE public.clients SET current_status_id = $2 WHERE id = $1 RETURNING *",
      [clientId, statusId]
    );
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async archive(clientId, actorUserId, reason, archivedAt) {
    const result = await this.db.query(`
      UPDATE public.clients
      SET archived_at = $2, archived_by_user_id = $3, archive_reason = $4
      WHERE id = $1 AND archived_at IS NULL
      RETURNING *
    `, [clientId, archivedAt, actorUserId, reason]);
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async restore(clientId) {
    const result = await this.db.query(`
      UPDATE public.clients
      SET archived_at = NULL, archived_by_user_id = NULL, archive_reason = NULL
      WHERE id = $1 AND archived_at IS NOT NULL
      RETURNING *
    `, [clientId]);
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
}

class TrialsRepository extends SqlRepository {
  constructor(db) { super(db, "trials"); }
  async listByClient(clientId) {
    return rows(await this.db.query("SELECT * FROM public.trials WHERE client_id = $1 ORDER BY scheduled_at DESC", [clientId]));
  }
  async findActiveByClient(clientId, { forUpdate = false } = {}) {
    const result = await this.db.query(
      `SELECT * FROM public.trials WHERE client_id = $1 AND active${forUpdate ? " FOR UPDATE" : ""}`,
      [clientId]
    );
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async create(value) {
    const result = await this.db.query(`
      INSERT INTO public.trials (
        id, client_id, manager_id, closer_id, slot_id, scheduled_at, completed_at,
        status_at_booking_id, result_status_id, result_at, result_actor_user_id,
        attendance_outcome, archive_interrupted_at, active, created_at,
        trial_type, trial_amount, trial_payment_date, registered_by_user_id,
        receipt_storage_key, receipt_original_name, receipt_mime_type,
        receipt_size_bytes, receipt_uploaded_at, assignment_state, preferred_time_text,
        preferred_date, preferred_start_time, preferred_end_time, assigned_at,
        assigned_by_user_id, assignment_version, pending_reschedule,
        reschedule_reason_id, reschedule_from_trial_id, previous_closer_id,
        pending_reschedule_at, pending_reschedule_by_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,now()),
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
        $33,$34,$35,$36,$37,$38)
      RETURNING *
    `, [
      value.id, value.clientId, value.managerId, value.closerId, value.slotId,
      value.scheduledAt, value.completedAt || null, value.statusAtBookingId,
      value.resultStatusId || null, value.resultAt || null, value.resultActorUserId || null,
      value.attendanceOutcome || null, value.archiveInterruptedAt || null,
      value.active !== false, value.createdAt || null,
      value.trialType || "FREE", Number(value.trialAmount || 0), value.trialPaymentDate || null,
      value.registeredByUserId || value.managerId, value.receiptStorageKey || null,
      value.receiptOriginalName || null, value.receiptMimeType || null,
      value.receiptSizeBytes || null, value.receiptUploadedAt || null,
      value.assignmentState || "SCHEDULED", value.preferredTimeText || null,
      value.preferredDate || null, value.preferredStartTime || null, value.preferredEndTime || null,
      value.assignedAt || null, value.assignedByUserId || null, Number(value.assignmentVersion || 1),
      Boolean(value.pendingReschedule), value.rescheduleReasonId || null,
      value.rescheduleFromTrialId || null, value.previousCloserId || null,
      value.pendingRescheduleAt || null, value.pendingRescheduleByUserId || null,
    ]);
    return camelRow(result.rows[0]);
  }
  async finish(id, changes) {
    const result = await this.db.query(`
      UPDATE public.trials SET
        active = false,
        pending_reschedule = false,
        completed_at = COALESCE($2, completed_at),
        result_status_id = COALESCE($3, result_status_id),
        result_at = COALESCE($4, result_at),
        result_actor_user_id = COALESCE($5, result_actor_user_id),
        attendance_outcome = COALESCE($6, attendance_outcome),
        archive_interrupted_at = COALESCE($7, archive_interrupted_at)
      WHERE id = $1 RETURNING *
    `, [
      id, changes.completedAt || null, changes.resultStatusId || null,
      changes.resultAt || null, changes.resultActorUserId || null,
      changes.attendanceOutcome || null, changes.archiveInterruptedAt || null,
    ]);
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
}

class AvailabilitySlotsRepository extends SqlRepository {
  constructor(db) { super(db, "availability_slots"); }
  async listForCloser(closerId, from, to) {
    const result = await this.db.query(`
      SELECT * FROM public.availability_slots
      WHERE closer_id = $1 AND ($2::timestamptz IS NULL OR start_at >= $2)
        AND ($3::timestamptz IS NULL OR start_at < $3)
      ORDER BY start_at
    `, [closerId, from || null, to || null]);
    return rows(result);
  }
  async lockById(id) {
    const result = await this.db.query("SELECT * FROM public.availability_slots WHERE id = $1 FOR UPDATE", [id]);
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async create(value) {
    const result = await this.db.query(`
      INSERT INTO public.availability_slots (id, closer_id, start_at, end_at, status, booked_trial_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now())) RETURNING *
    `, [value.id, value.closerId, value.startAt, value.endAt, value.status || "FREE", value.bookedTrialId || null, value.createdAt || null]);
    return camelRow(result.rows[0]);
  }
  async hasTrialReferences(id) {
    const result = await this.db.query("SELECT 1 FROM public.trials WHERE slot_id=$1 LIMIT 1", [id]);
    return result.rowCount > 0;
  }
}

class PaymentsRepository extends SqlRepository {
  constructor(db) { super(db, "payments", mapPayment); }
  async listByClient(clientId) {
    return rows(await this.db.query("SELECT * FROM public.payments WHERE client_id = $1 ORDER BY payment_date DESC, created_at DESC", [clientId]), mapPayment);
  }
  async findActiveById(id, { forUpdate = false } = {}) {
    const result = await this.db.query(
      `SELECT * FROM public.payments WHERE id = $1 AND voided_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`,
      [id]
    );
    return result.rowCount ? mapPayment(result.rows[0]) : null;
  }
  async create(value) {
    const result = await this.db.query(`
      INSERT INTO public.payments (
        id, client_id, manager_attribution_id, closer_attribution_id, amount,
        payment_method_id, payment_date, comment, created_by_user_id,
        corrected_from_payment_id, voided_at, idempotency_key, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,now())) RETURNING *
    `, [
      value.id, value.clientId, value.managerAttributionId, value.closerAttributionId,
      value.amount, value.paymentMethodId, value.paymentDate, value.comment || "",
      value.createdBy || value.createdByUserId, value.correctedFromPaymentId || null,
      value.voidedAt || null, value.idempotencyKey || null, value.createdAt || null,
    ]);
    return mapPayment(result.rows[0]);
  }
  async void(id, voidedAt) {
    const result = await this.db.query(
      "UPDATE public.payments SET voided_at = $2 WHERE id = $1 AND voided_at IS NULL RETURNING *",
      [id, voidedAt]
    );
    return result.rowCount ? mapPayment(result.rows[0]) : null;
  }
  async recordCorrection(value) {
    const result = await this.db.query(`
      INSERT INTO public.payment_corrections (
        id, original_payment_id, replacement_payment_id, corrected_by_user_id,
        reason, old_value, new_value, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now())) RETURNING *
    `, [
      value.id, value.originalPaymentId, value.replacementPaymentId,
      value.correctedByUserId, value.reason || "", value.oldValue || {},
      value.newValue || {}, value.createdAt || null,
    ]);
    return camelRow(result.rows[0]);
  }
}

class ReferenceRepository extends SqlRepository {
  async list({ includeArchived = true } = {}) {
    const where = includeArchived ? "" : "WHERE active";
    return rows(await this.db.query(`SELECT * FROM public.${this.table} ${where} ORDER BY sort_order, id`), this.mapper);
  }
}

class NotesRepository extends SqlRepository {
  constructor(db) { super(db, "notes"); }
  async listByClient(clientId) { return rows(await this.db.query("SELECT * FROM public.notes WHERE client_id = $1 ORDER BY created_at DESC", [clientId])); }
  async create(value) {
    const result = await this.db.query(`
      INSERT INTO public.notes (id, client_id, author_user_id, note_type, text, created_at)
      VALUES ($1,$2,$3,$4,$5,COALESCE($6,now())) RETURNING *
    `, [value.id, value.clientId, value.authorUserId || null, value.noteType, value.text, value.createdAt || null]);
    return camelRow(result.rows[0]);
  }
}

class ClientHistoryRepository extends SqlRepository {
  constructor(db) { super(db, "client_history"); }
  async listByClient(clientId) { return rows(await this.db.query("SELECT * FROM public.client_history WHERE client_id = $1 ORDER BY created_at DESC", [clientId])); }
  async append(value) {
    const result = await this.db.query(`
      INSERT INTO public.client_history (id, client_id, actor_user_id, event_type, old_value, new_value, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now())) RETURNING *
    `, [value.id, value.clientId, value.actorUserId || null, value.eventType, value.oldValue ?? null, value.newValue ?? null, value.createdAt || null]);
    return camelRow(result.rows[0]);
  }
}

class NotificationsRepository extends SqlRepository {
  constructor(db) { super(db, "notifications"); }
  async listForUser(userId, limit = 20) {
    return rows(await this.db.query("SELECT * FROM public.notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2", [userId, limit]));
  }
  async create(value) {
    const result = await this.db.query(`
      INSERT INTO public.notifications (id, user_id, client_id, trial_id, type, content, read_at, snoozed_until, resolved_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,now()),COALESCE($11,now()))
      ON CONFLICT DO NOTHING RETURNING *
    `, [value.id, value.userId, value.clientId || null, value.trialId || null, value.type, value.content, value.readAt || null, value.snoozedUntil || null, value.resolvedAt || null, value.createdAt || null, value.updatedAt || null]);
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async markRead(id, userId, readAt = new Date().toISOString()) {
    const result = await this.db.query(
      "UPDATE public.notifications SET read_at = COALESCE(read_at, $3) WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId, readAt]
    );
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async snooze(id, userId, snoozedUntil) {
    const result = await this.db.query(
      "UPDATE public.notifications SET snoozed_until=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND resolved_at IS NULL RETURNING *",
      [id, userId, snoozedUntil]
    );
    return result.rowCount ? camelRow(result.rows[0]) : null;
  }
  async resolveForTrial(trialId, type, resolvedAt = new Date().toISOString()) {
    return rows(await this.db.query(
      "UPDATE public.notifications SET resolved_at=$3,snoozed_until=NULL,updated_at=$3 WHERE trial_id=$1 AND type=$2 AND resolved_at IS NULL RETURNING *",
      [trialId, type, resolvedAt]
    ));
  }
}

class AuditLogsRepository extends SqlRepository {
  constructor(db) { super(db, "audit_logs"); }
  async append(value) {
    const result = await this.db.query(`
      INSERT INTO public.audit_logs (id, actor_user_id, entity_type, entity_id, action, old_value, new_value, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now())) RETURNING *
    `, [value.id, value.actorUserId || null, value.entityType, value.entityId, value.action, value.oldValue ?? null, value.newValue ?? null, value.createdAt || null]);
    return camelRow(result.rows[0]);
  }
  async recent(limit = 100) { return rows(await this.db.query("SELECT * FROM public.audit_logs ORDER BY created_at DESC LIMIT $1", [limit])); }
}

class SessionsRepository extends SqlRepository {
  constructor(db) { super(db, "sessions"); }
  tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
  async create({ id, token, userId, expiresAt, ipAddress, userAgent }) {
    const result = await this.db.query(`
      INSERT INTO public.sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [id, userId, this.tokenHash(token), expiresAt, ipAddress || null, userAgent || null]);
    return camelRow(result.rows[0]);
  }
  async createToken(token, userId) {
    return this.create({
      id: `sess_${crypto.randomUUID().slice(0, 8)}`,
      token,
      userId,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    });
  }
  async getUserId(token) {
    const result = await this.db.query(`
      SELECT user_id FROM public.sessions
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()
    `, [this.tokenHash(token)]);
    return result.rowCount ? result.rows[0].user_id : null;
  }
  async findActiveUserByToken(token) {
    const result = await this.db.query(`
      SELECT u.* FROM public.sessions s
      JOIN public.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active
    `, [this.tokenHash(token)]);
    return result.rowCount ? mapUser(result.rows[0]) : null;
  }
  async revoke(token, revokedAt = new Date().toISOString()) {
    await this.db.query("UPDATE public.sessions SET revoked_at = $2 WHERE token_hash = $1", [this.tokenHash(token), revokedAt]);
  }
  async deleteByUserId(userId) {
    return (await this.db.query("DELETE FROM public.sessions WHERE user_id=$1", [userId])).rowCount;
  }
  async purgeExpired() { return (await this.db.query("DELETE FROM public.sessions WHERE expires_at <= now() OR revoked_at IS NOT NULL")).rowCount; }
}

class SavedFiltersRepository extends SqlRepository {
  constructor(db) { super(db, "saved_filters"); }
  async listForUser(userId, module) {
    return rows(await this.db.query(
      "SELECT * FROM public.saved_filters WHERE user_id = $1 AND ($2::text IS NULL OR module = $2) ORDER BY created_at",
      [userId, module || null]
    ));
  }
}

class SettingsRepository extends SqlRepository {
  constructor(db) { super(db, "app_settings"); }
  async get() {
    const result = await this.db.query("SELECT * FROM public.app_settings WHERE id = 'global'");
    if (!result.rowCount) return null;
    const value = camelRow(result.rows[0]);
    return {
      version: value.schemaVersion,
      timezone: value.timezone,
      branding: { companyName: value.companyName, accentColor: value.accentColor, logoUrl: value.logoUrl },
      reminderMinutes: value.reminderMinutes,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }
  async logoData() {
    const result=await this.db.query("SELECT logo_url FROM public.app_settings WHERE id='global'");
    return result.rowCount?result.rows[0].logo_url||"":"";
  }
}

function createRepositories(db) {
  return {
    users: new UsersRepository(db),
    roles: new RolesRepository(db),
    permissions: new PermissionsRepository(db),
    clients: new ClientsRepository(db),
    trials: new TrialsRepository(db),
    availabilitySlots: new AvailabilitySlotsRepository(db),
    payments: new PaymentsRepository(db),
    statuses: new ReferenceRepository(db, "statuses"),
    leadSources: new ReferenceRepository(db, "lead_sources"),
    tags: new ReferenceRepository(db, "tags"),
    refusalReasons: new ReferenceRepository(db, "refusal_reasons"),
    paymentMethods: new ReferenceRepository(db, "payment_methods"),
    notes: new NotesRepository(db),
    history: new ClientHistoryRepository(db),
    notifications: new NotificationsRepository(db),
    auditLogs: new AuditLogsRepository(db),
    sessions: new SessionsRepository(db),
    savedFilters: new SavedFiltersRepository(db),
    settings: new SettingsRepository(db),
  };
}

module.exports = {
  camelRow,
  mapUser,
  mapPayment,
  SqlRepository,
  UsersRepository,
  RolesRepository,
  PermissionsRepository,
  ClientsRepository,
  TrialsRepository,
  AvailabilitySlotsRepository,
  PaymentsRepository,
  ReferenceRepository,
  NotesRepository,
  ClientHistoryRepository,
  NotificationsRepository,
  AuditLogsRepository,
  SessionsRepository,
  SavedFiltersRepository,
  SettingsRepository,
  createRepositories,
};
