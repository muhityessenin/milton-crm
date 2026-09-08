"use strict";

const assert=require("node:assert/strict");
const base=process.env.MILTON_BASE_URL||"http://127.0.0.1:4173";
async function call(token,path,{method="GET",body}={}){const response=await fetch(base+path,{method,headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)}),type=response.headers.get("content-type")||"",value=type.includes("json")?await response.json():await response.text();if(!response.ok){const error=new Error(value.error||String(value));error.status=response.status;error.value=value;throw error}return value}
async function expectStatus(status,fn,message){try{await fn();assert.fail(message||`Expected HTTP ${status}`)}catch(error){assert.equal(error.status,status,error.message);return error}}
async function login(login,password="demo123"){return (await call("","/api/login",{method:"POST",body:{login,password}})).token}

(async()=>{
  const stamp=String(Date.now()).slice(-7),password="qaPass123",ownerToken=await login("admin@milton.kz"),initial=await call(ownerToken,"/api/bootstrap"),managerRole=initial.roles.find(r=>r.systemKey==="MANAGER"),closerRole=initial.roles.find(r=>r.systemKey==="CLOSER"),adminRole=initial.roles.find(r=>r.systemKey==="ADMIN");
  assert.equal(initial.me.isOwner,true);
  const managerLogin=`archive.manager.${stamp}@milton.kz`,closerLogin=`archive.closer.${stamp}@milton.kz`,adminLogin=`archive.admin.${stamp}@milton.kz`;
  const manager=await call(ownerToken,"/api/admin/users",{method:"POST",body:{name:`Archive Manager ${stamp}`,login:managerLogin,password,roleId:managerRole.id}}),closer=await call(ownerToken,"/api/admin/users",{method:"POST",body:{name:`Archive Closer ${stamp}`,login:closerLogin,password,roleId:closerRole.id}}),normalAdmin=await call(ownerToken,"/api/admin/users",{method:"POST",body:{name:`Normal Admin ${stamp}`,login:adminLogin,password,roleId:adminRole.id}});
  assert.equal(normalAdmin.isOwner,false);
  const managerToken=await login(managerLogin,password),closerToken=await login(closerLogin,password),adminToken=await login(adminLogin,password);
  assert.equal((await call(managerToken,"/api/bootstrap")).access.permissions["clients.archive"],false);
  assert.equal((await call(adminToken,"/api/bootstrap")).me.isOwner,false);

  const date="2026-09-01";
  await call(closerToken,"/api/slots/generate",{method:"POST",body:{closerId:closer.id,date,start:"14:00",end:"17:00",interval:60}});
  let slots=await call(managerToken,`/api/slots?closerId=${closer.id}&date=${date}`),slot=slots.find(s=>s.status==="FREE");
  const phone=`+7744${stamp}`,client=await call(managerToken,"/api/clients",{method:"POST",body:{name:`Archive Client ${stamp}`,phone,closerId:closer.id,slotId:slot.id,leadSourceId:"src_1",comment:"Archive lifecycle QA"}});
  await call(closerToken,`/api/clients/${client.id}/notes`,{method:"POST",body:{text:"Preserve this note through archive"}});
  await call(closerToken,`/api/clients/${client.id}/status`,{method:"POST",body:{statusId:"st_payment",amount:41000,paymentMethodId:"method_1",paymentDate:date}});

  await expectStatus(403,()=>call(managerToken,`/api/clients/${client.id}/archive`,{method:"POST",body:{reason:"TEST"}}),"archive must be denied without permission");
  await call(ownerToken,`/api/admin/users/${manager.id}`,{method:"PUT",body:{permissionOverrides:{"clients.archive":true}}});
  assert.equal((await call(managerToken,"/api/bootstrap")).access.permissions["clients.archive"],true);
  await expectStatus(422,()=>call(managerToken,`/api/clients/${client.id}/archive`,{method:"POST",body:{}}),"reason is required");
  const archived=await call(managerToken,`/api/clients/${client.id}/archive`,{method:"POST",body:{reason:"TEST"}});
  assert.equal(archived.archiveReason,"TEST");assert.equal(archived.archivedByUserId,manager.id);assert.ok(archived.archivedAt);
  const archivedBoot=await call(managerToken,"/api/bootstrap");
  assert.equal(archivedBoot.clients.some(c=>c.id===client.id),false);assert.equal(archivedBoot.archivedClients.some(c=>c.id===client.id),true);
  const archivedCard=await call(managerToken,`/api/clients/${client.id}`);
  assert.equal(archivedCard.payments.filter(p=>!p.voidedAt).length,1);assert.equal(archivedCard.notes.length,1);assert.ok(archivedCard.trials.length);assert.ok(archivedCard.history.some(h=>h.eventType==="CLIENT_ARCHIVED"&&h.newValue.reasonLabel==="Тест"));
  const operational=await call(ownerToken,`/api/analytics?from=${date}&to=${date}&managerId=${manager.id}`),historical=await call(ownerToken,`/api/analytics?from=${date}&to=${date}&managerId=${manager.id}&includeArchived=true`);
  assert.equal(operational.kpis.revenue,0);assert.equal(historical.kpis.revenue,41000);assert.equal(historical.kpis.trials,1);
  slots=await call(managerToken,`/api/slots?closerId=${closer.id}&date=${date}`);slot=slots.find(s=>s.status==="FREE");
  const duplicate=await expectStatus(409,()=>call(managerToken,"/api/clients",{method:"POST",body:{name:"Should not duplicate",phone,closerId:closer.id,slotId:slot.id}}));
  assert.equal(duplicate.value.error,"Клиент с таким номером находится в архиве");assert.equal(duplicate.value.clientId,client.id);assert.equal(duplicate.value.canRestore,true);

  await call(managerToken,`/api/clients/${client.id}/restore`,{method:"POST"});
  const restored=await call(managerToken,`/api/clients/${client.id}`);assert.equal(restored.client.archivedAt,null);assert.equal(restored.payments.filter(p=>!p.voidedAt).length,1);assert.ok(restored.history.some(h=>h.eventType==="CLIENT_RESTORED"));
  await expectStatus(403,()=>call(adminToken,`/api/clients/${client.id}`,{method:"DELETE",body:{confirmation:"УДАЛИТЬ"}}),"normal admin must not permanently delete");
  await expectStatus(403,()=>call(adminToken,`/api/admin/users/${initial.me.id}`,{method:"PUT",body:{name:"Hijacked owner"}}),"normal admin must not edit owner");
  await expectStatus(403,()=>call(adminToken,`/api/admin/users/${initial.me.id}/archive`,{method:"POST"}),"owner must not be archivable");

  await call(managerToken,`/api/clients/${client.id}/archive`,{method:"POST",body:{reason:"DUPLICATE"}});
  await expectStatus(422,()=>call(ownerToken,`/api/clients/${client.id}`,{method:"DELETE",body:{confirmation:"delete"}}),"strong confirmation is required");
  const deleted=await call(ownerToken,`/api/clients/${client.id}`,{method:"DELETE",body:{confirmation:"УДАЛИТЬ"}});assert.equal(deleted.hardDeleted,true);assert.equal(deleted.financialRecordsPreserved,false);assert.equal(deleted.relatedRecordsRemoved.payments,1);assert.equal(deleted.relatedRecordsRemoved.trials,1);
  await expectStatus(404,()=>call(ownerToken,`/api/clients/${client.id}`),"deleted client card must not be recoverable");
  const retained=await call(ownerToken,`/api/analytics?from=${date}&to=${date}&managerId=${manager.id}&includeArchived=true`);assert.equal(retained.kpis.revenue,0);assert.equal(retained.kpis.trials,0);
  const audit=await call(ownerToken,"/api/audit");assert.equal(audit.some(row=>row.entityId===client.id&&row.action==="CLIENT_ARCHIVED"),false);assert.equal(audit.some(row=>row.entityId===client.id&&row.action==="CLIENT_RESTORED"),false);assert.ok(audit.some(row=>row.entityId===client.id&&row.action==="CLIENT_PERMANENTLY_DELETED"&&row.newValue.hardDeleted));
  for(const account of [manager,closer,normalAdmin])await call(ownerToken,`/api/admin/users/${account.id}/archive`,{method:"POST"});
  console.log(JSON.stringify({ok:true,clientId:client.id,archivePermissionDenied:true,archivePermissionGranted:true,archiveReasonRequired:true,historyPreserved:true,duplicateBlocked:true,restored:true,normalAdminDeleteDenied:true,ownerProtected:true,ownerDeleteConfirmed:true,financialHistoryRemoved:true,qaUsersArchived:true},null,2));
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
