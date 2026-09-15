"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const views = require("../public/crm-views");

const statuses = [
  { id: "today", name: "Сегодняшние", systemKey:"TODAY", actionType: "NONE", sortOrder: 0, active: true, color: "#14a06f" },
  { id: "scheduled", name: "Запланированные", systemKey:"PLANNED", actionType: "NONE", sortOrder: 1, active: true, color: "#3157d5" },
  { id: "completed", name: "Завершён", actionType: "NONE", sortOrder: 2, active: true, color: "#14a06f" },
  { id: "reschedule", name: "Перенос", actionType: "REQUIRE_RESCHEDULE", sortOrder: 3, active: true },
  { id: "no_show", name: "Не пришёл", actionType: "MARK_NO_SHOW", sortOrder: 4, active: true },
  { id: "refusal", name: "Отказ", actionType: "REQUIRE_REFUSAL_REASON", sortOrder: 5, active: true },
  { id: "payment", name: "Чек / Оплата", actionType: "REQUIRE_PAYMENT", sortOrder: 6, active: true },
  { id: "custom", name: "Повторный контакт", actionType: "NONE", sortOrder: 7, active: true },
];

function client(overrides = {}) {
  return {
    id: overrides.id || "client",
    currentStatusId: "scheduled",
    paymentTotal: 0,
    activeTrial: { active: true, statusAtBookingId: "scheduled", preferredDate: "2026-09-14", trialType: "FREE", trialAmount: 0 },
    ...overrides,
  };
}

test("calendar grouping uses the real configurable Today and Planned statuses", () => {
  assert.equal(views.boardColumnKey(client(), statuses, "2026-09-14"), "status:today");
  assert.equal(views.boardColumnKey(client({ activeTrial: { active: true, statusAtBookingId: "scheduled", preferredDate: "2026-09-15" } }), statuses, "2026-09-14"), "status:scheduled");
  for (const statusId of ["reschedule", "no_show", "refusal", "completed", "custom"]) {
    assert.equal(views.boardColumnKey(client({ currentStatusId: statusId }), statuses, "2026-09-14"), `status:${statusId}`);
  }
});

test("real course payment overrides a stale planned status", () => {
  const paid = client({ paymentTotal: 55000 });
  assert.equal(views.hasMainCoursePayment(paid), true);
  assert.equal(views.effectiveStatus(paid, statuses).id, "payment");
  assert.equal(views.boardColumnKey(paid, statuses, "2026-09-14"), "status:payment");
});

test("paid trial amount never impersonates a main-course payment", () => {
  const paidTrial = client({ activeTrial: { active: true, statusAtBookingId: "scheduled", preferredDate: "2026-09-15", trialType: "PAID", trialAmount: 990 } });
  assert.equal(views.hasMainCoursePayment(paidTrial), false);
  assert.equal(views.boardColumnKey(paidTrial, statuses, "2026-09-14"), "status:scheduled");
});

test("every configured status remains a visible board column", () => {
  const configured = [...statuses, { id: "legacy", name: "Старый статус", active: false, sortOrder: 8 }];
  const columns = views.boardColumns([], configured, "2026-09-14");
  assert.deepEqual(columns.map((column) => column.key), configured.map((status) => `status:${status.id}`));
});

test("a client is never hidden when its legacy status is no longer configured", () => {
  const legacyClient = client({ currentStatusId: "removed", status: { id: "removed", name: "Архивный этап" }, activeTrial: null });
  const columns = views.boardColumns([legacyClient], statuses, "2026-09-14");
  assert.equal(columns.find((column) => column.key === "status:removed").clients[0].id, legacyClient.id);
});

test("a safely deleted status remains visible for clients that already use it",()=>{
  const deleted={id:"deleted",name:"Старый этап",deletedAt:"2026-09-15T00:00:00Z",active:false,sortOrder:20},item=client({currentStatusId:"deleted",status:deleted,activeTrial:null});
  const columns=views.boardColumns([item],[...statuses,deleted],"2026-09-15");
  assert.equal(columns.find(column=>column.key==="status:deleted").clients[0].id,item.id);
});

test("client grouping supports status, manager, closer, date and source", () => {
  const item = client({ manager: { name: "Дана" }, currentCloserId: null, closer: null, leadSource: { name: "Instagram" } });
  assert.equal(views.groupClients([item], "status", statuses)[0].title, "Запланированные");
  assert.equal(views.groupClients([item], "manager", statuses)[0].title, "Дана");
  assert.equal(views.groupClients([item], "closer", statuses)[0].title, "Клоузер не назначен");
  assert.equal(views.groupClients([item], "date", statuses)[0].title, "2026-09-14");
  assert.equal(views.groupClients([item], "source", statuses)[0].title, "Instagram");
});
