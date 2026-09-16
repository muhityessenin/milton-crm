"use strict";

const crypto = require("node:crypto");
const { Pool, Client } = require("pg");
const { createRepositories, camelRow } = require("./repositories");
const { PostgresStateRepository } = require("./state-repository");

const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const CHANGE_RESOURCES = {
  clients:["clients","schedule","analytics"], trials:["trials","schedule","clients","analytics"],
  availability_slots:["schedule"], payments:["payments","clients","analytics"], payment_corrections:["payments","clients","analytics"],
  notes:["clients"], client_history:["clients"], notifications:["notifications"], users:["users","schedule","clients"],
  roles:["users","settings"], role_permissions:["users","settings"], role_scopes:["users","settings"],
  user_permission_overrides:["users","settings"], user_scope_overrides:["users","settings"],
  statuses:["references","clients","analytics"], lead_sources:["references","clients","analytics"], tags:["references","clients"],
  refusal_reasons:["references","analytics"], payment_methods:["references","analytics"], app_settings:["settings"],
  teams:["users","finance"], employee_compensation_history:["users","finance"], payment_method_commission_history:["references","finance"], finance_trial_bonus_statuses:["settings","finance"],
};

class PostgresStorage {
  constructor({ pool, db = pool, ownsPool = true, stateCache, stateCacheTtlMillis = 5000, notificationRefreshMillis = 30000 }) {
    this.pool = pool;
    this.db = db;
    this.ownsPool = ownsPool;
    this.stateCache = stateCache || { value: null, expiresAt: 0, pending: null, revision:0, changeFeedReady:false };
    this.stateCacheTtlMillis = stateCacheTtlMillis;
    this.notificationRefreshMillis=notificationRefreshMillis;
    this.notificationRefreshes=new Map();
    this.stateWriteQueue = Promise.resolve();
    this.changeListener = null;
    this.changeListenerTimer = null;
    this.changeListenerFlushTimer = null;
    this.changeListenerResources = new Set();
    this.changeListenerStopped = false;
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
    return new PostgresStorage({ pool, stateCacheTtlMillis: options.stateCacheTtlMillis ?? 5000 });
  }

  async healthCheck() {
    const result = await this.db.query("SELECT 1 AS ok, current_database() AS database_name");
    return { ok: result.rows[0].ok === 1, databaseName: result.rows[0].database_name };
  }

  async assertSchema() {
    const result = await this.db.query(`
      SELECT version FROM public.schema_migrations
      WHERE version IN ('001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011') ORDER BY version
    `);
    if (result.rows.map((row) => row.version).join(",") !== "001,002,003,004,005,006,007,008,009,010,011") {
      throw new Error("Milton PostgreSQL migrations 001 through 011 are required");
    }
  }

  async startChangeListener(onChange) {
    if (!this.ownsPool || this.changeListener) return;
    this.changeListenerStopped = false;
    const client = new Client(this.pool.options);
    try { await client.connect(); }
    catch (error) { await client.end().catch(()=>{}); throw error; }
    const flush = () => {
      this.changeListenerFlushTimer=null;
      const resources=[...this.changeListenerResources];
      this.changeListenerResources.clear();
      this.invalidateStateCache();
      onChange(resources.length?resources:["bootstrap"]);
    };
    const handle = (message) => {
      try {
        const payload = JSON.parse(message.payload || "{}");
        for(const resource of CHANGE_RESOURCES[payload.table]||["bootstrap"])this.changeListenerResources.add(resource);
      } catch { this.changeListenerResources.add("bootstrap"); }
      if(!this.changeListenerFlushTimer){
        this.changeListenerFlushTimer=setTimeout(flush,10);
        this.changeListenerFlushTimer.unref?.();
      }
    };
    const reconnect = (error) => {
      if(error)console.error(`PostgreSQL realtime listener error: ${error.code || error.message}`);
      if(this.changeListenerStopped||this.changeListenerTimer)return;
      this.stateCache.changeFeedReady=false;
      this.invalidateStateCache();
      this.changeListener=null;
      client.off("notification",handle);client.end().catch(()=>{});
      this.changeListenerTimer=setTimeout(()=>{this.changeListenerTimer=null;this.startChangeListener(onChange).catch(reconnect)},1000);
      this.changeListenerTimer.unref?.();
    };
    client.on("notification", handle);
    client.once("error", reconnect);
    client.once("end", ()=>reconnect());
    await client.query("LISTEN milton_crm_changes");
    this.stateCache.changeFeedReady=true;
    this.changeListener = { client, handle };
  }

