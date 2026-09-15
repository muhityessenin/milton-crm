"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { financeReport } = require("../server/finance");

const dayKey = (value) => String(value).slice(0, 10);
const permissions = (keys) => new Set(keys);
const hasPermission = (actor, key) => actor.permissions.has(key);
const baseDb = () => ({
  users: [
    { id:"manager-a", name:"Manager A", role:"MANAGER", active:true, teamId:"team-a" },
    { id:"manager-b", name:"Manager B", role:"MANAGER", active:true, teamId:"team-b" },
    { id:"closer-a", name:"Closer A", role:"CLOSER", active:false, teamId:"team-a" },
  ],
  clients: [{ id:"client-a", name:"Client A", createdAt:"2026-09-01T10:00:00Z", currentStatusId:"paid", totalDealAmount:500000 }],
  statuses: [{ id:"paid", name:"Оплата", isRefund:false }],
  paymentMethods: [{ id:"installment", name:"Рассрочка" }],
  payments: [], trials: [], financeTrialBonusStatuses: [{ statusId:"conducted" }],
  employeeCompensationHistory: [
    { id:"m1", userId:"manager-a", salesCommissionPercent:4, conductedTrialAmount:0, effectiveAt:"2026-09-01T00:00:00Z" },
    { id:"m2", userId:"manager-a", salesCommissionPercent:5, conductedTrialAmount:0, effectiveAt:"2026-09-15T00:00:00Z" },
    { id:"c1", userId:"closer-a", salesCommissionPercent:5, conductedTrialAmount:990, effectiveAt:"2026-09-01T00:00:00Z" },
  ],
  paymentMethodCommissionHistory: [
    { id:"b1", paymentMethodId:"installment", bankCommissionPercent:15, effectiveAt:"2026-09-01T00:00:00Z" },
    { id:"b2", paymentMethodId:"installment", bankCommissionPercent:17, effectiveAt:"2026-10-01T00:00:00Z" },
  ],
});

test("salary uses frozen attribution and historical employee/bank rates", () => {
  const db=baseDb();
  db.payments.push({id:"p1",clientId:"client-a",amount:500000,paymentMethodId:"installment",paymentDate:"2026-09-10",managerAttributionId:"manager-a",closerAttributionId:"closer-a"});
  const actor={id:"owner",permissions:permissions(["finance.companyTurnover","finance.allPayments","finance.allTrials"])};
  const report=financeReport({db,actor,hasPermission,dayKey,filters:{from:"2026-09-01",to:"2026-09-30"}});
  assert.equal(report.rows[0].bankCommissionPercent,15);
  assert.equal(report.rows[0].net,425000);
  assert.equal(report.rows[0].managerRatePercent,4);
  assert.equal(report.rows[0].managerEarning,17000);
  assert.equal(report.rows[0].closerEarning,21250);
  assert.equal(report.rows[0].managerId,"manager-a");
  assert.equal(report.rows[0].closerName,"Closer A");
  assert.equal(report.rows[0].closerActive,false);
});

test("prepayment earns zero until full balance and preserves each component rate", () => {
  const db=baseDb();
  db.payments.push({id:"p1",clientId:"client-a",amount:100000,paymentMethodId:"installment",paymentDate:"2026-09-10",managerAttributionId:"manager-a",closerAttributionId:"closer-a"});
  const actor={id:"manager-a",permissions:permissions(["finance.own"])};
  let report=financeReport({db,actor,hasPermission,dayKey,filters:{from:"2026-09-01",to:"2026-10-31"}});
  assert.equal(report.summary.salary,0);
  assert.equal(report.rows[0].waitingForBalance,true);
  db.payments.push({id:"p2",clientId:"client-a",amount:400000,paymentMethodId:"installment",paymentDate:"2026-10-10",managerAttributionId:"manager-a",closerAttributionId:"closer-a"});
  report=financeReport({db,actor,hasPermission,dayKey,filters:{from:"2026-09-01",to:"2026-10-31"}});
  assert.equal(report.rows[0].eligible,true);
  assert.equal(report.rows[0].managerRatePercent,4);
  assert.equal(report.rows[1].managerRatePercent,5);
  assert.equal(report.rows[0].bankCommissionPercent,15);
  assert.equal(report.rows[1].bankCommissionPercent,17);
});

test("trial bonus is calculated once per qualifying trial with the historical closer rate", () => {
  const db=baseDb();
  db.trials.push({id:"trial-a",clientId:"client-a",closerId:"closer-a",resultStatusId:"conducted",resultAt:"2026-09-20T12:00:00Z"});
  const actor={id:"closer-a",permissions:permissions(["finance.own"])};
  const report=financeReport({db,actor,hasPermission,dayKey,filters:{from:"2026-09-01",to:"2026-09-30"}});
  assert.equal(report.trials.length,1);
  assert.equal(report.summary.conductedTrials,1);
  assert.equal(report.summary.trialBonus,990);
});

test("team visibility follows current membership while company totals do not expose payment rows", () => {
  const db=baseDb();
  db.payments.push({id:"p1",clientId:"client-a",amount:500000,paymentMethodId:"installment",paymentDate:"2026-09-10",managerAttributionId:"manager-a",closerAttributionId:"closer-a"});
  let actor={id:"lead",teamId:"team-a",permissions:permissions(["finance.team"])};
  let report=financeReport({db,actor,hasPermission,dayKey,filters:{from:"2026-09-01",to:"2026-09-30"}});
  assert.equal(report.rows.length,1);
  actor={id:"accountant",permissions:permissions(["finance.companyTurnover"])};
  report=financeReport({db,actor,hasPermission,dayKey,filters:{from:"2026-09-01",to:"2026-09-30"}});
  assert.equal(report.summary.grossTurnover,500000);
  assert.equal(report.rows.length,0);
});

test("voided payments and refunds are excluded or marked without destroying history", () => {
  const db=baseDb();
  db.payments.push(
    {id:"void",clientId:"client-a",amount:500000,paymentMethodId:"installment",paymentDate:"2026-09-10",managerAttributionId:"manager-a",closerAttributionId:"closer-a",voidedAt:"2026-09-11T00:00:00Z"},
    {id:"active",clientId:"client-a",amount:500000,paymentMethodId:"installment",paymentDate:"2026-09-10",managerAttributionId:"manager-a",closerAttributionId:"closer-a"},
  );
  db.statuses[0].isRefund=true;
  const actor={id:"manager-a",permissions:permissions(["finance.own"])};
  let report=financeReport({db,actor,hasPermission,dayKey,filters:{from:"2026-09-01",to:"2026-09-30"}});
  assert.equal(report.rows.length,0);
  report=financeReport({db,actor,hasPermission,dayKey,filters:{from:"2026-09-01",to:"2026-09-30",showRefunds:true}});
  assert.deepEqual(report.rows.map((row)=>row.id),["active"]);
  assert.equal(report.rows[0].refund,true);
});

test("finance migration is additive and defines historical ledgers and permissions", () => {
  const sql=fs.readFileSync(path.join(__dirname,"..","migrations","011_finance_salary.sql"),"utf8");
  assert.match(sql,/CREATE TABLE IF NOT EXISTS public\.teams/i);
  assert.match(sql,/employee_compensation_history/i);
  assert.match(sql,/payment_method_commission_history/i);
  assert.match(sql,/finance_trial_bonus_statuses/i);
  assert.match(sql,/finance\.clientHistory/);
  assert.doesNotMatch(sql,/\b(?:DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql,/\bDELETE\s+FROM\b/i);
});
