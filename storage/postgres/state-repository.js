"use strict";

const { camelRow, mapUser, mapPayment } = require("./repositories");

const stamp = () => new Date().toISOString();
const value = (row, key, fallback = null) => row[key] === undefined ? fallback : row[key];

async function upsert(db, table, columns, values) {
  const names = Object.keys(columns);
  const params = names.map((_, index) => `$${index + 1}`).join(",");
  const updates = names.filter((name) => name !== "id").map((name) => `${name}=EXCLUDED.${name}`).join(",");
  await db.query(
    `INSERT INTO public.${table} (${names.join(",")}) VALUES (${params}) ON CONFLICT (id) DO UPDATE SET ${updates}`,
    names.map((name) => values[columns[name]])
  );
}

async function removeMissing(db, table, ids) {
  await db.query(`DELETE FROM public.${table} WHERE NOT (id = ANY($1::text[]))`, [ids]);
}

class PostgresStateRepository {
  constructor(storage) { this.storage = storage; this.db = storage.db; }

  async load() {
    const result=await this.db.query(`
      SELECT
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at,x.id),'[]') FROM (
          SELECT u.*,
            COALESCE((SELECT jsonb_object_agg(permission_key,enabled) FROM public.user_permission_overrides WHERE user_id=u.id),'{}') permission_overrides,
            COALESCE((SELECT jsonb_object_agg(resource,scope) FROM public.user_scope_overrides WHERE user_id=u.id),'{}') scope_overrides
          FROM public.users u) x) users,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at,x.id),'[]') FROM (
          SELECT r.*,
            COALESCE((SELECT jsonb_object_agg(permission_key,enabled) FROM public.role_permissions WHERE role_id=r.id),'{}') permissions,
            COALESCE((SELECT jsonb_object_agg(resource,scope) FROM public.role_scopes WHERE role_id=r.id),'{}') scopes
          FROM public.roles r) x) roles,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id),'[]') FROM (
          SELECT c.*,COALESCE((SELECT jsonb_agg(tag_id ORDER BY tag_id) FROM public.client_tags WHERE client_id=c.id),'[]') tag_ids FROM public.clients c) x) clients,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.trials x) trials,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.availability_slots x) availability_slots,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.payments x) payments,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.payment_corrections x) payment_corrections,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.sort_order,x.id),'[]') FROM public.statuses x) statuses,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.sort_order,x.id),'[]') FROM public.lead_sources x) lead_sources,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.sort_order,x.id),'[]') FROM public.tags x) tags,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.sort_order,x.id),'[]') FROM public.refusal_reasons x) refusal_reasons,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.sort_order,x.id),'[]') FROM public.payment_methods x) payment_methods,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.notes x) notes,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.client_history x) history,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.notifications x) notifications,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.audit_logs x) audit_logs,
        (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.saved_filters x) saved_filters,
        (SELECT to_jsonb(x) FROM public.app_settings x WHERE id='global') settings
    `);
    const raw=result.rows[0],mapped=(items,mapper=camelRow)=>(items||[]).map(mapper);
    const users=mapped(raw.users,mapUser),roles=mapped(raw.roles),clients=mapped(raw.clients),trials=mapped(raw.trials);
    const availabilitySlots=mapped(raw.availability_slots),payments=mapped(raw.payments,mapPayment),paymentCorrections=mapped(raw.payment_corrections);
    const statuses=mapped(raw.statuses),leadSources=mapped(raw.lead_sources),tags=mapped(raw.tags),refusalReasons=mapped(raw.refusal_reasons),paymentMethods=mapped(raw.payment_methods);
    const notes=mapped(raw.notes),history=mapped(raw.history),notifications=mapped(raw.notifications),auditLogs=mapped(raw.audit_logs),savedFilters=mapped(raw.saved_filters);
    const settingsRow=camelRow(raw.settings);
    const settings=settingsRow?{version:settingsRow.schemaVersion,timezone:settingsRow.timezone,branding:{companyName:settingsRow.companyName,accentColor:settingsRow.accentColor,logoUrl:settingsRow.logoUrl},reminderMinutes:settingsRow.reminderMinutes,unassignedTrialReminderMinutes:settingsRow.unassignedTrialReminderMinutes??120,createdAt:settingsRow.createdAt,updatedAt:settingsRow.updatedAt}:null;
    return {
      meta: settings || { version: 1, timezone: "Asia/Almaty", branding: { companyName: "Milton", accentColor: "#3157D5", logoUrl: "" }, reminderMinutes: 30 },
      users, roles, clients, trials, availabilitySlots, payments, paymentCorrections,
      statuses, leadSources, tags, refusalReasons, paymentMethods, notes, history,
      notifications, auditLogs, savedFilters,
    };
  }

