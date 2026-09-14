"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { JsonStorage } = require("../storage/json-storage");
const { storageConfig } = require("../storage/config");
const { PostgresStorage } = require("../storage/postgres/storage");
const { createPostgresWriteHandler } = require("../storage/postgres/api-writes");
const { attachRequestContext, readJsonBody, sendJson, serveStatic } = require("./http");
const { LoginRateLimiter, clientIp } = require("./login-rate-limit");
const { LocalFileStorage } = require("./file-storage");
const { RealtimeHub, resourcesForMutation } = require("./realtime");
const { validateTrialPayment } = require("./trial-registration");
const { createVpsDeploymentService, DeploymentError } = require("./vps-deployment");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = process.env.JSON_DB_FILE ? path.resolve(process.env.JSON_DB_FILE) : path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, "uploads");
const STORAGE_CONFIG = storageConfig({ rootDir: ROOT });
const TZ = "Asia/Almaty";
const fileStorage = new LocalFileStorage({ rootDir:UPLOAD_DIR, maxBytes:Number(process.env.RECEIPT_MAX_BYTES || 5_000_000) });
const realtimeHub = new RealtimeHub();
const CLIENT_ARCHIVE_REASONS={DUPLICATE:"Дубль",TEST:"Тест",ERROR:"Ошибка"};
const loginRateLimiter=new LoginRateLimiter({maxAttempts:Number(process.env.LOGIN_RATE_LIMIT_MAX||10),windowMillis:Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS||900000)});
const trustProxy=process.env.TRUST_PROXY==="true";
const secureCookie=process.env.NODE_ENV==="production"?" Secure;":"";
const loginRateKey=(req,login)=>`${clientIp(req,trustProxy)}:${String(login||"").trim().toLowerCase()}`;
const defaultRussianNames = { st_scheduled:"Запланирован", st_completed:"Завершён", st_reschedule:"Перенесён", st_no_show:"Неявка", st_refusal:"Отказ", st_payment:"Оплата", src_1:"Instagram", src_2:"TikTok", src_3:"Рекомендация", src_4:"Школа" };
const PERMISSION_CATALOG = {
  dashboard: ["view"],
  clients: ["view","create","edit","archive","changeStatus","addNotes","viewHistory","reassignManager","reassignCloser"],
  schedule: ["view","createOwnAvailability","editOwnAvailability","viewOthers","manageOthers","scheduleTrial","rescheduleTrial","assignUnassigned","reassignCloser"],
  crm: ["view","changeStatus"],
  payments: ["view","create","edit","viewHistory"],
  analytics: ["view","viewManager","viewCloser","viewSource","viewRefusal","export"],
  users: ["view","create","edit","archive","manageRoles","managePermissions"],
  settings: ["manageStatuses","manageRefusalReasons","manageLeadSources","managePaymentMethods","manageTags","manageBranding"],
  audit: ["view"]
};
const PERMISSION_KEYS = Object.entries(PERMISSION_CATALOG).flatMap(([module, actions]) => actions.map((action) => `${module}.${action}`));
const allPermissions = () => Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true]));
const pickedPermissions = (...keys) => Object.fromEntries(PERMISSION_KEYS.map((key) => [key, keys.includes(key)]));
function defaultRoles() {
  return [
    { id:"role_admin", name:"Администратор", systemKey:"ADMIN", baseRole:"ADMIN", isSystem:true, active:true, permissions:allPermissions(), scopes:{clients:"ALL",schedule:"ALL",payments:"ALL",analytics:"ALL"} },
    { id:"role_manager", name:"Менеджер", systemKey:"MANAGER", baseRole:"MANAGER", isSystem:true, active:true, permissions:pickedPermissions("clients.view","clients.create","clients.changeStatus","clients.addNotes","clients.viewHistory","schedule.view","schedule.viewOthers","schedule.scheduleTrial","schedule.rescheduleTrial","schedule.assignUnassigned","payments.view","payments.viewHistory","analytics.view","analytics.viewManager"), scopes:{clients:"OWN",schedule:"ALL",payments:"OWN",analytics:"OWN"} },
    { id:"role_closer", name:"Клоузер", systemKey:"CLOSER", baseRole:"CLOSER", isSystem:true, active:true, permissions:pickedPermissions("dashboard.view","clients.view","clients.changeStatus","clients.addNotes","clients.viewHistory","schedule.view","schedule.createOwnAvailability","schedule.editOwnAvailability","schedule.rescheduleTrial","crm.view","crm.changeStatus","payments.view","payments.create","payments.viewHistory","analytics.view","analytics.viewCloser"), scopes:{clients:"OWN",schedule:"OWN",payments:"OWN",analytics:"OWN"} }
  ].map((role) => ({ ...role, archivedAt:null, createdAt:now(), updatedAt:now() }));
}
function ensureAuthorizationModel(loaded) {
  let changed = false;
  if (!Array.isArray(loaded.roles)) { loaded.roles = defaultRoles(); changed = true; }
  for (const role of loaded.roles) {
    role.permissions ||= {}; role.scopes ||= {};
    if (!role.baseRole) { role.baseRole = role.systemKey || "MANAGER"; changed = true; }
    for (const key of PERMISSION_KEYS) if (role.permissions[key] === undefined) { role.permissions[key] = false; changed = true; }
    for (const resource of ["clients","schedule","payments","analytics"]) if (!role.scopes[resource]) { role.scopes[resource] = role.systemKey === "ADMIN" ? "ALL" : "OWN"; changed = true; }
  }
  for (const account of loaded.users) {
    if (!account.roleId) { account.roleId = ({ADMIN:"role_admin",MANAGER:"role_manager",CLOSER:"role_closer"})[account.role] || "role_manager"; changed = true; }
    if (!account.permissionOverrides) { account.permissionOverrides = {}; changed = true; }
    if (!account.scopeOverrides) { account.scopeOverrides = {}; changed = true; }
    if (account.teamId === undefined) { account.teamId = null; changed = true; }
  }
  let owner=loaded.users.find((account)=>account.isOwner===true);if(!owner){owner=loaded.users.find((account)=>account.id==="usr_admin")||loaded.users.find((account)=>account.role==="ADMIN");if(owner){owner.isOwner=true;changed=true;}}
  for(const account of loaded.users)if(account!==owner&&account.isOwner!==false){account.isOwner=false;changed=true;}
  for(const c of loaded.clients||[]){if(c.archivedAt===undefined){c.archivedAt=null;c.archivedByUserId=null;c.archiveReason=null;changed=true;}if(c.permanentlyDeletedAt===undefined){c.permanentlyDeletedAt=null;c.permanentlyDeletedByUserId=null;changed=true;}if(c.totalDealAmount===undefined){c.totalDealAmount=null;c.remainingPaymentDueDate=null;c.prepaymentStartedAt=null;changed=true;}if(c.statusChangedAt===undefined){c.statusChangedAt=null;changed=true;}}
  for(const configuredStatus of loaded.statuses||[]){if(configuredStatus.partialPayment===undefined){configuredStatus.partialPayment=false;changed=true;}}
  const requiredSystemGrants={MANAGER:["clients.changeStatus","schedule.rescheduleTrial","schedule.assignUnassigned","analytics.view","analytics.viewManager"],CLOSER:["analytics.view","analytics.viewCloser"]};
  for(const role of loaded.roles){for(const key of requiredSystemGrants[role.systemKey]||[]){if(role.permissions[key]!==true){role.permissions[key]=true;changed=true;}}}
  const noShow=loaded.statuses?.find((item)=>item.id==="st_no_show");if(noShow&&noShow.actionType!=="MARK_NO_SHOW"){noShow.actionType="MARK_NO_SHOW";noShow.requiredFields=[];changed=true;}
  for(const deletedClient of (loaded.clients||[]).filter(item=>item.permanentlyDeletedAt)){
    const trialIds=new Set((loaded.trials||[]).filter(item=>item.clientId===deletedClient.id).map(item=>item.id)),paymentIds=new Set((loaded.payments||[]).filter(item=>item.clientId===deletedClient.id).map(item=>item.id)),removed={trials:trialIds.size,payments:paymentIds.size,notes:(loaded.notes||[]).filter(item=>item.clientId===deletedClient.id).length,history:(loaded.history||[]).filter(item=>item.clientId===deletedClient.id).length};
    for(const slot of (loaded.availabilitySlots||[]).filter(item=>trialIds.has(item.bookedTrialId))){slot.status="FREE";slot.bookedTrialId=null;}
    loaded.trials=(loaded.trials||[]).filter(item=>item.clientId!==deletedClient.id);loaded.payments=(loaded.payments||[]).filter(item=>item.clientId!==deletedClient.id);loaded.notes=(loaded.notes||[]).filter(item=>item.clientId!==deletedClient.id);loaded.history=(loaded.history||[]).filter(item=>item.clientId!==deletedClient.id);loaded.notifications=(loaded.notifications||[]).filter(item=>item.clientId!==deletedClient.id);
    loaded.auditLogs=(loaded.auditLogs||[]).filter(item=>!(item.entityType==="CLIENT"&&item.entityId===deletedClient.id)&&!(item.entityType==="PAYMENT"&&paymentIds.has(item.entityId)));loaded.auditLogs.push({id:`audit_${crypto.randomUUID().slice(0,8)}`,actorUserId:deletedClient.permanentlyDeletedByUserId||owner?.id||null,entityType:"CLIENT",entityId:deletedClient.id,action:"CLIENT_PERMANENTLY_DELETED",oldValue:null,newValue:{hardDeleted:true,relatedRecordsRemoved:removed},createdAt:deletedClient.permanentlyDeletedAt||new Date().toISOString()});
    loaded.clients=loaded.clients.filter(item=>item.id!==deletedClient.id);changed=true;
  }
  return changed;
}

const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const hashPassword = (value, salt = crypto.randomBytes(16).toString("hex")) => {
  const hash = crypto.scryptSync(value, salt, 64).toString("hex");
  return `${salt}:${hash}`;
};
const verifyPassword = (value, stored) => {
  const [salt, expected] = stored.split(":");
  const actual = crypto.scryptSync(value, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, "hex"));
};

