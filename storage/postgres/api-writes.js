"use strict";

const crypto = require("node:crypto");
const { camelRow, mapUser, mapPayment } = require("./repositories");

const makeId = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const publicUser = (user) => {
  if (!user) return null;
  const { passwordHash, permissionOverrides, scopeOverrides, ...safe } = user;
  return safe;
};

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

const requirePermission = (actor, key) => {
  if (!actor) throw new HttpError(401, "Требуется авторизация");
  const override = actor.permissionOverrides || {};
  const enabled = Object.prototype.hasOwnProperty.call(override, key) ? override[key] === true : actor.accessRole?.permissions?.[key] === true;
  if (!enabled) throw new HttpError(403, "У вас нет прав для этого действия");
};
const scopeFor = (actor, resource) => actor.scopeOverrides?.[resource] || actor.accessRole?.scopes?.[resource] || "OWN";

async function actorFor(tx, req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "") || (req.headers.cookie || "").match(/milton_session=([^;]+)/)?.[1];
  if (!token) throw new HttpError(401, "Требуется авторизация");
  const result = await tx.db.query(`
    SELECT u.*,
      COALESCE((SELECT jsonb_object_agg(permission_key,enabled) FROM user_permission_overrides WHERE user_id=u.id),'{}') permission_overrides,
      COALESCE((SELECT jsonb_object_agg(resource,scope) FROM user_scope_overrides WHERE user_id=u.id),'{}') scope_overrides,
      COALESCE((SELECT jsonb_object_agg(permission_key,enabled) FROM role_permissions WHERE role_id=u.role_id),'{}') access_permissions,
      COALESCE((SELECT jsonb_object_agg(resource,scope) FROM role_scopes WHERE role_id=u.role_id),'{}') access_scopes,
      r.active access_role_active
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN roles r ON r.id=u.role_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active
  `, [tx.sessions.tokenHash(token)]);
  if (!result.rowCount) throw new HttpError(401, "Требуется авторизация");
  const actor = mapUser(result.rows[0]);
  actor.accessRole = { active: result.rows[0].access_role_active, permissions: result.rows[0].access_permissions || {}, scopes: result.rows[0].access_scopes || {} };
  delete actor.accessPermissions; delete actor.accessScopes; delete actor.accessRoleActive;
  return actor;
}

async function clientMatchesScope(tx, actor, client, resource) {
  const scope = scopeFor(actor, resource);
  if (scope === "ALL") return true;
  if (scope === "OWN") return client.currentManagerId === actor.id || client.currentCloserId === actor.id;
  if (!actor.teamId) return false;
  const result = await tx.db.query("SELECT 1 FROM users WHERE id=ANY($1::text[]) AND team_id=$2 LIMIT 1", [[client.currentManagerId, client.currentCloserId].filter(Boolean), actor.teamId]);
  return result.rowCount > 0;
}

function expectedVersion(req, input) {
  const header = String(req.headers["if-match"] || "").replace(/^W\//, "").replaceAll('"', "");
  const raw = input?.version ?? (header ? Number(header) : undefined);
  if (raw === undefined || raw === null || raw === "") return null;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 0) throw new HttpError(422, "Некорректная версия записи");
  return version;
}

function assertVersion(row, version) {
  if (version !== null && Number(row.version) !== version) throw new HttpError(409, "Запись уже была изменена другим пользователем", { currentVersion: Number(row.version) });
}

async function lockClient(tx, id) {
  const result = await tx.db.query("SELECT * FROM clients WHERE id=$1 FOR UPDATE", [id]);
  if (!result.rowCount) throw new HttpError(404, "Клиент не найден");
  return tx.clients.findById(id);
}