  async save(state, original=null) {
    const fullState=state;
    const changed=(name)=>{
      if(!original)return fullState[name]||[];
      const previous=new Map((original[name]||[]).map((row)=>[row.id,JSON.stringify(row)]));
      return (fullState[name]||[]).filter((row)=>previous.get(row.id)!==JSON.stringify(row));
    };
    state={...fullState};
    for(const name of ["roles","users","clients","trials","availabilitySlots","payments","paymentCorrections","statuses","leadSources","tags","refusalReasons","paymentMethods","notes","history","notifications","auditLogs","savedFilters"])state[name]=changed(name);
    const now = stamp();
    for (const row of state.roles) await upsert(this.db, "roles", {
      id:"id", name:"name", system_key:"systemKey", base_role:"baseRole", is_system:"isSystem",
      active:"active", archived_at:"archivedAt", created_at:"createdAt", updated_at:"updatedAt",
    }, { ...row, active:value(row,"active",true), isSystem:Boolean(row.isSystem), createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });

    const references = [
      ["statuses", state.statuses, { id:"id", name:"name", color:"color", sort_order:"sortOrder", action_type:"actionType", required_fields:"requiredFields", active:"active", archived_at:"archivedAt", created_at:"createdAt", updated_at:"updatedAt" }],
      ["lead_sources", state.leadSources, { id:"id", name:"name", sort_order:"sortOrder", active:"active", archived_at:"archivedAt", created_at:"createdAt", updated_at:"updatedAt" }],
      ["tags", state.tags, { id:"id", name:"name", color:"color", sort_order:"sortOrder", active:"active", archived_at:"archivedAt", created_at:"createdAt", updated_at:"updatedAt" }],
      ["refusal_reasons", state.refusalReasons, { id:"id", name:"name", sort_order:"sortOrder", active:"active", archived_at:"archivedAt", created_at:"createdAt", updated_at:"updatedAt" }],
      ["payment_methods", state.paymentMethods, { id:"id", name:"name", sort_order:"sortOrder", active:"active", archived_at:"archivedAt", created_at:"createdAt", updated_at:"updatedAt" }],
    ];
    for (const [table, rows, columns] of references) for (const row of rows) await upsert(this.db, table, columns, {
      ...row, color:value(row,"color",table === "tags" ? "#EDF0F5" : "#7C879E"), sortOrder:value(row,"sortOrder",0),
      actionType:value(row,"actionType","NONE"), requiredFields:value(row,"requiredFields",[]), active:value(row,"active",true),
      createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now), archivedAt:value(row,"archivedAt",null),
    });

    for (const row of state.users) await upsert(this.db, "users", {
      id:"id", name:"name", login:"login", password_hash:"passwordHash", role_id:"roleId", business_role:"role",
      is_owner:"isOwner", avatar_url:"avatarUrl", profile_status:"profileStatus", active:"active", team_id:"teamId",
      archived_at:"archivedAt", trial_duration_minutes:"trialDurationMinutes", created_at:"createdAt", updated_at:"updatedAt",
    }, { ...row, isOwner:Boolean(row.isOwner), avatarUrl:value(row,"avatarUrl",""), profileStatus:value(row,"profileStatus","WORKING"), active:value(row,"active",true), createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });

    for (const row of state.clients) await upsert(this.db, "clients", {
      id:"id", name:"name", normalized_phone:"normalizedPhone", original_phone:"originalPhone",
      original_manager_id:"originalManagerId", current_manager_id:"currentManagerId", current_closer_id:"currentCloserId",
      current_status_id:"currentStatusId", lead_source_id:"leadSourceId", registration_comment:"registrationComment",
      archived_at:"archivedAt", archived_by_user_id:"archivedByUserId", archive_reason:"archiveReason",
      current_reason_id:"currentReasonId",
      permanently_deleted_at:"permanentlyDeletedAt", permanently_deleted_by_user_id:"permanentlyDeletedByUserId",
      created_at:"createdAt", updated_at:"updatedAt",
    }, { ...row, registrationComment:value(row,"registrationComment",""), createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });

    for (const row of state.availabilitySlots) await upsert(this.db, "availability_slots", {
      id:"id", closer_id:"closerId", start_at:"startAt", end_at:"endAt", status:"status", booked_trial_id:"bookedTrialId", created_at:"createdAt", updated_at:"updatedAt",
    }, { ...row, status:"FREE", bookedTrialId:null, createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });

