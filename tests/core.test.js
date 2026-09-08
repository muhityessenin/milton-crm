"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, seedDatabase, defaultRoles, PERMISSION_KEYS, applyOverrides, analyticsFilters, analyticsReport, dayKey, setDbForTests } = require("../server");

test("Kazakhstan phone formats normalize to the same value", () => {
  const formats = ["87071234567", "+77071234567", "8 707 123 45 67", "+7 707 123 45 67"];
  assert.deepEqual([...new Set(formats.map(normalizePhone))], ["+77071234567"]);
});

test("seed status actions are configured independently of visible names", () => {
  const db = seedDatabase();
  const payment = db.statuses.find((s) => s.actionType === "REQUIRE_PAYMENT");
  const noShow = db.statuses.find((s) => s.actionType === "MARK_NO_SHOW");
  assert.deepEqual(payment.requiredFields, ["amount", "paymentMethodId", "paymentDate"]);
  assert.equal(noShow.id,"st_no_show");
  assert.ok(db.statuses.every((s) => s.color && typeof s.sortOrder === "number"));
});

test("every booked slot points to exactly one trial", () => {
  const db = seedDatabase();
  for (const slot of db.availabilitySlots.filter((s) => s.status === "BOOKED")) {
    assert.equal(db.trials.filter((t) => t.id === slot.bookedTrialId).length, 1);
  }
  for (const trial of db.trials.filter((t) => t.active)) {
    assert.equal(db.availabilitySlots.filter((s) => s.id === trial.slotId && s.bookedTrialId === trial.id).length, 1);
  }
});

test("payment attribution and payment date are stored independently", () => {
  const db = seedDatabase();
  const payment = db.payments[0];
  assert.ok(payment.managerAttributionId);
  assert.ok(payment.closerAttributionId);
  assert.match(payment.paymentDate, /^\d{4}-\d{2}-\d{2}$/);
});

test("default role migration preserves legacy access scopes", () => {
  const roles = defaultRoles();
  const admin = roles.find((role) => role.systemKey === "ADMIN");
  const manager = roles.find((role) => role.systemKey === "MANAGER");
  const closer = roles.find((role) => role.systemKey === "CLOSER");
  assert.equal(Object.keys(admin.permissions).length, PERMISSION_KEYS.length);
  assert.ok(Object.values(admin.permissions).every(Boolean));
  assert.equal(manager.scopes.clients, "OWN");
  assert.equal(manager.permissions["schedule.scheduleTrial"], true);
  assert.equal(closer.permissions["clients.changeStatus"], true);
  assert.equal(manager.permissions["analytics.view"], true);
  assert.equal(manager.permissions["clients.changeStatus"], true);
  assert.equal(manager.permissions["clients.archive"], false);
  assert.equal(closer.permissions["clients.archive"], false);
  assert.equal(closer.permissions["analytics.view"], true);
});

test("individual overrides can deny, grant, and return to role inheritance", () => {
  let overrides = applyOverrides({}, { "clients.addNotes": false, "analytics.view": true });
  assert.deepEqual(overrides, { "clients.addNotes": false, "analytics.view": true });
  overrides = applyOverrides(overrides, { "clients.addNotes": null });
  assert.deepEqual(overrides, { "analytics.view": true });
});

