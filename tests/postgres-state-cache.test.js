"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PostgresStorage } = require("../storage/postgres/storage");
const { PostgresStateRepository } = require("../storage/postgres/state-repository");

test("PostgreSQL read model cache coalesces concurrent reads and invalidates explicitly", async () => {
  const storage = new PostgresStorage({
    pool: null,
    db: {},
    ownsPool: false,
    stateCacheTtlMillis: 1_000,
  });
  let loads = 0;
  storage.state = {
    async load() {
      loads += 1;
      return { clients: [{ id: "client-1" }] };
    },
  };

  const read = () => storage.runState(async (state) => ({ clients: state.clients.length }), { readOnly: true });
  const burst = await Promise.all(Array.from({ length: 50 }, read));
  assert.equal(burst.length, 50);
  assert.ok(burst.every((result) => result.clients === 1));
  assert.equal(loads, 1);

  storage.invalidateStateCache();
  assert.deepEqual(await read(), { clients: 1 });
  assert.equal(loads, 2);
});

test("PostgreSQL change feed keeps the read model hot until an invalidation", async () => {
  const shared={value:null,expiresAt:0,pending:null,changeFeedReady:true};
  const storage=new PostgresStorage({pool:null,db:{},ownsPool:false,stateCache:shared,stateCacheTtlMillis:1});
  let loads=0;storage.state={load:async()=>{loads+=1;return{revision:loads};}};
  const read=()=>storage.runState(async(state)=>state.revision,{readOnly:true});
  assert.equal(await read(),1);
  shared.expiresAt=0;
  assert.equal(await read(),1);
  assert.equal(loads,1);
  storage.invalidateStateCache();
  assert.equal(await read(),2);
});

test("operational notification refreshes are coalesced and briefly throttled per user", async () => {
  let queries=0;const storage=new PostgresStorage({pool:null,db:{query:async()=>{queries+=1;return{rowCount:0,rows:[]};}},ownsPool:false,notificationRefreshMillis:30_000});
  await Promise.all([storage.ensureOperationalNotificationsFor("user-1"),storage.ensureOperationalNotificationsFor("user-1")]);
  assert.equal(queries,5);
  assert.equal(await storage.ensureOperationalNotificationsFor("user-1"),0);
  assert.equal(queries,5);
});

test("PostgreSQL read snapshots exclude audit and inline media by default",async()=>{
  const queries=[];
  const empty={users:[],roles:[],clients:[],trials:[],availability_slots:[],payments:[],payment_corrections:[],statuses:[],lead_sources:[],tags:[],refusal_reasons:[],payment_methods:[],notes:[],history:[],notifications:[],audit_logs:[],saved_filters:[],teams:[],employee_compensation_history:[],payment_method_commission_history:[],finance_trial_bonus_statuses:[],settings:null};
  const repository=new PostgresStateRepository({db:{query:async(sql)=>{queries.push(sql);return{rows:[empty]};}}});
  const light=await repository.load({includeAuditLogs:false,includeMedia:false});
  assert.deepEqual(light.auditLogs,[]);
  assert.doesNotMatch(queries[0],/FROM public\.audit_logs/);
  assert.match(queries[0],/__stored__/);
  queries.length=0;
  await repository.load();
  assert.match(queries[0],/FROM public\.audit_logs/);
  assert.doesNotMatch(queries[0],/__stored__/);
});