async function enrichedClient(tx, clientId, viewer, archiveReasons) {
  let canViewPayments = true;
  try { requirePermission(viewer, "payments.view"); } catch { canViewPayments = false; }
  const result = await tx.db.query(`
    SELECT c.*,
      COALESCE((SELECT jsonb_agg(ct.tag_id ORDER BY ct.tag_id) FROM client_tags ct WHERE ct.client_id=c.id),'[]') tag_ids,
      to_jsonb(manager_row) manager_row,to_jsonb(closer_row) closer_row,to_jsonb(original_manager_row) original_manager_row,to_jsonb(archived_by_row) archived_by_row,
      to_jsonb(status_row) status_row,to_jsonb(reason_row) reason_row,to_jsonb(source_row) source_row,
      (SELECT to_jsonb(t) FROM trials t WHERE t.client_id=c.id AND t.active LIMIT 1) active_trial_row,
      COALESCE((SELECT jsonb_agg(to_jsonb(tag_row) ORDER BY tag_row.id) FROM client_tags ct JOIN tags tag_row ON tag_row.id=ct.tag_id WHERE ct.client_id=c.id),'[]') tags_rows,
      CASE WHEN $2::boolean THEN COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.payment_date DESC,p.created_at DESC) FROM payments p WHERE p.client_id=c.id AND p.voided_at IS NULL),'[]') ELSE '[]'::jsonb END payments_rows
    FROM clients c
    LEFT JOIN users manager_row ON manager_row.id=c.current_manager_id
    LEFT JOIN users closer_row ON closer_row.id=c.current_closer_id
    LEFT JOIN users original_manager_row ON original_manager_row.id=c.original_manager_id
    LEFT JOIN users archived_by_row ON archived_by_row.id=c.archived_by_user_id
    LEFT JOIN statuses status_row ON status_row.id=c.current_status_id
    LEFT JOIN refusal_reasons reason_row ON reason_row.id=c.current_reason_id
    LEFT JOIN lead_sources source_row ON source_row.id=c.lead_source_id
    WHERE c.id=$1
  `, [clientId, canViewPayments]);
  if (!result.rowCount) return null;
  const raw = result.rows[0], client = camelRow(raw);
  for (const key of ["managerRow", "closerRow", "originalManagerRow", "archivedByRow", "statusRow", "reasonRow", "sourceRow", "activeTrialRow", "tagsRows", "paymentsRows"]) delete client[key];
  const manager = mapUser(raw.manager_row), closer = mapUser(raw.closer_row), originalManager = mapUser(raw.original_manager_row), archivedBy = mapUser(raw.archived_by_row);
  const status = camelRow(raw.status_row), currentReason=camelRow(raw.reason_row), leadSource = camelRow(raw.source_row), activeTrial = camelRow(raw.active_trial_row);
  const tags = (raw.tags_rows || []).map(camelRow), payments = (raw.payments_rows || []).map(mapPayment);
  const activePayments = payments.filter((payment) => !payment.voidedAt);
  const overdue = activeTrial?.assignmentState!=="UNASSIGNED" && activeTrial?.scheduledAt && new Date(activeTrial.scheduledAt).getTime() + 3600000 < Date.now() && client.currentStatusId === activeTrial.statusAtBookingId;
  return { ...client, manager: publicUser(manager), closer: publicUser(closer)||{id:null,name:"Без клоузера",role:"CLOSER",avatarUrl:""}, originalManager: publicUser(originalManager), archivedBy: publicUser(archivedBy), archiveReasonLabel: archiveReasons[client.archiveReason] || client.archiveReason || null, status,currentReason, leadSource, tags, activeTrial, payments: activePayments, paymentTotal: activePayments.reduce((sum, payment) => sum + Number(payment.amount), 0), overdue: Boolean(overdue) };
}

async function appendHistory(tx, clientId, actorId, eventType, oldValue, newValue, createdAt = now()) {
  return tx.history.append({ id: makeId("hist"), clientId, actorUserId: actorId, eventType, oldValue, newValue, createdAt });
}
async function appendNotification(tx, userId, clientId, type, content, trialId = null, createdAt = now()) {
  return tx.notifications.create({ id: makeId("notif"), userId, clientId, trialId, type, content, createdAt });
}

function isHandledRoute(method, pathname) {
  if ((method === "POST" && ["/api/clients", "/api/slots/generate"].includes(pathname)) || (method === "PUT" && ["/api/profile","/api/admin/unassigned-settings"].includes(pathname))) return true;
  if (["PUT","DELETE"].includes(method) && /^\/api\/slots\/[^/]+$/.test(pathname)) return true;
  return (method === "POST" && /^\/api\/clients\/[^/]+\/(archive|restore|notes|reassign|status)$/.test(pathname))
    || (method === "POST" && /^\/api\/trials\/[^/]+\/(assign|reassign)$/.test(pathname))
    || (method === "DELETE" && /^\/api\/clients\/[^/]+$/.test(pathname))
    || (method === "POST" && /^\/api\/payments\/[^/]+\/correct$/.test(pathname))
    || (method === "POST" && /^\/api\/notifications\/[^/]+\/(read|snooze)$/.test(pathname));
}