function analyticsFixture() {
  const store=seedDatabase();
  store.clients=[{id:"c1",name:"Test",originalManagerId:"usr_manager",currentManagerId:"usr_manager2",currentCloserId:"usr_closer2",currentStatusId:"st_payment",leadSourceId:"src_1",tagIds:["tag_1"],createdAt:"2026-01-01T18:59:00.000Z",updatedAt:"2026-01-02T00:00:00.000Z"}];
  store.trials=[0,1,2].map((n)=>({id:`t${n}`,clientId:"c1",managerId:"usr_manager",closerId:"usr_closer",scheduledAt:`2026-01-0${n+2}T00:00:00.000Z`,completedAt:n===2?"2026-01-04T01:00:00.000Z":null,active:n===2,statusAtBookingId:"st_scheduled",createdAt:"2026-01-01T00:00:00.000Z"}));
  store.payments=[10,20,30].map((amount,n)=>({id:`p${n}`,clientId:"c1",managerAttributionId:"usr_manager",closerAttributionId:"usr_closer",amount,paymentMethodId:"method_1",paymentDate:`2026-01-0${n+4}`,createdAt:"2026-02-01T00:00:00.000Z",voidedAt:null}));
  store.history=[{id:"h1",clientId:"c1",eventType:"STATUS_CHANGED",newValue:{statusId:"st_refusal",refusalReasonId:"reason_1"},createdAt:"2026-01-03T19:00:00.000Z"}];
  setDbForTests(store);
  return {store,actor:store.users.find((u)=>u.id==="usr_admin")};
}
function reportFilters(extra={}) { return {from:"2026-01-01",to:"2026-01-31",managerId:"",closerId:"",sourceId:"",statusId:"",paymentMethodId:"",refusalReasonId:"",tagId:"",dateType:"trial",compare:false,...extra}; }

test("Asia/Almaty business dates do not shift around midnight", () => {
  assert.equal(dayKey("2026-01-01T18:59:00.000Z"),"2026-01-01");
  assert.equal(dayKey("2026-01-01T19:00:00.000Z"),"2026-01-02");
  assert.equal(dayKey("2026-01-02"),"2026-01-02");
});

test("reschedules count as trial events while conversion counts unique clients", () => {
  const {actor}=analyticsFixture(),report=analyticsReport(actor,reportFilters());
  assert.equal(report.kpis.trials,3);
  assert.equal(report.kpis.trialClients,1);
  assert.equal(report.kpis.payments,3);
  assert.equal(report.kpis.convertedClients,1);
  assert.equal(report.kpis.conversion,100);
  assert.equal(report.kpis.revenue,60);
  assert.equal(report.statusBaseline.count,1);
});

test("historical manager and closer attribution survives reassignment", () => {
  const {actor}=analyticsFixture();
  const historical=analyticsReport(actor,reportFilters({managerId:"usr_manager",closerId:"usr_closer"}));
  const current=analyticsReport(actor,reportFilters({managerId:"usr_manager2",closerId:"usr_closer2"}));
  assert.equal(historical.kpis.revenue,60);
  assert.equal(historical.kpis.trials,3);
  assert.equal(current.kpis.revenue,0);
  assert.equal(current.kpis.trials,0);
});

test("archived clients are excluded operationally but can be included intentionally", () => {
  const {store,actor}=analyticsFixture();
  store.clients[0].archivedAt="2026-01-20T10:00:00.000Z";
  store.clients[0].archivedByUserId=actor.id;
  store.clients[0].archiveReason="TEST";
  const operational=analyticsReport(actor,reportFilters());
  assert.equal(operational.kpis.trials,0);
  assert.equal(operational.kpis.payments,0);
  assert.equal(operational.kpis.revenue,0);
  const historical=analyticsReport(actor,reportFilters({includeArchived:true}));
  assert.equal(historical.kpis.trials,3);
  assert.equal(historical.kpis.payments,3);
  assert.equal(historical.kpis.revenue,60);
});

test("payment date, archived references, and combined filters stay consistent", () => {
  const {store,actor}=analyticsFixture();
  store.users.find((u)=>u.id==="usr_manager").active=false;
  store.users.find((u)=>u.id==="usr_closer").active=false;
  store.paymentMethods.find((m)=>m.id==="method_1").active=false;
  store.leadSources.find((s)=>s.id==="src_1").active=false;
  store.statuses.find((s)=>s.id==="st_payment").active=false;
  const combined=analyticsReport(actor,reportFilters({managerId:"usr_manager",closerId:"usr_closer",sourceId:"src_1",statusId:"st_payment",paymentMethodId:"method_1",refusalReasonId:"reason_1",tagId:"tag_1"}));
  assert.equal(combined.kpis.revenue,60);
  assert.ok(combined.managers.some((row)=>row.id==="usr_manager"));
  assert.ok(combined.closers.some((row)=>row.id==="usr_closer"));
  assert.ok(combined.paymentMethods.some((row)=>row.id==="method_1"));
  assert.ok(combined.sources.some((row)=>row.id==="src_1"));
  assert.ok(combined.statuses.some((row)=>row.id==="st_payment"&&row.count===1));
  const wrongCreatedDate=analyticsReport(actor,reportFilters({from:"2026-02-01",to:"2026-02-01",dateType:"payment"}));
  assert.equal(wrongCreatedDate.kpis.revenue,0);
});

