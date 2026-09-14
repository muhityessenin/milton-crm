"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const root=path.join(__dirname,"..");
const app=fs.readFileSync(path.join(root,"public","app.js"),"utf8");
const server=fs.readFileSync(path.join(root,"server","application.js"),"utf8");
const css=fs.readFileSync(path.join(root,"public","styles.css"),"utf8");
const migration=fs.readFileSync(path.join(root,"migrations","008_trial_operations.sql"),"utf8");

test("manager registration is unassigned and availability is view-only",()=>{
  assert.match(app,/assignmentMode='LATER'/);
  assert.match(app,/closerId=null;payload\.slotId=null/);
  assert.match(app,/api\/availability-summary/);
  assert.match(app,/Слот не забронирован/);
});

test("separate unassigned navigation is hidden without deleting legacy flow",()=>{
  assert.match(app,/key!=="unassigned"/);
  assert.match(app,/renderUnassignedTrials/);
  assert.match(app,/TRIAL_REGISTERED_UNASSIGNED/);
});

test("CRM cards expose operational facts and dynamic date groups",()=>{
  for(const label of ["Сегодняшние","Запланированные","Ответственный менеджер","Клоузер","Сумма","Статус","Причина"])assert.match(app,new RegExp(label));
  assert.match(app,/clientPlanDate\(c\)===businessToday/);
});

test("reschedule later and notification snooze UX are present",()=>{
  assert.match(app,/Назначить новое время сейчас/);
  assert.match(app,/Назначить позже/);
  assert.match(app,/Перенос — ожидает нового времени/);
  assert.match(app,/api\/notifications\/\$\{card\.dataset\.popup\}\/snooze/);
  assert.match(server,/15\*60000/);
});

test("migration 008 is additive and contains no destructive statements",()=>{
  assert.match(migration,/ADD COLUMN IF NOT EXISTS pending_reschedule/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS snoozed_until/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS resolved_at/);
  assert.doesNotMatch(migration,/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/i);
});

test("mobile navigation honors the safe area and reserves content space",()=>{
  assert.match(css,/height:calc\(67px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css,/padding-bottom:calc\(105px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css,/overflow-x:hidden/);
});