    for (const row of state.trials) { await upsert(this.db, "trials", {
      id:"id", client_id:"clientId", manager_id:"managerId", closer_id:"closerId", slot_id:"slotId", scheduled_at:"scheduledAt",
      completed_at:"completedAt", status_at_booking_id:"statusAtBookingId", result_status_id:"resultStatusId", result_at:"resultAt",
      result_actor_user_id:"resultActorUserId", attendance_outcome:"attendanceOutcome", archive_interrupted_at:"archiveInterruptedAt",
      active:"active", created_at:"createdAt", updated_at:"updatedAt", trial_type:"trialType", trial_amount:"trialAmount",
      trial_payment_date:"trialPaymentDate", registered_by_user_id:"registeredByUserId", receipt_storage_key:"receiptStorageKey",
      receipt_original_name:"receiptOriginalName", receipt_mime_type:"receiptMimeType", receipt_size_bytes:"receiptSizeBytes", receipt_uploaded_at:"receiptUploadedAt",
      assignment_state:"assignmentState", preferred_time_text:"preferredTimeText", preferred_date:"preferredDate",
      preferred_start_time:"preferredStartTime", preferred_end_time:"preferredEndTime", assigned_at:"assignedAt",
      assigned_by_user_id:"assignedByUserId", assignment_version:"assignmentVersion",
      pending_reschedule:"pendingReschedule", reschedule_reason_id:"rescheduleReasonId",
      reschedule_from_trial_id:"rescheduleFromTrialId", previous_closer_id:"previousCloserId",
      pending_reschedule_at:"pendingRescheduleAt", pending_reschedule_by_user_id:"pendingRescheduleByUserId",
    }, { ...row, active:value(row,"active",true), trialType:value(row,"trialType","FREE"), trialAmount:value(row,"trialAmount",0), registeredByUserId:value(row,"registeredByUserId",row.managerId), createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });}

    for (const row of state.payments) await upsert(this.db, "payments", {
      id:"id", client_id:"clientId", manager_attribution_id:"managerAttributionId", closer_attribution_id:"closerAttributionId",
      amount:"amount", payment_method_id:"paymentMethodId", payment_date:"paymentDate", comment:"comment", created_by_user_id:"createdBy",
      corrected_from_payment_id:"correctedFromPaymentId", voided_at:"voidedAt", idempotency_key:"idempotencyKey", created_at:"createdAt", updated_at:"updatedAt",
    }, { ...row, comment:value(row,"comment",""), createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });

    for (const row of state.notes) await upsert(this.db, "notes", {
      id:"id", client_id:"clientId", author_user_id:"authorUserId", note_type:"noteType", text:"text", created_at:"createdAt", updated_at:"updatedAt",
    }, { ...row, createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });
    for (const row of state.history) await upsert(this.db, "client_history", {
      id:"id", client_id:"clientId", actor_user_id:"actorUserId", event_type:"eventType", old_value:"oldValue", new_value:"newValue", created_at:"createdAt",
    }, { ...row, createdAt:value(row,"createdAt",now) });
    for (const row of state.notifications) await upsert(this.db, "notifications", {
      id:"id", user_id:"userId", client_id:"clientId", trial_id:"trialId", type:"type", content:"content", read_at:"readAt",
      snoozed_until:"snoozedUntil", resolved_at:"resolvedAt", created_at:"createdAt", updated_at:"updatedAt",
    }, { ...row, createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });
    for (const row of state.auditLogs) await upsert(this.db, "audit_logs", {
      id:"id", actor_user_id:"actorUserId", entity_type:"entityType", entity_id:"entityId", action:"action", old_value:"oldValue", new_value:"newValue", created_at:"createdAt",
    }, { ...row, createdAt:value(row,"createdAt",now) });
    for (const row of state.savedFilters) await upsert(this.db, "saved_filters", {
      id:"id", user_id:"userId", module:"module", name:"name", filter_value:"filterValue", is_default:"isDefault", created_at:"createdAt", updated_at:"updatedAt",
    }, { ...row, filterValue:value(row,"filterValue",{}), isDefault:value(row,"isDefault",false), createdAt:value(row,"createdAt",now), updatedAt:value(row,"updatedAt",now) });
    for (const row of state.paymentCorrections || []) await upsert(this.db, "payment_corrections", {
      id:"id", original_payment_id:"originalPaymentId", replacement_payment_id:"replacementPaymentId", corrected_by_user_id:"correctedByUserId",
      reason:"reason", old_value:"oldValue", new_value:"newValue", created_at:"createdAt",
    }, { ...row, reason:value(row,"reason",""), oldValue:value(row,"oldValue",{}), newValue:value(row,"newValue",{}), createdAt:value(row,"createdAt",now) });

