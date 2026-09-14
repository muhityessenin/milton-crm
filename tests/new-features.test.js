"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { validateTrialPayment } = require("../server/trial-registration");
const { LocalFileStorage } = require("../server/file-storage");
const { RealtimeHub, resourcesForMutation } = require("../server/realtime");
const { layout } = require("../public/avatar-crop");

test("free and paid trial payment validation is explicit and independent from course payments", () => {
  assert.deepEqual(validateTrialPayment({ trialType:"FREE", trialAmount:990 }).value, { trialType:"FREE", trialAmount:0, receipt:null });
  assert.match(validateTrialPayment({ trialType:"PAID", trialAmount:0, receiptDataUrl:"x" }).error, /сумму/);
  assert.match(validateTrialPayment({ trialType:"PAID", trialAmount:1500 }).error, /чек/);
  assert.equal(validateTrialPayment({ trialType:"PAID", trialAmount:2000, receiptDataUrl:"data:image/png;base64,AA==", receiptName:"paid.png" }).value.trialAmount, 2000);
});

test("receipt storage persists references without putting base64 in the database value", async (t) => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"milton-receipt-"));t.after(()=>fs.promises.rm(root,{recursive:true,force:true}));
  const storage=new LocalFileStorage({rootDir:root,maxBytes:1024});
  const saved=await storage.saveDataUrl("data:application/pdf;base64,JVBERi0xLjQK","receipt.pdf");
  assert.equal(saved.mimeType,"application/pdf");assert.equal(saved.sizeBytes,9);assert.equal("dataUrl" in saved,false);
  assert.equal((await fs.promises.readFile(storage.resolve(saved.key),"utf8")).startsWith("%PDF-"),true);
  const restarted=new LocalFileStorage({rootDir:root,maxBytes:1024});assert.ok(restarted.resolve(saved.key));
  await restarted.remove(saved.key);assert.equal(fs.existsSync(storage.resolve(saved.key)),false);
});

test("realtime invalidations contain resource names only", () => {
  const hub=new RealtimeHub({heartbeatMillis:60_000}),req=new EventEmitter(),writes=[];
  const res=Object.assign(new EventEmitter(),{writeHead(){},write(value){writes.push(value);return true},end(){}});
  hub.connect(req,res,"usr_private");hub.publish(resourcesForMutation("POST","/api/clients"));hub.close();
  const output=writes.join("");assert.match(output,/clients/);assert.doesNotMatch(output,/usr_private/);assert.doesNotMatch(output,/phone|clientId|name/);
});

test("avatar crop layout always covers a 512 square and clamps dragging", () => {
  const wide=layout(1600,800,1,9999,-9999,512);assert.ok(wide.width>=512&&wide.height>=512);assert.ok(wide.x<=0&&wide.x+wide.width>=512);assert.ok(wide.y<=0&&wide.y+wide.height>=512);
  const zoomed=layout(800,1600,2,0,0,512);assert.equal(zoomed.scale,1.28);assert.equal(zoomed.width,1024);assert.equal(zoomed.height,2048);
});

test("migration preserves completed slots and emits commit-safe PostgreSQL notifications", () => {
  const sql=fs.readFileSync(path.join(__dirname,"..","migrations","005_realtime_trial_receipts_and_schedule.sql"),"utf8");
  assert.match(sql,/status IN \('FREE', 'BOOKED', 'OCCUPIED'\)/);assert.match(sql,/status = 'OCCUPIED'/);assert.match(sql,/pg_notify\('milton_crm_changes'/);assert.match(sql,/FOR EACH STATEMENT/);
});

test("prepayment migration is additive and keeps remaining balance derived from payments", () => {
  const sql=fs.readFileSync(path.join(__dirname,"..","migrations","009_prepayment_and_client_timestamps.sql"),"utf8");
  assert.match(sql,/ADD COLUMN IF NOT EXISTS partial_payment/);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS total_deal_amount/);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS status_changed_at/);
  assert.match(sql,/notifications_user_client_balance_uidx/);
  assert.doesNotMatch(sql,/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(sql,/remaining_amount/i);
});

test("CRM cards add compact prepayment and exact timestamps without replacing existing facts", () => {
  const app=fs.readFileSync(path.join(__dirname,"..","public","app.js"),"utf8"),css=fs.readFileSync(path.join(__dirname,"..","public","styles.css"),"utf8");
  for(const label of ["Менеджер:","Клоузер:","Сумма:","Статус:","Причина:","Пробный:","Создан:","Статус с:","Изм.:"])assert.match(app,new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.match(app,/if\(!p\?\.active\)return''/);
  assert.match(app,/Предоплата:.*Остаток:/);
  assert.match(app,/timeZone:'Asia\/Almaty'/);
  assert.match(css,/\.card-timestamps\{/);
  assert.match(css,/\.prepayment-card\{/);
});
