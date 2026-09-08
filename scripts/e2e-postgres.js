"use strict";

const crypto=require("node:crypto");
const {Pool}=require("pg");
const {storageConfig}=require("../storage/config");

const runId=String(Date.now()).slice(-8),marker=`E2E-${runId}`,password=`E2e-${runId}!`;
const logins={manager:`e2e.${runId}.manager@milton.local`,closer:`e2e.${runId}.closer@milton.local`};
const tokens=[],clientIds=[],userIds=[],paymentIds=[];
let app,base="",serverStarted=false;
const result={runId,checks:[],analytics:null,restartPersistence:false,cleanup:null};
const check=(name,condition,details)=>{if(!condition)throw new Error(`${name}${details?`: ${details}`:""}`);result.checks.push(name);};
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Almaty"}).format(new Date());

async function request(token,method,pathname,payload,expected=200){
  const response=await fetch(`${base}${pathname}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(payload===undefined?{}:{"Content-Type":"application/json"})},body:payload===undefined?undefined:JSON.stringify(payload)});
  const type=response.headers.get("content-type")||"",body=type.includes("application/json")?await response.json():await response.text();
  if(response.status!==expected)throw new Error(`${method} ${pathname}: expected ${expected}, received ${response.status} ${JSON.stringify(body)}`);
  return body;
}
async function login(login,passwordValue){const body=await request("","POST","/api/login",{login,password:passwordValue});tokens.push(body.token);return body.token;}
async function listen(){await app.startServer(0);serverStarted=true;base=`http://127.0.0.1:${app.server.address().port}`;}
async function stop(){if(serverStarted&&app.server.listening)await new Promise((resolve)=>app.server.close(resolve));serverStarted=false;}

async function cleanup(){
  await stop().catch(()=>{});
  const config=storageConfig(),pool=new Pool({connectionString:config.databaseUrl,ssl:config.ssl?{rejectUnauthorized:false}:false,connectionTimeoutMillis:10000});const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const owner=(await client.query("SELECT id FROM public.users WHERE is_owner AND active")).rows[0];
    if(owner){const clients=await client.query("SELECT id FROM public.clients WHERE registration_comment=$1",[marker]);for(const row of clients.rows)await client.query("SELECT public.permanently_delete_client($1,$2,'УДАЛИТЬ')",[row.id,owner.id]);}
    const tempUsers=await client.query("SELECT id FROM public.users WHERE login=ANY($1::text[])",[Object.values(logins)]),tempUserIds=tempUsers.rows.map(row=>row.id);
    if(tempUserIds.length){await client.query("DELETE FROM public.notifications WHERE user_id=ANY($1::text[])",[tempUserIds]);await client.query("DELETE FROM public.availability_slots WHERE closer_id=ANY($1::text[])",[tempUserIds]);await client.query("DELETE FROM public.saved_filters WHERE user_id=ANY($1::text[])",[tempUserIds]);await client.query("DELETE FROM public.sessions WHERE user_id=ANY($1::text[])",[tempUserIds]);await client.query("DELETE FROM public.users WHERE id=ANY($1::text[])",[tempUserIds]);}
    const tokenHashes=tokens.map(token=>crypto.createHash("sha256").update(token).digest("hex"));if(tokenHashes.length)await client.query("DELETE FROM public.sessions WHERE token_hash=ANY($1::text[])",[tokenHashes]);
    const entityIds=[...new Set([...clientIds,...userIds,...paymentIds])];
    if(entityIds.length)await client.query("DELETE FROM public.audit_logs WHERE entity_id=ANY($1::text[])",[entityIds]);
    if(tempUserIds.length)await client.query("DELETE FROM public.audit_logs WHERE actor_user_id=ANY($1::text[])",[tempUserIds]);
    await client.query("DELETE FROM public.audit_logs WHERE new_value::text LIKE $1",[`%${marker}%`]);
    await client.query("COMMIT");
    const counts=(await client.query("SELECT (SELECT count(*)::int FROM public.clients) clients,(SELECT count(*)::int FROM public.trials) trials,(SELECT count(*)::int FROM public.payments) payments,(SELECT count(*)::int FROM public.availability_slots) slots,(SELECT count(*)::int FROM public.users WHERE NOT is_owner) employees,(SELECT count(*)::int FROM public.users WHERE is_owner) owners")).rows[0];
    result.cleanup=counts;
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();await pool.end();}
}

async function main(){
  process.env.STORAGE_BACKEND="postgres";
  app=require("../server");check("PostgreSQL backend selected",app.storageBackend==="postgres");await listen();
  try{
    const ownerToken=await login("admin@milton.kz","demo123");check("Owner login",Boolean(ownerToken));
    const bootstrap=await request(ownerToken,"GET","/api/bootstrap");check("Owner privilege",bootstrap.me.isOwner===true);check("Seeded roles available",bootstrap.roles.length===3);
    const manager=await request(ownerToken,"POST","/api/admin/users",{name:`${marker} Manager`,login:logins.manager,password,roleId:"role_manager",active:true},201);userIds.push(manager.id);
    const closer=await request(ownerToken,"POST","/api/admin/users",{name:`${marker} Closer`,login:logins.closer,password,roleId:"role_closer",active:true},201);userIds.push(closer.id);check("Manager and Closer created",Boolean(manager.id&&closer.id));

    const closerToken=await login(logins.closer,password);check("Closer login",Boolean(closerToken));
    const date=today();await request(closerToken,"POST","/api/slots/generate",{date,start:"09:00",end:"15:00",interval:60},201);
    const slots=await request(closerToken,"GET",`/api/slots?closerId=${closer.id}&date=${date}`);check("Closer availability created",slots.filter(row=>row.status==="FREE").length>=4);

    const managerToken=await login(logins.manager,password);check("Manager login",Boolean(managerToken));
    const free=slots.filter(row=>row.status==="FREE");let phoneBase=Number(runId)%9000000+1000000;
    const createClient=async(name,slot,index)=>{const body=await request(managerToken,"POST","/api/clients",{name:`${marker} ${name}`,phone:`+7700${String(phoneBase+index).padStart(7,"0")}`,closerId:closer.id,slotId:slot.id,statusId:"st_scheduled",leadSourceId:"src_1",tagIds:["tag_1"],comment:marker},201);clientIds.push(body.id);return body;};
    const primary=await createClient("Payment",free[0],0);check("Client created and trial booked",Boolean(primary.activeTrial?.id));
    const closerView=await request(closerToken,"GET","/api/bootstrap");check("Closer sees Manager client",closerView.clients.some(row=>row.id===primary.id));
    await request(managerToken,"POST",`/api/clients/${primary.id}/status`,{statusId:"st_reschedule",newSlotId:free[1].id});check("Trial rescheduled",true);
    await request(managerToken,"POST",`/api/clients/${primary.id}/notes`,{text:`${marker} manager note`},201);

    const refusal=await createClient("Refusal",free[2],1);await request(closerToken,"POST",`/api/clients/${refusal.id}/status`,{statusId:"st_refusal",refusalReasonId:"reason_1"});check("Refusal reason recorded",true);
    const noShow=await createClient("NoShow",free[3],2);await request(managerToken,"POST",`/api/clients/${noShow.id}/status`,{statusId:"st_no_show"});check("No-show recorded",true);

    await request(closerToken,"POST",`/api/clients/${primary.id}/status`,{statusId:"st_payment",amount:60000,paymentMethodId:"method_1",paymentDate:date,paymentComment:marker});
    const managerDrawer=await request(managerToken,"GET",`/api/clients/${primary.id}`);check("Manager sees payment",managerDrawer.payments.length===1);paymentIds.push(managerDrawer.payments[0].id);check("Notes and timeline persisted",managerDrawer.notes.some(row=>row.text.includes(marker))&&managerDrawer.history.length>=5);

    await request(managerToken,"POST",`/api/clients/${primary.id}/archive`,{reason:"TEST"},403);check("Archive permission enforced",true);
    await request(closerToken,"POST","/api/admin/users",{name:"Forbidden"},403);check("Admin endpoint permission enforced",true);

    const analytics=await request(ownerToken,"GET",`/api/analytics?from=${date}&to=${date}`);result.analytics={trials:analytics.kpis.trials,payments:analytics.kpis.payments,conversion:analytics.kpis.conversion,revenue:analytics.kpis.revenue,average:analytics.kpis.average,attendance:analytics.attendance};
    check("Analytics trial count",analytics.kpis.trials===4,JSON.stringify(result.analytics));check("Analytics payment count",analytics.kpis.payments===1);check("Analytics conversion",Math.abs(analytics.kpis.conversion-100/3)<0.01);check("Analytics revenue",Number(analytics.kpis.revenue)===60000);check("Analytics average check",Number(analytics.kpis.average)===60000);
    check("Attendance analytics",analytics.attendance.scheduled===4&&analytics.attendance.rescheduled===1&&analytics.attendance.noShow===1&&analytics.attendance.reached===2&&Math.abs(analytics.attendance.attendance-50)<0.01,JSON.stringify(analytics.attendance));
    check("Refusal analytics",analytics.refusals.some(row=>row.id==="reason_1"&&row.count===1));

    await request(ownerToken,"POST",`/api/clients/${primary.id}/archive`,{reason:"TEST"});const archived=await request(ownerToken,"GET","/api/bootstrap");check("Archive visible",archived.archivedClients.some(row=>row.id===primary.id));
    await request(ownerToken,"POST",`/api/clients/${primary.id}/restore`,{});check("Client restored",(await request(ownerToken,"GET",`/api/clients/${primary.id}`)).client.archivedAt===null);

    await stop();await listen();const afterRestart=await request(ownerToken,"GET","/api/bootstrap");check("Session persisted across restart",afterRestart.me.id==="usr_admin");check("PostgreSQL data persisted across restart",afterRestart.clients.some(row=>row.id===primary.id));result.restartPersistence=true;

    for(const id of clientIds)await request(ownerToken,"DELETE",`/api/clients/${id}`,{confirmation:"УДАЛИТЬ"});
    await request(ownerToken,"DELETE",`/api/admin/users/${manager.id}`,{confirmed:true});await request(ownerToken,"DELETE",`/api/admin/users/${closer.id}`,{confirmed:true});check("Temporary API records deleted",true);
  }finally{await cleanup();await app.closeStorage().catch(()=>{});}
  check("Cleanup preserved only Owner",result.cleanup.clients===0&&result.cleanup.trials===0&&result.cleanup.payments===0&&result.cleanup.slots===0&&result.cleanup.employees===0&&result.cleanup.owners===1,JSON.stringify(result.cleanup));
  console.log(JSON.stringify(result,null,2));
}

main().catch(async(error)=>{console.error(error.stack||error.message);try{if(app)await cleanup();}catch(cleanupError){console.error(`Cleanup failed: ${cleanupError.message}`);}process.exitCode=1;});