function localIso(days = 0, hour = 10, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function seedDatabase() {
  const users = [
    { id: "usr_admin", name: "Amina Milton", login: "admin@milton.kz", role: "ADMIN", avatarUrl: "", profileStatus: "WORKING", active: true },
    { id: "usr_manager", name: "Aruzhan S.", login: "manager@milton.kz", role: "MANAGER", avatarUrl: "", profileStatus: "WORKING", active: true },
    { id: "usr_manager2", name: "Aigerim K.", login: "aigerim@milton.kz", role: "MANAGER", avatarUrl: "", profileStatus: "DAY_OFF", active: true },
    { id: "usr_closer", name: "Daniyar T.", login: "closer@milton.kz", role: "CLOSER", avatarUrl: "", profileStatus: "WORKING", active: true },
    { id: "usr_closer2", name: "Alisher B.", login: "alisher@milton.kz", role: "CLOSER", avatarUrl: "", profileStatus: "NOT_ACCEPTING", active: true }
  ].map((u) => ({ ...u, isOwner:u.id==="usr_admin",passwordHash: hashPassword("demo123"), archivedAt: null, createdAt: now(), updatedAt: now() }));
  const statuses = [
    { id: "st_scheduled", name: "Scheduled", color: "#4F6BED", sortOrder: 1, actionType: "NONE", requiredFields: [], active: true },
    { id: "st_completed", name: "Completed", color: "#14A06F", sortOrder: 2, actionType: "NONE", requiredFields: [], active: true },
    { id: "st_reschedule", name: "Rescheduled", color: "#9C6ADE", sortOrder: 3, actionType: "REQUIRE_RESCHEDULE", requiredFields: ["newSlotId"], active: true },
    { id: "st_no_show", name: "No-show", color: "#E7952C", sortOrder: 4, actionType: "MARK_NO_SHOW", requiredFields: [], active: true },
    { id: "st_refusal", name: "Refusal", color: "#D64C4C", sortOrder: 5, actionType: "REQUIRE_REFUSAL_REASON", requiredFields: ["refusalReasonId"], active: true },
    { id: "st_payment", name: "Payment", color: "#087F5B", sortOrder: 6, actionType: "REQUIRE_PAYMENT", requiredFields: ["amount", "paymentMethodId", "paymentDate"], active: true }
  ];
  const leadSources = ["Instagram", "TikTok", "Recommendation", "School"].map((name, i) => ({ id: `src_${i + 1}`, name, active: true, sortOrder: i + 1 }));
  const tags = ["Hot", "VIP", "Repeat", "School"].map((name, i) => ({ id: `tag_${i + 1}`, name, active: true, color: ["#FDE7E7", "#EEE7FD", "#E7F6EE", "#E8F0FE"][i] }));
  const refusalReasons = ["Price", "Schedule", "Not ready", "Chose another school"].map((name, i) => ({ id: `reason_${i + 1}`, name, active: true, sortOrder: i + 1 }));
  const paymentMethods = ["Kaspi Gold", "Kaspi installment", "Cash", "Transfer"].map((name, i) => ({ id: `method_${i + 1}`, name, active: true, sortOrder: i + 1 }));
  const clients = [
    { id: "cl_1", name: "Aisha Nurgali", normalizedPhone: "+77071234567", originalPhone: "8 707 123 45 67", originalManagerId: "usr_manager", currentManagerId: "usr_manager", currentCloserId: "usr_closer", currentStatusId: "st_scheduled", leadSourceId: "src_1", tagIds: ["tag_1"], registrationComment: "Beginner. Interested in speaking, three times per week.", createdAt: localIso(-2, 11), updatedAt: now() },
    { id: "cl_2", name: "Timur Bekov", normalizedPhone: "+77025551212", originalPhone: "+7 702 555 12 12", originalManagerId: "usr_manager", currentManagerId: "usr_manager", currentCloserId: "usr_closer", currentStatusId: "st_payment", leadSourceId: "src_3", tagIds: ["tag_2"], registrationComment: "Intermediate. Looking for an evening group.", createdAt: localIso(-6, 14), updatedAt: now() },
    { id: "cl_3", name: "Madina Omar", normalizedPhone: "+77771114455", originalPhone: "+7 777 111 44 55", originalManagerId: "usr_manager2", currentManagerId: "usr_manager2", currentCloserId: "usr_closer2", currentStatusId: "st_refusal", leadSourceId: "src_2", tagIds: [], registrationComment: "Needs IELTS preparation.", createdAt: localIso(-8, 9), updatedAt: now() }
  ].map((c)=>({...c,archivedAt:null,archivedByUserId:null,archiveReason:null,permanentlyDeletedAt:null,permanentlyDeletedByUserId:null}));
  const trials = [
    { id: "trial_1", clientId: "cl_1", closerId: "usr_closer", managerId: "usr_manager", slotId: "slot_booked_1", scheduledAt: localIso(0, 15), completedAt: null, statusAtBookingId: "st_scheduled", active: true, createdAt: localIso(-2, 11) },
    { id: "trial_2", clientId: "cl_2", closerId: "usr_closer", managerId: "usr_manager", slotId: "slot_old_2", scheduledAt: localIso(-2, 17), completedAt: localIso(-2, 18), statusAtBookingId: "st_scheduled", active: false, createdAt: localIso(-6, 14) },
    { id: "trial_3", clientId: "cl_3", closerId: "usr_closer2", managerId: "usr_manager2", slotId: "slot_old_3", scheduledAt: localIso(-4, 12), completedAt: localIso(-4, 13), statusAtBookingId: "st_scheduled", active: false, createdAt: localIso(-8, 9) }
  ];
  const availabilitySlots = [];
  for (const closerId of ["usr_closer", "usr_closer2"]) {
    for (let day = 0; day < 7; day++) {
      for (let hour = 10; hour < 19; hour++) {
        const startAt = localIso(day, hour);
        const seededBooking = closerId === "usr_closer" && day === 0 && hour === 15;
        availabilitySlots.push({ id: seededBooking ? "slot_booked_1" : id("slot"), closerId, startAt, endAt: localIso(day, hour + 1), status: seededBooking ? "BOOKED" : "FREE", bookedTrialId: seededBooking ? "trial_1" : null, createdAt: now() });
      }
    }
  }
  const payments = [{ id: "pay_1", clientId: "cl_2", managerAttributionId: "usr_manager", closerAttributionId: "usr_closer", amount: 45000, paymentMethodId: "method_1", paymentDate: localIso(-2).slice(0, 10), comment: "Group package", createdBy: "usr_closer", createdAt: localIso(-2, 18), correctedFromPaymentId: null, voidedAt: null }];
  const notes = [{ id: "note_1", clientId: "cl_2", authorUserId: "usr_closer", noteType: "CLOSER_NOTE", text: "Level: Elementary. Client liked the teacher and chose the evening group.", createdAt: localIso(-2, 18) }];
  const history = clients.map((c) => ({ id: id("hist"), clientId: c.id, actorUserId: c.originalManagerId, eventType: "CLIENT_CREATED", oldValue: null, newValue: { name: c.name }, createdAt: c.createdAt }));
  return { meta: { version: 1, timezone: TZ, branding: { companyName: "Milton", accentColor: "#3157D5", logoUrl: "" }, reminderMinutes: 30 }, users, statuses, leadSources, tags, refusalReasons, paymentMethods, clients, availabilitySlots, trials, payments, paymentCorrections:[], notes, history, notifications: [], auditLogs: [], savedFilters: [] };
}

function migrateLoadedDb(loaded) {
  let migrated = ensureAuthorizationModel(loaded);
  if (!Array.isArray(loaded.paymentCorrections)) { loaded.paymentCorrections = []; migrated = true; }
  // Repair early demo seeds without discarding any user-created data.
  for (const trial of loaded.trials.filter((item) => item.active)) {
    if (!loaded.availabilitySlots.some((slot) => slot.id === trial.slotId)) {
      const matching = loaded.availabilitySlots.find((slot) => slot.closerId === trial.closerId && slot.startAt === trial.scheduledAt && slot.bookedTrialId === trial.id);
      if (matching) { matching.id = trial.slotId; migrated = true; }
    }
  }
  for (const trial of loaded.trials) {
    if (!trial.trialType) { trial.trialType="FREE"; trial.trialAmount=0; trial.trialPaymentDate=null; trial.registeredByUserId=trial.managerId; trial.receiptStorageKey=null; trial.receiptOriginalName=null; trial.receiptMimeType=null; trial.receiptSizeBytes=null; trial.receiptUploadedAt=null; migrated=true; }
    if(!trial.assignmentState){trial.assignmentState=trial.slotId?"SCHEDULED":"UNASSIGNED";trial.preferredTimeText||="";trial.preferredDate||=null;trial.preferredStartTime||=null;trial.preferredEndTime||=null;trial.assignedAt=trial.slotId?(trial.assignedAt||trial.createdAt):null;trial.assignedByUserId||=null;trial.assignmentVersion||=1;migrated=true;}
  }
  if(loaded.meta.unassignedTrialReminderMinutes===undefined){loaded.meta.unassignedTrialReminderMinutes=120;migrated=true;}
  return migrated;
}
const requestState = new AsyncLocalStorage();
const jsonStorage = new JsonStorage({ filePath:DB_FILE, seed:seedDatabase, migrate:migrateLoadedDb, permissionCatalog:PERMISSION_CATALOG });
let runtimeStorage = STORAGE_CONFIG.backend === "postgres"
  ? PostgresStorage.connect(STORAGE_CONFIG.databaseUrl, {
      max: STORAGE_CONFIG.poolMax,
      connectionTimeoutMillis: STORAGE_CONFIG.connectionTimeoutMillis,
      idleTimeoutMillis: STORAGE_CONFIG.idleTimeoutMillis,
      queryTimeoutMillis: STORAGE_CONFIG.queryTimeoutMillis,
      applicationName: STORAGE_CONFIG.applicationName,
      stateCacheTtlMillis: STORAGE_CONFIG.stateCacheTtlMillis,
      ssl: STORAGE_CONFIG.ssl,
    })
  : jsonStorage;
let postgresWriteHandler;
let vpsDeploymentService=createVpsDeploymentService();
let fallbackDb = STORAGE_CONFIG.backend === "json" ? jsonStorage.load() : null;
const activeState = () => requestState.getStore()?.state || fallbackDb;
const activeStorage = () => requestState.getStore()?.storage || runtimeStorage;
const db = new Proxy({}, {
  get(_target, property) { const state=activeState(); if(!state)throw new Error("Storage state is unavailable outside an API request"); return state[property]; },
  set(_target, property, next) { const state=activeState(); if(!state)throw new Error("Storage state is unavailable outside an API request"); state[property]=next; return true; },
  ownKeys() { return Reflect.ownKeys(activeState() || {}); },
  getOwnPropertyDescriptor() { return { enumerable:true, configurable:true }; },
});
function setDbForTests(next) { ensureAuthorizationModel(next); next.paymentCorrections ||= []; fallbackDb = next; jsonStorage.replaceState(next); }
function setStorageForTests(next) {
  runtimeStorage = next;
  if (postgresWriteHandler) postgresWriteHandler=createPostgresWriteHandler({storage:runtimeStorage,readBody:body,sendJson,normalizePhone,archiveReasons:CLIENT_ARCHIVE_REASONS,hashPassword,validImageData,fileStorage,validateTrialPayment});
}
function setVpsDeploymentServiceForTests(next) { vpsDeploymentService=next; }
function saveDb() {
  const context=requestState.getStore();
  if(context){context.dirty=true;return;}
  if(STORAGE_CONFIG.backend!=="json")throw new Error("saveDb must run inside a storage transaction");
  jsonStorage.replaceState(fallbackDb);jsonStorage.save();
}

function normalizePhone(input = "") {
  let digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "8") digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return digits.length === 11 && digits[0] === "7" ? `+${digits}` : `+${digits}`;
}
function publicUser(u) { if(!u)return null; const { passwordHash, permissionOverrides, scopeOverrides, ...safe } = u; return safe; }
function adminUserView(u) { if(!u)return null; const { passwordHash, ...safe } = u; return safe; }
function status(id) { return db.statuses.find((x) => x.id === id); }
function user(id) { return db.users.find((x) => x.id === id); }
function client(id) { return db.clients.find((x) => x.id === id); }
function roleFor(actor) { return db.roles.find((role) => role.id === actor.roleId && role.active); }
function hasPermission(actor, key) {
  if (!actor?.active || !PERMISSION_KEYS.includes(key)) return false;
  if (Object.prototype.hasOwnProperty.call(actor.permissionOverrides || {}, key)) return actor.permissionOverrides[key] === true;
  return roleFor(actor)?.permissions?.[key] === true;
}
function scopeFor(actor, resource) { return actor.scopeOverrides?.[resource] || roleFor(actor)?.scopes?.[resource] || "OWN"; }
function effectiveAccess(actor) { return { permissions:Object.fromEntries(PERMISSION_KEYS.map((key) => [key, hasPermission(actor,key)])), scopes:Object.fromEntries(["clients","schedule","payments","analytics"].map((resource) => [resource,scopeFor(actor,resource)])) }; }
function belongsToTeam(actor, assignedUserId) { const assigned = user(assignedUserId); return Boolean(actor.teamId && assigned?.teamId && actor.teamId === assigned.teamId); }
function clientMatchesScope(actor,c,resource) {
  const scope = scopeFor(actor,resource);
  if (scope === "ALL") return true;
  if (scope === "TEAM") return belongsToTeam(actor,c.currentManagerId) || belongsToTeam(actor,c.currentCloserId);
  return c.currentManagerId === actor.id || c.currentCloserId === actor.id;
}
function canSeeClient(actor, c) { return Boolean(c&&!c.archivedAt&&!c.permanentlyDeletedAt&&hasPermission(actor,"clients.view")&&clientMatchesScope(actor,c,"clients")); }
function canSeeArchivedClient(actor,c){return Boolean(c&&c.archivedAt&&!c.permanentlyDeletedAt&&hasPermission(actor,"clients.view")&&hasPermission(actor,"clients.archive")&&clientMatchesScope(actor,c,"clients"));}
function canOpenClient(actor,c){return canSeeClient(actor,c)||canSeeArchivedClient(actor,c);}
function userMatchesScope(actor,targetUserId,resource) { const scope=scopeFor(actor,resource); return scope==="ALL" || (scope==="TEAM"&&belongsToTeam(actor,targetUserId)) || targetUserId===actor.id; }
function analyticsUsersFor(actor){const scope=scopeFor(actor,"analytics");if(scope==="ALL")return db.users;const ids=new Set([actor.id]);for(const c of db.clients.filter((item)=>clientMatchesScope(actor,item,"analytics"))){ids.add(c.currentManagerId);ids.add(c.currentCloserId);}if(scope==="TEAM")for(const account of db.users)if(belongsToTeam(actor,account.id))ids.add(account.id);return db.users.filter((account)=>ids.has(account.id));}
function enrichClient(c,viewer=null) {
  const activeTrial = db.trials.find((t) => t.clientId === c.id && t.active);
  const allPayments = !viewer || hasPermission(viewer,"payments.view") ? db.payments.filter((p) => p.clientId === c.id && !p.voidedAt) : [];
  const overdue = activeTrial?.assignmentState!=="UNASSIGNED" && activeTrial?.scheduledAt && new Date(activeTrial.scheduledAt).getTime() + 3600000 < Date.now() && c.currentStatusId === activeTrial.statusAtBookingId;
  const paymentTotal=allPayments.reduce((n,p)=>n+Number(p.amount),0),totalDealAmount=Number(c.totalDealAmount||0),remainingAmount=Math.max(0,totalDealAmount-paymentTotal);
  const statusChangedAt=c.statusChangedAt||db.history.filter((item)=>item.clientId===c.id&&item.eventType==="STATUS_CHANGED"&&item.newValue?.statusId===c.currentStatusId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0]?.createdAt||c.createdAt;
  const prepayment=totalDealAmount>0?{totalDealAmount,paymentTotal,remainingAmount,dueDate:c.remainingPaymentDueDate||null,startedAt:c.prepaymentStartedAt||null,active:remainingAmount>0}:null;
  return { ...c,statusChangedAt, manager: publicUser(user(c.currentManagerId)), closer: publicUser(user(c.currentCloserId))||{id:null,name:"Без клоузера",role:"CLOSER",avatarUrl:""}, originalManager: publicUser(user(c.originalManagerId)), archivedBy:publicUser(user(c.archivedByUserId)),archiveReasonLabel:CLIENT_ARCHIVE_REASONS[c.archiveReason]||c.archiveReason||null,status: status(c.currentStatusId), currentReason:db.refusalReasons.find((x)=>x.id===c.currentReasonId)||null, leadSource: db.leadSources.find((x) => x.id === c.leadSourceId), tags: db.tags.filter((x) => c.tagIds.includes(x.id)), activeTrial, payments: allPayments, paymentTotal,prepayment, overdue: Boolean(overdue) };
}
function canSeeUnassigned(actor,trial){const c=client(trial.clientId);return Boolean(c&&trial.active&&trial.assignmentState==="UNASSIGNED"&&canSeeClient(actor,c)&&hasPermission(actor,"schedule.assignUnassigned"));}
function unassignedPayload(actor){return db.trials.filter((trial)=>canSeeUnassigned(actor,trial)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map((trial)=>{const c=enrichClient(client(trial.clientId),actor);return{...trial,client:c,manager:publicUser(user(trial.managerId)),waitingSeconds:Math.max(0,Math.floor((Date.now()-new Date(trial.createdAt).getTime())/1000)),receiptUrl:trial.receiptStorageKey?`/api/trials/${trial.id}/receipt`:null};});}
function history(clientId, actorId, eventType, oldValue, newValue) { db.history.push({ id: id("hist"), clientId, actorUserId: actorId, eventType, oldValue, newValue, createdAt: now() }); }
function audit(actorId, entityType, entityId, action, oldValue, newValue) { db.auditLogs.push({ id: id("audit"), actorUserId: actorId, entityType, entityId, action, oldValue, newValue, createdAt: now() }); }
function notify(userId, clientId, type, content, trialId=null) { if(!userId)return;const existing=db.notifications.find((n)=>n.userId===userId&&n.trialId===trialId&&n.type===type&&!n.resolvedAt);if(existing){existing.content=content;existing.updatedAt=now();return existing;}const value={ id: id("notif"), userId, clientId, trialId, type, content, readAt: null, snoozedUntil:null,resolvedAt:null,createdAt: now(),updatedAt:now() };db.notifications.push(value);return value; }

const json = (res, code, value) => { const context=requestState.getStore();if(context){context.response={code,value};return;}return sendJson(res,code,value); };
const fail = (res, code, message, details) => json(res, code, { error: message, details });
const body = readJsonBody;
async function actorFrom(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "") || (req.headers.cookie || "").match(/milton_session=([^;]+)/)?.[1];
  const uid = token ? await activeStorage().sessions.getUserId(token) : null;
  return uid ? db.users.find((u) => u.id === uid && u.active) : null;
}
function requirePermission(res, actor, permission) { if (!actor) { fail(res, 401, "Требуется авторизация"); return false; } if (!hasPermission(actor, permission)) { fail(res, 403, "У вас нет прав для этого действия"); return false; } return true; }
function paymentStatusPermissionMessage(statusName) { return `Для статуса «${statusName || "Оплата/Чек"}» требуется право «Оплаты → Создание оплаты» (payments.create)`; }
function canManageUserRoles(actor) { return ["users.manageRoles","users.create","users.edit"].some((key)=>hasPermission(actor,key)); }
function cleanPermissions(input = {}) { return Object.fromEntries(Object.entries(input).filter(([key,value]) => PERMISSION_KEYS.includes(key) && (value === true || value === false || value === null))); }
function cleanScopes(input = {}) { return Object.fromEntries(Object.entries(input).filter(([key,value]) => ["clients","schedule","payments","analytics"].includes(key) && ["OWN","TEAM","ALL",null].includes(value))); }
function applyOverrides(current,changes) { const next={...(current||{})}; for(const [key,value] of Object.entries(changes)){if(value===null)delete next[key];else next[key]=value;} return next; }
function validImageData(value) { return !value || (/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(value) && value.length <= 1_500_000); }
const CONFIG_TYPES={statuses:{collection:"statuses",permission:"settings.manageStatuses",prefix:"st"},leadSources:{collection:"leadSources",permission:"settings.manageLeadSources",prefix:"src"},refusalReasons:{collection:"refusalReasons",permission:"settings.manageRefusalReasons",prefix:"reason"},paymentMethods:{collection:"paymentMethods",permission:"settings.managePaymentMethods",prefix:"method"},tags:{collection:"tags",permission:"settings.manageTags",prefix:"tag"}};
function configPayload(type,input,current={}) {
  const name=String(input.name??current.name??"").trim();if(!name)return null;
  const base={...current,name,active:input.active??current.active??true,sortOrder:Number(input.sortOrder??current.sortOrder??0)};
  if(type==="statuses"){base.color=/^#[0-9a-fA-F]{6}$/.test(input.color||current.color||"")?(input.color||current.color):"#7C879E";base.actionType=["NONE","MARK_NO_SHOW","REQUIRE_REFUSAL_REASON","REQUIRE_RESCHEDULE","REQUIRE_PAYMENT"].includes(input.actionType)?input.actionType:(current.actionType||"NONE");base.requiredFields={NONE:[],MARK_NO_SHOW:[],REQUIRE_REFUSAL_REASON:["refusalReasonId"],REQUIRE_RESCHEDULE:["newSlotId"],REQUIRE_PAYMENT:["amount","paymentMethodId","paymentDate"]}[base.actionType];base.partialPayment=input.partialPayment===true||input.partialPayment==="on";}
  if(type==="tags")base.color=/^#[0-9a-fA-F]{6}$/.test(input.color||current.color||"")?(input.color||current.color):"#EDF0F5";
  return base;
}
function ensureOperationalNotifications(actor){
  const before=JSON.stringify(db.notifications);
  const current=Date.now(),reminder=(db.meta.reminderMinutes||30)*60000;
  for(const trial of db.trials.filter((item)=>item.active&&item.closerId===actor.id&&!client(item.clientId)?.archivedAt&&!client(item.clientId)?.permanentlyDeletedAt)){
    const starts=new Date(trial.scheduledAt).getTime(),c=client(trial.clientId);if(!c)continue;
    const add=(type,content)=>notify(actor.id,c.id,type,content,trial.id);
    if(starts>=current&&starts-current<=reminder)add("TRIAL_REMINDER",`${c.name} · пробный урок скоро начнётся`);
    if(current>starts+3600000&&c.currentStatusId===trial.statusAtBookingId)add("TRIAL_OVERDUE",`${c.name} · результат пробного урока просрочен`);
  }
  const threshold=Number(db.meta.unassignedTrialReminderMinutes??120)*60000;if(threshold>0)for(const trial of db.trials.filter((item)=>canSeeUnassigned(actor,item)&&Date.now()-new Date(item.createdAt).getTime()>=threshold)){const c=client(trial.clientId),type=trial.pendingReschedule?"TRIAL_RESCHEDULE_PENDING":"UNASSIGNED_TRIAL_OVERDUE";notify(actor.id,c.id,type,trial.pendingReschedule?`${c.name} · пробный ожидает нового времени`:`${c.name} · пробный ожидает назначения`,trial.id);}
  if(hasPermission(actor,"payments.view"))for(const c of db.clients.filter((item)=>canSeeClient(actor,item)&&item.totalDealAmount)){const paid=db.payments.filter((payment)=>payment.clientId===c.id&&!payment.voidedAt).reduce((sum,payment)=>sum+Number(payment.amount),0),remaining=Math.max(0,Number(c.totalDealAmount)-paid),due=c.remainingPaymentDueDate,existing=db.notifications.filter((item)=>item.userId===actor.id&&item.clientId===c.id&&item.type==="PREPAYMENT_BALANCE_DUE"&&!item.resolvedAt);if(remaining<=0||!due){for(const item of existing){item.resolvedAt=now();item.snoozedUntil=null;item.updatedAt=now();}continue;}if(due<=dayKey(now()))notify(actor.id,c.id,"PREPAYMENT_BALANCE_DUE",`${c.name} · ${due===dayKey(now())?'доплата сегодня':'доплата просрочена'}: ${remaining} ₸`);}
  return before!==JSON.stringify(db.notifications);
}

function dashboard(actor) {
  const visible = db.clients.filter((c) => canSeeClient(actor, c));
  const paymentClients = db.clients.filter((c) => !c.archivedAt&&!c.permanentlyDeletedAt&&clientMatchesScope(actor,c,"payments"));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const trials = db.trials.filter((t) => visible.some((c) => c.id === t.clientId) && new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(t.scheduledAt)) === today);
  const pays = db.payments.filter((p) => paymentClients.some((c) => c.id === p.clientId) && p.paymentDate === today && !p.voidedAt);
  return { clients: visible.length, todayTrials: trials.length, completed: trials.filter((t) => t.completedAt).length, remaining: trials.filter((t) => new Date(t.scheduledAt) >= new Date()).length, payments: hasPermission(actor,"payments.view")?pays.length:0, revenue: hasPermission(actor,"payments.view")?pays.reduce((n, p) => n + Number(p.amount), 0):0, overdue: visible.map((c)=>enrichClient(c,actor)).filter((c) => c.overdue).length, upcoming: trials.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map((t) => ({ ...t, client: enrichClient(client(t.clientId),actor) })) };
}