function databaseError(error) {
  if (error instanceof HttpError) return error;
  if (error.code === "SLOT_UNAVAILABLE") return new HttpError(409, "Этот слот уже занят. Выберите другое время.", { code:"SLOT_UNAVAILABLE" });
  if (error.code === "SLOT_CLOSER_MISMATCH") return new HttpError(409, "Выбранное время относится к другому клоузеру. Выберите время заново.", { code:"SLOT_CLOSER_MISMATCH" });
  if (error.code === "DUPLICATE_PHONE") return new HttpError(409, error.message, { code:"DUPLICATE_PHONE", clientId:error.clientId });
  if (["ALREADY_ARCHIVED", "CLIENT_ARCHIVED"].includes(error.code)) return new HttpError(409, error.message);
  if (["CLIENT_NOT_FOUND", "NOT_ARCHIVED"].includes(error.code)) return new HttpError(404, error.message);
  if (error.code === "ARCHIVE_REASON_REQUIRED") return new HttpError(422, error.message);
  if (error.code === "23505") {
    if (String(error.constraint).includes("normalized_phone")) return new HttpError(409, "Клиент с таким номером телефона уже существует");
    if (String(error.constraint).includes("availability_slots_closer_id_start_at")) return new HttpError(409, "У клоузера уже есть слот на это время");
    if (String(error.constraint).includes("slot") || String(error.message).includes("slot")) return new HttpError(409, "Этот слот уже занят. Выберите другое время.", { code:"SLOT_UNAVAILABLE" });
    if (String(error.constraint).includes("idempotency")) return new HttpError(409, "Повторный платёж уже обрабатывается");
    return new HttpError(409, "Такая запись уже существует");
  }
  if (["40001", "40P01"].includes(error.code)) return new HttpError(409, "Данные одновременно изменились. Обновите страницу и повторите действие");
  if (error.code === "P0002") return new HttpError(404, "Клиент не найден");
  if (error.code === "42501") return new HttpError(403, error.message);
  return error;
}

