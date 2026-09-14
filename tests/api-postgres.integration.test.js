"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const enabled = process.env.RUN_POSTGRES_API_TESTS === "1";

test("full HTTP API works through PostgreSQL storage", { skip:!enabled }, async (t) => {
  const progress=(label)=>{if(process.env.DEBUG_STORAGE_TEST)console.log(`api-pg:${label}`);};
  process.env.STORAGE_BACKEND="json";
  process.env.JSON_DB_FILE=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"milton-pg-api-")),"db.json");
  const app=require("../server");
  const { storageConfig }=require("../storage/config");
  const { PostgresStorage }=require("../storage/postgres/storage");
  const ownerStorage=PostgresStorage.connect(storageConfig().databaseUrl,{max:2});
  await ownerStorage.assertSchema();
  progress("schema");
  const client=await ownerStorage.pool.connect();
  await client.query("BEGIN");
  const txStorage=new PostgresStorage({pool:ownerStorage.pool,db:client,ownsPool:false});
  t.after(async()=>{
    if(app.server.listening)await new Promise((resolve)=>app.server.close(resolve));
    await client.query("ROLLBACK").catch(()=>{});client.release();await ownerStorage.close();
  });
  const state=app.seedDatabase();app.setDbForTests(state);
  state.users=state.users.filter((row)=>["usr_admin","usr_manager","usr_closer"].includes(row.id));
  const loginSuffix=`${Date.now()}-${process.pid}`,testLogins={usr_admin:`api.owner.${loginSuffix}@milton.local`,usr_manager:`api.manager.${loginSuffix}@milton.local`,usr_closer:`api.closer.${loginSuffix}@milton.local`};
  state.users.forEach((row)=>{row.login=testLogins[row.id]});
  state.statuses=state.statuses.filter((row)=>["st_scheduled","st_payment"].includes(row.id));
  state.leadSources=state.leadSources.filter((row)=>row.id==="src_1");state.tags=state.tags.filter((row)=>row.id==="tag_1");
  state.refusalReasons=state.refusalReasons.slice(0,1);state.paymentMethods=state.paymentMethods.filter((row)=>row.id==="method_1");
  state.clients=[];state.trials=[];state.payments=[];state.paymentCorrections=[];state.notes=[];state.history=[];state.notifications=[];state.auditLogs=[];state.savedFilters=[];
  state.availabilitySlots=state.availabilitySlots.filter((row)=>row.closerId==="usr_closer"&&row.status==="FREE").slice(0,2);
  await txStorage.state.save(state);
  progress("seed");
  app.setStorageForTests(txStorage);
  await app.startServer(0);

  const base=`http://127.0.0.1:${app.server.address().port}`;let token="";
  async function call(method,pathname,payload,extraHeaders={}){
    const response=await fetch(`${base}${pathname}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(payload===undefined?{}:{"Content-Type":"application/json"}),...extraHeaders},body:payload===undefined?undefined:JSON.stringify(payload)});
    const type=response.headers.get("content-type")||"";
    return {response,body:type.includes("application/json")?await response.json():await response.text()};
  }
  async function callAs(authToken,method,pathname,payload){
    const response=await fetch(`${base}${pathname}`,{method,headers:{Authorization:`Bearer ${authToken}`,...(payload===undefined?{}:{"Content-Type":"application/json"})},body:payload===undefined?undefined:JSON.stringify(payload)});
    const type=response.headers.get("content-type")||"";
    return {response,body:type.includes("application/json")?await response.json():await response.text()};
  }

  let result=await call("GET","/api/health");
  assert.equal(result.response.status,200);assert.deepEqual(result.body,{status:"ok",storage:"postgres"});
  result=await call("POST","/api/login",{login:testLogins.usr_admin,password:"demo123"});
  progress("login");
  assert.equal(result.response.status,200);token=result.body.token;const ownerToken=token;
  result=await call("POST","/api/login",{login:testLogins.usr_closer,password:"demo123"});assert.equal(result.response.status,200);const closerToken=result.body.token;token=ownerToken;result=await call("POST","/api/login",{login:testLogins.usr_manager,password:"demo123"});assert.equal(result.response.status,200);const managerToken=result.body.token;token=ownerToken;
  result=await call("GET","/api/bootstrap");assert.equal(result.response.status,200);assert.equal(result.body.me.isOwner,true);
  progress("bootstrap");
  const slots=(await call("GET","/api/slots?closerId=usr_closer")).body;
  const slot=slots.find((item)=>item.status==="FREE");assert.ok(slot);
  const slotDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Almaty"}).format(new Date(slot.startAt));
  result=await call("GET",`/api/schedule-board?date=${slotDate}`);assert.equal(result.response.status,200);assert.ok(result.body.closers.some((closer)=>closer.id==="usr_closer"));assert.equal(result.body.slots.find((item)=>item.id===slot.id).status,"FREE");
  token=managerToken;result=await call("GET",`/api/availability-summary?date=${slotDate}`);assert.equal(result.response.status,200);assert.equal(Object.keys(result.body.items[0]).some(key=>/closer/i.test(key)),false);result=await call("POST","/api/clients",{name:"PG Manager view-only",phone:"+77015556639",closerId:"usr_closer",slotId:slot.id,assignmentMode:"NOW",preferredDate:slotDate,preferredTimeText:"10:00",trialType:"FREE"});assert.equal(result.response.status,201);const managerOnlyClient=result.body;assert.equal(managerOnlyClient.activeTrial.assignmentState,"UNASSIGNED");assert.equal(managerOnlyClient.activeTrial.slotId,null);assert.equal((await call("GET","/api/slots?closerId=usr_closer")).body.find(item=>item.id===slot.id).status,"FREE");assert.equal((await call("GET","/api/unassigned-trials")).response.status,403);token=ownerToken;assert.equal((await call("DELETE",`/api/clients/${managerOnlyClient.id}`,{confirmation:"УДАЛИТЬ"})).response.status,200);

  token=closerToken;
  result=await call("POST","/api/slots/generate",{closerId:"usr_closer",date:"2031-01-15",start:"10:00",end:"14:00",durationMinutes:40});assert.equal(result.response.status,201);assert.equal(result.body.created,6);assert.equal(result.body.durationMinutes,40);
  let managedSlots=(await call("GET","/api/slots?closerId=usr_closer&date=2031-01-15")).body;assert.equal(managedSlots.length,6);assert.equal(new Date(managedSlots[0].endAt)-new Date(managedSlots[0].startAt),40*60*1000);assert.equal(new Date(managedSlots.at(-1).endAt).toISOString(),"2031-01-15T09:00:00.000Z");
  result=await call("POST","/api/slots/generate",{closerId:"usr_closer",date:"2031-01-15",start:"10:20",end:"11:00",durationMinutes:40});assert.equal(result.response.status,201);assert.equal(result.body.created,0);
  result=await call("PUT",`/api/slots/${managedSlots[0].id}`,{date:"2031-01-15",time:"14:00",durationMinutes:35});assert.equal(result.response.status,200);assert.equal(new Date(result.body.endAt)-new Date(result.body.startAt),35*60*1000);
  result=await call("DELETE",`/api/slots/${managedSlots[1].id}`);assert.equal(result.response.status,200);assert.equal(result.body.deleted,true);
  assert.equal((await call("POST","/api/slots/generate",{closerId:"usr_closer",date:"2031-01-16",start:"10:00",end:"11:00",durationMinutes:9})).response.status,422);
  assert.equal((await call("GET","/api/bootstrap")).body.me.trialDurationMinutes,40);
  token=ownerToken;

  result=await call("POST","/api/clients",{name:"PG Unassigned Client",phone:"+77015556640",managerId:"usr_manager",statusId:"st_scheduled",assignmentMode:"LATER",preferredTimeText:"После 20:00",trialType:"FREE"});assert.equal(result.response.status,201);const unassignedClientId=result.body.id,unassignedTrial=result.body.activeTrial;assert.equal(unassignedTrial.assignmentState,"UNASSIGNED");assert.equal(unassignedTrial.slotId,null);result=await call("GET","/api/unassigned-trials");assert.equal(result.body.items.some(item=>item.id===unassignedTrial.id),true);result=await callAs(ownerToken,"POST",`/api/trials/${unassignedTrial.id}/assign`,{slotId:slot.id,version:unassignedTrial.assignmentVersion});assert.equal(result.response.status,200);assert.equal(result.body.originalManagerId,"usr_manager");result=await callAs(ownerToken,"POST",`/api/trials/${unassignedTrial.id}/assign`,{slotId:slot.id,version:unassignedTrial.assignmentVersion});assert.equal(result.response.status,409);assert.equal((await call("GET","/api/unassigned-trials")).body.items.length,0);assert.equal((await call("DELETE",`/api/clients/${unassignedClientId}`,{confirmation:"УДАЛИТЬ"})).response.status,200);

  result=await call("POST","/api/clients",{name:"API PostgreSQL Client",phone:"+7 701 555 66 44",managerId:"usr_manager",closerId:"usr_closer",slotId:slot.id,statusId:"st_scheduled",leadSourceId:"src_1",tagIds:["tag_1"],trialType:"FREE"});
  progress("client");
  assert.equal(result.response.status,201);const clientId=result.body.id;
  assert.equal((await call("DELETE",`/api/slots/${slot.id}`)).response.status,409);
  assert.equal(result.body.activeTrial.slotId,slot.id);assert.equal(result.body.activeTrial.closerId,slot.closerId);assert.equal(result.body.activeTrial.scheduledAt,slot.startAt);
  const otherFree=slots.find((item)=>item.id!==slot.id&&item.status==="FREE");assert.ok(otherFree);
  result=await call("POST","/api/clients",{name:"Duplicate phone retry",phone:"+7 701 555 66 44",managerId:"usr_manager",closerId:"usr_closer",slotId:otherFree.id,statusId:"st_scheduled",trialType:"FREE"});assert.equal(result.response.status,409);assert.equal(result.body.code,"DUPLICATE_PHONE");assert.equal(result.body.clientId,clientId);assert.equal((await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===otherFree.id).status,"FREE");
  result=await call("GET",`/api/schedule-board?date=${slotDate}`);const boardSlot=result.body.slots.find((item)=>item.id===slot.id);assert.equal(boardSlot.status,"BOOKED");assert.equal(boardSlot.events[0].clientName,"API PostgreSQL Client");assert.equal(boardSlot.events[0].manager.id,"usr_manager");
  assert.equal((await call("GET",`/api/clients/${clientId}`)).response.status,200);
  assert.equal((await call("POST",`/api/clients/${clientId}/notes`,{text:"PostgreSQL API note"})).response.status,201);
  progress("note");

  const paymentInput={statusId:"st_payment",amount:60000,paymentMethodId:"method_1",paymentDate:"2026-09-02"},paymentHeaders={"Idempotency-Key":"postgres-api-payment-1"};
  result=await call("POST",`/api/clients/${clientId}/status`,paymentInput,paymentHeaders);
  assert.equal(result.response.status,200);
  assert.equal((await call("POST",`/api/clients/${clientId}/status`,paymentInput,paymentHeaders)).response.status,200);
  const occupied=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===slot.id);assert.equal(occupied.status,"OCCUPIED");assert.equal(occupied.events[0].statusName,"Чек");
  assert.equal((await call("DELETE",`/api/slots/${slot.id}`)).response.status,409);
  progress("payment");
  result=await call("GET",`/api/clients/${clientId}`);assert.equal(result.body.payments.length,1);const paymentId=result.body.payments[0].id;assert.ok(paymentId);
  assert.equal((await call("POST",`/api/payments/${paymentId}/correct`,{amount:61000,paymentMethodId:"method_1",paymentDate:"2026-09-02",reason:"PostgreSQL API test"})).response.status,201);
  progress("correction");

  result=await call("POST","/api/admin/config/statuses",{name:"Предоплата PG test",color:"#d99014",actionType:"NONE",partialPayment:true,sortOrder:90});assert.equal(result.response.status,201);const prepaymentStatus=result.body;assert.equal(prepaymentStatus.partialPayment,true);
  const createdAtBeforePrepayment=(await call("GET",`/api/clients/${clientId}`)).body.client.createdAt;
  result=await call("POST",`/api/clients/${clientId}/status`,{statusId:prepaymentStatus.id,amount:10000,totalDealAmount:80000,remainingPaymentDueDate:"2026-09-01",paymentMethodId:"method_1",paymentDate:"2026-09-02",paymentComment:"Предоплата PG"},{"Idempotency-Key":"postgres-api-prepayment-1"});assert.equal(result.response.status,200);assert.equal(result.body.prepayment.paymentTotal,71000);assert.equal(result.body.prepayment.remainingAmount,9000);assert.equal(new Date(result.body.createdAt).getTime(),new Date(createdAtBeforePrepayment).getTime());const statusChangedAt=result.body.statusChangedAt;
  result=await call("GET","/api/bootstrap");assert.ok(result.body.notifications.some(item=>item.clientId===clientId&&item.type==="PREPAYMENT_BALANCE_DUE"&&!item.resolvedAt));
  result=await call("POST",`/api/clients/${clientId}/notes`,{text:"PostgreSQL timestamp note"});assert.equal(result.response.status,201);result=await call("GET",`/api/clients/${clientId}`);assert.equal(new Date(result.body.client.statusChangedAt).getTime(),new Date(statusChangedAt).getTime());
  result=await call("POST",`/api/clients/${clientId}/status`,{statusId:prepaymentStatus.id,amount:9000,totalDealAmount:80000,remainingPaymentDueDate:"2026-09-01",paymentMethodId:"method_1",paymentDate:"2026-09-02"},{"Idempotency-Key":"postgres-api-prepayment-2"});assert.equal(result.response.status,200);assert.equal(result.body.prepayment.remainingAmount,0);assert.equal(result.body.prepayment.active,false);assert.equal(new Date(result.body.statusChangedAt).getTime(),new Date(statusChangedAt).getTime());
  result=await call("GET","/api/bootstrap");assert.ok(result.body.notifications.some(item=>item.clientId===clientId&&item.type==="PREPAYMENT_BALANCE_DUE"&&item.resolvedAt));
  progress("prepayment");

  assert.equal((await call("POST",`/api/clients/${clientId}/archive`,{reason:"TEST"})).response.status,200);
  assert.equal((await call("POST",`/api/clients/${clientId}/restore`,{})).response.status,200);
  progress("archive-restore");
  assert.equal((await call("PUT","/api/admin/branding",{companyName:"Milton",accentColor:"#3157D5",logoUrl:""})).response.status,200);
  assert.equal((await call("GET","/api/analytics?from=2026-09-01&to=2026-09-30")).response.status,200);
  assert.equal((await call("GET","/api/export/payments.csv?from=2026-09-01&to=2026-09-30")).response.status,200);
  assert.equal((await call("GET","/api/audit")).response.status,200);
  progress("reads");

  result=await call("DELETE",`/api/clients/${clientId}`,{confirmation:"УДАЛИТЬ"});
  assert.equal(result.response.status,200);assert.equal(result.body.hardDeleted,true);
  progress("delete");
  assert.equal((await txStorage.clients.findById(clientId)),null);
  assert.ok((await txStorage.auditLogs.recent()).some((row)=>row.action==="CLIENT_PERMANENTLY_DELETED"));
});
