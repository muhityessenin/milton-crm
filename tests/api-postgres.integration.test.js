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
  const state=app.seedDatabase();app.setDbForTests(state);
  state.users=state.users.filter((row)=>["usr_admin","usr_manager","usr_closer"].includes(row.id));
  state.statuses=state.statuses.filter((row)=>["st_scheduled","st_payment"].includes(row.id));
  state.leadSources=state.leadSources.filter((row)=>row.id==="src_1");state.tags=state.tags.filter((row)=>row.id==="tag_1");
  state.refusalReasons=state.refusalReasons.slice(0,1);state.paymentMethods=state.paymentMethods.filter((row)=>row.id==="method_1");
  state.clients=[];state.trials=[];state.payments=[];state.paymentCorrections=[];state.notes=[];state.history=[];state.notifications=[];state.auditLogs=[];state.savedFilters=[];
  state.availabilitySlots=state.availabilitySlots.filter((row)=>row.closerId==="usr_closer"&&row.status==="FREE").slice(0,2);
  await txStorage.state.save(state);
  progress("seed");
  app.setStorageForTests(txStorage);
  await app.startServer(0);
  t.after(async()=>{
    if(app.server.listening)await new Promise((resolve)=>app.server.close(resolve));
    await client.query("ROLLBACK").catch(()=>{});client.release();await ownerStorage.close();
  });

  const base=`http://127.0.0.1:${app.server.address().port}`;let token="";
  async function call(method,pathname,payload,extraHeaders={}){
    const response=await fetch(`${base}${pathname}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(payload===undefined?{}:{"Content-Type":"application/json"}),...extraHeaders},body:payload===undefined?undefined:JSON.stringify(payload)});
    const type=response.headers.get("content-type")||"";
    return {response,body:type.includes("application/json")?await response.json():await response.text()};
  }

  let result=await call("GET","/api/health");
  assert.equal(result.response.status,200);assert.deepEqual(result.body,{status:"ok",storage:"postgres"});
  result=await call("POST","/api/login",{login:"admin@milton.kz",password:"demo123"});
  progress("login");
  assert.equal(result.response.status,200);token=result.body.token;
  result=await call("GET","/api/bootstrap");assert.equal(result.response.status,200);assert.equal(result.body.me.isOwner,true);
  progress("bootstrap");
  const slots=(await call("GET","/api/slots?closerId=usr_closer")).body;
  const slot=slots.find((item)=>item.status==="FREE");assert.ok(slot);
  const slotDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Almaty"}).format(new Date(slot.startAt));
  result=await call("GET",`/api/schedule-board?date=${slotDate}`);assert.equal(result.response.status,200);assert.ok(result.body.closers.some((closer)=>closer.id==="usr_closer"));assert.equal(result.body.slots.find((item)=>item.id===slot.id).status,"FREE");

  result=await call("POST","/api/clients",{name:"API PostgreSQL Client",phone:"+7 701 555 66 44",managerId:"usr_manager",closerId:"usr_closer",slotId:slot.id,statusId:"st_scheduled",leadSourceId:"src_1",tagIds:["tag_1"],trialType:"FREE"});
  progress("client");
  assert.equal(result.response.status,201);const clientId=result.body.id;
  result=await call("GET",`/api/schedule-board?date=${slotDate}`);const boardSlot=result.body.slots.find((item)=>item.id===slot.id);assert.equal(boardSlot.status,"BOOKED");assert.equal(boardSlot.events[0].clientName,"API PostgreSQL Client");assert.equal(boardSlot.events[0].manager.id,"usr_manager");
  assert.equal((await call("GET",`/api/clients/${clientId}`)).response.status,200);
  assert.equal((await call("POST",`/api/clients/${clientId}/notes`,{text:"PostgreSQL API note"})).response.status,201);
  progress("note");

  const paymentInput={statusId:"st_payment",amount:60000,paymentMethodId:"method_1",paymentDate:"2026-09-02"},paymentHeaders={"Idempotency-Key":"postgres-api-payment-1"};
  result=await call("POST",`/api/clients/${clientId}/status`,paymentInput,paymentHeaders);
  assert.equal(result.response.status,200);
  assert.equal((await call("POST",`/api/clients/${clientId}/status`,paymentInput,paymentHeaders)).response.status,200);
  const occupied=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===slot.id);assert.equal(occupied.status,"OCCUPIED");assert.equal(occupied.events[0].statusName,"Чек");
  progress("payment");
  result=await call("GET",`/api/clients/${clientId}`);assert.equal(result.body.payments.length,1);const paymentId=result.body.payments[0].id;assert.ok(paymentId);
  assert.equal((await call("POST",`/api/payments/${paymentId}/correct`,{amount:61000,paymentMethodId:"method_1",paymentDate:"2026-09-02",reason:"PostgreSQL API test"})).response.status,201);
  progress("correction");

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