  async stopChangeListener() {
    this.changeListenerStopped=true;clearTimeout(this.changeListenerTimer);this.changeListenerTimer=null;
    clearTimeout(this.changeListenerFlushTimer);this.changeListenerFlushTimer=null;this.changeListenerResources.clear();
    this.stateCache.changeFeedReady=false;
    if (!this.changeListener) return;
    const { client, handle } = this.changeListener;
    this.changeListener = null;
    client.off("notification", handle);
    await client.query("UNLISTEN milton_crm_changes").catch(() => {});
    await client.end().catch(() => {});
  }

  invalidateStateCache() {
    this.stateCache.revision=(this.stateCache.revision||0)+1;
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
      let state = this.stateCache.value && (this.stateCache.changeFeedReady || (this.stateCacheTtlMillis > 0 && this.stateCache.expiresAt > Date.now()))
        ? this.stateCache.value
        : null;
      if (!state) {
        if (!this.stateCache.pending) {
          this.stateCache.pending=(async()=>{
            // A single business operation can emit many table notifications.
            // Let the short listener batch settle before starting the expensive snapshot.
            if(this.stateCache.changeFeedReady&&(this.stateCache.revision||0)>0)await new Promise((resolve)=>setTimeout(resolve,15));
            const revision=this.stateCache.revision||0;
            const value=await this.transaction((tx)=>tx.state.load({includeAuditLogs:false,includeMedia:false}),{invalidateCache:false});
            return{value,revision};
          })();
        }
        const pending=this.stateCache.pending;
        try {
          const loaded=await pending;state=loaded.value;
          if (loaded.revision===(this.stateCache.revision||0)&&this.stateCacheTtlMillis > 0) {
            this.stateCache.value = state;
            this.stateCache.expiresAt = Date.now() + this.stateCacheTtlMillis;
          }
        } finally {
          if(this.stateCache.pending===pending)this.stateCache.pending=null;
        }
      }
      const result = await work(state, this);
      if (result?.dirty) throw new Error("Read-only API request attempted to mutate PostgreSQL state");
      return result;
    }
    const execute = () => this.transaction(async (tx) => {
      await tx.db.query("SELECT pg_advisory_xact_lock(hashtext('milton_crm_api_state'))");
      const state = await tx.state.load({includeAuditLogs:true,includeMedia:true});
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
    if(!userId)return 0;
    const current=this.notificationRefreshes.get(userId);
    if(current?.pending)return current.pending;
    if(current?.nextAt>Date.now())return 0;
    const pending=this.refreshOperationalNotificationsFor(userId);
    this.notificationRefreshes.set(userId,{pending,nextAt:0});
    try{const result=await pending;this.notificationRefreshes.set(userId,{pending:null,nextAt:Date.now()+this.notificationRefreshMillis});return result;}
    catch(error){this.notificationRefreshes.delete(userId);throw error;}
  }

  async refreshOperationalNotificationsFor(userId) {
    if (!userId) return 0;
    const statusChanges=await this.db.query(`
      WITH candidates AS (
        SELECT c.id client_id,c.current_status_id old_status_id,desired.id new_status_id,c.current_manager_id actor_id,t.id trial_id
        FROM clients c JOIN statuses current_status ON current_status.id=c.current_status_id
        JOIN trials t ON t.client_id=c.id AND t.active AND NOT t.pending_reschedule
        JOIN LATERAL (
          SELECT id FROM statuses
          WHERE system_key=CASE WHEN COALESCE(t.preferred_date,(t.scheduled_at AT TIME ZONE 'Asia/Almaty')::date)=(now() AT TIME ZONE 'Asia/Almaty')::date THEN 'TODAY' ELSE 'PLANNED' END
            AND deleted_at IS NULL LIMIT 1
        ) desired ON true
        WHERE c.archived_at IS NULL AND current_status.system_key IN ('TODAY','PLANNED') AND c.current_status_id<>desired.id
      ), updated_clients AS (
        UPDATE clients c SET current_status_id=x.new_status_id,status_changed_at=now(),updated_at=now()
        FROM candidates x WHERE c.id=x.client_id RETURNING c.id
      ), updated_trials AS (
        UPDATE trials t SET status_at_booking_id=x.new_status_id,updated_at=now()
        FROM candidates x WHERE t.id=x.trial_id RETURNING t.id
      ), history_rows AS (
        INSERT INTO client_history(id,client_id,actor_user_id,event_type,old_value,new_value)
        SELECT 'hist_'||substr(replace(gen_random_uuid()::text,'-',''),1,8),client_id,actor_id,'STATUS_CHANGED',jsonb_build_object('statusId',old_status_id),jsonb_build_object('statusId',new_status_id,'automatic',true,'reason','CALENDAR_DATE') FROM candidates RETURNING id
      )
      INSERT INTO audit_logs(id,actor_user_id,entity_type,entity_id,action,old_value,new_value)
      SELECT 'audit_'||substr(replace(gen_random_uuid()::text,'-',''),1,8),actor_id,'CLIENT',client_id,'STATUS_AUTO_CHANGED',jsonb_build_object('statusId',old_status_id),jsonb_build_object('statusId',new_status_id) FROM candidates
    `);
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
    const unassigned=await this.db.query(`
      INSERT INTO notifications(id,user_id,client_id,trial_id,type,content)
      SELECT 'notif_'||substr(replace(gen_random_uuid()::text,'-',''),1,8),$1,t.client_id,t.id,
        CASE WHEN t.pending_reschedule THEN 'TRIAL_RESCHEDULE_PENDING' ELSE 'UNASSIGNED_TRIAL_OVERDUE' END,
        c.name||CASE WHEN t.pending_reschedule THEN ' · пробный ожидает нового времени' ELSE ' · пробный ожидает назначения' END
      FROM trials t JOIN clients c ON c.id=t.client_id CROSS JOIN app_settings s JOIN users viewer ON viewer.id=$1
      WHERE t.active AND t.assignment_state='UNASSIGNED' AND c.archived_at IS NULL
        AND s.unassigned_trial_reminder_minutes>0
        AND now()>=t.created_at+make_interval(mins=>s.unassigned_trial_reminder_minutes)
        AND (t.manager_id=$1 OR viewer.business_role='ADMIN')
      ON CONFLICT(user_id,type,trial_id) WHERE trial_id IS NOT NULL DO NOTHING
    `,[userId]);
    const balances=await this.db.query(`
      INSERT INTO notifications(id,user_id,client_id,type,content)
      SELECT 'notif_'||substr(replace(gen_random_uuid()::text,'-',''),1,8),$1,c.id,'PREPAYMENT_BALANCE_DUE',
        c.name||CASE WHEN c.remaining_payment_due_date=(now() AT TIME ZONE 'Asia/Almaty')::date THEN ' · доплата сегодня: ' ELSE ' · доплата просрочена: ' END||
        greatest(0,c.total_deal_amount-COALESCE(p.paid,0))||' ₸'
      FROM clients c
      JOIN users viewer ON viewer.id=$1
      LEFT JOIN (SELECT client_id,sum(amount) paid FROM payments WHERE voided_at IS NULL GROUP BY client_id) p ON p.client_id=c.id
      WHERE c.archived_at IS NULL AND c.total_deal_amount IS NOT NULL AND c.remaining_payment_due_date IS NOT NULL
        AND c.remaining_payment_due_date<=(now() AT TIME ZONE 'Asia/Almaty')::date
        AND c.total_deal_amount-COALESCE(p.paid,0)>0
        AND (c.current_manager_id=$1 OR viewer.business_role='ADMIN')
      ON CONFLICT(user_id,client_id,type) WHERE trial_id IS NULL AND client_id IS NOT NULL AND type='PREPAYMENT_BALANCE_DUE'
      DO UPDATE SET content=EXCLUDED.content,updated_at=now(),resolved_at=NULL
      WHERE notifications.content IS DISTINCT FROM EXCLUDED.content OR notifications.resolved_at IS NOT NULL
    `,[userId]);
    const resolvedBalances=await this.db.query(`
      UPDATE notifications n SET resolved_at=now(),snoozed_until=NULL,updated_at=now()
      WHERE n.user_id=$1 AND n.type='PREPAYMENT_BALANCE_DUE' AND n.resolved_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM clients c LEFT JOIN payments p ON p.client_id=c.id AND p.voided_at IS NULL
          WHERE c.id=n.client_id AND c.total_deal_amount IS NOT NULL
          GROUP BY c.id HAVING c.total_deal_amount-COALESCE(sum(p.amount),0)>0
        )
    `,[userId]);
    if(statusChanges.rowCount||result.rowCount||unassigned.rowCount||balances.rowCount||resolvedBalances.rowCount)this.invalidateStateCache();
    return statusChanges.rowCount+result.rowCount+unassigned.rowCount+balances.rowCount+resolvedBalances.rowCount;
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
        trialType: input.trialType || "FREE",
        trialAmount: input.trialAmount || 0,
        trialPaymentDate: input.trialPaymentDate || null,
        registeredByUserId: input.registeredByUserId || input.actorUserId,
        receiptStorageKey: input.receiptStorageKey || null,
        receiptOriginalName: input.receiptOriginalName || null,
        receiptMimeType: input.receiptMimeType || null,
        receiptSizeBytes: input.receiptSizeBytes || null,
        receiptUploadedAt: input.receiptUploadedAt || null,
      });
      await tx.history.append({ id: input.clientHistoryId || id("hist"), clientId: client.id, actorUserId: input.actorUserId, eventType: "CLIENT_CREATED", oldValue: null, newValue: { name: client.name, phone: client.normalizedPhone }, createdAt });
      await tx.history.append({ id: input.trialHistoryId || id("hist"), clientId: client.id, actorUserId: input.actorUserId, eventType: "TRIAL_SCHEDULED", oldValue: null, newValue: { scheduledAt: trial.scheduledAt, closerId: trial.closerId }, createdAt });
      await tx.notifications.create({ id: input.notificationId || id("notif"), userId: input.closerId, clientId: client.id, trialId: trial.id, type: "TRIAL_ASSIGNED", content: `${client.name} · ${trial.scheduledAt}`, createdAt });
      return { client, trial };
    });
  }

  async registerClientUnassignedTrial(input){
    return this.transaction(async(tx)=>{
      const duplicate=await tx.clients.findByNormalizedPhone(input.normalizedPhone);if(duplicate)throw Object.assign(new Error(duplicate.archivedAt?"Клиент с таким номером находится в архиве":"Клиент с таким номером телефона уже существует"),{code:"DUPLICATE_PHONE",clientId:duplicate.id});
      const createdAt=input.createdAt||now();const client=await tx.clients.create({id:input.clientId||id("cl"),name:input.name,normalizedPhone:input.normalizedPhone,originalPhone:input.originalPhone,originalManagerId:input.managerId,currentManagerId:input.managerId,currentCloserId:null,currentStatusId:input.statusId,leadSourceId:input.leadSourceId||null,registrationComment:input.registrationComment||"",tagIds:input.tagIds||[],createdAt,updatedAt:createdAt});
      const trial=await tx.trials.create({id:input.trialId||id("trial"),clientId:client.id,managerId:input.managerId,closerId:null,slotId:null,scheduledAt:null,statusAtBookingId:input.statusId,active:true,createdAt,assignmentState:"UNASSIGNED",preferredTimeText:input.preferredTimeText||null,preferredDate:input.preferredDate||null,preferredStartTime:input.preferredStartTime||null,preferredEndTime:input.preferredEndTime||null,trialType:input.trialType||"FREE",trialAmount:input.trialAmount||0,trialPaymentDate:input.trialPaymentDate||null,registeredByUserId:input.registeredByUserId||input.actorUserId,receiptStorageKey:input.receiptStorageKey||null,receiptOriginalName:input.receiptOriginalName||null,receiptMimeType:input.receiptMimeType||null,receiptSizeBytes:input.receiptSizeBytes||null,receiptUploadedAt:input.receiptUploadedAt||null});
      await tx.history.append({id:id("hist"),clientId:client.id,actorUserId:input.actorUserId,eventType:"CLIENT_CREATED",oldValue:null,newValue:{name:client.name,phone:client.normalizedPhone},createdAt});await tx.history.append({id:id("hist"),clientId:client.id,actorUserId:input.actorUserId,eventType:"TRIAL_REGISTERED_UNASSIGNED",oldValue:null,newValue:{preferredTimeText:trial.preferredTimeText},createdAt});await tx.auditLogs.append({id:id("audit"),actorUserId:input.actorUserId,entityType:"TRIAL",entityId:trial.id,action:"TRIAL_REGISTERED_UNASSIGNED",oldValue:null,newValue:{clientId:client.id,preferredTimeText:trial.preferredTimeText},createdAt});return{client,trial};
    });
  }

  async rescheduleTrial(input) {
    return this.transaction(async (tx) => {
      const clientResult = await tx.db.query("SELECT * FROM public.clients WHERE id = $1 FOR UPDATE", [input.clientId]);
      if (!clientResult.rowCount) throw Object.assign(new Error("Клиент не найден"), { code: "CLIENT_NOT_FOUND" });
      const client = camelRow(clientResult.rows[0]);
      const oldTrial = await tx.trials.findActiveByClient(input.clientId, { forUpdate: true });
      const later=input.rescheduleMode==="LATER";
      const newSlot = later?null:await tx.availabilitySlots.lockById(input.newSlotId);
      if (!later&&(!newSlot || newSlot.status !== "FREE" || newSlot.closerId !== client.currentCloserId)) {
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
      const trial = await tx.trials.create(later?{
        ...oldTrial,id:input.trialId||id("trial"),clientId:client.id,managerId:client.currentManagerId,
        closerId:null,slotId:null,scheduledAt:null,completedAt:null,resultStatusId:null,resultAt:null,
        resultActorUserId:null,attendanceOutcome:null,active:true,createdAt:changedAt,assignmentState:"UNASSIGNED",
        assignedAt:null,assignedByUserId:null,assignmentVersion:1,pendingReschedule:true,
        rescheduleReasonId:input.reasonId,rescheduleFromTrialId:oldTrial?.id||null,
        previousCloserId:oldTrial?.closerId||client.currentCloserId,pendingRescheduleAt:changedAt,
        pendingRescheduleByUserId:input.actorUserId,
      }:{
        id: input.trialId || id("trial"), clientId: client.id,
        managerId: client.currentManagerId, closerId: client.currentCloserId,
        slotId: newSlot.id, scheduledAt: newSlot.startAt,
        statusAtBookingId: input.statusId, active: true, createdAt: changedAt,
        assignmentState:"SCHEDULED",rescheduleReasonId:input.reasonId,rescheduleFromTrialId:oldTrial?.id||null,
        previousCloserId:oldTrial?.closerId||client.currentCloserId,
      });
      await tx.db.query("UPDATE clients SET current_status_id=$2,current_reason_id=$3,updated_at=$4,status_changed_at=CASE WHEN current_status_id<>$2 THEN $4 ELSE status_changed_at END WHERE id=$1",[client.id,input.statusId,input.reasonId,changedAt]);
      await tx.history.append({ id: input.historyId || id("hist"), clientId: client.id, actorUserId: input.actorUserId, eventType: later?"TRIAL_RESCHEDULE_PENDING":"TRIAL_RESCHEDULED", oldValue: oldTrial && { trialId: oldTrial.id, scheduledAt: oldTrial.scheduledAt, closerId:oldTrial.closerId }, newValue: { trialId: trial.id, scheduledAt: trial.scheduledAt, reasonId:input.reasonId }, createdAt: changedAt });
      const recipients=later?(await tx.db.query("SELECT id FROM users WHERE active AND business_role='ADMIN'")).rows.map((row)=>row.id):[client.currentManagerId,client.currentCloserId];
      for (const userId of new Set(recipients.filter(Boolean))) {
        await tx.notifications.create({ id: id("notif"), userId, clientId: client.id, trialId: trial.id, type: later?"TRIAL_RESCHEDULE_PENDING":"TRIAL_RESCHEDULED", content: later?`${client.name} · пробный ожидает нового времени`:`${client.name} · ${trial.scheduledAt}`, createdAt: changedAt });
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
      if (input.statusId) await tx.db.query("UPDATE clients SET current_status_id=$2,updated_at=$3,status_changed_at=CASE WHEN current_status_id<>$2 THEN $3 ELSE status_changed_at END WHERE id=$1",[client.id,input.statusId,createdAt]);
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
    await this.stopChangeListener();
    if (this.ownsPool) await this.pool.end();
  }
}

module.exports = { PostgresStorage };
