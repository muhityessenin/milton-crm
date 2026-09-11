"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milton-json-api-"));
process.env.STORAGE_BACKEND = "json";
process.env.JSON_DB_FILE = path.join(directory, "db.json");
process.env.UPLOAD_DIR = path.join(directory, "uploads");
const { startServer, server, closeStorage } = require("../server");

test("full HTTP API preserves CRM behavior through JSON storage", async (t) => {
  await startServer(0);
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await closeStorage();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = "";
  async function call(method, pathname, payload) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const type = response.headers.get("content-type") || "";
    return { response, body: type.includes("application/json") ? await response.json() : await response.text() };
  }

  let result = await call("GET", "/api/health");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { status:"ok", storage:"json" });

  result = await call("POST", "/api/login", { login:"admin@milton.kz", password:"demo123" });
  assert.equal(result.response.status, 200); token = result.body.token;
  const ownerToken=token;result=await call("POST","/api/login",{login:"closer@milton.kz",password:"demo123"});assert.equal(result.response.status,200);const closerToken=result.body.token;token=ownerToken;
  const eventsAbort=new AbortController(),eventsResponse=await fetch(`${base}/api/events`,{headers:{Authorization:`Bearer ${closerToken}`},signal:eventsAbort.signal});assert.equal(eventsResponse.status,200);const eventsReader=eventsResponse.body.getReader();await eventsReader.read();

  result = await call("GET", "/api/bootstrap");
  assert.equal(result.response.status, 200);
  result=await call("GET","/api/sync?resources=notifications");assert.equal(result.response.status,200);assert.ok(Array.isArray(result.body.notifications));assert.equal("clients" in result.body,false);
  result = await call("GET", "/api/bootstrap");
  const slot = result.body.dashboard ? (await call("GET", "/api/slots?closerId=usr_closer")).body.find((item) => item.status === "FREE") : null;
  assert.ok(slot);

  result = await call("POST", "/api/clients", { name:"Invalid paid",phone:"+77015554431",managerId:"usr_manager",closerId:"usr_closer",slotId:slot.id,statusId:"st_scheduled",trialType:"PAID",trialAmount:1500 });
  assert.equal(result.response.status,422);assert.match(result.body.error,/чек/);

  result = await call("POST", "/api/clients", {
    name:"API JSON Client", phone:"+7 701 555 44 33", managerId:"usr_manager",
    closerId:"usr_closer", slotId:slot.id, statusId:"st_scheduled", leadSourceId:"src_1", tagIds:["tag_1"], trialType:"FREE",
  });
  assert.equal(result.response.status, 201); const clientId=result.body.id;
  const realtimeChunk=await Promise.race([eventsReader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Realtime update timeout")),1500))]);const realtimeText=new TextDecoder().decode(realtimeChunk.value);assert.match(realtimeText,/event: invalidate/);assert.match(realtimeText,/clients/);assert.doesNotMatch(realtimeText,/API JSON Client|\+7701/);eventsAbort.abort();
  result=await call("POST","/api/clients",{name:"API JSON Client",phone:"+7 701 555 44 33",managerId:"usr_manager",closerId:"usr_closer",slotId:slot.id,statusId:"st_scheduled",trialType:"FREE"});assert.equal(result.response.status,409);assert.equal((await call("GET","/api/bootstrap")).body.clients.filter((item)=>item.id===clientId).length,1);

  result = await call("POST", `/api/clients/${clientId}/notes`, { text:"API storage note" });
  assert.equal(result.response.status, 201);
  token="";result=await call("POST","/api/login",{login:"manager@milton.kz",password:"demo123"});assert.equal(result.response.status,200);const managerToken=result.body.token,managerAbort=new AbortController(),managerEvents=await fetch(`${base}/api/events`,{headers:{Authorization:`Bearer ${managerToken}`},signal:managerAbort.signal}),managerReader=managerEvents.body.getReader();await managerReader.read();token=closerToken;
  result = await call("POST", `/api/clients/${clientId}/status`, { statusId:"st_payment", amount:50000, paymentMethodId:"method_1", paymentDate:"2026-09-02" });
  assert.equal(result.response.status, 200);
  const managerChange=await Promise.race([managerReader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Manager realtime timeout")),1500))]);assert.match(new TextDecoder().decode(managerChange.value),/payments|clients/);managerAbort.abort();token=managerToken;const managerDrawer=await call("GET",`/api/clients/${clientId}`);assert.equal(managerDrawer.body.client.currentStatusId,"st_payment");assert.equal(managerDrawer.body.payments.length,1);token=ownerToken;
  const occupied=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===slot.id);assert.equal(occupied.status,"OCCUPIED");assert.equal(occupied.events[0].statusName,"Чек");

  result = await call("GET", `/api/clients/${clientId}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.notes.length, 1);
  assert.equal(result.body.payments.length, 1);
  const paymentId=result.body.payments[0].id;

  result = await call("POST", `/api/payments/${paymentId}/correct`, { amount:51000, paymentMethodId:"method_1", paymentDate:"2026-09-02", reason:"API test" });
  assert.equal(result.response.status, 201);
  result = await call("POST", `/api/clients/${clientId}/archive`, { reason:"TEST" });
  assert.equal(result.response.status, 200);
  result = await call("POST", `/api/clients/${clientId}/restore`, {});
  assert.equal(result.response.status, 200);

  result = await call("PUT", "/api/admin/branding", { companyName:"Milton", accentColor:"#3157D5", logoUrl:"" });
  assert.equal(result.response.status, 200);
  const avatarDataUrl="data:image/jpeg;base64,/9j/2Q==";result=await call("PUT","/api/profile",{avatarUrl:avatarDataUrl});assert.equal(result.response.status,200);assert.equal((await call("GET","/api/bootstrap")).body.me.avatarUrl,avatarDataUrl);
  assert.equal((await call("GET", "/api/analytics?from=2026-09-01&to=2026-09-30")).response.status, 200);
  assert.equal((await call("GET", "/api/export/clients.csv?from=2026-09-01&to=2026-09-30")).response.status, 200);

  result = await call("DELETE", `/api/clients/${clientId}`, { confirmation:"УДАЛИТЬ" });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.hardDeleted, true);
  assert.equal((await call("GET", "/api/audit")).response.status, 200);

  const paidSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.status==="FREE");
  const receiptDataUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  result=await call("POST","/api/clients",{name:"Paid Trial Client",phone:"+77015554432",managerId:"usr_manager",closerId:"usr_closer",slotId:paidSlot.id,statusId:"st_scheduled",trialType:"PAID",trialAmount:1500,receiptDataUrl,receiptName:"receipt.png"});
  assert.equal(result.response.status,201);const paidClientId=result.body.id;
  result=await call("GET",`/api/clients/${paidClientId}`);assert.equal(result.body.trials[0].trialType,"PAID");assert.equal(Number(result.body.trials[0].trialAmount),1500);assert.ok(result.body.trials[0].receiptUrl);const receiptUrl=result.body.trials[0].receiptUrl,receiptResponse=await fetch(`${base}${receiptUrl}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(receiptResponse.status,200);assert.equal(receiptResponse.headers.get("content-type"),"image/png");
  token="";result=await call("POST","/api/login",{login:"alisher@milton.kz",password:"demo123"});assert.equal(result.response.status,200);const unrelatedToken=result.body.token;const deniedReceipt=await fetch(`${base}${receiptUrl}`,{headers:{Authorization:`Bearer ${unrelatedToken}`}});assert.equal(deniedReceipt.status,404);token=ownerToken;
  const newSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.status==="FREE");result=await call("POST",`/api/clients/${paidClientId}/status`,{statusId:"st_reschedule",newSlotId:newSlot.id});assert.equal(result.response.status,200);const rescheduledTrialId=result.body.activeTrial.id,oldAfter=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===paidSlot.id);assert.equal(oldAfter.status,"FREE");assert.equal(oldAfter.events[0].statusName,"Перенос");assert.equal(oldAfter.events[0].rescheduledTo.trialId,rescheduledTrialId);const newAfter=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===newSlot.id);assert.equal(newAfter.status,"BOOKED");assert.equal(newAfter.bookedTrialId,rescheduledTrialId);
  result=await call("POST",`/api/clients/${paidClientId}/status`,{statusId:"st_no_show"});assert.equal(result.response.status,200);const noShowSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===newSlot.id);assert.equal(noShowSlot.status,"OCCUPIED");assert.equal(noShowSlot.events[0].statusName,"Не пришёл");
  assert.equal((await call("DELETE",`/api/clients/${paidClientId}`,{confirmation:"УДАЛИТЬ"})).response.status,200);
  const raceSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.status==="FREE"),race=await Promise.all([call("POST","/api/clients",{name:"Race A",phone:"+77015554461",managerId:"usr_manager",closerId:"usr_closer",slotId:raceSlot.id,statusId:"st_scheduled",trialType:"FREE"}),call("POST","/api/clients",{name:"Race B",phone:"+77015554462",managerId:"usr_manager",closerId:"usr_closer",slotId:raceSlot.id,statusId:"st_scheduled",trialType:"FREE"})]);assert.deepEqual(race.map((item)=>item.response.status).sort(),[201,409]);const raceWinner=race.find((item)=>item.response.status===201).body;assert.equal((await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===raceSlot.id).events.filter((item)=>item.active).length,1);result=await call("POST",`/api/clients/${raceWinner.id}/status`,{statusId:"st_refusal",refusalReasonId:"reason_1"});assert.equal(result.response.status,200);const refusedSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===raceSlot.id);assert.equal(refusedSlot.status,"OCCUPIED");assert.equal(refusedSlot.events[0].statusName,"Отказ");await call("DELETE",`/api/clients/${raceWinner.id}`,{confirmation:"УДАЛИТЬ"});
});
