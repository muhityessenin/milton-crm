"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { storageConfig } = require("../storage/config");
const { PostgresStorage } = require("../storage/postgres/storage");

const enabled = process.env.RUN_POSTGRES_TESTS === "1";

test("PostgreSQL repositories preserve CRM shapes and transactional workflows", { skip: !enabled }, async () => {
  const config = storageConfig();
  assert.ok(config.databaseUrl, "DATABASE_URL is required");
  const storage = PostgresStorage.connect(config.databaseUrl, { max: 2 });
  const rollback = new Error("ROLLBACK_POSTGRES_REPOSITORY_TEST");

  try {
    await storage.assertSchema();
    await assert.rejects(storage.transaction(async (tx) => {
      await tx.db.query(`
        INSERT INTO public.roles (id, name, system_key, base_role, is_system) VALUES
          ('repo_role_admin', 'Repository Admin', NULL, 'ADMIN', false),
          ('repo_role_manager', 'Repository Manager', NULL, 'MANAGER', false),
          ('repo_role_closer', 'Repository Closer', NULL, 'CLOSER', false)
      `);
      await tx.db.query(`
        INSERT INTO public.role_permissions (role_id, permission_key, enabled)
        VALUES ('repo_role_manager', 'clients.view', true)
      `);
      await tx.db.query(`
        INSERT INTO public.role_scopes (role_id, resource, scope)
        VALUES ('repo_role_manager', 'clients', 'OWN')
      `);
      await tx.db.query(`
        INSERT INTO public.users (id, name, login, password_hash, role_id, business_role, is_owner) VALUES
          ('repo_owner', 'Repository Admin', 'repo.owner@milton.local', 'hash', 'repo_role_admin', 'ADMIN', false),
          ('repo_manager', 'Repository Manager', 'repo.manager@milton.local', 'hash', 'repo_role_manager', 'MANAGER', false),
          ('repo_closer', 'Repository Closer', 'repo.closer@milton.local', 'hash', 'repo_role_closer', 'CLOSER', false)
      `);
      await tx.db.query("UPDATE public.users SET trial_duration_minutes=40 WHERE id='repo_closer'");
      assert.equal((await tx.users.findById("repo_closer")).trialDurationMinutes,40);
      await tx.db.query(`
        INSERT INTO public.user_permission_overrides (user_id, permission_key, enabled)
        VALUES ('repo_manager', 'clients.archive', true)
      `);
      await tx.db.query(`
        INSERT INTO public.statuses (id, name, color, sort_order, action_type, required_fields) VALUES
          ('repo_status_scheduled', 'Repository Scheduled', '#3157D5', 1, 'NONE', '{}'),
          ('repo_status_reschedule', 'Repository Reschedule', '#9C6ADE', 2, 'REQUIRE_RESCHEDULE', ARRAY['newSlotId']),
          ('repo_status_payment', 'Repository Payment', '#087F5B', 3, 'REQUIRE_PAYMENT', ARRAY['amount','paymentMethodId','paymentDate'])
      `);
      await tx.db.query("INSERT INTO public.lead_sources (id, name) VALUES ('repo_source', 'Repository Source')");
      await tx.db.query("INSERT INTO public.tags (id, name, color) VALUES ('repo_tag', 'Repository Tag', '#EDF0F5')");
      await tx.db.query("INSERT INTO public.refusal_reasons (id, name) VALUES ('repo_reason', 'Repository Reason')");
      await tx.db.query("INSERT INTO public.payment_methods (id, name) VALUES ('repo_method', 'Repository Method')");
      await tx.availabilitySlots.create({ id: "repo_slot_1", closerId: "repo_closer", startAt: "2026-09-20T05:00:00.000Z", endAt: "2026-09-20T06:00:00.000Z" });
      await tx.availabilitySlots.create({ id: "repo_slot_2", closerId: "repo_closer", startAt: "2026-09-21T05:00:00.000Z", endAt: "2026-09-21T06:00:00.000Z" });

      const registered = await tx.registerClientAndBookTrial({
        clientId: "repo_client", trialId: "repo_trial_1",
        clientHistoryId: "repo_hist_client", trialHistoryId: "repo_hist_trial",
        notificationId: "repo_notif_trial", actorUserId: "repo_manager",
        name: "Repository Client", normalizedPhone: "+77000000991",
        originalPhone: "+7 700 000 99 1", managerId: "repo_manager",
        closerId: "repo_closer", statusId: "repo_status_scheduled",
        leadSourceId: "repo_source", tagIds: ["repo_tag"], slotId: "repo_slot_1", trialType:"FREE",
      });
      assert.equal(registered.client.currentManagerId, "repo_manager");
      assert.deepEqual((await tx.clients.findById("repo_client")).tagIds, ["repo_tag"]);
      assert.equal((await tx.availabilitySlots.findById("repo_slot_1")).bookedTrialId, "repo_trial_1");

      const rescheduled = await tx.rescheduleTrial({
        clientId: "repo_client", actorUserId: "repo_manager",
        newSlotId: "repo_slot_2", statusId: "repo_status_reschedule",
        trialId: "repo_trial_2", historyId: "repo_hist_reschedule",
      });
      assert.equal(rescheduled.slotId, "repo_slot_2");
      assert.equal((await tx.availabilitySlots.findById("repo_slot_1")).status, "FREE");
      assert.equal((await tx.availabilitySlots.findById("repo_slot_2")).status, "BOOKED");
      const trialHistory=await tx.trials.listByClient("repo_client");assert.equal(trialHistory.length,2);assert.equal(trialHistory.find((row)=>row.id==="repo_trial_1").attendanceOutcome,"RESCHEDULED");assert.equal(trialHistory.find((row)=>row.id==="repo_trial_2").trialType,"FREE");

      const payment = await tx.recordPayment({
        paymentId: "repo_payment_1", historyId: "repo_hist_payment",
        notificationId: "repo_notif_payment", clientId: "repo_client",
        actorUserId: "repo_closer", closerAttributionId: "repo_closer",
        amount: 45000, paymentMethodId: "repo_method", paymentDate: "2026-09-21",
        statusId: "repo_status_payment",
      });
      assert.equal(payment.managerAttributionId, "repo_manager");
      assert.equal(Number(payment.amount), 45000);

      const corrected = await tx.correctPayment({
        paymentId: "repo_payment_1", replacementPaymentId: "repo_payment_2",
        correctionId: "repo_correction", historyId: "repo_hist_correction",
        auditId: "repo_audit_correction", actorUserId: "repo_owner",
        amount: 47000, paymentMethodId: "repo_method", paymentDate: "2026-09-21",
        reason: "Repository integration test",
      });
      assert.equal(corrected.correctedFromPaymentId, "repo_payment_1");
      assert.equal(Number(corrected.amount), 47000);

      await tx.notes.create({ id: "repo_note", clientId: "repo_client", authorUserId: "repo_manager", noteType: "MANAGER_NOTE", text: "Repository note" });
      assert.equal((await tx.notes.listByClient("repo_client")).length, 1);
      assert.ok((await tx.history.listByClient("repo_client")).length >= 4);

      const archived = await tx.archiveClient({
        clientId: "repo_client", actorUserId: "repo_manager", reason: "TEST",
        historyId: "repo_hist_archive", auditId: "repo_audit_archive",
      });
      assert.equal(archived.archiveReason, "TEST");
      assert.equal((await tx.availabilitySlots.findById("repo_slot_2")).status, "FREE");

      const restored = await tx.restoreClient({
        clientId: "repo_client", actorUserId: "repo_manager",
        historyId: "repo_hist_restore", auditId: "repo_audit_restore",
      });
      assert.equal(restored.archivedAt, null);

      const rawToken = "repository-session-token";
      await tx.sessions.create({ id: "repo_session", token: rawToken, userId: "repo_owner", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      assert.equal((await tx.sessions.findActiveUserByToken(rawToken)).id, "repo_owner");
      await tx.sessions.revoke(rawToken);
      assert.equal(await tx.sessions.findActiveUserByToken(rawToken), null);

      assert.equal((await tx.settings.get()).branding.companyName, "Milton");
      assert.equal((await tx.roles.findById("repo_role_manager")).permissions["clients.view"], true);
      assert.ok((await tx.permissions.list()).some((permission) => permission.key === "clients.archive"));
      assert.ok((await tx.statuses.list({ includeArchived: false })).some((status) => status.id === "repo_status_payment"));

      await tx.db.query("SET LOCAL statement_timeout = '90s'");
      const apiState = await tx.state.load();
      const originalApiState=structuredClone(apiState);
      apiState.clients[0].registrationComment="State repository update";
      apiState.meta.branding.companyName="Milton Test";
      await tx.state.save(apiState,originalApiState);
      const reloadedApiState=await tx.state.load();
      assert.equal(reloadedApiState.clients[0].registrationComment,"State repository update");
      assert.equal(reloadedApiState.meta.branding.companyName,"Milton Test");

      const deletion = await tx.permanentlyDeleteClient({
        clientId: "repo_client", actorUserId: "usr_admin", confirmation: "УДАЛИТЬ",
      });
      assert.equal(deletion.hardDeleted, true);
      assert.equal(await tx.clients.findById("repo_client"), null);
      assert.ok((await tx.auditLogs.recent()).some((entry) => entry.action === "CLIENT_PERMANENTLY_DELETED"));

      throw rollback;
    }), (error) => error === rollback);
    const cleanup = await storage.db.query(`
      SELECT
        (SELECT count(*) FROM public.users WHERE id LIKE 'repo_%')::int AS users,
        (SELECT count(*) FROM public.clients WHERE id LIKE 'repo_%')::int AS clients,
        (SELECT count(*) FROM public.audit_logs WHERE id LIKE 'repo_%')::int AS audit_logs
    `);
    assert.deepEqual(cleanup.rows[0], { users: 0, clients: 0, audit_logs: 0 });
  } finally {
    await storage.close();
  }
});