    if(state.roles.length){
      const roleIds=state.roles.map((row)=>row.id);await this.db.query("DELETE FROM public.role_permissions WHERE role_id=ANY($1::text[])",[roleIds]);await this.db.query("DELETE FROM public.role_scopes WHERE role_id=ANY($1::text[])",[roleIds]);
      const permissionRows=state.roles.flatMap((role)=>Object.entries(role.permissions||{}).map(([permission,enabled])=>[role.id,permission,enabled]));
      if(permissionRows.length)await this.db.query("INSERT INTO public.role_permissions(role_id,permission_key,enabled) SELECT * FROM unnest($1::text[],$2::text[],$3::boolean[])",[permissionRows.map(r=>r[0]),permissionRows.map(r=>r[1]),permissionRows.map(r=>r[2])]);
      const scopeRows=state.roles.flatMap((role)=>Object.entries(role.scopes||{}).map(([resource,scope])=>[role.id,resource,scope]));
      if(scopeRows.length)await this.db.query("INSERT INTO public.role_scopes(role_id,resource,scope) SELECT * FROM unnest($1::text[],$2::text[],$3::text[])",[scopeRows.map(r=>r[0]),scopeRows.map(r=>r[1]),scopeRows.map(r=>r[2])]);
    }
    if(state.users.length){
      const userIds=state.users.map((row)=>row.id);await this.db.query("DELETE FROM public.user_permission_overrides WHERE user_id=ANY($1::text[])",[userIds]);await this.db.query("DELETE FROM public.user_scope_overrides WHERE user_id=ANY($1::text[])",[userIds]);
      const permissionRows=state.users.flatMap((user)=>Object.entries(user.permissionOverrides||{}).map(([permission,enabled])=>[user.id,permission,enabled]));
      if(permissionRows.length)await this.db.query("INSERT INTO public.user_permission_overrides(user_id,permission_key,enabled) SELECT * FROM unnest($1::text[],$2::text[],$3::boolean[])",[permissionRows.map(r=>r[0]),permissionRows.map(r=>r[1]),permissionRows.map(r=>r[2])]);
      const scopeRows=state.users.flatMap((user)=>Object.entries(user.scopeOverrides||{}).map(([resource,scope])=>[user.id,resource,scope]));
      if(scopeRows.length)await this.db.query("INSERT INTO public.user_scope_overrides(user_id,resource,scope) SELECT * FROM unnest($1::text[],$2::text[],$3::text[])",[scopeRows.map(r=>r[0]),scopeRows.map(r=>r[1]),scopeRows.map(r=>r[2])]);
    }
    const clientsChanged=!original||state.clients.length||(original.clients||[]).length!==fullState.clients.length;
    if(clientsChanged){await this.db.query("DELETE FROM public.client_tags");const tagRows=fullState.clients.flatMap((client)=>(client.tagIds||[]).map((tagId)=>[client.id,tagId]));if(tagRows.length)await this.db.query("INSERT INTO public.client_tags(client_id,tag_id) SELECT * FROM unnest($1::text[],$2::text[])",[tagRows.map(r=>r[0]),tagRows.map(r=>r[1])]);}

    const deletionOrder = [
      ["payment_corrections","paymentCorrections"], ["notifications","notifications"], ["notes","notes"],
      ["client_history","history"], ["audit_logs","auditLogs"], ["saved_filters","savedFilters"],
      ["payments","payments"], ["trials","trials"], ["clients","clients"], ["availability_slots","availabilitySlots"],
      ["users","users"], ["roles","roles"], ["statuses","statuses"], ["lead_sources","leadSources"],
      ["tags","tags"], ["refusal_reasons","refusalReasons"], ["payment_methods","paymentMethods"],
    ];
    const owner=fullState.users.find((row)=>row.isOwner&&row.active);
    for (const [table,name] of deletionOrder){const rows=fullState[name]||[],ids=new Set(rows.map((row)=>row.id)),hasRemoval=!original||(original[name]||[]).some((row)=>!ids.has(row.id));if(hasRemoval){if(table==="clients"&&owner)await this.db.query("SELECT set_config('milton.actor_user_id',$1,true)",[owner.id]);await removeMissing(this.db,table,[...ids]);}}

    const meta = fullState.meta || {};
    if(!original||JSON.stringify(original.meta)!==JSON.stringify(meta))await this.db.query(`
      INSERT INTO public.app_settings (id,schema_version,timezone,company_name,accent_color,logo_url,reminder_minutes,unassigned_trial_reminder_minutes,updated_at)
      VALUES ('global',$1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (id) DO UPDATE SET schema_version=EXCLUDED.schema_version,timezone=EXCLUDED.timezone,
        company_name=EXCLUDED.company_name,accent_color=EXCLUDED.accent_color,logo_url=EXCLUDED.logo_url,
        reminder_minutes=EXCLUDED.reminder_minutes,unassigned_trial_reminder_minutes=EXCLUDED.unassigned_trial_reminder_minutes,updated_at=now()
    `, [meta.version || 1, meta.timezone || "Asia/Almaty", meta.branding?.companyName || "Milton", meta.branding?.accentColor || "#3157D5", meta.branding?.logoUrl || "", meta.reminderMinutes || 30,meta.unassignedTrialReminderMinutes??120]);
  }
}

module.exports = { PostgresStateRepository };
