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
const { startServer, server, closeStorage, setVpsDeploymentServiceForTests } = require("../server");

test("full HTTP API preserves CRM behavior through JSON storage", async (t) => {
  await startServer(0);
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await closeStorage();
    fs.rmSync(directory,{recursive:true,force:true});
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
  const dayFrom=(value)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Almaty"}).format(new Date(value));

  let result = await call("GET", "/api/health");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { status:"ok", storage:"json" });
  const staticResponse=await fetch(`${base}/app.js`,{headers:{"Accept-Encoding":"gzip"}});assert.equal(staticResponse.status,200);assert.equal(staticResponse.headers.get("content-encoding"),"gzip");assert.match(staticResponse.headers.get("cache-control"),/must-revalidate/);const staticEtag=staticResponse.headers.get("etag");await staticResponse.arrayBuffer();const cachedStatic=await fetch(`${base}/app.js`,{headers:{"If-None-Match":staticEtag}});assert.equal(cachedStatic.status,304);

  result = await call("POST", "/api/login", { login:"admin@milton.kz", password:"demo123" });
  assert.equal(result.response.status, 200); token = result.body.token;
  const ownerToken=token;result=await call("POST","/api/login",{login:"closer@milton.kz",password:"demo123"});assert.equal(result.response.status,200);const closerToken=result.body.token;token=ownerToken;
  const deploymentJobId="a".repeat(32),deploymentCommit="b".repeat(40);let selectedDeploymentVersion=null;setVpsDeploymentServiceForTests({describe:()=>({configured:true,missing:[],host:"203.0.113.10",port:22,username:"ubuntu",deployPath:"/opt/milton-crm"}),listDeployments:async()=>({retentionDays:30,deployments:[{version:22,deployedAt:"2026-09-14T15:00:00Z",sha:deploymentCommit,shortSha:"bbbbbbb",committedAt:"2026-09-13T14:00:00+05:00",author:"Owner",subject:"Detailed deployment"}]}),start:async(version)=>{selectedDeploymentVersion=version;return {jobId:deploymentJobId,state:"running",version,commit:deploymentCommit};},status:async(jobId)=>({jobId,state:"success",exitCode:0,output:"Deployment complete"})});
  token=closerToken;result=await call("GET","/api/admin/deployment");assert.equal(result.response.status,403);assert.equal((await call("GET","/api/admin/deployment/versions")).response.status,403);
  token=ownerToken;result=await call("GET","/api/admin/deployment");assert.equal(result.response.status,200);assert.equal(result.body.configured,true);assert.equal("password" in result.body,false);
  result=await call("GET","/api/admin/deployment/versions");assert.equal(result.response.status,200);assert.equal(result.body.deployments[0].version,22);
  result=await call("POST","/api/admin/deployment",{version:22});assert.equal(result.response.status,202);assert.equal(result.body.jobId,deploymentJobId);assert.equal(selectedDeploymentVersion,22);
  result=await call("GET",`/api/admin/deployment/${deploymentJobId}`);assert.equal(result.response.status,200);assert.equal(result.body.state,"success");assert.match(result.body.output,/Deployment complete/);
  const eventsAbort=new AbortController(),eventsResponse=await fetch(`${base}/api/events`,{headers:{Authorization:`Bearer ${closerToken}`},signal:eventsAbort.signal});assert.equal(eventsResponse.status,200);const eventsReader=eventsResponse.body.getReader();await eventsReader.read();

  result = await call("GET", "/api/bootstrap");
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("content-encoding"),"gzip");
  result=await call("GET","/api/sync?resources=notifications");assert.equal(result.response.status,200);assert.ok(Array.isArray(result.body.notifications));assert.equal("clients" in result.body,false);
  result = await call("GET", "/api/bootstrap");
  const slot = result.body.dashboard ? (await call("GET", "/api/slots?closerId=usr_closer")).body.find((item) => item.status === "FREE") : null;
  assert.ok(slot);
  const slotDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Almaty"}).format(new Date(slot.startAt));
  result=await call("GET",`/api/schedule-board?date=${slotDate}`);assert.equal(result.response.status,200);assert.ok(result.body.closers.some((closer)=>closer.id==="usr_closer"));assert.ok(result.body.closers.every((closer)=>closer.active&&closer.role==="CLOSER"));assert.equal(result.body.slots.find((item)=>item.id===slot.id).status,"FREE");

  result = await call("POST", "/api/clients", { name:"Invalid paid",phone:"+77015554431",managerId:"usr_manager",closerId:"usr_closer",slotId:slot.id,statusId:"st_scheduled",trialType:"PAID",trialAmount:1500 });
  assert.equal(result.response.status,422);assert.match(result.body.error,/чек/);

  result=await call("POST","/api/clients",{name:"Unassigned Client",phone:"+77015554001",managerId:"usr_manager",statusId:"st_scheduled",assignmentMode:"LATER",preferredTimeText:"После 20:00",trialType:"FREE"});assert.equal(result.response.status,201);const unassignedClientId=result.body.id,unassignedTrial=result.body.activeTrial;assert.equal(result.body.currentStatusId,"st_scheduled");assert.equal(unassignedTrial.assignmentState,"UNASSIGNED");assert.equal(unassignedTrial.closerId,null);assert.equal(unassignedTrial.slotId,null);assert.equal(unassignedTrial.scheduledAt,null);
  result=await call("GET","/api/unassigned-trials");assert.equal(result.response.status,200);assert.equal(result.body.items.some(t=>t.id===unassignedTrial.id&&t.preferredTimeText==="После 20:00"),true);assert.equal((await call("GET",`/api/schedule-board?date=${slotDate}`)).body.slots.some(s=>s.bookedTrialId===unassignedTrial.id),false);
  const assignSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find(item=>item.status==="FREE");const assignmentRace=await Promise.all([call("POST",`/api/trials/${unassignedTrial.id}/assign`,{slotId:assignSlot.id,version:unassignedTrial.assignmentVersion}),call("POST",`/api/trials/${unassignedTrial.id}/assign`,{slotId:assignSlot.id,version:unassignedTrial.assignmentVersion})]);assert.deepEqual(assignmentRace.map(x=>x.response.status).sort(),[200,409]);result=await call("GET",`/api/clients/${unassignedClientId}`);assert.equal(result.body.client.activeTrial.assignmentState,"SCHEDULED");assert.equal(result.body.client.originalManagerId,"usr_manager");assert.ok(result.body.history.some(h=>h.eventType==="TRIAL_ASSIGNED"));assert.equal((await call("GET","/api/unassigned-trials")).body.items.some(t=>t.id===unassignedTrial.id),false);assert.equal((await call("GET",`/api/schedule-board?date=${dayFrom(assignSlot.startAt)}`)).body.slots.find(s=>s.id===assignSlot.id).bookedTrialId,unassignedTrial.id);assert.equal((await call("DELETE",`/api/clients/${unassignedClientId}`,{confirmation:"УДАЛИТЬ"})).response.status,200);

  result = await call("POST", "/api/clients", {
    name:"API JSON Client", phone:"+7 701 555 44 33", managerId:"usr_manager",
    closerId:"usr_closer", slotId:slot.id, statusId:"st_scheduled", leadSourceId:"src_1", tagIds:["tag_1"], trialType:"FREE",
  });
  assert.equal(result.response.status, 201); const clientId=result.body.id;
  assert.equal((await call("DELETE",`/api/slots/${slot.id}`)).response.status,409);
  result=await call("GET",`/api/schedule-board?date=${slotDate}`);const boardBooked=result.body.slots.find((item)=>item.id===slot.id);assert.equal(boardBooked.status,"BOOKED");assert.equal(boardBooked.events[0].clientName,"API JSON Client");assert.equal(boardBooked.events[0].manager.id,"usr_manager");
  const realtimeChunk=await Promise.race([eventsReader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Realtime update timeout")),1500))]);const realtimeText=new TextDecoder().decode(realtimeChunk.value);assert.match(realtimeText,/event: invalidate/);assert.match(realtimeText,/clients/);assert.doesNotMatch(realtimeText,/API JSON Client|\+7701/);eventsAbort.abort();
  result=await call("POST","/api/clients",{name:"API JSON Client",phone:"+7 701 555 44 33",managerId:"usr_manager",closerId:"usr_closer",slotId:slot.id,statusId:"st_scheduled",trialType:"FREE"});assert.equal(result.response.status,409);assert.equal((await call("GET","/api/bootstrap")).body.clients.filter((item)=>item.id===clientId).length,1);

  result = await call("POST", `/api/clients/${clientId}/notes`, { text:"API storage note" });
  assert.equal(result.response.status, 201);
  token=closerToken;result=await call("GET",`/api/schedule-board?date=${slotDate}`);assert.deepEqual(result.body.closers.map((closer)=>closer.id),["usr_closer"]);token="";result=await call("POST","/api/login",{login:"manager@milton.kz",password:"demo123"});assert.equal(result.response.status,200);const managerToken=result.body.token,managerAbort=new AbortController(),managerEvents=await fetch(`${base}/api/events`,{headers:{Authorization:`Bearer ${managerToken}`},signal:managerAbort.signal}),managerReader=managerEvents.body.getReader();await managerReader.read();token=managerToken;
  const managerFree=(await call("GET","/api/slots?closerId=usr_closer")).body.find(item=>item.status==="FREE"),managerFreeDate=dayFrom(managerFree.startAt),summaryBefore=await call("GET",`/api/availability-summary?date=${managerFreeDate}`);assert.equal(summaryBefore.response.status,200);assert.equal(Object.keys(summaryBefore.body.items[0]).some(key=>/closer/i.test(key)),false);result=await call("POST","/api/clients",{name:"Manager view-only registration",phone:"+77015554991",closerId:"usr_closer",slotId:managerFree.id,assignmentMode:"NOW",preferredDate:managerFreeDate,preferredTimeText:"10:00",trialType:"FREE"});assert.equal(result.response.status,201);const managerOnlyClient=result.body;assert.equal(managerOnlyClient.currentStatusId,managerFreeDate===dayFrom(new Date().toISOString())?"st_today":"st_scheduled");assert.equal(managerOnlyClient.activeTrial.assignmentState,"UNASSIGNED");assert.equal(managerOnlyClient.activeTrial.slotId,null);assert.equal((await call("GET","/api/slots?closerId=usr_closer")).body.find(item=>item.id===managerFree.id).status,"FREE");assert.equal((await call("GET","/api/unassigned-trials")).response.status,403);token=ownerToken;assert.equal((await call("DELETE",`/api/clients/${managerOnlyClient.id}`,{confirmation:"УДАЛИТЬ"})).response.status,200);token=closerToken;
  token=ownerToken;result=await call("POST","/api/admin/roles",{name:"Админ - Клоузеров",baseRole:"ADMIN",permissions:{"clients.view":true,"clients.changeStatus":true,"crm.view":true,"crm.changeStatus":true,"payments.view":true,"payments.create":false},scopes:{clients:"ALL",payments:"ALL"}});assert.equal(result.response.status,201);const closerAdminRole=result.body;
  result=await call("POST","/api/admin/users",{name:"Админ - Клоузеров QA",login:"closer-admin-json@milton.test",password:"demo123",roleId:closerAdminRole.id});assert.equal(result.response.status,201);
  result=await call("POST","/api/clients",{name:"Payment permission JSON",phone:"+77015554992",managerId:"usr_manager",statusId:"st_scheduled",assignmentMode:"LATER",trialType:"FREE"});assert.equal(result.response.status,201);const permissionClientId=result.body.id,permissionTrial=result.body.activeTrial;result=await call("POST",`/api/trials/${permissionTrial.id}/assign`,{slotId:managerFree.id,version:permissionTrial.assignmentVersion});assert.equal(result.response.status,200);
  token="";result=await call("POST","/api/login",{login:"closer-admin-json@milton.test",password:"demo123"});assert.equal(result.response.status,200);const closerAdminToken=result.body.token;token=closerAdminToken;
  const permissionPayment={statusId:"st_payment",amount:25000,paymentMethodId:"method_1",paymentDate:"2026-09-14"};result=await call("POST",`/api/clients/${permissionClientId}/status`,permissionPayment);assert.equal(result.response.status,403);assert.equal(result.body.details.missingPermission,"payments.create");assert.match(result.body.error,/Оплаты → Создание оплаты.*payments\.create/);
  token=ownerToken;result=await call("GET",`/api/clients/${permissionClientId}`);assert.equal(result.body.payments.length,0);result=await call("PUT",`/api/admin/roles/${closerAdminRole.id}`,{permissions:{"payments.create":true}});assert.equal(result.response.status,200);
  token=closerAdminToken;result=await call("POST",`/api/clients/${permissionClientId}/status`,permissionPayment);assert.equal(result.response.status,200);token=ownerToken;result=await call("GET",`/api/clients/${permissionClientId}`);assert.equal(result.body.payments.length,1);assert.equal(result.body.client.currentStatusId,"st_payment");assert.equal((await call("DELETE",`/api/clients/${permissionClientId}`,{confirmation:"УДАЛИТЬ"})).response.status,200);token=closerToken;

  result = await call("POST", `/api/clients/${clientId}/status`, { statusId:"st_payment", amount:50000, paymentMethodId:"method_1", paymentDate:"2026-09-02" });
  assert.equal(result.response.status, 200);
  const managerChange=await Promise.race([managerReader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Manager realtime timeout")),1500))]);assert.match(new TextDecoder().decode(managerChange.value),/payments|clients/);managerAbort.abort();token=managerToken;const managerDrawer=await call("GET",`/api/clients/${clientId}`);assert.equal(managerDrawer.body.client.currentStatusId,"st_payment");assert.equal(managerDrawer.body.payments.length,1);token=ownerToken;
  const occupied=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===slot.id);assert.equal(occupied.status,"OCCUPIED");assert.equal(occupied.events[0].crmStatus.id,"st_payment");assert.equal(occupied.events[0].crmStatus.color,"#087F5B");
  assert.equal((await call("DELETE",`/api/slots/${slot.id}`)).response.status,409);

  result = await call("GET", `/api/clients/${clientId}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.notes.length, 1);
  assert.equal(result.body.payments.length, 1);
  const paymentId=result.body.payments[0].id;

  result = await call("POST", `/api/payments/${paymentId}/correct`, { amount:51000, paymentMethodId:"method_1", paymentDate:"2026-09-02", reason:"API test" });
  assert.equal(result.response.status, 201);
  result=await call("POST","/api/admin/config/statuses",{name:"Предоплата API test",color:"#d99014",actionType:"NONE",partialPayment:true,sortOrder:90});assert.equal(result.response.status,201);const prepaymentStatus=result.body;assert.equal(prepaymentStatus.partialPayment,true);
  const createdAtBeforePrepayment=(await call("GET",`/api/clients/${clientId}`)).body.client.createdAt;
  result=await call("POST",`/api/clients/${clientId}/status`,{statusId:prepaymentStatus.id,amount:20000,totalDealAmount:80000,remainingPaymentDueDate:"2026-09-01",paymentMethodId:"method_1",paymentDate:"2026-09-02",paymentComment:"Предоплата API"});assert.equal(result.response.status,200);assert.equal(result.body.prepayment.paymentTotal,71000);assert.equal(result.body.prepayment.remainingAmount,9000);assert.equal(result.body.prepayment.active,true);assert.equal(result.body.createdAt,createdAtBeforePrepayment);const statusChangedAt=result.body.statusChangedAt;
  result=await call("GET","/api/bootstrap");assert.ok(result.body.notifications.some(item=>item.clientId===clientId&&item.type==="PREPAYMENT_BALANCE_DUE"&&!item.resolvedAt));
  await new Promise(resolve=>setTimeout(resolve,5));result=await call("POST",`/api/clients/${clientId}/notes`,{text:"Timestamp API test"});assert.equal(result.response.status,201);result=await call("GET",`/api/clients/${clientId}`);assert.equal(result.body.client.statusChangedAt,statusChangedAt);assert.notEqual(result.body.client.updatedAt,statusChangedAt);
  result=await call("POST",`/api/clients/${clientId}/status`,{statusId:prepaymentStatus.id,amount:9000,totalDealAmount:80000,remainingPaymentDueDate:"2026-09-01",paymentMethodId:"method_1",paymentDate:"2026-09-02"});assert.equal(result.response.status,200);assert.equal(result.body.prepayment.remainingAmount,0);assert.equal(result.body.prepayment.active,false);assert.equal(result.body.statusChangedAt,statusChangedAt);
  result=await call("GET","/api/bootstrap");assert.ok(result.body.notifications.some(item=>item.clientId===clientId&&item.type==="PREPAYMENT_BALANCE_DUE"&&item.resolvedAt));
  result=await call("GET",`/api/clients/${clientId}`);const accidentalPayment=result.body.payments.find(payment=>Number(payment.amount)===9000);assert.ok(accidentalPayment);
  token=closerAdminToken;result=await call("DELETE",`/api/payments/${accidentalPayment.id}`,{confirmed:true});assert.equal(result.response.status,403);token=ownerToken;
  result=await call("DELETE",`/api/payments/${accidentalPayment.id}`,{confirmed:true});assert.equal(result.response.status,200);assert.equal(result.body.deleted,true);
  result=await call("GET",`/api/clients/${clientId}`);assert.equal(result.body.client.prepayment.remainingAmount,9000);assert.ok(result.body.payments.some(payment=>payment.id===accidentalPayment.id&&payment.voidedAt));assert.ok(result.body.history.some(entry=>entry.eventType==="PAYMENT_DELETED"&&entry.oldValue.id===accidentalPayment.id));
  result=await call("POST","/api/admin/config/tags",{name:"Временный тег для удаления",color:"#abcdef",sortOrder:99});assert.equal(result.response.status,201);const removableTag=result.body;result=await call("DELETE",`/api/admin/config/tags/${removableTag.id}`,{confirmed:false});assert.equal(result.response.status,200);assert.equal(result.body.deleted,true);
  result = await call("POST", `/api/clients/${clientId}/archive`, { reason:"TEST" });
  assert.equal(result.response.status, 200);
  result = await call("POST", `/api/clients/${clientId}/restore`, {});
  assert.equal(result.response.status, 200);

  const logoDataUrl="data:image/png;base64,iVBORw0KGgo=";result = await call("PUT", "/api/admin/branding", { companyName:"Milton", accentColor:"#3157D5", logoUrl:logoDataUrl });assert.equal(result.response.status, 200);assert.match(result.body.logoUrl,/^\/api\/branding\/logo\?v=/);const logoResponse=await fetch(`${base}${result.body.logoUrl}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(logoResponse.status,200);assert.equal(logoResponse.headers.get("content-type"),"image/png");const logoEtag=logoResponse.headers.get("etag");await logoResponse.arrayBuffer();assert.equal((await fetch(`${base}${result.body.logoUrl}`,{headers:{Authorization:`Bearer ${token}`,"If-None-Match":logoEtag}})).status,304);result=await call("PUT","/api/admin/branding",{companyName:"Milton",accentColor:"#3157D5",logoUrl:""});assert.equal(result.response.status,200);
  const avatarDataUrl="data:image/jpeg;base64,/9j/2Q==";result=await call("PUT","/api/profile",{avatarUrl:avatarDataUrl});assert.equal(result.response.status,200);const optimizedBootstrap=await call("GET","/api/bootstrap"),avatarUrl=optimizedBootstrap.body.me.avatarUrl;assert.match(avatarUrl,/^\/api\/users\/usr_admin\/avatar\?v=/);assert.equal(JSON.stringify(optimizedBootstrap.body).includes("data:image"),false);const avatarResponse=await fetch(`${base}${avatarUrl}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(avatarResponse.status,200);assert.equal(avatarResponse.headers.get("content-type"),"image/jpeg");assert.equal((await avatarResponse.arrayBuffer()).byteLength,4);
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
  const newSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.status==="FREE");result=await call("POST",`/api/clients/${paidClientId}/status`,{statusId:"st_reschedule",rescheduleMode:"NOW",refusalReasonId:"reason_2",newSlotId:newSlot.id});assert.equal(result.response.status,200);const rescheduledTrialId=result.body.activeTrial.id,oldAfter=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===paidSlot.id);assert.equal(oldAfter.status,"FREE");assert.equal(oldAfter.events[0].crmStatus.id,"st_reschedule");assert.equal(oldAfter.events[0].rescheduledTo.trialId,rescheduledTrialId);const newAfter=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===newSlot.id);assert.equal(newAfter.status,"BOOKED");assert.equal(newAfter.bookedTrialId,rescheduledTrialId);
  result=await call("POST",`/api/clients/${paidClientId}/status`,{statusId:"st_no_show"});assert.equal(result.response.status,200);const noShowSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===newSlot.id);assert.equal(noShowSlot.status,"OCCUPIED");assert.equal(noShowSlot.events[0].crmStatus.id,"st_no_show");
  assert.equal((await call("DELETE",`/api/clients/${paidClientId}`,{confirmation:"УДАЛИТЬ"})).response.status,200);
  const raceSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.status==="FREE"),race=await Promise.all([call("POST","/api/clients",{name:"Race A",phone:"+77015554461",managerId:"usr_manager",closerId:"usr_closer",slotId:raceSlot.id,statusId:"st_scheduled",trialType:"FREE"}),call("POST","/api/clients",{name:"Race B",phone:"+77015554462",managerId:"usr_manager",closerId:"usr_closer",slotId:raceSlot.id,statusId:"st_scheduled",trialType:"FREE"})]);assert.deepEqual(race.map((item)=>item.response.status).sort(),[201,409]);const raceWinner=race.find((item)=>item.response.status===201).body;assert.equal((await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===raceSlot.id).events.filter((item)=>item.active).length,1);result=await call("POST",`/api/clients/${raceWinner.id}/status`,{statusId:"st_refusal",refusalReasonId:"reason_1"});assert.equal(result.response.status,200);const refusedSlot=(await call("GET","/api/slots?closerId=usr_closer")).body.find((item)=>item.id===raceSlot.id);assert.equal(refusedSlot.status,"OCCUPIED");assert.equal(refusedSlot.events[0].crmStatus.id,"st_refusal");await call("DELETE",`/api/clients/${raceWinner.id}`,{confirmation:"УДАЛИТЬ"});

  token=closerToken;result=await call("POST","/api/slots/generate",{closerId:"usr_closer",date:"2031-01-15",start:"10:00",end:"14:00",durationMinutes:40});assert.equal(result.response.status,201);assert.equal(result.body.created,6);
  let managedSlots=(await call("GET","/api/slots?closerId=usr_closer&date=2031-01-15")).body;assert.equal(managedSlots.length,6);assert.equal(new Date(managedSlots[0].endAt)-new Date(managedSlots[0].startAt),40*60*1000);
  result=await call("POST","/api/slots/generate",{closerId:"usr_closer",date:"2031-01-15",start:"10:20",end:"11:00",durationMinutes:40});assert.equal(result.response.status,201);assert.equal(result.body.created,0);
  result=await call("PUT",`/api/slots/${managedSlots[0].id}`,{date:"2031-01-15",time:"14:00",durationMinutes:35});assert.equal(result.response.status,200);assert.equal(new Date(result.body.endAt)-new Date(result.body.startAt),35*60*1000);
  const deleteEventsAbort=new AbortController(),deleteEventsResponse=await fetch(`${base}/api/events`,{headers:{Authorization:`Bearer ${managerToken}`},signal:deleteEventsAbort.signal}),deleteEventsReader=deleteEventsResponse.body.getReader();await deleteEventsReader.read();
  result=await call("DELETE",`/api/slots/${managedSlots[1].id}`);assert.equal(result.response.status,200);assert.equal(result.body.deleted,true);const deleteRealtime=await Promise.race([deleteEventsReader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Slot delete realtime timeout")),1500))]);assert.match(new TextDecoder().decode(deleteRealtime.value),/schedule/);deleteEventsAbort.abort();
  assert.equal((await call("POST","/api/slots/generate",{closerId:"usr_closer",date:"2031-01-16",start:"10:00",end:"11:00",durationMinutes:181})).response.status,422);
});