test("zero data and previous-period comparison remain finite", () => {
  const {actor}=analyticsFixture(),report=analyticsReport(actor,reportFilters({from:"2025-01-01",to:"2025-01-07",compare:true}));
  for(const value of Object.values(report.kpis))assert.equal(Number.isFinite(value),true);
  for(const value of Object.values(report.comparison.kpis))assert.equal(Number.isFinite(value),true);
  assert.equal(report.comparison.from,"2024-12-25");
  assert.equal(report.comparison.to,"2024-12-31");
});

test("analytics query dates are normalized without changing active filters", () => {
  const parsed=analyticsFilters(new URLSearchParams("from=2026-01-31&to=2026-01-01&managerId=usr_manager&compare=true&includeArchived=true"));
  assert.equal(parsed.from,"2026-01-01");
  assert.equal(parsed.to,"2026-01-31");
  assert.equal(parsed.managerId,"usr_manager");
  assert.equal(parsed.compare,true);
  assert.equal(parsed.includeArchived,true);
});

test("attendance uses scheduled trial history and preserves reschedules", () => {
  const store=seedDatabase(),actor=store.users.find((u)=>u.id==="usr_admin");
  store.clients=Array.from({length:10},(_,index)=>({id:`ac${index}`,name:`Attendance ${index}`,originalManagerId:"usr_manager",currentManagerId:"usr_manager",currentCloserId:"usr_closer",currentStatusId:"st_completed",leadSourceId:"src_1",tagIds:["tag_1"],createdAt:"2026-09-01T02:00:00.000Z",updatedAt:"2026-09-01T03:00:00.000Z"}));
  store.trials=store.clients.map((client,index)=>({id:`at${index}`,clientId:client.id,managerId:"usr_manager",closerId:"usr_closer",scheduledAt:`2026-09-01T${String(index+3).padStart(2,"0")}:00:00.000Z`,completedAt:index>=3?"2026-09-01T18:00:00.000Z":null,active:false,statusAtBookingId:"st_scheduled",resultStatusId:index<2?"st_no_show":index===2?"st_reschedule":"st_completed",attendanceOutcome:index<2?"NO_SHOW":index===2?"RESCHEDULED":"REACHED",createdAt:"2026-08-31T02:00:00.000Z"}));
  store.payments=[];store.history=[];setDbForTests(store);
  const report=analyticsReport(actor,reportFilters({from:"2026-09-01",to:"2026-09-01"}));
  assert.deepEqual(report.attendance,{scheduled:10,noShow:2,rescheduled:1,formulaReached:7,reached:7,unresolvedOverdue:0,attendance:70});
});

test("unresolved overdue trial is reported separately from reached attendance", () => {
  const store=seedDatabase(),actor=store.users.find((u)=>u.id==="usr_admin");
  store.clients=[{id:"overdue-client",name:"Overdue",originalManagerId:"usr_manager",currentManagerId:"usr_manager",currentCloserId:"usr_closer",currentStatusId:"st_scheduled",leadSourceId:"src_1",tagIds:[],createdAt:"2020-01-01T00:00:00.000Z",updatedAt:"2020-01-01T00:00:00.000Z"}];
  store.trials=[{id:"overdue-trial",clientId:"overdue-client",managerId:"usr_manager",closerId:"usr_closer",scheduledAt:"2020-01-01T05:00:00.000Z",completedAt:null,active:true,statusAtBookingId:"st_scheduled",createdAt:"2019-12-31T00:00:00.000Z"}];store.payments=[];store.history=[];setDbForTests(store);
  const report=analyticsReport(actor,reportFilters({from:"2020-01-01",to:"2020-01-01"}));
  assert.equal(report.attendance.scheduled,1);assert.equal(report.attendance.unresolvedOverdue,1);assert.equal(report.attendance.reached,0);assert.equal(report.attendance.attendance,0);
});