function bootstrapPayload(actor) {
  const visibleClients=db.clients.filter((c)=>canSeeClient(actor,c)).map((c)=>enrichClient(c,actor));
  const archivedClients=hasPermission(actor,"clients.archive")?db.clients.filter((c)=>canSeeArchivedClient(actor,c)).map((c)=>enrichClient(c,actor)):[];
  const analyticsDimensions=hasPermission(actor,"analytics.view")?{users:analyticsUsersFor(actor).map(publicUser),statuses:db.statuses,leadSources:db.leadSources,tags:db.tags,refusalReasons:db.refusalReasons,paymentMethods:db.paymentMethods}:null;
  return {me:publicUser(actor),access:effectiveAccess(actor),permissionCatalog:PERMISSION_CATALOG,branding:db.meta.branding,timezone:db.meta.timezone,unassignedReminderMinutes:db.meta.unassignedTrialReminderMinutes||120,dashboard:dashboard(actor),clients:visibleClients,archivedClients,archiveReasons:CLIENT_ARCHIVE_REASONS,unassignedTrials:actor.role==="ADMIN"&&hasPermission(actor,"schedule.assignUnassigned")?unassignedPayload(actor):[],users:db.users.filter((u)=>hasPermission(actor,"users.view")||u.active).map((u)=>hasPermission(actor,"users.managePermissions")?adminUserView(u):publicUser(u)),roles:canManageUserRoles(actor)?db.roles:[],statuses:db.statuses,leadSources:db.leadSources,tags:db.tags,refusalReasons:db.refusalReasons,paymentMethods:db.paymentMethods,analyticsDimensions,notifications:db.notifications.filter((n)=>n.userId===actor.id).slice(-50).reverse()};
}

function syncPayload(actor,resources){
  const full=bootstrapPayload(actor);if(resources.has("bootstrap"))return full;
  const keys=new Set(),add=(...items)=>items.forEach((item)=>keys.add(item));
  if(["clients","trials","payments","schedule","analytics"].some((item)=>resources.has(item)))add("dashboard","clients","archivedClients","archiveReasons","unassignedTrials","unassignedReminderMinutes");
  if(resources.has("notifications"))add("notifications");
  if(["users","profile"].some((item)=>resources.has(item)))add("me","access","users","roles","analyticsDimensions");
  if(resources.has("settings"))add("me","access","permissionCatalog","branding","users","roles","analyticsDimensions");
  if(resources.has("references"))add("statuses","leadSources","tags","refusalReasons","paymentMethods","analyticsDimensions");
  return Object.fromEntries([...keys].map((key)=>[key,full[key]]));
}

const dayKey = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Intl.DateTimeFormat("en-CA", { timeZone:TZ }).format(new Date(value));
const inRange = (value,from,to) => { const key=dayKey(value); return key>=from&&key<=to; };
const addDays = (date,days) => { const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10); };
const daysBetween = (from,to) => Math.max(1,Math.round((new Date(`${to}T12:00:00Z`)-new Date(`${from}T12:00:00Z`))/86400000)+1);
function analyticsFilters(params) {
  const current=dayKey(now()),monthStart=`${current.slice(0,8)}01`,from=/^\d{4}-\d{2}-\d{2}$/.test(params.get("from")||"")?params.get("from"):monthStart,to=/^\d{4}-\d{2}-\d{2}$/.test(params.get("to")||"")?params.get("to"):current;
  return { from:from<=to?from:to,to:from<=to?to:from,managerId:params.get("managerId")||"",closerId:params.get("closerId")||"",sourceId:params.get("sourceId")||"",statusId:params.get("statusId")||"",paymentMethodId:params.get("paymentMethodId")||"",refusalReasonId:params.get("refusalReasonId")||"",tagId:params.get("tagId")||"",dateType:["client","trial","payment"].includes(params.get("dateType"))?params.get("dateType"):"trial",compare:params.get("compare")==="true",includeArchived:params.get("includeArchived")==="true" };
}
function latestRefusalReason(clientId) { return db.history.filter((item)=>item.clientId===clientId&&item.newValue?.refusalReasonId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]?.newValue?.refusalReasonId||""; }
function analyticsClientMatch(actor,c,f,ignoreSource=false) {
  if((c.archivedAt||c.permanentlyDeletedAt)&&!f.includeArchived)return false;
  if(!clientMatchesScope(actor,c,"analytics"))return false;
  if(!ignoreSource&&f.sourceId&&c.leadSourceId!==f.sourceId)return false;
  if(f.statusId&&c.currentStatusId!==f.statusId)return false;
  if(f.tagId&&!c.tagIds.includes(f.tagId))return false;
  if(f.refusalReasonId&&latestRefusalReason(c.id)!==f.refusalReasonId)return false;
  if(f.paymentMethodId&&!db.payments.some((p)=>!p.voidedAt&&p.clientId===c.id&&p.paymentMethodId===f.paymentMethodId))return false;
  return true;
}
function trialAttendanceOutcome(trial) {
  if(trial.attendanceOutcome)return trial.attendanceOutcome;
  const result=status(trial.resultStatusId);
  if(result?.actionType==="MARK_NO_SHOW")return "NO_SHOW";
  if(result?.actionType==="REQUIRE_RESCHEDULE")return "RESCHEDULED";
  const wasRescheduled=db.history.some((item)=>item.clientId===trial.clientId&&item.eventType==="TRIAL_RESCHEDULED"&&item.oldValue?.scheduledAt===trial.scheduledAt);
  if(wasRescheduled||(!trial.active&&!trial.completedAt&&db.trials.some((other)=>other.clientId===trial.clientId&&other.createdAt>trial.createdAt)))return "RESCHEDULED";
  if(trial.completedAt||trial.resultStatusId)return "REACHED";
  if(trial.active&&Date.now()>new Date(trial.scheduledAt).getTime()+3600000)return "OVERDUE";
  return "PENDING";
}
function displayTrialStatus(trial) {
  if (trial.active) return "Записан";
  if (trial.attendanceOutcome === "RESCHEDULED") return "Перенос";
  if (trial.attendanceOutcome === "NO_SHOW") return "Не пришёл";
  if (status(trial.resultStatusId)?.actionType === "REQUIRE_PAYMENT") return "Чек";
  return defaultRussianNames[trial.resultStatusId] || status(trial.resultStatusId)?.name || "Завершён";
}
function permittedScheduleClosers(actor){
  const mayViewOthers=hasPermission(actor,"schedule.viewOthers")||hasPermission(actor,"schedule.manageOthers");
  return db.users.filter((account)=>account.active&&account.role==="CLOSER"&&(account.id===actor.id||(mayViewOthers&&userMatchesScope(actor,account.id,"schedule"))));
}
function scheduleSlotPayload(slot,actor){
  const events=db.trials.filter((trial)=>trial.slotId===slot.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map((trial)=>{
    const next=trial.attendanceOutcome==="RESCHEDULED"?db.trials.filter((candidate)=>candidate.clientId===trial.clientId&&candidate.id!==trial.id&&candidate.createdAt>=trial.resultAt).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]:null;
    const visibleClient=client(trial.clientId),mayOpen=visibleClient&&canOpenClient(actor,visibleClient),manager=user(trial.managerId);
    return{id:trial.id,clientId:mayOpen?trial.clientId:null,clientName:mayOpen?visibleClient.name:null,slotId:trial.slotId,scheduledAt:trial.scheduledAt,active:trial.active,resultStatusId:trial.resultStatusId||null,attendanceOutcome:trial.attendanceOutcome||null,statusName:displayTrialStatus(trial),manager:manager?publicUser(manager):null,rescheduledTo:next?{trialId:next.id,scheduledAt:next.scheduledAt}:null};
  });
  const booked=events.find((trial)=>trial.id===slot.bookedTrialId);
  return{...slot,clientId:booked?.clientId||null,events};
}
function attendanceSummary(trials) {
  const scheduled=trials.length,noShow=trials.filter((trial)=>trialAttendanceOutcome(trial)==="NO_SHOW").length,rescheduled=trials.filter((trial)=>trialAttendanceOutcome(trial)==="RESCHEDULED").length,unresolvedOverdue=trials.filter((trial)=>trialAttendanceOutcome(trial)==="OVERDUE").length;
  const formulaReached=Math.max(0,scheduled-noShow-rescheduled),reached=Math.max(0,formulaReached-unresolvedOverdue),attendance=scheduled?reached/scheduled*100:0;
  return {scheduled,noShow,rescheduled,formulaReached,reached,unresolvedOverdue,attendance};
}
function trendGranularity(from,to){const days=daysBetween(from,to);return days<=45?"day":days<=180?"week":"month";}
function bucketKey(date,granularity){if(granularity==="day")return date;if(granularity==="month")return date.slice(0,7);const d=new Date(`${date}T12:00:00Z`),day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()-day+1);return d.toISOString().slice(0,10);}
function analyticsReport(actor,f,includeComparison=true){
  const scopedClients=db.clients.filter((c)=>analyticsClientMatch(actor,c,f)),clientIds=new Set(scopedClients.map((c)=>c.id));
  const trialRows=db.trials.filter((t)=>t.assignmentState!=="UNASSIGNED"&&t.scheduledAt&&clientIds.has(t.clientId)&&inRange(t.scheduledAt,f.from,f.to)&&(!f.managerId||t.managerId===f.managerId)&&(!f.closerId||t.closerId===f.closerId));
  const paymentRows=db.payments.filter((p)=>!p.voidedAt&&clientIds.has(p.clientId)&&inRange(p.paymentDate,f.from,f.to)&&(!f.managerId||p.managerAttributionId===f.managerId)&&(!f.closerId||p.closerAttributionId===f.closerId)&&(!f.paymentMethodId||p.paymentMethodId===f.paymentMethodId));
  const trialClientIds=[...new Set(trialRows.map((t)=>t.clientId))];
  const convertedClientIds=trialClientIds.filter((clientId)=>{const firstTrial=trialRows.filter((t)=>t.clientId===clientId).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt))[0];return db.payments.some((p)=>!p.voidedAt&&p.clientId===clientId&&p.paymentDate>=dayKey(firstTrial.scheduledAt)&&(!f.managerId||p.managerAttributionId===f.managerId)&&(!f.closerId||p.closerAttributionId===f.closerId)&&(!f.paymentMethodId||p.paymentMethodId===f.paymentMethodId));});
  const revenue=paymentRows.reduce((sum,p)=>sum+Number(p.amount),0),conversion=trialClientIds.length?convertedClientIds.length/trialClientIds.length*100:0;
  let contextIds;if(f.dateType==="client")contextIds=new Set(scopedClients.filter((c)=>inRange(c.createdAt,f.from,f.to)&&(!f.managerId||c.originalManagerId===f.managerId)&&(!f.closerId||c.currentCloserId===f.closerId)).map((c)=>c.id));else if(f.dateType==="payment")contextIds=new Set(paymentRows.map((p)=>p.clientId));else contextIds=new Set(trialRows.map((t)=>t.clientId));
  const statusBase=Math.max(1,contextIds.size),statuses=db.statuses.filter((s)=>s.active||[...contextIds].some((cid)=>client(cid)?.currentStatusId===s.id)).sort((a,b)=>a.sortOrder-b.sortOrder).map((s)=>{const count=[...contextIds].filter((cid)=>client(cid)?.currentStatusId===s.id).length;return{id:s.id,name:s.name,color:s.color,count,percentage:count/statusBase*100,active:s.active};});
  const granularity=trendGranularity(f.from,f.to),buckets=new Map();
  for(const t of trialRows){const key=bucketKey(dayKey(t.scheduledAt),granularity),row=buckets.get(key)||{key,trials:0,payments:0,revenue:0};row.trials++;buckets.set(key,row);}
  for(const p of paymentRows){const key=bucketKey(p.paymentDate,granularity),row=buckets.get(key)||{key,trials:0,payments:0,revenue:0};row.payments++;row.revenue+=Number(p.amount);buckets.set(key,row);}
  const trend=[...buckets.values()].sort((a,b)=>a.key.localeCompare(b.key));
  const resultTime=(trial)=>trial.resultAt||trial.completedAt||null;
  const closerResultRows=db.trials.filter((t)=>t.assignmentState!=="UNASSIGNED"&&resultTime(t)&&clientIds.has(t.clientId)&&inRange(resultTime(t),f.from,f.to)&&(!f.managerId||t.managerId===f.managerId)&&(!f.closerId||t.closerId===f.closerId));
  const performance=(kind)=>db.users.filter((u)=>u.role===kind&&(!f.managerId||kind!=="MANAGER"||u.id===f.managerId)&&(!f.closerId||kind!=="CLOSER"||u.id===f.closerId)).map((u)=>{const performanceTrials=kind==="CLOSER"?closerResultRows:trialRows,personTrials=performanceTrials.filter((t)=>kind==="MANAGER"?t.managerId===u.id:t.closerId===u.id),personTrialClients=[...new Set(personTrials.map((t)=>t.clientId))],personPayments=paymentRows.filter((p)=>kind==="MANAGER"?p.managerAttributionId===u.id:p.closerAttributionId===u.id),performanceDate=(trial)=>kind==="CLOSER"?resultTime(trial):trial.scheduledAt,personConverted=personTrialClients.filter((cid)=>{const first=personTrials.filter((t)=>t.clientId===cid).sort((a,b)=>performanceDate(a).localeCompare(performanceDate(b)))[0];return db.payments.some((p)=>!p.voidedAt&&p.clientId===cid&&p.paymentDate>=dayKey(performanceDate(first))&&(kind==="MANAGER"?p.managerAttributionId===u.id:p.closerAttributionId===u.id)&&(!f.paymentMethodId||p.paymentMethodId===f.paymentMethodId));}),personRevenue=personPayments.reduce((sum,p)=>sum+Number(p.amount),0);return{id:u.id,name:u.name,clients:kind==="MANAGER"?scopedClients.filter((c)=>c.originalManagerId===u.id&&inRange(c.createdAt,f.from,f.to)).length:undefined,trials:personTrials.length,conducted:kind==="CLOSER"?personTrials.filter((t)=>t.completedAt).length:undefined,payments:personPayments.length,conversion:personTrialClients.length?personConverted.length/personTrialClients.length*100:0,revenue:personRevenue,average:personPayments.length?personRevenue/personPayments.length:0};}).filter((row)=>row.trials||row.payments||row.clients).sort((a,b)=>b.revenue-a.revenue);
  const refusalEvents=db.history.filter((h)=>h.eventType==="STATUS_CHANGED"&&h.newValue?.refusalReasonId&&clientIds.has(h.clientId)&&inRange(h.createdAt,f.from,f.to)&&(!f.managerId||client(h.clientId)?.originalManagerId===f.managerId)&&(!f.closerId||client(h.clientId)?.currentCloserId===f.closerId));const refusalTotal=Math.max(1,refusalEvents.length),refusals=db.refusalReasons.map((reason)=>{const count=refusalEvents.filter((h)=>h.newValue.refusalReasonId===reason.id).length;return{id:reason.id,name:reason.name,count,percentage:count/refusalTotal*100};}).filter((row)=>row.count||db.refusalReasons.find((r)=>r.id===row.id)?.active).sort((a,b)=>b.count-a.count);
  const sources=db.leadSources.filter((s)=>!f.sourceId||s.id===f.sourceId).map((source)=>{const sourceClients=db.clients.filter((c)=>analyticsClientMatch(actor,c,f,true)&&c.leadSourceId===source.id),ids=new Set(sourceClients.map((c)=>c.id)),clients=sourceClients.filter((c)=>inRange(c.createdAt,f.from,f.to)&&(!f.managerId||c.originalManagerId===f.managerId)).length,sourceTrials=trialRows.filter((t)=>ids.has(t.clientId)),sourceTrialClients=[...new Set(sourceTrials.map((t)=>t.clientId))],payments=paymentRows.filter((p)=>ids.has(p.clientId)),converted=sourceTrialClients.filter((cid)=>{const first=sourceTrials.filter((t)=>t.clientId===cid).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt))[0];return db.payments.some((p)=>!p.voidedAt&&p.clientId===cid&&p.paymentDate>=dayKey(first.scheduledAt)&&(!f.managerId||p.managerAttributionId===f.managerId)&&(!f.closerId||p.closerAttributionId===f.closerId)&&(!f.paymentMethodId||p.paymentMethodId===f.paymentMethodId));}),sourceRevenue=payments.reduce((sum,p)=>sum+Number(p.amount),0);return{id:source.id,name:source.name,clients,trials:sourceTrials.length,payments:payments.length,conversion:sourceTrialClients.length?converted.length/sourceTrialClients.length*100:0,revenue:sourceRevenue,average:payments.length?sourceRevenue/payments.length:0};}).filter((row)=>row.clients||row.trials||row.payments).sort((a,b)=>b.revenue-a.revenue);
  const methods=db.paymentMethods.filter((m)=>!f.paymentMethodId||m.id===f.paymentMethodId).map((method)=>{const rows=paymentRows.filter((p)=>p.paymentMethodId===method.id),methodRevenue=rows.reduce((sum,p)=>sum+Number(p.amount),0);return{id:method.id,name:method.name,payments:rows.length,revenue:methodRevenue,share:revenue?methodRevenue/revenue*100:0};}).filter((row)=>row.payments).sort((a,b)=>b.revenue-a.revenue);
  const assignmentRows=db.trials.filter((t)=>clientIds.has(t.clientId)&&(!f.managerId||t.managerId===f.managerId)),currentlyUnassigned=assignmentRows.filter((t)=>t.active&&t.assignmentState==="UNASSIGNED"),assignedDurations=assignmentRows.filter((t)=>t.assignedAt).map((t)=>Math.max(0,new Date(t.assignedAt)-new Date(t.createdAt))),assignmentThreshold=(db.meta.unassignedTrialReminderMinutes||120)*60000;
  const report={filters:f,assignment:{currentUnassigned:currentlyUnassigned.length,averageAssignmentMinutes:assignedDurations.length?assignedDurations.reduce((a,b)=>a+b,0)/assignedDurations.length/60000:0,overThreshold:currentlyUnassigned.filter((t)=>Date.now()-new Date(t.createdAt)>=assignmentThreshold).length,thresholdMinutes:db.meta.unassignedTrialReminderMinutes||120},kpis:{trials:trialRows.length,trialClients:trialClientIds.length,payments:paymentRows.length,convertedClients:convertedClientIds.length,conversion,revenue,average:paymentRows.length?revenue/paymentRows.length:0},attendance:attendanceSummary(trialRows),statusBaseline:{count:contextIds.size,label:{client:"текущий статус уникальных клиентов, созданных за период",trial:"текущий статус уникальных клиентов с пробным уроком за период",payment:"текущий статус уникальных клиентов с оплатой за период"}[f.dateType]},statuses,granularity,trend,managers:hasPermission(actor,"analytics.viewManager")?performance("MANAGER"):[],closers:hasPermission(actor,"analytics.viewCloser")?performance("CLOSER"):[],refusals:hasPermission(actor,"analytics.viewRefusal")?refusals:[],sources:hasPermission(actor,"analytics.viewSource")?sources:[],paymentMethods:methods};
  if(includeComparison&&f.compare){const length=daysBetween(f.from,f.to),previous={...f,from:addDays(f.from,-length),to:addDays(f.from,-1),compare:false},prior=analyticsReport(actor,previous,false);report.comparison={from:previous.from,to:previous.to,kpis:prior.kpis,attendance:prior.attendance};}
  return report;
}

