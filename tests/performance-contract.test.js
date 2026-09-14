"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");

const directory=fs.mkdtempSync(path.join(os.tmpdir(),"milton-performance-"));
process.env.STORAGE_BACKEND="json";
process.env.JSON_DB_FILE=path.join(directory,"db.json");
process.env.UPLOAD_DIR=path.join(directory,"uploads");
const {startServer,server,closeStorage,seedDatabase,setDbForTests}=require("../server");

test("bootstrap stays compact and responsive with repeated profile images",async(t)=>{
  const data=seedDatabase(),avatar=`data:image/jpeg;base64,${Buffer.alloc(150_000,7).toString("base64")}`;
  data.users.forEach((user)=>{user.avatarUrl=avatar;});
  const templates=data.clients.slice();
  data.clients=Array.from({length:500},(_,index)=>({...templates[index%templates.length],id:`perf_client_${index}`,normalizedPhone:`+77${String(index).padStart(9,"0")}`,originalPhone:`+77${String(index).padStart(9,"0")}`,createdAt:new Date(Date.now()-index*1000).toISOString()}));
  data.trials=[];data.payments=[];data.notes=[];data.history=[];data.notifications=[];data.availabilitySlots=[];
  setDbForTests(data);
  await startServer(0);
  t.after(async()=>{if(server.listening)await new Promise((resolve)=>server.close(resolve));await closeStorage();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(`${base}/api/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:"admin@milton.kz",password:"demo123"})});
  const {token}=await login.json(),headers={Authorization:`Bearer ${token}`};
  const started=performance.now(),response=await fetch(`${base}/api/bootstrap`,{headers:{...headers,"Accept-Encoding":"identity"}}),text=await response.text(),duration=performance.now()-started;
  t.diagnostic(`500 clients: ${Buffer.byteLength(text)} bytes, ${duration.toFixed(1)}ms`);
  assert.equal(response.status,200);assert.equal(text.includes("data:image"),false);assert.ok(Buffer.byteLength(text)<1_500_000,`bootstrap is ${Buffer.byteLength(text)} bytes`);assert.ok(duration<2_000,`bootstrap took ${duration.toFixed(1)}ms`);
  const partialStarted=performance.now(),partial=await fetch(`${base}/api/sync?resources=notifications`,{headers:{...headers,"Accept-Encoding":"identity"}}),partialText=await partial.text();
  assert.equal(partial.status,200);assert.ok(Buffer.byteLength(partialText)<10_000);assert.ok(performance.now()-partialStarted<500);
  const burst=await Promise.all(Array.from({length:20},async()=>{const value=await fetch(`${base}/api/bootstrap`,{headers});await value.arrayBuffer();return value.status;}));
  assert.deepEqual(new Set(burst),new Set([200]));
});