function createPostgresWriteHandler({ storage, readBody, sendJson, normalizePhone, archiveReasons, hashPassword, validImageData, fileStorage, validateTrialPayment }) {
  return async function handle(req, res, url) {
    if (!isHandledRoute(req.method, url.pathname)) return false;
    let storedReceiptKey = null, deletedReceiptKeys = [];
    try {
      const result = await storage.transaction(async (tx) => {
        const actor = await actorFor(tx, req);
        const input = await readBody(req);

        if (req.method === "PUT" && url.pathname === "/api/profile") {
          const locked = (await tx.db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [actor.id])).rows[0];
          const oldValue = publicUser(actor);
          if (input.name !== undefined && !String(input.name).trim()) throw new HttpError(422, "Введите имя");
          if (input.login !== undefined && !String(input.login).trim()) throw new HttpError(422, "Введите логин");
          if (input.login) { const duplicate = await tx.db.query("SELECT 1 FROM users WHERE id<>$1 AND lower(login)=lower($2)", [actor.id, String(input.login)]); if (duplicate.rowCount) throw new HttpError(409, "Пользователь с таким логином уже существует"); }
          if (input.avatarUrl !== undefined && !validImageData(input.avatarUrl)) throw new HttpError(422, "Некорректное изображение профиля");
          if (input.password && String(input.password).length < 6) throw new HttpError(422, "Пароль должен содержать минимум 6 символов");
          const updated = await tx.db.query(`UPDATE users SET name=$2,login=$3,avatar_url=$4,profile_status=$5,password_hash=$6,updated_at=now() WHERE id=$1 RETURNING *`, [actor.id, input.name === undefined ? locked.name : String(input.name).trim(), input.login === undefined ? locked.login : String(input.login).trim(), input.avatarUrl === undefined ? locked.avatar_url : input.avatarUrl, ["WORKING", "DAY_OFF", "NOT_ACCEPTING"].includes(input.profileStatus) ? input.profileStatus : locked.profile_status, input.password ? hashPassword(String(input.password)) : locked.password_hash]);
          const value = await tx.users.findById(updated.rows[0].id);
          await tx.auditLogs.append({ id: makeId("audit"), actorUserId: actor.id, entityType: "USER", entityId: actor.id, action: "PROFILE_UPDATED", oldValue, newValue: publicUser(value) });
          return { status: 200, body: publicUser(value) };
        }
        if(req.method==="PUT"&&url.pathname==="/api/admin/unassigned-settings"){
          requirePermission(actor,"settings.manageBranding");const minutes=Number(input.minutes);if(!Number.isInteger(minutes)||minutes<0||minutes>10080)throw new HttpError(422,"Укажите порог от 0 до 10080 минут");await tx.db.query("UPDATE app_settings SET unassigned_trial_reminder_minutes=$1,updated_by_user_id=$2,updated_at=now() WHERE id='global'",[minutes,actor.id]);await tx.auditLogs.append({id:makeId("audit"),actorUserId:actor.id,entityType:"SETTINGS",entityId:"unassigned-trials",action:"UNASSIGNED_REMINDER_CHANGED",oldValue:null,newValue:{minutes},createdAt:now()});return{status:200,body:{minutes}};
        }

        const slotRoute=url.pathname.match(/^\/api\/slots\/([^/]+)$/);
        if(slotRoute&&["PUT","DELETE"].includes(req.method)){
          const slot=await tx.availabilitySlots.lockById(slotRoute[1]);if(!slot)throw new HttpError(404,"Слот не найден");
          const managesOther=slot.closerId!==actor.id;
          if(managesOther){requirePermission(actor,"schedule.manageOthers");const owner=await tx.users.findById(slot.closerId),scope=scopeFor(actor,"schedule");if(scope!=="ALL"&&(scope!=="TEAM"||!actor.teamId||owner?.teamId!==actor.teamId))throw new HttpError(403,"Область данных не включает этого сотрудника");}
          else requirePermission(actor,"schedule.editOwnAvailability");
          if(new Date(slot.startAt)<=new Date())throw new HttpError(409,"Прошедший слот нельзя изменить или удалить");
          if(slot.status!=="FREE"||slot.bookedTrialId)throw new HttpError(409,"На этот слот уже записан пробный урок");
          if(await tx.availabilitySlots.hasTrialReferences(slot.id))throw new HttpError(409,"Слот содержит историю пробного урока и должен быть сохранён");
          if(req.method==="DELETE"){
            await tx.db.query("DELETE FROM availability_slots WHERE id=$1",[slot.id]);await tx.auditLogs.append({id:makeId("audit"),actorUserId:actor.id,entityType:"AVAILABILITY_SLOT",entityId:slot.id,action:"AVAILABILITY_SLOT_DELETED",oldValue:slot,newValue:null,createdAt:now()});return{status:200,body:{id:slot.id,deleted:true}};
          }
          const date=String(input.date||"");const time=String(input.time||"");const duration=Number(input.durationMinutes);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time)||!Number.isInteger(duration)||duration<10||duration>180)throw new HttpError(422,"Укажите корректные дату, время и длительность от 10 до 180 минут");
          const startAt=new Date(`${date}T${time}:00+05:00`);if(Number.isNaN(startAt.getTime())||startAt<=new Date())throw new HttpError(422,"Новый слот должен быть в будущем");const endAt=new Date(startAt.getTime()+duration*60000);await tx.db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[slot.closerId]);const overlap=await tx.db.query("SELECT 1 FROM availability_slots WHERE id<>$1 AND closer_id=$2 AND start_at<$4 AND end_at>$3 LIMIT 1",[slot.id,slot.closerId,startAt.toISOString(),endAt.toISOString()]);if(overlap.rowCount)throw new HttpError(409,"Новое время пересекается с другим слотом клоузера");
          const updated=(await tx.db.query("UPDATE availability_slots SET start_at=$2,end_at=$3 WHERE id=$1 RETURNING *",[slot.id,startAt.toISOString(),endAt.toISOString()])).rows[0];await tx.auditLogs.append({id:makeId("audit"),actorUserId:actor.id,entityType:"AVAILABILITY_SLOT",entityId:slot.id,action:"AVAILABILITY_SLOT_UPDATED",oldValue:slot,newValue:camelRow(updated),createdAt:now()});return{status:200,body:camelRow(updated)};
        }

        if (req.method === "POST" && url.pathname === "/api/clients") {
          requirePermission(actor, "clients.create"); requirePermission(actor, "schedule.scheduleTrial");
          const paymentValidation = validateTrialPayment(input);
          if (paymentValidation.error) throw new HttpError(422, paymentValidation.error);
          const phone = normalizePhone(input.phone), name = String(input.name || "").trim();
          const unassigned=actor.role==="MANAGER"||input.assignmentMode==="LATER";
          if (!name || phone.length < 12 || (!unassigned&&(!input.closerId || !input.slotId))) throw new HttpError(422, unassigned?"Укажите имя и корректный телефон":"Укажите имя, корректный телефон, клоузера и свободное время");
          const closer = unassigned?null:await tx.users.findById(input.closerId);
          if (!unassigned&&(!closer?.active || closer.role !== "CLOSER")) throw new HttpError(422, "Выберите активного клоузера");
          const statusId = input.statusId || (await tx.db.query("SELECT id FROM statuses WHERE active ORDER BY sort_order,id LIMIT 1")).rows[0]?.id;
          const managerId = actor.role === "MANAGER" ? actor.id : input.managerId;
          const duplicate = await tx.clients.findByNormalizedPhone(phone);
          if (duplicate) throw new HttpError(409, duplicate.archivedAt ? "Клиент с таким номером находится в архиве" : "Клиент с таким номером телефона уже существует", { code:"DUPLICATE_PHONE", clientId: duplicate.id, archived: Boolean(duplicate.archivedAt) });
          const receipt=paymentValidation.value.receipt?await fileStorage.saveDataUrl(paymentValidation.value.receipt.dataUrl,paymentValidation.value.receipt.originalName):null;
          storedReceiptKey=receipt?.key||null;
          const common={clientId:makeId("cl"),trialId:makeId("trial"),actorUserId:actor.id,name,normalizedPhone:phone,originalPhone:input.phone,managerId,closerId:input.closerId||null,statusId,leadSourceId:input.leadSourceId||null,tagIds:input.tagIds||[],registrationComment:input.comment||"",slotId:input.slotId||null,trialType:paymentValidation.value.trialType,trialAmount:paymentValidation.value.trialAmount,trialPaymentDate:paymentValidation.value.trialType==="PAID"?now().slice(0,10):null,registeredByUserId:actor.id,receiptStorageKey:receipt?.key||null,receiptOriginalName:receipt?.originalName||null,receiptMimeType:receipt?.mimeType||null,receiptSizeBytes:receipt?.sizeBytes||null,receiptUploadedAt:receipt?.uploadedAt||null,preferredTimeText:String(input.preferredTimeText||"").trim(),preferredDate:input.preferredDate||null,preferredStartTime:input.preferredStartTime||null,preferredEndTime:input.preferredEndTime||null};
          const created=unassigned?await tx.registerClientUnassignedTrial(common):await tx.registerClientAndBookTrial(common);
          return { status: 201, body: await enrichedClient(tx, created.client.id, actor, archiveReasons) };
        }

        const assignment=url.pathname.match(/^\/api\/trials\/([^/]+)\/(assign|reassign)$/);
        if(req.method==="POST"&&assignment){
          const trialId=assignment[1],action=assignment[2];if(actor.role!=="ADMIN")throw new HttpError(403,"Назначать клоузера может только администратор");requirePermission(actor,action==="assign"?"schedule.assignUnassigned":"schedule.reassignCloser");
          const locked=(await tx.db.query("SELECT * FROM trials WHERE id=$1 AND active FOR UPDATE",[trialId])).rows[0];if(!locked)throw new HttpError(404,"Активный пробный не найден");
          if(action==="assign"&&locked.assignment_state!=="UNASSIGNED")throw new HttpError(409,"Пробный уже назначен. Обновите данные");
          if(action==="reassign"&&locked.assignment_state!=="SCHEDULED")throw new HttpError(409,"Пробный ещё не назначен");
          if(input.version!==undefined&&Number(input.version)!==Number(locked.assignment_version))throw new HttpError(409,"Назначение уже изменилось. Обновите данные");
          const client=await lockClient(tx,locked.client_id);if(!(await clientMatchesScope(tx,actor,client,"clients")))throw new HttpError(404,"Клиент не найден");
          const slot=await tx.availabilitySlots.lockById(input.slotId);if(!slot||slot.status!=="FREE")throw new HttpError(409,"Этот слот уже занят");
          const changedAt=now(),oldValue={closerId:locked.closer_id,slotId:locked.slot_id,scheduledAt:locked.scheduled_at};
          if(action==="reassign"&&locked.slot_id&&new Date(locked.scheduled_at)>new Date())await tx.db.query("UPDATE availability_slots SET status='FREE',booked_trial_id=NULL WHERE id=$1 AND booked_trial_id=$2",[locked.slot_id,trialId]);
          const wasPending=Boolean(locked.pending_reschedule);
          await tx.db.query("UPDATE trials SET closer_id=$2,slot_id=$3,scheduled_at=$4,assignment_state='SCHEDULED',assigned_at=$5,assigned_by_user_id=$6,assignment_version=assignment_version+1,pending_reschedule=false,updated_at=$5 WHERE id=$1",[trialId,slot.closerId,slot.id,slot.startAt,changedAt,actor.id]);
          await tx.db.query("UPDATE clients SET current_closer_id=$2,current_status_id=CASE WHEN $4 THEN $5 ELSE current_status_id END,current_reason_id=CASE WHEN $4 THEN NULL ELSE current_reason_id END,updated_at=$3 WHERE id=$1",[client.id,slot.closerId,changedAt,wasPending,locked.status_at_booking_id]);
          if(wasPending)await tx.notifications.resolveForTrial(trialId,"TRIAL_RESCHEDULE_PENDING",changedAt);
          const newValue={closerId:slot.closerId,slotId:slot.id,scheduledAt:slot.startAt};const eventType=wasPending?"TRIAL_RESCHEDULE_TIME_ASSIGNED":action==="assign"?"TRIAL_ASSIGNED":"TRIAL_ASSIGNMENT_CHANGED";
          await appendHistory(tx,client.id,actor.id,eventType,oldValue,newValue,changedAt);await tx.auditLogs.append({id:makeId("audit"),actorUserId:actor.id,entityType:"TRIAL",entityId:trialId,action:eventType,oldValue,newValue,createdAt:changedAt});await appendNotification(tx,slot.closerId,client.id,"TRIAL_ASSIGNED",`${client.name} · ${slot.startAt}`,trialId,changedAt);
          return{status:200,body:await enrichedClient(tx,client.id,actor,archiveReasons)};
        }

        const clientMatch = url.pathname.match(/^\/api\/clients\/([^/]+)(?:\/(archive|restore|notes|reassign|status))?$/);
        if (clientMatch) {
          const clientId = clientMatch[1], action = clientMatch[2];
          if (req.method === "DELETE" && !action) {
            if (!actor.isOwner) throw new HttpError(403, "Постоянное удаление доступно только владельцу системы");
            const client = await lockClient(tx, clientId);
            if (!(await clientMatchesScope(tx, actor, client, "clients"))) throw new HttpError(404, "Клиент не найден");
            if (!["УДАЛИТЬ", client.name].includes(String(input.confirmation || ""))) throw new HttpError(422, "Подтвердите постоянное удаление клиента");
            deletedReceiptKeys=(await tx.db.query("SELECT receipt_storage_key FROM trials WHERE client_id=$1 AND receipt_storage_key IS NOT NULL",[clientId])).rows.map((row)=>row.receipt_storage_key);
            const deleted = await tx.permanentlyDeleteClient({ clientId, actorUserId: actor.id, confirmation: "УДАЛИТЬ" });
            return { status: 200, body: { ...deleted, deletedAt: now(), financialRecordsPreserved: false } };
          }
          const client = await lockClient(tx, clientId);
          assertVersion(client, expectedVersion(req, input));
          if (!(await clientMatchesScope(tx, actor, client, "clients"))) throw new HttpError(404, "Клиент не найден");

          if (action === "archive") {
            requirePermission(actor, "clients.archive");
            const archived = await tx.archiveClient({ clientId, actorUserId: actor.id, reason: String(input.reason || "") });
            return { status: 200, body: await enrichedClient(tx, archived.id, actor, archiveReasons) };
          }
          if (action === "restore") {
            requirePermission(actor, "clients.archive");
            const restored = await tx.restoreClient({ clientId, actorUserId: actor.id });
            return { status: 200, body: await enrichedClient(tx, restored.id, actor, archiveReasons) };
          }
          if (client.archivedAt) throw new HttpError(404, "Клиент не найден");
          if (action === "notes") {
            requirePermission(actor, "clients.addNotes");
            const text = String(input.text || "").trim(); if (!text) throw new HttpError(422, "Введите текст заметки");
            const note = await tx.notes.create({ id: makeId("note"), clientId, authorUserId: actor.id, noteType: actor.role === "MANAGER" ? "MANAGER_NOTE" : "CLOSER_NOTE", text, createdAt: now() });
            await appendHistory(tx, clientId, actor.id, "NOTE_ADDED", null, { noteId: note.id, type: note.noteType });
            return { status: 201, body: note };
          }
          if (action === "reassign") {
            const oldValue = { managerId: client.currentManagerId, closerId: client.currentCloserId };
            let managerId = client.currentManagerId, closerId = client.currentCloserId;
            if (input.managerId && input.managerId !== managerId) {
              requirePermission(actor, "clients.reassignManager"); const manager = await tx.users.findById(input.managerId);
              if (!manager?.active || manager.role !== "MANAGER") throw new HttpError(422, "Выберите активного менеджера");
              managerId = manager.id; await appendHistory(tx, clientId, actor.id, "MANAGER_REASSIGNED", { managerId: oldValue.managerId }, { managerId }); await appendNotification(tx, managerId, clientId, "CLIENT_REASSIGNED", `${client.name} · вы назначены менеджером`);
            }
            if (input.closerId && input.closerId !== closerId) {
              requirePermission(actor, "clients.reassignCloser"); const closer = await tx.users.findById(input.closerId);
              if (!closer?.active || closer.role !== "CLOSER") throw new HttpError(422, "Выберите активного клоузера");
              const activeTrial = await tx.trials.findActiveByClient(clientId, { forUpdate: true });
              if (activeTrial) {
                const newSlot = await tx.availabilitySlots.lockById(input.newSlotId);
                if (!newSlot || newSlot.closerId !== closer.id || newSlot.status !== "FREE") throw new HttpError(409, "Для нового клоузера выберите свободное время");
                await tx.trials.finish(activeTrial.id, { resultAt: now(), resultActorUserId: actor.id, attendanceOutcome: "RESCHEDULED" });
                const trial = await tx.trials.create({ id: makeId("trial"), clientId, closerId: closer.id, managerId, slotId: newSlot.id, scheduledAt: newSlot.startAt, statusAtBookingId: client.currentStatusId, active: true });
                await appendHistory(tx, clientId, actor.id, "TRIAL_RESCHEDULED", { trialId: activeTrial.id, scheduledAt: activeTrial.scheduledAt, closerId: activeTrial.closerId }, { trialId: trial.id, scheduledAt: trial.scheduledAt, closerId: closer.id });
              }
              closerId = closer.id; await appendHistory(tx, clientId, actor.id, "CLOSER_REASSIGNED", { closerId: oldValue.closerId }, { closerId }); await appendNotification(tx, closerId, clientId, "CLIENT_REASSIGNED", `${client.name} · вы назначены клоузером`);
            }
            await tx.db.query("UPDATE clients SET current_manager_id=$2,current_closer_id=$3,updated_at=now() WHERE id=$1", [clientId, managerId, closerId]);
            return { status: 200, body: await enrichedClient(tx, clientId, actor, archiveReasons) };
          }
          if (action === "status") {
            if (!actor) throw new HttpError(401, "Требуется авторизация");
            try { requirePermission(actor, "clients.changeStatus"); } catch { requirePermission(actor, "crm.changeStatus"); }
            const status = await tx.statuses.findById(input.statusId);
            if (!status?.active) throw new HttpError(422, "Выберите активный статус");
            if (actor.role === "MANAGER" && !["REQUIRE_RESCHEDULE", "MARK_NO_SHOW"].includes(status.actionType)) throw new HttpError(403, "Этот статус может изменить только клоузер");
            const requiredFields=status.actionType==="REQUIRE_RESCHEDULE"?(input.rescheduleMode==="LATER"?["refusalReasonId"]:["refusalReasonId","newSlotId"]):(status.requiredFields||[]);
            const missing = requiredFields.filter((field) => input[field] === undefined || input[field] === null || input[field] === "");
            if (missing.length) throw new HttpError(422, "Заполните все обязательные поля", missing);
            if (["REQUIRE_REFUSAL_REASON","REQUIRE_RESCHEDULE"].includes(status.actionType)) { const reason = await tx.refusalReasons.findById(input.refusalReasonId); if (!reason?.active) throw new HttpError(422, status.actionType==="REQUIRE_RESCHEDULE"?"Выберите причину переноса":"Выберите активную причину отказа"); }
            const changedAt = now(), oldStatusId = client.currentStatusId;
            if (status.actionType === "REQUIRE_RESCHEDULE") {
              requirePermission(actor, "schedule.rescheduleTrial");
              await tx.rescheduleTrial({ clientId, actorUserId: actor.id, newSlotId: input.newSlotId, statusId: status.id, reasonId:input.refusalReasonId,rescheduleMode:input.rescheduleMode==="LATER"?"LATER":"NOW",changedAt });
            } else {
              if (status.actionType === "REQUIRE_PAYMENT") {
                requirePermission(actor, "payments.create");
                const amount = Number(input.amount), paymentDate = String(input.paymentDate || ""), key = String(req.headers["idempotency-key"] || input.idempotencyKey || "").trim() || null;
                if (!(amount > 0) || !(await tx.paymentMethods.findById(input.paymentMethodId))?.active || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) throw new HttpError(422, "Укажите корректную сумму, способ и дату оплаты");
                if (key && key.length > 128) throw new HttpError(422, "Ключ идемпотентности слишком длинный");
                const existing = key ? await tx.db.query("SELECT id FROM payments WHERE created_by_user_id=$1 AND idempotency_key=$2", [actor.id, key]) : { rowCount: 0 };
                if (existing.rowCount) return { status: 200, body: await enrichedClient(tx, clientId, actor, archiveReasons) };
                await tx.recordPayment({ paymentId: makeId("pay"), clientId, actorUserId: actor.id, closerAttributionId: actor.role === "CLOSER" ? actor.id : client.currentCloserId, amount, paymentMethodId: input.paymentMethodId, paymentDate, comment: input.paymentComment || "", statusId: status.id, idempotencyKey: key, createdAt: changedAt });
              } else await tx.clients.updateStatus(clientId, status.id);
              await tx.db.query("UPDATE clients SET current_reason_id=$2,updated_at=$3 WHERE id=$1",[clientId,input.refusalReasonId||null,changedAt]);
              const activeTrial = await tx.trials.findActiveByClient(clientId, { forUpdate: true });
              if (activeTrial && status.id !== activeTrial.statusAtBookingId) await tx.trials.finish(activeTrial.id, { completedAt: changedAt, resultStatusId: status.id, resultAt: changedAt, resultActorUserId: actor.id, attendanceOutcome: status.actionType === "MARK_NO_SHOW" ? "NO_SHOW" : "REACHED" });
            }
            await appendHistory(tx, clientId, actor.id, "STATUS_CHANGED", { statusId: oldStatusId }, { statusId: status.id, refusalReasonId: input.refusalReasonId || null }, changedAt);
            return { status: 200, body: await enrichedClient(tx, clientId, actor, archiveReasons) };
          }
        }

        const correction = url.pathname.match(/^\/api\/payments\/([^/]+)\/correct$/);
        if (correction) {
          requirePermission(actor, "payments.edit");
          const payment = await tx.payments.findActiveById(correction[1], { forUpdate: true });
          if (!payment) throw new HttpError(404, "Активная оплата не найдена");
          assertVersion(payment, expectedVersion(req, input));
          const client = await lockClient(tx, payment.clientId);
          if (client.archivedAt) throw new HttpError(409, "Оплаты архивного клиента доступны только для просмотра");
          if (!(await clientMatchesScope(tx, actor, client, "payments"))) throw new HttpError(403, "Оплата вне вашей области данных");
          const amount = Number(input.amount);
          if (!(amount > 0) || !(await tx.paymentMethods.findById(input.paymentMethodId))?.active || !/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate || "")) throw new HttpError(422, "Укажите корректную сумму, способ и дату оплаты");
          const replacement = await tx.correctPayment({ paymentId: payment.id, replacementPaymentId: makeId("pay"), correctionId: makeId("pcorr"), historyId: makeId("hist"), auditId: makeId("audit"), actorUserId: actor.id, amount, paymentMethodId: input.paymentMethodId, paymentDate: input.paymentDate, comment: input.comment || "", reason: String(input.reason || "") });
          return { status: 201, body: replacement };
        }

        const notification = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
        if (notification) {
          const updated = await tx.notifications.markRead(notification[1], actor.id);
          if (!updated) throw new HttpError(404, "Уведомление не найдено");
          return { status: 200, body: updated };
        }
        const snoozeNotification=url.pathname.match(/^\/api\/notifications\/([^/]+)\/snooze$/);
        if(snoozeNotification){
          const snoozedUntil=new Date(Date.now()+15*60000).toISOString(),updated=await tx.notifications.snooze(snoozeNotification[1],actor.id,snoozedUntil);
          if(!updated)throw new HttpError(404,"Активное уведомление не найдено");
          return{status:200,body:updated};
        }

        if (req.method === "POST" && url.pathname === "/api/slots/generate") {
          const requestedCloser = input.closerId || actor.id, managingOther = requestedCloser !== actor.id;
          if (managingOther) requirePermission(actor, "schedule.manageOthers"); else requirePermission(actor, "schedule.createOwnAvailability");
          if (managingOther && scopeFor(actor, "schedule") !== "ALL") {
            const target = await tx.users.findById(requestedCloser);
            if (scopeFor(actor, "schedule") !== "TEAM" || !actor.teamId || target?.teamId !== actor.teamId) throw new HttpError(403, "Область данных не включает этого сотрудника");
          }
          const closer = await tx.users.findById(requestedCloser); if (!closer?.active || closer.role !== "CLOSER") throw new HttpError(422, "Выберите активного клоузера");
          await tx.db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[closer.id]);
          const [sh, sm] = String(input.start || "").split(":").map(Number), [eh, em] = String(input.end || "").split(":").map(Number), duration = Number(input.durationMinutes ?? input.interval ?? closer.trialDurationMinutes ?? 60);
          const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || "")), validClock = Number.isInteger(sh) && sh >= 0 && sh <= 23 && Number.isInteger(sm) && sm >= 0 && sm <= 59 && Number.isInteger(eh) && eh >= 0 && eh <= 23 && Number.isInteger(em) && em >= 0 && em <= 59;
          if (!validDate || !validClock || !Number.isInteger(duration) || duration < 10 || duration > 180 || !(eh * 60 + em > sh * 60 + sm)) throw new HttpError(422, "Укажите корректную дату, диапазон времени и длительность от 10 до 180 минут");
          if(Number(closer.trialDurationMinutes)!==duration)await tx.db.query("UPDATE users SET trial_duration_minutes=$2 WHERE id=$1",[closer.id,duration]);
          let cursor = sh * 60 + sm, created = 0;
          while (cursor + duration <= eh * 60 + em) {
            const hh = String(Math.floor(cursor / 60)).padStart(2, "0"), mm = String(cursor % 60).padStart(2, "0");
            const startAt = new Date(`${input.date}T${hh}:${mm}:00+05:00`).toISOString(), endAt = new Date(new Date(startAt).getTime() + duration * 60000).toISOString();
            const overlap=await tx.db.query("SELECT 1 FROM availability_slots WHERE closer_id=$1 AND start_at<$3 AND end_at>$2 LIMIT 1",[requestedCloser,startAt,endAt]);
            if(overlap.rowCount){cursor+=duration;continue;}
            const result = await tx.db.query("INSERT INTO availability_slots(id,closer_id,start_at,end_at,status) VALUES($1,$2,$3,$4,'FREE') ON CONFLICT(closer_id,start_at) DO NOTHING", [makeId("slot"), requestedCloser, startAt, endAt]);
            created += result.rowCount; cursor += duration;
          }
          return { status: 201, body: { created,durationMinutes:duration } };
        }
        throw new Error("Matched PostgreSQL write route was not handled");
      });
      sendJson(res, result.status, result.body);
      for(const key of deletedReceiptKeys)await fileStorage.remove(key).catch((error)=>console.error(`Receipt cleanup error: ${error.code || error.message}`));
    } catch (rawError) {
      if(storedReceiptKey)await fileStorage.remove(storedReceiptKey).catch(()=>{});
      const error = databaseError(rawError);
      if (error instanceof HttpError) sendJson(res, error.status, { error:error.message, ...(error.details||{}), details:error.details });
      else throw error;
    }
    return true;
  };
}

module.exports = { createPostgresWriteHandler, isHandledRoute };