async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const input = await body(req),rateKey=loginRateKey(req,input.login),retryAfter=loginRateLimiter.retryAfterSeconds(rateKey);if(retryAfter){res.setHeader("Retry-After",String(retryAfter));return fail(res,429,"Слишком много попыток входа. Попробуйте позже");} const found = db.users.find((u) => u.login.toLowerCase() === String(input.login || "").toLowerCase() && u.active);
    if (!found || !verifyPassword(String(input.password || ""), found.passwordHash)){loginRateLimiter.recordFailure(rateKey);return fail(res, 401, "Неверный логин или пароль");}
    loginRateLimiter.reset(rateKey);
    const token = crypto.randomBytes(32).toString("hex"); await activeStorage().sessions.createToken(token, found.id);
    res.setHeader("Set-Cookie", `milton_session=${token}; HttpOnly;${secureCookie} SameSite=Strict; Path=/; Max-Age=43200`);
    return json(res, 200, { token, user: publicUser(found) });
  }
  const actor = await actorFrom(req);
  if (!actor) return fail(res, 401, "Требуется авторизация");
  if (url.pathname === "/api/admin/deployment" || url.pathname === "/api/admin/deployment/commits" || /^\/api\/admin\/deployment\/[a-f0-9]{32}$/.test(url.pathname)) {
    if(!actor.isOwner)return fail(res,403,"Публикация доступна только глобальному владельцу");
    try{
      if(req.method==="GET"&&url.pathname==="/api/admin/deployment")return json(res,200,vpsDeploymentService.describe());
      if(req.method==="GET"&&url.pathname==="/api/admin/deployment/commits")return json(res,200,await vpsDeploymentService.listCommits());
      if(req.method==="POST"&&url.pathname==="/api/admin/deployment"){
        const input=await body(req),commit=String(input.commit||"").trim()||null,result=await vpsDeploymentService.start(commit);audit(actor.id,"SYSTEM",result.jobId,"DEPLOYMENT_STARTED",null,{host:vpsDeploymentService.describe().host,commit:result.commit});saveDb();return json(res,202,result);
      }
      if(req.method==="GET")return json(res,200,await vpsDeploymentService.status(url.pathname.split("/").pop()));
      return fail(res,405,"Метод не поддерживается");
    }catch(error){
      if(error instanceof DeploymentError||error?.statusCode)return fail(res,error.statusCode||502,error.message);
      throw error;
    }
  }
  if (req.method === "GET" && url.pathname === "/api/events") return realtimeHub.connect(req,res,actor.id);
  if (req.method === "GET" && /^\/api\/trials\/[^/]+\/receipt$/.test(url.pathname)) {
    const trialId=url.pathname.split("/")[3],trial=db.trials.find((item)=>item.id===trialId),c=trial&&client(trial.clientId);
    if(!trial||!c||!canOpenClient(actor,c)||!hasPermission(actor,"clients.viewHistory")||!trial.receiptStorageKey)return fail(res,404,"Чек не найден");
    const receiptPath=fileStorage.resolve(trial.receiptStorageKey);if(!receiptPath||!fs.existsSync(receiptPath))return fail(res,404,"Файл чека не найден");
    res.writeHead(200,{"Content-Type":trial.receiptMimeType||"application/octet-stream","Content-Length":String(trial.receiptSizeBytes||fs.statSync(receiptPath).size),"Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(trial.receiptOriginalName||"receipt")}`,"Cache-Control":"private, no-store"});
    return fs.createReadStream(receiptPath).pipe(res);
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    if(!(activeStorage() instanceof PostgresStorage)&&ensureOperationalNotifications(actor))saveDb();
    return json(res,200,bootstrapPayload(actor));
  }
  if(req.method==="GET"&&url.pathname==="/api/unassigned-trials"){
    if(actor.role!=="ADMIN")return fail(res,403,"Нераспределённые пробные назначает администратор");
    if(!requirePermission(res,actor,"schedule.assignUnassigned"))return;
    return json(res,200,{items:unassignedPayload(actor),reminderMinutes:db.meta.unassignedTrialReminderMinutes||120});
  }
  if(req.method==="GET"&&url.pathname==="/api/availability-summary"){
    if(!hasPermission(actor,"clients.create")&&!hasPermission(actor,"schedule.view"))return fail(res,403,"У вас нет прав для просмотра доступности");
    const date=/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date")||"")?url.searchParams.get("date"):dayKey(now());
    const groups=new Map();
    for(const slot of db.availabilitySlots.filter((item)=>dayKey(item.startAt)===date)){
      const key=`${slot.startAt}|${slot.endAt}`,current=groups.get(key)||{startAt:slot.startAt,endAt:slot.endAt,availableCount:0,totalCount:0};
      current.totalCount+=1;if(slot.status==="FREE"&&!slot.bookedTrialId)current.availableCount+=1;groups.set(key,current);
    }
    return json(res,200,{date,items:[...groups.values()].sort((a,b)=>a.startAt.localeCompare(b.startAt))});
  }
  if(req.method==="GET"&&url.pathname==="/api/sync"){
    const allowed=new Set(["bootstrap","clients","trials","schedule","payments","notifications","analytics","users","profile","settings","references"]);
    const resources=new Set(String(url.searchParams.get("resources")||"").split(",").filter((item)=>allowed.has(item)));
    if(!resources.size)resources.add("bootstrap");
    return json(res,200,syncPayload(actor,resources));
  }
  if (req.method === "GET" && /^\/api\/clients\/[^/]+$/.test(url.pathname)) {
    const c = client(url.pathname.split("/").pop()); if (!c || !canOpenClient(actor, c)) return fail(res, 404, "Клиент не найден");
    const mayViewHistory=hasPermission(actor,"clients.viewHistory"),mayViewPayments=hasPermission(actor,"payments.viewHistory")&&clientMatchesScope(actor,c,"payments");
    const trials=mayViewHistory?db.trials.filter((x)=>x.clientId===c.id).map((trial)=>{const{receiptStorageKey,...safeTrial}=trial;return{...safeTrial,registeredBy:publicUser(user(trial.registeredByUserId||trial.managerId)),receiptUrl:receiptStorageKey?`/api/trials/${trial.id}/receipt`:null}}).sort((a,b)=>String(b.scheduledAt||b.createdAt).localeCompare(String(a.scheduledAt||a.createdAt))):[];
    return json(res, 200, { client: enrichClient(c,actor), trials, notes:mayViewHistory?db.notes.filter((x) => x.clientId === c.id).map((n) => ({ ...n, author: publicUser(user(n.authorUserId)) })).sort((a,b) => b.createdAt.localeCompare(a.createdAt)):[], history:mayViewHistory?db.history.filter((x) => x.clientId === c.id).map((h) => ({ ...h, actor: publicUser(user(h.actorUserId)) })).sort((a,b) => b.createdAt.localeCompare(a.createdAt)):[], payments:mayViewPayments?db.payments.filter((x) => x.clientId === c.id).map((p) => ({ ...p, method: db.paymentMethods.find((m) => m.id === p.paymentMethodId), closer: publicUser(user(p.closerAttributionId)) })).sort((a,b) => b.paymentDate.localeCompare(a.paymentDate)):[] });
  }
  if (req.method === "POST" && /^\/api\/clients\/[^/]+\/archive$/.test(url.pathname)) {
    if(!requirePermission(res,actor,"clients.archive"))return;const cid=url.pathname.split("/")[3],c=client(cid);if(!c||c.permanentlyDeletedAt||!clientMatchesScope(actor,c,"clients"))return fail(res,404,"Клиент не найден");if(c.archivedAt)return fail(res,409,"Клиент уже находится в архиве");const input=await body(req),reason=String(input.reason||"");if(!CLIENT_ARCHIVE_REASONS[reason])return fail(res,422,"Выберите причину архивации");const archivedAt=now(),oldValue={archivedAt:c.archivedAt,archiveReason:c.archiveReason};c.archivedAt=archivedAt;c.archivedByUserId=actor.id;c.archiveReason=reason;c.updatedAt=archivedAt;const activeTrial=db.trials.find((trial)=>trial.clientId===c.id&&trial.active);if(activeTrial){activeTrial.active=false;activeTrial.archiveInterruptedAt=archivedAt;const slot=db.availabilitySlots.find((item)=>item.id===activeTrial.slotId);if(slot&&slot.bookedTrialId===activeTrial.id){slot.status="FREE";slot.bookedTrialId=null;}}history(c.id,actor.id,"CLIENT_ARCHIVED",oldValue,{reason,reasonLabel:CLIENT_ARCHIVE_REASONS[reason],archivedAt});audit(actor.id,"CLIENT",c.id,"CLIENT_ARCHIVED",oldValue,{reason,reasonLabel:CLIENT_ARCHIVE_REASONS[reason],archivedAt,archivedByUserId:actor.id});saveDb();return json(res,200,enrichClient(c,actor));
  }
  if (req.method === "POST" && /^\/api\/clients\/[^/]+\/restore$/.test(url.pathname)) {
    if(!requirePermission(res,actor,"clients.archive"))return;const cid=url.pathname.split("/")[3],c=client(cid);if(!c||c.permanentlyDeletedAt||!c.archivedAt||!clientMatchesScope(actor,c,"clients"))return fail(res,404,"Клиент в архиве не найден");if(db.clients.some((other)=>other.id!==c.id&&!other.archivedAt&&!other.permanentlyDeletedAt&&other.normalizedPhone===c.normalizedPhone))return fail(res,409,"Активный клиент с таким телефоном уже существует");const restoredAt=now(),oldValue={archivedAt:c.archivedAt,archivedByUserId:c.archivedByUserId,archiveReason:c.archiveReason};c.archivedAt=null;c.archivedByUserId=null;c.archiveReason=null;c.updatedAt=restoredAt;history(c.id,actor.id,"CLIENT_RESTORED",oldValue,{restoredAt});audit(actor.id,"CLIENT",c.id,"CLIENT_RESTORED",oldValue,{restoredAt,restoredByUserId:actor.id});saveDb();return json(res,200,enrichClient(c,actor));
  }
  if (req.method === "DELETE" && /^\/api\/clients\/[^/]+$/.test(url.pathname)) {
    if(!actor.isOwner)return fail(res,403,"Постоянное удаление доступно только владельцу системы");
    const cid=url.pathname.split("/")[3],c=client(cid);if(!c||c.permanentlyDeletedAt||!clientMatchesScope(actor,c,"clients"))return fail(res,404,"Клиент не найден");
    const input=await body(req);if(!["УДАЛИТЬ",c.name].includes(String(input.confirmation||"")))return fail(res,422,"Подтвердите постоянное удаление клиента");
    const clientTrials=db.trials.filter(item=>item.clientId===c.id),trialIds=new Set(clientTrials.map(item=>item.id)),paymentIds=new Set(db.payments.filter(item=>item.clientId===c.id).map(item=>item.id)),removed={trials:trialIds.size,payments:paymentIds.size,notes:db.notes.filter(item=>item.clientId===c.id).length,history:db.history.filter(item=>item.clientId===c.id).length};
    for(const slot of db.availabilitySlots.filter(item=>trialIds.has(item.bookedTrialId))){slot.status="FREE";slot.bookedTrialId=null;}
    db.trials=db.trials.filter(item=>item.clientId!==c.id);db.payments=db.payments.filter(item=>item.clientId!==c.id);db.notes=db.notes.filter(item=>item.clientId!==c.id);db.history=db.history.filter(item=>item.clientId!==c.id);db.notifications=db.notifications.filter(item=>item.clientId!==c.id);
    db.auditLogs=db.auditLogs.filter(item=>!(item.entityType==="CLIENT"&&item.entityId===c.id)&&!(item.entityType==="PAYMENT"&&paymentIds.has(item.entityId)));
    db.clients=db.clients.filter(item=>item.id!==c.id);audit(actor.id,"CLIENT",c.id,"CLIENT_PERMANENTLY_DELETED",null,{hardDeleted:true,relatedRecordsRemoved:removed});saveDb();for(const trial of clientTrials)if(trial.receiptStorageKey)await fileStorage.remove(trial.receiptStorageKey).catch((error)=>console.error(`Receipt cleanup error: ${error.code||error.message}`));return json(res,200,{id:c.id,deletedAt:now(),hardDeleted:true,financialRecordsPreserved:false,relatedRecordsRemoved:removed});
  }
  if (req.method === "PUT" && url.pathname === "/api/admin/branding") {
    if (!requirePermission(res,actor,"settings.manageBranding")) return;
    const input = await body(req); if (!String(input.companyName||"").trim() || !/^#[0-9a-fA-F]{6}$/.test(input.accentColor||"") || !validImageData(input.logoUrl)) return fail(res,422,"Укажите название, корректный цвет и изображение до 1 МБ");
    const oldValue = { ...db.meta.branding }; db.meta.branding = { companyName:String(input.companyName).trim(), accentColor:input.accentColor, logoUrl:input.logoUrl || "" }; audit(actor.id,"BRANDING","branding","BRANDING_CHANGED",oldValue,db.meta.branding); saveDb(); return json(res,200,db.meta.branding);
  }
  if(req.method==="PUT"&&url.pathname==="/api/admin/unassigned-settings"){
    if(!requirePermission(res,actor,"settings.manageBranding"))return;const input=await body(req),minutes=Number(input.minutes);if(!Number.isInteger(minutes)||minutes<0||minutes>10080)return fail(res,422,"Укажите порог от 0 до 10080 минут");db.meta.unassignedTrialReminderMinutes=minutes;audit(actor.id,"SETTINGS","unassigned-trials","UNASSIGNED_REMINDER_CHANGED",null,{minutes});saveDb();return json(res,200,{minutes});
  }
  if (req.method === "PUT" && url.pathname === "/api/profile") {
    const input=await body(req),oldValue=publicUser(actor);if(input.name!==undefined&&!String(input.name).trim())return fail(res,422,"Введите имя");if(input.login!==undefined&&!String(input.login).trim())return fail(res,422,"Введите логин");if(input.login&&db.users.some((u)=>u.id!==actor.id&&u.login.toLowerCase()===String(input.login).toLowerCase()))return fail(res,409,"Пользователь с таким логином уже существует");if(input.avatarUrl!==undefined&&!validImageData(input.avatarUrl))return fail(res,422,"Некорректное изображение профиля");if(input.name!==undefined)actor.name=String(input.name).trim();if(input.login!==undefined)actor.login=String(input.login).trim();if(input.avatarUrl!==undefined)actor.avatarUrl=input.avatarUrl;if(["WORKING","DAY_OFF","NOT_ACCEPTING"].includes(input.profileStatus))actor.profileStatus=input.profileStatus;if(input.password){if(String(input.password).length<6)return fail(res,422,"Пароль должен содержать минимум 6 символов");actor.passwordHash=hashPassword(String(input.password));}actor.updatedAt=now();audit(actor.id,"USER",actor.id,"PROFILE_UPDATED",oldValue,publicUser(actor));saveDb();return json(res,200,publicUser(actor));
  }
  if (/^\/api\/admin\/config\/[^/]+(?:\/[^/]+)?(?:\/(?:archive|restore))?$/.test(url.pathname)) {
    const parts=url.pathname.split("/"),type=parts[4],itemId=parts[5],action=parts[6],cfg=CONFIG_TYPES[type];if(!cfg)return fail(res,404,"Неизвестный справочник");if(!requirePermission(res,actor,cfg.permission))return;const collection=db[cfg.collection];
    if(req.method==="POST"&&!itemId){const input=await body(req),payload=configPayload(type,input);if(!payload)return fail(res,422,"Введите название");const item={id:id(cfg.prefix),...payload};collection.push(item);audit(actor.id,"CONFIG",item.id,"CONFIG_CREATED",null,{type,...item});saveDb();return json(res,201,item);}
    const target=collection.find((item)=>item.id===itemId);if(!target)return fail(res,404,"Элемент справочника не найден");
    if(req.method==="PUT"&&!action){const input=await body(req),next=configPayload(type,input,target);if(!next)return fail(res,422,"Введите название");const oldValue=structuredClone(target);Object.assign(target,next);audit(actor.id,"CONFIG",target.id,"CONFIG_UPDATED",oldValue,{type,...target});saveDb();return json(res,200,target);}
    if(req.method==="POST"&&["archive","restore"].includes(action)){const oldValue={active:target.active};target.active=action==="restore";target.archivedAt=target.active?null:now();audit(actor.id,"CONFIG",target.id,target.active?"CONFIG_RESTORED":"CONFIG_ARCHIVED",oldValue,{type,active:target.active});saveDb();return json(res,200,target);}
  }
  if (req.method === "POST" && url.pathname === "/api/admin/roles") {
    if (!requirePermission(res,actor,"users.manageRoles")) return;
    const input = await body(req); if (!String(input.name||"").trim()) return fail(res,422,"Введите название роли");
    const role = { id:id("role"), name:String(input.name).trim(), systemKey:null, baseRole:["ADMIN","MANAGER","CLOSER"].includes(input.baseRole)?input.baseRole:"MANAGER", isSystem:false, active:true, permissions:{...pickedPermissions(),...cleanPermissions(input.permissions)}, scopes:{clients:"OWN",schedule:"OWN",payments:"OWN",analytics:"OWN",...cleanScopes(input.scopes)}, archivedAt:null, createdAt:now(), updatedAt:now() }; db.roles.push(role); audit(actor.id,"ROLE",role.id,"ROLE_CREATED",null,role); saveDb(); return json(res,201,role);
  }
  if (req.method === "PUT" && /^\/api\/admin\/roles\/[^/]+$/.test(url.pathname)) {
    if (!requirePermission(res,actor,"users.manageRoles")) return; const target = db.roles.find((role)=>role.id===url.pathname.split("/").pop()); if (!target) return fail(res,404,"Роль не найдена");
    const input=await body(req), oldValue=structuredClone(target); if (String(input.name||"").trim()) target.name=String(input.name).trim(); target.permissions={...target.permissions,...cleanPermissions(input.permissions)}; target.scopes={...target.scopes,...cleanScopes(input.scopes)}; target.updatedAt=now(); audit(actor.id,"ROLE",target.id,"ROLE_EDITED",oldValue,target); saveDb(); return json(res,200,target);
  }
  if (req.method === "POST" && /^\/api\/admin\/roles\/[^/]+\/archive$/.test(url.pathname)) {
    if (!requirePermission(res,actor,"users.manageRoles")) return; const rid=url.pathname.split("/")[4],target=db.roles.find((role)=>role.id===rid); if(!target)return fail(res,404,"Роль не найдена"); if(target.isSystem)return fail(res,422,"Системную роль нельзя архивировать"); const oldValue={active:target.active,archivedAt:target.archivedAt}; target.active=false;target.archivedAt=now();target.updatedAt=now();audit(actor.id,"ROLE",target.id,"ROLE_ARCHIVED",oldValue,{active:false,archivedAt:target.archivedAt});saveDb();return json(res,200,target);
  }
  if (req.method === "POST" && url.pathname === "/api/admin/users") {
    if (!requirePermission(res,actor,"users.create")) return; const input=await body(req),role=db.roles.find((item)=>item.id===input.roleId&&item.active); if(!role)return fail(res,422,"Выберите активную роль"); if(!String(input.name||"").trim()||!String(input.login||"").trim()||String(input.password||"").length<6)return fail(res,422,"Укажите имя, логин и пароль не короче 6 символов"); if(db.users.some((item)=>item.login.toLowerCase()===String(input.login).toLowerCase()))return fail(res,409,"Пользователь с таким логином уже существует"); if(!validImageData(input.avatarUrl))return fail(res,422,"Некорректное изображение профиля"); if((Object.keys(input.permissionOverrides||{}).length||Object.keys(input.scopeOverrides||{}).length)&&!hasPermission(actor,"users.managePermissions"))return fail(res,403,"Нет права на индивидуальные разрешения");
    const account={id:id("usr"),name:String(input.name).trim(),login:String(input.login).trim(),passwordHash:hashPassword(input.password),role:role.baseRole,roleId:role.id,isOwner:false,avatarUrl:input.avatarUrl||"",profileStatus:input.profileStatus||"WORKING",active:input.active!==false,permissionOverrides:applyOverrides({},cleanPermissions(input.permissionOverrides)),scopeOverrides:applyOverrides({},cleanScopes(input.scopeOverrides)),teamId:input.teamId||null,archivedAt:null,createdAt:now(),updatedAt:now()};db.users.push(account);audit(actor.id,"USER",account.id,"USER_CREATED",null,{...publicUser(account),permissionOverrides:account.permissionOverrides,scopeOverrides:account.scopeOverrides});saveDb();return json(res,201,publicUser(account));
  }
  if (req.method === "PUT" && /^\/api\/admin\/users\/[^/]+$/.test(url.pathname)) {
    if (!requirePermission(res,actor,"users.edit")) return; const target=user(url.pathname.split("/").pop());if(!target)return fail(res,404,"Пользователь не найден");if(target.isOwner&&!actor.isOwner)return fail(res,403,"Учётная запись владельца защищена");const input=await body(req),oldValue={...publicUser(target),permissionOverrides:{...target.permissionOverrides},scopeOverrides:{...target.scopeOverrides}},oldRoleId=target.roleId,oldPermissions=JSON.stringify(target.permissionOverrides),oldScopes=JSON.stringify(target.scopeOverrides);if(target.isOwner&&input.roleId&&input.roleId!==target.roleId)return fail(res,403,"Роль владельца нельзя изменить");if(input.roleId&&input.roleId!==target.roleId){const role=db.roles.find((item)=>item.id===input.roleId&&item.active);if(!role)return fail(res,422,"Выберите активную роль");target.roleId=role.id;target.role=role.baseRole;}if(input.name)target.name=String(input.name).trim();if(input.login){if(db.users.some((u)=>u.id!==target.id&&u.login.toLowerCase()===String(input.login).toLowerCase()))return fail(res,409,"Пользователь с таким логином уже существует");target.login=String(input.login).trim();}if(input.teamId!==undefined)target.teamId=String(input.teamId||"").trim()||null;if(["WORKING","DAY_OFF","NOT_ACCEPTING"].includes(input.profileStatus))target.profileStatus=input.profileStatus;if(input.password){if(String(input.password).length<6)return fail(res,422,"Пароль должен содержать минимум 6 символов");target.passwordHash=hashPassword(String(input.password));}if(input.avatarUrl!==undefined){if(!validImageData(input.avatarUrl))return fail(res,422,"Некорректное изображение профиля");target.avatarUrl=input.avatarUrl;}if(input.permissionOverrides||input.scopeOverrides){if(!requirePermission(res,actor,"users.managePermissions"))return;target.permissionOverrides=applyOverrides(target.permissionOverrides,cleanPermissions(input.permissionOverrides));target.scopeOverrides=applyOverrides(target.scopeOverrides,cleanScopes(input.scopeOverrides));}target.updatedAt=now();if(oldRoleId!==target.roleId)audit(actor.id,"USER",target.id,"USER_ROLE_CHANGED",{roleId:oldRoleId},{roleId:target.roleId});if(oldPermissions!==JSON.stringify(target.permissionOverrides))audit(actor.id,"USER",target.id,"USER_PERMISSION_CHANGED",oldValue.permissionOverrides,target.permissionOverrides);if(oldScopes!==JSON.stringify(target.scopeOverrides))audit(actor.id,"USER",target.id,"DATA_SCOPE_CHANGED",oldValue.scopeOverrides,target.scopeOverrides);saveDb();return json(res,200,publicUser(target));
  }
  if (req.method === "DELETE" && /^\/api\/admin\/users\/[^/]+$/.test(url.pathname)) {
    if(actor.role!=="ADMIN")return fail(res,403,"Постоянное удаление сотрудников доступно только администратору");
    const uid=url.pathname.split("/").pop(),target=user(uid);if(!target)return fail(res,404,"Сотрудник не найден");if(target.isOwner)return fail(res,403,"Учётную запись владельца нельзя удалить");if(target.id===actor.id)return fail(res,422,"Нельзя удалить собственную учётную запись");
    const input=await body(req);if(input.confirmed!==true)return fail(res,422,"Подтвердите постоянное удаление сотрудника");
    const managerClients=db.clients.filter(c=>c.currentManagerId===target.id||c.originalManagerId===target.id),closerClients=db.clients.filter(c=>c.currentCloserId===target.id),affectedClients=new Set([...managerClients,...closerClients].map(c=>c.id));let replacement=null;
    if(affectedClients.size){if(!["MANAGER","CLOSER"].includes(target.role))return fail(res,409,"Сначала переназначьте клиентов этого сотрудника");replacement=user(input.replacementUserId)||db.users.find(account=>account.id!==target.id&&account.active&&account.role===target.role);if(!replacement||replacement.id===target.id||!replacement.active||replacement.role!==target.role)return fail(res,422,`Нет активного сотрудника роли ${target.role==="MANAGER"?"Менеджер":"Клоузер"} для передачи клиентов`);}
    for(const c of managerClients){if(c.currentManagerId===target.id)c.currentManagerId=replacement.id;if(c.originalManagerId===target.id)c.originalManagerId=replacement.id;c.updatedAt=now();}
    for(const c of closerClients){c.currentCloserId=replacement.id;c.updatedAt=now();}
    const removedTrialIds=new Set(db.trials.filter(item=>item.managerId===target.id||item.closerId===target.id).map(item=>item.id)),removedPaymentIds=new Set(db.payments.filter(item=>item.managerAttributionId===target.id||item.closerAttributionId===target.id).map(item=>item.id)),removed={clientsReassigned:affectedClients.size,trials:removedTrialIds.size,payments:removedPaymentIds.size,notes:db.notes.filter(item=>item.authorUserId===target.id).length,history:db.history.filter(item=>item.actorUserId===target.id).length,slots:db.availabilitySlots.filter(item=>item.closerId===target.id).length};
    for(const slot of db.availabilitySlots.filter(item=>removedTrialIds.has(item.bookedTrialId))){slot.status="FREE";slot.bookedTrialId=null;}
    const referencesRemoved=value=>{const raw=JSON.stringify(value||{});return [...removedTrialIds,...removedPaymentIds].some(recordId=>raw.includes(recordId));};
    db.trials=db.trials.filter(item=>!removedTrialIds.has(item.id));db.payments=db.payments.filter(item=>!removedPaymentIds.has(item.id));db.notes=db.notes.filter(item=>item.authorUserId!==target.id);db.history=db.history.filter(item=>item.actorUserId!==target.id&&!referencesRemoved(item.oldValue)&&!referencesRemoved(item.newValue));db.notifications=db.notifications.filter(item=>item.userId!==target.id);db.availabilitySlots=db.availabilitySlots.filter(item=>item.closerId!==target.id);db.savedFilters=(db.savedFilters||[]).filter(item=>item.userId!==target.id);
    db.auditLogs=db.auditLogs.filter(item=>item.actorUserId!==target.id&&!(item.entityType==="USER"&&item.entityId===target.id)&&!(item.entityType==="PAYMENT"&&removedPaymentIds.has(item.entityId)));db.users=db.users.filter(item=>item.id!==target.id);await activeStorage().sessions.deleteByUserId(target.id);
    audit(actor.id,"USER",target.id,"USER_PERMANENTLY_DELETED",null,{hardDeleted:true,relatedRecordsRemoved:removed});saveDb();return json(res,200,{id:target.id,hardDeleted:true,relatedRecordsRemoved:removed});
  }
  if (req.method === "POST" && /^\/api\/admin\/users\/[^/]+\/archive$/.test(url.pathname)) { if(!requirePermission(res,actor,"users.archive"))return;const uid=url.pathname.split("/")[4],target=user(uid);if(!target)return fail(res,404,"Пользователь не найден");if(target.isOwner)return fail(res,403,"Учётную запись владельца нельзя архивировать");if(target.id===actor.id)return fail(res,422,"Нельзя архивировать собственную учётную запись");const oldValue={active:target.active,archivedAt:target.archivedAt};target.active=false;target.archivedAt=now();target.updatedAt=now();audit(actor.id,"USER",target.id,"USER_ARCHIVED",oldValue,{active:false,archivedAt:target.archivedAt});saveDb();return json(res,200,publicUser(target)); }
  if (req.method === "POST" && /^\/api\/admin\/users\/[^/]+\/restore$/.test(url.pathname)) { if(!requirePermission(res,actor,"users.archive"))return;const uid=url.pathname.split("/")[4],target=user(uid);if(!target)return fail(res,404,"Пользователь не найден");if(!db.roles.some((role)=>role.id===target.roleId&&role.active))return fail(res,422,"Перед восстановлением назначьте активную роль");const oldValue={active:target.active,archivedAt:target.archivedAt};target.active=true;target.archivedAt=null;target.updatedAt=now();audit(actor.id,"USER",target.id,"USER_RESTORED",oldValue,{active:true});saveDb();return json(res,200,publicUser(target)); }
  if (req.method === "POST" && /^\/api\/notifications\/[^/]+\/read$/.test(url.pathname)) {const target=db.notifications.find((n)=>n.id===url.pathname.split("/")[3]&&n.userId===actor.id);if(!target)return fail(res,404,"Уведомление не найдено");target.readAt=target.readAt||now();saveDb();return json(res,200,target);}
  if (req.method === "POST" && /^\/api\/notifications\/[^/]+\/snooze$/.test(url.pathname)) {const target=db.notifications.find((n)=>n.id===url.pathname.split("/")[3]&&n.userId===actor.id&&!n.resolvedAt);if(!target)return fail(res,404,"Активное уведомление не найдено");target.snoozedUntil=new Date(Date.now()+15*60000).toISOString();target.updatedAt=now();saveDb();return json(res,200,target);}
  if (req.method === "GET" && url.pathname === "/api/audit") { if(!requirePermission(res,actor,"audit.view"))return;return json(res,200,db.auditLogs.slice().reverse().map((entry)=>({...entry,actor:publicUser(user(entry.actorUserId))}))); }
  if(req.method==="GET"&&url.pathname==="/api/schedule-board"){
    if(!requirePermission(res,actor,"schedule.view"))return;
    const date=/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date")||"")?url.searchParams.get("date"):dayKey(now());
    const closers=permittedScheduleClosers(actor),closerIds=new Set(closers.map((account)=>account.id));
    const slots=db.availabilitySlots.filter((slot)=>closerIds.has(slot.closerId)&&dayKey(slot.startAt)===date).sort((a,b)=>a.startAt.localeCompare(b.startAt)).map((slot)=>scheduleSlotPayload(slot,actor));
    return json(res,200,{date,closers:closers.map(publicUser),slots});
  }
  if (req.method === "GET" && url.pathname === "/api/slots") {
    if (!requirePermission(res, actor, "schedule.view")) return;
    const closerId = url.searchParams.get("closerId"); const date = url.searchParams.get("date");
    if (closerId && closerId !== actor.id && ((!hasPermission(actor,"schedule.viewOthers") && !hasPermission(actor,"schedule.manageOthers")) || !userMatchesScope(actor,closerId,"schedule"))) return fail(res,403,"Нет доступа к расписанию другого сотрудника");
    const permittedIds=new Set(permittedScheduleClosers(actor).map((account)=>account.id));
    return json(res,200,db.availabilitySlots.filter((slot)=>permittedIds.has(slot.closerId)&&(!closerId||slot.closerId===closerId)&&(!date||dayKey(slot.startAt)===date)).sort((a,b)=>a.startAt.localeCompare(b.startAt)).map((slot)=>scheduleSlotPayload(slot,actor)));
  }
  if (req.method === "POST" && url.pathname === "/api/clients") {
    if (!requirePermission(res, actor, "clients.create") || !requirePermission(res, actor, "schedule.scheduleTrial")) return;
    const input = await body(req); const normalizedPhone = normalizePhone(input.phone),trialPayment=validateTrialPayment(input);
    if(trialPayment.error)return fail(res,422,trialPayment.error);
    const unassigned=actor.role==="MANAGER"||input.assignmentMode==="LATER";
    if (!input.name || normalizedPhone.length < 12 || (!unassigned&&(!input.closerId || !input.slotId))) return fail(res, 422, unassigned?"Укажите имя и корректный телефон":"Укажите имя, корректный телефон, клоузера и свободное время");
    const duplicate = db.clients.find((c) => !c.permanentlyDeletedAt&&c.normalizedPhone === normalizedPhone); if (duplicate) return json(res, 409, { error:duplicate.archivedAt?"Клиент с таким номером находится в архиве":"Клиент с таким номером телефона уже существует",code:"DUPLICATE_PHONE",clientId:duplicate.id,archived:Boolean(duplicate.archivedAt),canRestore:Boolean(duplicate.archivedAt&&hasPermission(actor,"clients.archive")&&clientMatchesScope(actor,duplicate,"clients")) });
    const slot=unassigned?null:db.availabilitySlots.find((s)=>s.id===input.slotId&&s.closerId===input.closerId);if(!unassigned&&(!slot||slot.status!=="FREE"))return json(res,409,{error:"Этот слот уже занят. Выберите другое время.",code:"SLOT_UNAVAILABLE"});
    const managerId = actor.role === "MANAGER" ? actor.id : input.managerId; const c = { id: id("cl"), name: input.name.trim(), normalizedPhone, originalPhone: input.phone, originalManagerId: managerId, currentManagerId: managerId, currentCloserId: unassigned?null:input.closerId, currentStatusId: input.statusId || db.statuses.filter((s) => s.active).sort((a,b) => a.sortOrder-b.sortOrder)[0].id, leadSourceId: input.leadSourceId || null, tagIds: input.tagIds || [], registrationComment: input.comment || "",archivedAt:null,archivedByUserId:null,archiveReason:null,permanentlyDeletedAt:null,permanentlyDeletedByUserId:null, createdAt: now(), updatedAt: now() };
    const receipt=trialPayment.value.receipt?await fileStorage.saveDataUrl(trialPayment.value.receipt.dataUrl,trialPayment.value.receipt.originalName):null;
    const trial = { id: id("trial"), clientId: c.id, closerId: c.currentCloserId, managerId, slotId: slot?.id||null, scheduledAt: slot?.startAt||null, completedAt: null, statusAtBookingId: c.currentStatusId, active: true, createdAt: now(),assignmentState:unassigned?"UNASSIGNED":"SCHEDULED",preferredTimeText:String(input.preferredTimeText||"").trim(),preferredDate:input.preferredDate||null,preferredStartTime:input.preferredStartTime||null,preferredEndTime:input.preferredEndTime||null,assignedAt:unassigned?null:now(),assignedByUserId:unassigned?null:actor.id,assignmentVersion:1,trialType:trialPayment.value.trialType,trialAmount:trialPayment.value.trialAmount,trialPaymentDate:trialPayment.value.trialType==="PAID"?dayKey(now()):null,registeredByUserId:actor.id,receiptStorageKey:receipt?.key||null,receiptOriginalName:receipt?.originalName||null,receiptMimeType:receipt?.mimeType||null,receiptSizeBytes:receipt?.sizeBytes||null,receiptUploadedAt:receipt?.uploadedAt||null };
    db.clients.push(c);db.trials.push(trial);if(slot){slot.status="BOOKED";slot.bookedTrialId=trial.id;}
    history(c.id,actor.id,"CLIENT_CREATED",null,{name:c.name,phone:normalizedPhone});history(c.id,actor.id,unassigned?"TRIAL_REGISTERED_UNASSIGNED":"TRIAL_SCHEDULED",null,unassigned?{preferredTimeText:trial.preferredTimeText}:{scheduledAt:trial.scheduledAt,closerId:trial.closerId});if(!unassigned)notify(c.currentCloserId,c.id,"TRIAL_ASSIGNED",`${c.name} · ${trial.scheduledAt}`);saveDb();
    return json(res, 201, enrichClient(c,actor));
  }
  if(req.method==="POST"&&/^\/api\/trials\/[^/]+\/(assign|reassign)$/.test(url.pathname)){
    const trialId=url.pathname.split("/")[3],action=url.pathname.split("/")[4],trial=db.trials.find((item)=>item.id===trialId&&item.active),input=await body(req);if(actor.role!=="ADMIN")return fail(res,403,"Назначать клоузера может только администратор");if(!trial)return fail(res,404,"Активный пробный не найден");const c=client(trial.clientId);if(!c||!canSeeClient(actor,c))return fail(res,404,"Клиент не найден");if(!requirePermission(res,actor,action==="assign"?"schedule.assignUnassigned":"schedule.reassignCloser"))return;if(action==="assign"&&trial.assignmentState!=="UNASSIGNED")return fail(res,409,"Пробный уже назначен. Обновите данные");if(action==="reassign"&&trial.assignmentState!=="SCHEDULED")return fail(res,409,"Пробный ещё не назначен");if(input.version!==undefined&&Number(input.version)!==Number(trial.assignmentVersion||1))return fail(res,409,"Назначение уже изменилось. Обновите данные");const slot=db.availabilitySlots.find((item)=>item.id===input.slotId&&item.status==="FREE");if(!slot)return fail(res,409,"Этот слот уже занят");const old={closerId:trial.closerId,slotId:trial.slotId,scheduledAt:trial.scheduledAt};if(action==="reassign"&&trial.slotId){const oldSlot=db.availabilitySlots.find((item)=>item.id===trial.slotId);if(oldSlot&&oldSlot.bookedTrialId===trial.id&&new Date(oldSlot.startAt)>new Date()){oldSlot.status="FREE";oldSlot.bookedTrialId=null;}}trial.closerId=slot.closerId;trial.slotId=slot.id;trial.scheduledAt=slot.startAt;trial.assignmentState="SCHEDULED";trial.assignedAt=now();trial.assignedByUserId=actor.id;trial.assignmentVersion=Number(trial.assignmentVersion||1)+1;const wasPending=Boolean(trial.pendingReschedule);trial.pendingReschedule=false;c.currentCloserId=slot.closerId;if(wasPending){const statusChanged=c.currentStatusId!==trial.statusAtBookingId;c.currentStatusId=trial.statusAtBookingId;c.currentReasonId=null;if(statusChanged)c.statusChangedAt=now();for(const n of db.notifications.filter((n)=>n.trialId===trial.id&&n.type==="TRIAL_RESCHEDULE_PENDING"&&!n.resolvedAt)){n.resolvedAt=now();n.snoozedUntil=null;n.updatedAt=now();}}c.updatedAt=now();slot.status="BOOKED";slot.bookedTrialId=trial.id;const event=wasPending?"TRIAL_RESCHEDULE_TIME_ASSIGNED":action==="assign"?"TRIAL_ASSIGNED":"TRIAL_ASSIGNMENT_CHANGED";history(c.id,actor.id,event,old,{closerId:trial.closerId,slotId:trial.slotId,scheduledAt:trial.scheduledAt});audit(actor.id,"TRIAL",trial.id,event,old,{closerId:trial.closerId,slotId:trial.slotId,scheduledAt:trial.scheduledAt});notify(trial.closerId,c.id,"TRIAL_ASSIGNED",`${c.name} · ${trial.scheduledAt}`,trial.id);saveDb();return json(res,200,enrichClient(c,actor));
  }
  if (req.method === "POST" && /^\/api\/clients\/[^/]+\/notes$/.test(url.pathname)) {
    const cid = url.pathname.split("/")[3], c = client(cid); if (!c || !canSeeClient(actor, c)) return fail(res, 404, "Клиент не найден");
    if (!requirePermission(res, actor, "clients.addNotes")) return;
    const input = await body(req); if (!String(input.text || "").trim()) return fail(res, 422, "Введите текст заметки");
    const note = { id: id("note"), clientId: cid, authorUserId: actor.id, noteType: actor.role === "MANAGER" ? "MANAGER_NOTE" : "CLOSER_NOTE", text: String(input.text).trim(), createdAt: now() }; db.notes.push(note);c.updatedAt=note.createdAt; history(cid, actor.id, "NOTE_ADDED", null, { noteId: note.id, type: note.noteType }); saveDb(); return json(res, 201, note);
  }
  if (req.method === "POST" && /^\/api\/clients\/[^/]+\/reassign$/.test(url.pathname)) {
    const cid=url.pathname.split("/")[3],c=client(cid);if(!c||!canSeeClient(actor,c))return fail(res,404,"Клиент не найден");const input=await body(req),oldValue={managerId:c.currentManagerId,closerId:c.currentCloserId};
    if(input.managerId&&input.managerId!==c.currentManagerId){if(!requirePermission(res,actor,"clients.reassignManager"))return;const manager=user(input.managerId);if(!manager||!manager.active||manager.role!=="MANAGER")return fail(res,422,"Выберите активного менеджера");c.currentManagerId=manager.id;history(c.id,actor.id,"MANAGER_REASSIGNED",{managerId:oldValue.managerId},{managerId:manager.id});notify(manager.id,c.id,"CLIENT_REASSIGNED",`${c.name} · вы назначены менеджером`);}
    if(input.closerId&&input.closerId!==c.currentCloserId){if(!requirePermission(res,actor,"clients.reassignCloser"))return;const closer=user(input.closerId);if(!closer||!closer.active||closer.role!=="CLOSER")return fail(res,422,"Выберите активного клоузера");const activeTrial=db.trials.find((t)=>t.clientId===c.id&&t.active);if(activeTrial){const newSlot=db.availabilitySlots.find((s)=>s.id===input.newSlotId&&s.closerId===closer.id&&s.status==="FREE");if(!newSlot)return fail(res,409,"Для нового клоузера выберите свободное время");activeTrial.active=false;activeTrial.attendanceOutcome="RESCHEDULED";activeTrial.resultAt=now();activeTrial.resultActorUserId=actor.id;const oldSlot=db.availabilitySlots.find((s)=>s.id===activeTrial.slotId);if(oldSlot){oldSlot.status="FREE";oldSlot.bookedTrialId=null;}const trial={id:id("trial"),clientId:c.id,closerId:closer.id,managerId:c.currentManagerId,slotId:newSlot.id,scheduledAt:newSlot.startAt,completedAt:null,statusAtBookingId:c.currentStatusId,active:true,createdAt:now()};db.trials.push(trial);newSlot.status="BOOKED";newSlot.bookedTrialId=trial.id;history(c.id,actor.id,"TRIAL_RESCHEDULED",{trialId:activeTrial.id,scheduledAt:activeTrial.scheduledAt,closerId:activeTrial.closerId},{trialId:trial.id,scheduledAt:trial.scheduledAt,closerId:closer.id});}c.currentCloserId=closer.id;history(c.id,actor.id,"CLOSER_REASSIGNED",{closerId:oldValue.closerId},{closerId:closer.id});notify(closer.id,c.id,"CLIENT_REASSIGNED",`${c.name} · вы назначены клоузером`);}
    c.updatedAt=now();saveDb();return json(res,200,enrichClient(c,actor));
  }
  if (req.method === "POST" && /^\/api\/payments\/[^/]+\/correct$/.test(url.pathname)) {
    if(!requirePermission(res,actor,"payments.edit"))return;const old=db.payments.find((p)=>p.id===url.pathname.split("/")[3]&&!p.voidedAt);if(!old)return fail(res,404,"Активная оплата не найдена");const c=client(old.clientId);if(!c||c.archivedAt||c.permanentlyDeletedAt)return fail(res,409,"Оплаты архивного клиента доступны только для просмотра");if(!clientMatchesScope(actor,c,"payments"))return fail(res,403,"Оплата вне вашей области данных");const input=await body(req),amount=Number(input.amount);if(!(amount>0)||!db.paymentMethods.some((m)=>m.id===input.paymentMethodId&&m.active)||!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate||""))return fail(res,422,"Укажите корректную сумму, способ и дату оплаты");old.voidedAt=now();const payment={...old,id:id("pay"),amount,paymentMethodId:input.paymentMethodId,paymentDate:input.paymentDate,comment:input.comment||"",createdBy:actor.id,createdAt:now(),correctedFromPaymentId:old.id,voidedAt:null};db.payments.push(payment);c.updatedAt=payment.createdAt;const correction={id:id("pcorr"),originalPaymentId:old.id,replacementPaymentId:payment.id,correctedByUserId:actor.id,reason:String(input.reason||""),oldValue:structuredClone(old),newValue:structuredClone(payment),createdAt:now()};db.paymentCorrections.push(correction);history(c.id,actor.id,"PAYMENT_CORRECTED",{paymentId:old.id,amount:old.amount,paymentMethodId:old.paymentMethodId,paymentDate:old.paymentDate},{paymentId:payment.id,amount:payment.amount,paymentMethodId:payment.paymentMethodId,paymentDate:payment.paymentDate});audit(actor.id,"PAYMENT",old.id,"PAYMENT_CORRECTED",old,payment);saveDb();return json(res,201,payment);
  }
  if (req.method === "POST" && /^\/api\/clients\/[^/]+\/status$/.test(url.pathname)) {
    const cid = url.pathname.split("/")[3], c = client(cid); if (!c || !canSeeClient(actor, c)) return fail(res, 404, "Клиент не найден"); if (!hasPermission(actor,"clients.changeStatus") && !hasPermission(actor,"crm.changeStatus")) return fail(res,403,"Для изменения статуса требуется право «Клиенты → Изменение статуса» (clients.changeStatus) или «CRM / Канбан → Изменение статуса» (crm.changeStatus)",{missingPermissions:["clients.changeStatus","crm.changeStatus"]});
    const input = await body(req), next = status(input.statusId); if (!next || !next.active) return fail(res, 422, "Выберите активный статус");
    if(actor.role==="MANAGER"&&!['REQUIRE_RESCHEDULE','MARK_NO_SHOW'].includes(next.actionType))return fail(res,403,"Этот статус может изменить только клоузер");
    const paymentAction=next.actionType==="REQUIRE_PAYMENT"||next.partialPayment,requiredFields=next.actionType==="REQUIRE_RESCHEDULE"?(input.rescheduleMode==="LATER"?["refusalReasonId"]:["refusalReasonId","newSlotId"]):(paymentAction?["amount","paymentMethodId","paymentDate",...(next.partialPayment?["totalDealAmount","remainingPaymentDueDate"]:[])]:next.requiredFields||[]);const missing = requiredFields.filter((f) => input[f] === undefined || input[f] === null || input[f] === ""); if (missing.length) return fail(res, 422, "Заполните все обязательные поля", missing);
    const oldStatusId = c.currentStatusId;
    if (["REQUIRE_REFUSAL_REASON","REQUIRE_RESCHEDULE"].includes(next.actionType) && !db.refusalReasons.some((r) => r.id === input.refusalReasonId && r.active)) return fail(res, 422, next.actionType==="REQUIRE_RESCHEDULE"?"Выберите причину переноса":"Выберите активную причину отказа");
    if (next.actionType === "REQUIRE_RESCHEDULE") {
      if (!requirePermission(res, actor, "schedule.rescheduleTrial")) return;
      const later=input.rescheduleMode==="LATER",newSlot=later?null:db.availabilitySlots.find((s) => s.id === input.newSlotId && s.closerId === c.currentCloserId && s.status === "FREE"); if (!later&&!newSlot) return fail(res, 409, "Выбранное время недоступно");
      const oldTrial = db.trials.find((t) => t.clientId === c.id && t.active),changedAt=now(); if (oldTrial) { oldTrial.active = false;oldTrial.attendanceOutcome="RESCHEDULED";oldTrial.resultStatusId=next.id;oldTrial.resultAt=changedAt;oldTrial.resultActorUserId=actor.id;oldTrial.rescheduleReasonId=input.refusalReasonId; const oldSlot = db.availabilitySlots.find((s) => s.id === oldTrial.slotId); if (oldSlot) { oldSlot.status = "FREE"; oldSlot.bookedTrialId = null; } }
      const trial = later?{...oldTrial,id:id("trial"),closerId:null,slotId:null,scheduledAt:null,completedAt:null,resultStatusId:null,resultAt:null,resultActorUserId:null,attendanceOutcome:null,active:true,createdAt:changedAt,updatedAt:changedAt,assignmentState:"UNASSIGNED",assignedAt:null,assignedByUserId:null,assignmentVersion:1,pendingReschedule:true,rescheduleReasonId:input.refusalReasonId,rescheduleFromTrialId:oldTrial?.id||null,previousCloserId:oldTrial?.closerId||c.currentCloserId,pendingRescheduleAt:changedAt,pendingRescheduleByUserId:actor.id}:{ id: id("trial"), clientId: c.id, closerId: c.currentCloserId, managerId: c.currentManagerId, slotId: newSlot.id, scheduledAt: newSlot.startAt, completedAt: null, statusAtBookingId: oldTrial?.statusAtBookingId||c.currentStatusId, active: true, createdAt: changedAt,assignmentState:"SCHEDULED",assignmentVersion:1,rescheduleReasonId:input.refusalReasonId,rescheduleFromTrialId:oldTrial?.id||null,previousCloserId:oldTrial?.closerId||c.currentCloserId }; db.trials.push(trial);if(newSlot){newSlot.status = "BOOKED"; newSlot.bookedTrialId = trial.id;} history(c.id, actor.id, later?"TRIAL_RESCHEDULE_PENDING":"TRIAL_RESCHEDULED", oldTrial && { trialId:oldTrial.id,scheduledAt: oldTrial.scheduledAt,closerId:oldTrial.closerId }, { trialId:trial.id,scheduledAt: trial.scheduledAt,reasonId:input.refusalReasonId });if(later){for(const admin of db.users.filter((u)=>u.active&&u.role==="ADMIN"))notify(admin.id,c.id,"TRIAL_RESCHEDULE_PENDING",`${c.name} · пробный ожидает нового времени`,trial.id);}else{notify(c.currentManagerId,c.id,"TRIAL_RESCHEDULED",`${c.name} · ${trial.scheduledAt}`,trial.id);notify(c.currentCloserId,c.id,"TRIAL_RESCHEDULED",`${c.name} · ${trial.scheduledAt}`,trial.id);}
    }
    const changedAt=now();
    if (paymentAction) {
      if (!hasPermission(actor, "payments.create")) return fail(res,403,paymentStatusPermissionMessage(defaultRussianNames[next.id]||next.name),{missingPermission:"payments.create"});
      const amount = Number(input.amount); if (!(amount > 0) || !db.paymentMethods.some((m) => m.id === input.paymentMethodId && m.active) || !/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) return fail(res, 422, "Укажите корректную сумму, способ и дату оплаты");
      if(next.partialPayment){const total=Number(input.totalDealAmount),paidBefore=db.payments.filter((payment)=>payment.clientId===c.id&&!payment.voidedAt).reduce((sum,payment)=>sum+Number(payment.amount),0);if(!(total>0)||paidBefore+amount>total||!/^\d{4}-\d{2}-\d{2}$/.test(input.remainingPaymentDueDate))return fail(res,422,"Общая сумма должна быть не меньше всех оплат, укажите дату доплаты");c.totalDealAmount=total;c.remainingPaymentDueDate=input.remainingPaymentDueDate;c.prepaymentStartedAt=c.prepaymentStartedAt||changedAt;}
      const payment = { id: id("pay"), clientId: c.id, managerAttributionId: c.originalManagerId, closerAttributionId: actor.role === "CLOSER" ? actor.id : c.currentCloserId, amount, paymentMethodId: input.paymentMethodId, paymentDate: input.paymentDate, comment: input.paymentComment || "", createdBy: actor.id, createdAt: changedAt, correctedFromPaymentId: null, voidedAt: null }; db.payments.push(payment); history(c.id, actor.id, "PAYMENT_CREATED", null, { paymentId: payment.id, amount, paymentDate: payment.paymentDate,totalDealAmount:c.totalDealAmount||null,remainingPaymentDueDate:c.remainingPaymentDueDate||null }); notify(c.currentManagerId, c.id, "PAYMENT_RECORDED", `${c.name} · ${amount} ₸`);
    }
    c.currentReasonId=input.refusalReasonId||null;
    c.currentStatusId = next.id;if(oldStatusId!==next.id)c.statusChangedAt=changedAt;c.updatedAt=changedAt; const activeTrial = db.trials.find((t) => t.clientId === c.id && t.active); if (activeTrial && next.actionType !== "REQUIRE_RESCHEDULE" && next.id!==activeTrial.statusAtBookingId){activeTrial.completedAt = changedAt;activeTrial.active=false;activeTrial.resultStatusId=next.id;activeTrial.resultAt=changedAt;activeTrial.resultActorUserId=actor.id;activeTrial.attendanceOutcome=next.actionType==="MARK_NO_SHOW"?"NO_SHOW":"REACHED";const occupiedSlot=db.availabilitySlots.find((s)=>s.id===activeTrial.slotId&&s.bookedTrialId===activeTrial.id);if(occupiedSlot)occupiedSlot.status="OCCUPIED";} history(c.id, actor.id, "STATUS_CHANGED", { statusId: oldStatusId }, { statusId: next.id, refusalReasonId: input.refusalReasonId || null,trialId:activeTrial?.id||null,attendanceOutcome:activeTrial?.attendanceOutcome||null,totalDealAmount:c.totalDealAmount||null,remainingPaymentDueDate:c.remainingPaymentDueDate||null }); saveDb(); return json(res, 200, enrichClient(c,actor));
  }
  if(["PUT","DELETE"].includes(req.method)&&/^\/api\/slots\/[^/]+$/.test(url.pathname)){
    const target=db.availabilitySlots.find(item=>item.id===url.pathname.split("/").pop());if(!target)return fail(res,404,"Слот не найден");const managesOther=target.closerId!==actor.id;
    if(managesOther){if(!requirePermission(res,actor,"schedule.manageOthers"))return;if(!userMatchesScope(actor,target.closerId,"schedule"))return fail(res,403,"Область данных не включает этого сотрудника");}else if(!requirePermission(res,actor,"schedule.editOwnAvailability"))return;
    if(new Date(target.startAt)<=new Date())return fail(res,409,"Прошедший слот нельзя изменить или удалить");if(target.status!=="FREE"||target.bookedTrialId)return fail(res,409,"На этот слот уже записан пробный урок");if(db.trials.some(trial=>trial.slotId===target.id))return fail(res,409,"Слот содержит историю пробного урока и должен быть сохранён");
    const oldValue=structuredClone(target);if(req.method==="DELETE"){db.availabilitySlots=db.availabilitySlots.filter(item=>item.id!==target.id);audit(actor.id,"AVAILABILITY_SLOT",target.id,"AVAILABILITY_SLOT_DELETED",oldValue,null);saveDb();return json(res,200,{id:target.id,deleted:true});}
    const input=await body(req),date=String(input.date||""),clock=String(input.time||""),duration=Number(input.durationMinutes);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(clock)||!Number.isInteger(duration)||duration<10||duration>180)return fail(res,422,"Укажите корректные дату, время и длительность от 10 до 180 минут");const startAt=new Date(`${date}T${clock}:00+05:00`);if(Number.isNaN(startAt.getTime())||startAt<=new Date())return fail(res,422,"Новый слот должен быть в будущем");const endAt=new Date(startAt.getTime()+duration*60000);if(db.availabilitySlots.some(item=>item.id!==target.id&&item.closerId===target.closerId&&new Date(item.startAt)<endAt&&new Date(item.endAt)>startAt))return fail(res,409,"Новое время пересекается с другим слотом клоузера");target.startAt=startAt.toISOString();target.endAt=endAt.toISOString();target.updatedAt=now();audit(actor.id,"AVAILABILITY_SLOT",target.id,"AVAILABILITY_SLOT_UPDATED",oldValue,target);saveDb();return json(res,200,target);
  }
  if (req.method === "POST" && url.pathname === "/api/slots/generate") {
    const input = await body(req); const requestedCloser = input.closerId || actor.id; const managingOther = requestedCloser !== actor.id;
    if (managingOther) { if (!requirePermission(res,actor,"schedule.manageOthers")) return; if (!userMatchesScope(actor,requestedCloser,"schedule")) return fail(res,403,"Область данных не включает этого сотрудника"); }
    else if (!requirePermission(res,actor,"schedule.createOwnAvailability")) return;
    const closerId = requestedCloser; const closer=user(closerId);
    if(!closer||!closer.active||closer.role!=="CLOSER")return fail(res,422,"Выберите активного клоузера");
    const [sh, sm] = String(input.start || "").split(":").map(Number), [eh, em] = String(input.end || "").split(":").map(Number), duration = Number(input.durationMinutes ?? input.interval ?? closer.trialDurationMinutes ?? 60);
    const validDate=/^\d{4}-\d{2}-\d{2}$/.test(String(input.date||"")),validClock=Number.isInteger(sh)&&sh>=0&&sh<=23&&Number.isInteger(sm)&&sm>=0&&sm<=59&&Number.isInteger(eh)&&eh>=0&&eh<=23&&Number.isInteger(em)&&em>=0&&em<=59;
    if (!validDate || !validClock || !Number.isInteger(duration) || duration<10 || duration>180 || !(eh * 60 + em > sh * 60 + sm)) return fail(res, 422, "Укажите корректную дату, диапазон времени и длительность от 10 до 180 минут");
    closer.trialDurationMinutes=duration;let cursor = sh * 60 + sm, created = 0; while (cursor + duration <= eh * 60 + em) { const hh = String(Math.floor(cursor/60)).padStart(2,"0"),mm=String(cursor%60).padStart(2,"0"),startAt=new Date(`${input.date}T${hh}:${mm}:00+05:00`).toISOString(),endAt=new Date(new Date(startAt).getTime()+duration*60000).toISOString();if(!db.availabilitySlots.some((s)=>s.closerId===closerId&&new Date(s.startAt)<new Date(endAt)&&new Date(s.endAt)>new Date(startAt))){db.availabilitySlots.push({id:id("slot"),closerId,startAt,endAt,status:"FREE",bookedTrialId:null,createdAt:now()});created++;}cursor+=duration;}
    saveDb(); return json(res, 201, { created,durationMinutes:duration });
  }
  if (req.method === "GET" && url.pathname === "/api/analytics") {
    if (!requirePermission(res, actor, "analytics.view")) return; return json(res,200,analyticsReport(actor,analyticsFilters(url.searchParams)));
  }
  if (req.method === "GET" && url.pathname === "/api/export/analytics.csv") {
    if (!requirePermission(res,actor,"analytics.export"))return;const report=analyticsReport(actor,analyticsFilters(url.searchParams)),rows=[],push=(...values)=>rows.push(values);
    push("Аналитика Milton",`${report.filters.from} — ${report.filters.to}`);push();push("KPI","Значение");push("Пробные уроки (события)",report.kpis.trials);push("Уникальные клиенты с пробным уроком",report.kpis.trialClients);push("Оплаты",report.kpis.payments);push("Уникальные конвертированные клиенты",report.kpis.convertedClients);push("Конверсия",`${report.kpis.conversion.toFixed(1)}%`);push("Выручка",report.kpis.revenue);push("Средний чек",Math.round(report.kpis.average));push();push("Доходимость","Значение");push("Назначено",report.attendance.scheduled);push("Дошли",report.attendance.reached);push("Неявка",report.attendance.noShow);push("Перенос",report.attendance.rescheduled);push("Просрочено без результата",report.attendance.unresolvedOverdue);push("Доходимость",`${report.attendance.attendance.toFixed(1)}%`);push();push("Текущие статусы уникальных клиентов","Количество","Доля");report.statuses.forEach((row)=>push(defaultRussianNames[row.id]||row.name,row.count,`${row.percentage.toFixed(1)}%`));
    if(report.managers.length){push();push("Менеджеры","Клиенты","Уроки","Оплаты","Конверсия","Выручка","Средний чек");report.managers.forEach((row)=>push(row.name,row.clients,row.trials,row.payments,`${row.conversion.toFixed(1)}%`,row.revenue,Math.round(row.average)));}
    if(report.closers.length){push();push("Клоузеры","Уроки","Проведено","Оплаты","Конверсия","Выручка","Средний чек");report.closers.forEach((row)=>push(row.name,row.trials,row.conducted,row.payments,`${row.conversion.toFixed(1)}%`,row.revenue,Math.round(row.average)));}
    if(report.refusals.length){push();push("Причины отказа","Количество","Доля");report.refusals.forEach((row)=>push(defaultRussianNames[row.id]||row.name,row.count,`${row.percentage.toFixed(1)}%`));}
    if(report.sources.length){push();push("Источники","Клиенты","Уроки","Оплаты","Конверсия","Выручка","Средний чек");report.sources.forEach((row)=>push(defaultRussianNames[row.id]||row.name,row.clients,row.trials,row.payments,`${row.conversion.toFixed(1)}%`,row.revenue,Math.round(row.average)));}
    if(report.paymentMethods.length){push();push("Способы оплаты","Оплаты","Выручка","Доля выручки");report.paymentMethods.forEach((row)=>push(defaultRussianNames[row.id]||row.name,row.payments,row.revenue,`${row.share.toFixed(1)}%`));}
    const csv=rows.map((row)=>row.map((value)=>`"${String(value??"").replaceAll('"','""')}"`).join(",")).join("\n");res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=milton-analytics.csv"});return res.end(`\uFEFF${csv}`);
  }
  if (req.method === "GET" && ["/api/export/trials.csv","/api/export/payments.csv"].includes(url.pathname)) {
    if(!requirePermission(res,actor,"analytics.export"))return;const f=analyticsFilters(url.searchParams),ids=new Set(db.clients.filter((c)=>analyticsClientMatch(actor,c,f)).map((c)=>c.id));let rows;
    if(url.pathname.endsWith("trials.csv")){rows=[["Клиент","Дата пробного урока","Менеджер","Клоузер","Активный","Проведён"]];db.trials.filter((t)=>ids.has(t.clientId)&&inRange(t.scheduledAt,f.from,f.to)&&(!f.managerId||t.managerId===f.managerId)&&(!f.closerId||t.closerId===f.closerId)).forEach((t)=>rows.push([client(t.clientId)?.name,dayKey(t.scheduledAt),user(t.managerId)?.name,user(t.closerId)?.name,t.active?"Да":"Нет",t.completedAt?"Да":"Нет"]));}
    else{rows=[["Клиент","Дата оплаты","Сумма","Способ","Менеджер","Клоузер","Комментарий"]];db.payments.filter((p)=>!p.voidedAt&&ids.has(p.clientId)&&inRange(p.paymentDate,f.from,f.to)&&(!f.managerId||p.managerAttributionId===f.managerId)&&(!f.closerId||p.closerAttributionId===f.closerId)&&(!f.paymentMethodId||p.paymentMethodId===f.paymentMethodId)).forEach((p)=>rows.push([client(p.clientId)?.name,p.paymentDate,p.amount,db.paymentMethods.find((m)=>m.id===p.paymentMethodId)?.name,user(p.managerAttributionId)?.name,user(p.closerAttributionId)?.name,p.comment||""]));}
    const csv=rows.map((row)=>row.map((value)=>`"${String(value??"").replaceAll('"','""')}"`).join(",")).join("\n"),filename=url.pathname.endsWith("trials.csv")?"milton-trials.csv":"milton-payments.csv";res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename=${filename}`});return res.end(`\uFEFF${csv}`);
  }
  if (req.method === "GET" && url.pathname === "/api/export/clients.csv") {
    if (!requirePermission(res, actor, "analytics.export")) return; const filters=analyticsFilters(url.searchParams),rows = [["Клиент","Телефон","Статус","Менеджер","Клоузер","Источник лида","Создан"]]; db.clients.filter((c)=>analyticsClientMatch(actor,c,filters)).forEach((c) => rows.push([c.name,c.normalizedPhone,defaultRussianNames[c.currentStatusId]||status(c.currentStatusId)?.name,user(c.currentManagerId)?.name,user(c.currentCloserId)?.name,defaultRussianNames[c.leadSourceId]||db.leadSources.find((s)=>s.id===c.leadSourceId)?.name,c.createdAt])); const csv = rows.map((r)=>r.map((v)=>`"${String(v||"").replaceAll('"','""')}"`).join(",")).join("\n"); res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=milton-clients.csv"}); return res.end(`\uFEFF${csv}`);
  }
  return fail(res, 404, "Адрес API не найден");
}

