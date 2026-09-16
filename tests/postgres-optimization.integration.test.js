"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {storageConfig}=require("../storage/config");
const {PostgresStorage}=require("../storage/postgres/storage");

const enabled=process.env.RUN_POSTGRES_TESTS==="1";

test("compact PostgreSQL snapshots keep media and audit lazy without breaking trial reassignment",{skip:!enabled},async()=>{
  const storage=PostgresStorage.connect(storageConfig().databaseUrl,{max:2});
  const rollback=new Error("ROLLBACK_POSTGRES_OPTIMIZATION_TEST");
  try{
    await storage.assertSchema();
    await assert.rejects(storage.transaction(async(tx)=>{
      const avatar="data:image/png;base64,aW1hZ2U=",logo="data:image/png;base64,bG9nbw==";
      await tx.db.query("INSERT INTO roles(id,name,base_role,is_system) VALUES('opt_manager_role','Optimization Manager Role','MANAGER',false),('opt_closer_role','Optimization Closer Role','CLOSER',false)");
      await tx.db.query("INSERT INTO users(id,name,login,password_hash,role_id,business_role,avatar_url) VALUES('opt_manager','Optimization Manager','opt-manager@example.invalid','hash','opt_manager_role','MANAGER',$1),('opt_closer','Optimization Closer','opt-closer@example.invalid','hash','opt_closer_role','CLOSER','')",[avatar]);
      await tx.db.query("INSERT INTO statuses(id,name,color,action_type,required_fields) VALUES('opt_status','Optimization Status','#3157D5','NONE','{}')");
      await tx.clients.create({id:"opt_client",name:"Optimization Client",normalizedPhone:"+77000000998",originalPhone:"+77000000998",originalManagerId:"opt_manager",currentManagerId:"opt_manager",currentCloserId:"opt_closer",currentStatusId:"opt_status"});
      await tx.availabilitySlots.create({id:"opt_slot",closerId:"opt_closer",startAt:"2033-01-01T10:00:00Z",endAt:"2033-01-01T11:00:00Z"});
      await tx.trials.create({id:"opt_trial",clientId:"opt_client",managerId:"opt_manager",closerId:"opt_closer",slotId:"opt_slot",scheduledAt:"2033-01-01T10:00:00Z",statusAtBookingId:"opt_status",registeredByUserId:"opt_manager"});
      await tx.auditLogs.append({id:"opt_audit",actorUserId:"opt_manager",entityType:"CLIENT",entityId:"opt_client",action:"OPTIMIZATION_TEST",oldValue:null,newValue:{ok:true}});
      await tx.db.query("UPDATE app_settings SET logo_url=$1 WHERE id='global'",[logo]);

      const compact=await tx.state.load({includeAuditLogs:false,includeMedia:false});
      assert.equal(compact.users.find((row)=>row.id==="opt_manager").avatarUrl,"__stored__");
      assert.equal(compact.meta.branding.logoUrl,"__stored__");
      assert.equal(compact.auditLogs.some((row)=>row.id==="opt_audit"),false);

      const complete=await tx.state.load();
      assert.equal(complete.users.find((row)=>row.id==="opt_manager").avatarUrl,avatar);
      assert.equal(complete.meta.branding.logoUrl,logo);
      assert.equal(complete.auditLogs.some((row)=>row.id==="opt_audit"),true);

      const finished=await tx.trials.finish("opt_trial",{attendanceOutcome:"RESCHEDULED"});
      assert.equal(finished.active,false);
      assert.equal(finished.attendanceOutcome,"RESCHEDULED");
      assert.equal(finished.resultStatusId,null);
      throw rollback;
    }),error=>error===rollback);
  }finally{await storage.close();}
});