postgresWriteHandler=createPostgresWriteHandler({storage:runtimeStorage,readBody:body,sendJson,normalizePhone,archiveReasons:CLIENT_ARCHIVE_REASONS,hashPassword,validImageData,fileStorage,validateTrialPayment});
async function handleRequest(req,res){
  const startedAt=process.hrtime.bigint();
  const requestId=attachRequestContext(req,res);
  try{
    const url=new URL(req.url,`http://${req.headers.host}`);
    if(req.method==="GET"&&url.pathname==="/api/health"){
      const backend=runtimeStorage instanceof PostgresStorage?"postgres":"json";
      const database=backend==="postgres"?await runtimeStorage.healthCheck():{ok:true};
      return sendJson(res,database.ok?200:503,{status:database.ok?"ok":"unavailable",storage:backend});
    }
    if(!url.pathname.startsWith("/api/"))return serveStatic(PUBLIC_DIR,req,res,url);
    if(runtimeStorage instanceof PostgresStorage&&req.method==="POST"&&url.pathname==="/api/login"){
      const input=await body(req),rateKey=loginRateKey(req,input.login),retryAfter=loginRateLimiter.retryAfterSeconds(rateKey);if(retryAfter){res.setHeader("Retry-After",String(retryAfter));return sendJson(res,429,{error:"Слишком много попыток входа. Попробуйте позже"});}const found=await runtimeStorage.users.findByLogin(String(input.login||""));
      if(!found||!found.active||!verifyPassword(String(input.password||""),found.passwordHash)){loginRateLimiter.recordFailure(rateKey);return sendJson(res,401,{error:"Неверный логин или пароль"});}
      loginRateLimiter.reset(rateKey);
      const token=crypto.randomBytes(32).toString("hex");await runtimeStorage.sessions.createToken(token,found.id);
      res.setHeader("Set-Cookie",`milton_session=${token}; HttpOnly;${secureCookie} SameSite=Strict; Path=/; Max-Age=43200`);
      return sendJson(res,200,{token,user:publicUser(found)});
    }
    if(runtimeStorage instanceof PostgresStorage&&await postgresWriteHandler(req,res,url))return;
    if(runtimeStorage instanceof PostgresStorage&&req.method==="GET"&&url.pathname==="/api/bootstrap"){
      const token=(req.headers.authorization||"").replace(/^Bearer /,"")||(req.headers.cookie||"").match(/milton_session=([^;]+)/)?.[1];
      const userId=token?await runtimeStorage.sessions.getUserId(token):null;
      if(userId)await runtimeStorage.ensureOperationalNotificationsFor(userId);
    }
    const readOnlyState=req.method==="GET";
    const context=await runtimeStorage.runState(async(state,storage)=>{
      const current={state,storage,dirty:false,response:null};
      await requestState.run(current,()=>api(req,res,url));
      return current;
    },{readOnly:readOnlyState});
    if(context.response&&!res.writableEnded)sendJson(res,context.response.code,context.response.value);
  }catch(error){
    console.error(error);
    if(!res.headersSent){const code=error.statusCode||(error instanceof SyntaxError?400:500);sendJson(res,code,{error:code===413?"Слишком большой запрос":error instanceof SyntaxError?"Некорректный JSON":"Внутренняя ошибка сервера"});}
    else if(!res.writableEnded)res.end();
  }finally{
    const durationMs=Number(process.hrtime.bigint()-startedAt)/1e6;
    const requestPath=urlForLog(req.url);
    if(requestPath!=="/api/health")console.log(JSON.stringify({type:"http_request",requestId,method:req.method,path:requestPath,status:res.statusCode,durationMs:Number(durationMs.toFixed(1))}));
    if(res.statusCode>=200&&res.statusCode<300&&requestPath!=="/api/login"){
      const resources=resourcesForMutation(req.method,requestPath);if(resources.length)realtimeHub.publish(resources);
    }
  }
}
function urlForLog(value){try{return new URL(value,"http://localhost").pathname;}catch{return "/invalid-url";}}
const server=http.createServer(handleRequest);
server.requestTimeout=30_000;
server.headersTimeout=35_000;
server.keepAliveTimeout=5_000;
server.maxRequestsPerSocket=1_000;
async function startServer(port=PORT,host=HOST){if(STORAGE_CONFIG.backend==="postgres"){await runtimeStorage.assertSchema();await runtimeStorage.startChangeListener((resources)=>realtimeHub.publish(resources));}return new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,host,()=>{server.off("error",reject);resolve(server);});});}
async function closeStorage(){realtimeHub.close();await runtimeStorage.close();}
async function run(){
  let shuttingDown=false;
  const shutdown=async(signal)=>{
    if(shuttingDown)return;
    shuttingDown=true;
    console.log(`Milton CRM: ${signal}, завершение работы`);
    realtimeHub.close();
    if(server.listening)await new Promise((resolve)=>server.close(resolve));
    await runtimeStorage.close();
  };
  for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>shutdown(signal).then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1);}));
  return startServer().then(()=>console.log(`Milton CRM запущена: http://${HOST}:${PORT} · ${STORAGE_CONFIG.backend}`)).catch((error)=>{console.error(error);process.exitCode=1;});
}
module.exports={server,startServer,closeStorage,run,setStorageForTests,setVpsDeploymentServiceForTests,storageBackend:STORAGE_CONFIG.backend,normalizePhone,seedDatabase,defaultRoles,PERMISSION_KEYS,applyOverrides,analyticsFilters,analyticsReport,dayKey,setDbForTests};
