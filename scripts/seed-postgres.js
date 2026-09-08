"use strict";

const fs=require("node:fs");
const path=require("node:path");
const {Pool}=require("pg");
const {storageConfig}=require("../storage/config");

const ROOT=path.resolve(__dirname,"..");
const SOURCE_FILE=path.join(ROOT,"data","db.json");
const apply=process.argv.includes("--apply");
const numericId=(prefix)=>(row)=>new RegExp(`^${prefix}_[0-9]+$`).test(row.id);

function buildSeed(source){
  const businessCounts={clients:(source.clients||[]).length,trials:(source.trials||[]).length,payments:(source.payments||[]).length};
  if(Object.values(businessCounts).some(Boolean))throw new Error(`Business import is intentionally disabled: ${JSON.stringify(businessCounts)}`);
  const owners=(source.users||[]).filter((row)=>row.isOwner===true);
  if(owners.length!==1)throw new Error(`Exactly one Owner is required in JSON; found ${owners.length}`);
  const owner=owners[0];
  if(!/^[0-9a-f]+:[0-9a-f]+$/i.test(owner.passwordHash||""))throw new Error("Owner password hash is not compatible with the current scrypt format");
  const roles=(source.roles||[]).filter((row)=>row.isSystem&&["ADMIN","MANAGER","CLOSER"].includes(row.systemKey));
  if(roles.length!==3)throw new Error(`Expected three system roles; found ${roles.length}`);
  const permissions=[...new Set(roles.flatMap((row)=>Object.keys(row.permissions||{})))].sort().map((key)=>{
    const [module,action]=key.split(".");if(!module||!action)throw new Error(`Invalid permission key: ${key}`);return {key,module,action};
  });
  return {
    businessCounts,owner,roles,permissions,
    statuses:source.statuses||[],leadSources:(source.leadSources||[]).filter(numericId("src")),
    tags:(source.tags||[]).filter(numericId("tag")),refusalReasons:(source.refusalReasons||[]).filter(numericId("reason")),
    paymentMethods:(source.paymentMethods||[]).filter(numericId("method")),meta:source.meta||{},
  };
}

async function upsertReference(client,table,row,extra={}){
  const common=[row.id,row.name,row.sortOrder||0,row.active!==false,row.archivedAt||null,row.createdAt||new Date().toISOString(),row.updatedAt||new Date().toISOString()];
  if(table==="statuses")return client.query(`INSERT INTO public.statuses(id,name,color,sort_order,action_type,required_fields,active,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,color=EXCLUDED.color,sort_order=EXCLUDED.sort_order,action_type=EXCLUDED.action_type,required_fields=EXCLUDED.required_fields,active=EXCLUDED.active,archived_at=EXCLUDED.archived_at,updated_at=EXCLUDED.updated_at`,[row.id,row.name,row.color||"#7C879E",row.sortOrder||0,row.actionType||"NONE",row.requiredFields||[],row.active!==false,row.archivedAt||null,row.createdAt||new Date().toISOString(),row.updatedAt||new Date().toISOString()]);
  if(table==="tags")return client.query(`INSERT INTO public.tags(id,name,color,sort_order,active,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,color=EXCLUDED.color,sort_order=EXCLUDED.sort_order,active=EXCLUDED.active,archived_at=EXCLUDED.archived_at,updated_at=EXCLUDED.updated_at`,[row.id,row.name,row.color||"#EDF0F5",...common.slice(2)]);
  return client.query(`INSERT INTO public.${table}(id,name,sort_order,active,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order,active=EXCLUDED.active,archived_at=EXCLUDED.archived_at,updated_at=EXCLUDED.updated_at`,common);
}

async function importSeed(client,seed){
  await client.query("SELECT pg_advisory_xact_lock(hashtext('milton_crm_controlled_seed'))");
  const migrations=await client.query("SELECT version FROM public.schema_migrations WHERE version=ANY($1::text[])",[["001","002","003","004"]]);
  if(migrations.rowCount!==4)throw new Error("Migrations 001–004 must be applied before seed");
  const dbBusiness=await client.query("SELECT (SELECT count(*)::int FROM public.clients) clients,(SELECT count(*)::int FROM public.trials) trials,(SELECT count(*)::int FROM public.payments) payments");
  if(Object.values(dbBusiness.rows[0]).some(Boolean))throw new Error(`Supabase business tables are not empty: ${JSON.stringify(dbBusiness.rows[0])}`);
  const loginConflict=await client.query("SELECT id FROM public.users WHERE lower(login)=lower($1) AND id<>$2",[seed.owner.login,seed.owner.id]);
  if(loginConflict.rowCount)throw new Error(`Owner login already belongs to another ID: ${loginConflict.rows[0].id}`);

  for(const permission of seed.permissions)await client.query(`INSERT INTO public.permissions(permission_key,module,action) VALUES($1,$2,$3) ON CONFLICT(permission_key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action`,[permission.key,permission.module,permission.action]);
  for(const role of seed.roles)await client.query(`INSERT INTO public.roles(id,name,system_key,base_role,is_system,active,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,system_key=EXCLUDED.system_key,base_role=EXCLUDED.base_role,is_system=EXCLUDED.is_system,active=EXCLUDED.active,archived_at=EXCLUDED.archived_at,updated_at=EXCLUDED.updated_at`,[role.id,role.name,role.systemKey,role.baseRole,true,role.active!==false,role.archivedAt||null,role.createdAt||new Date().toISOString(),role.updatedAt||new Date().toISOString()]);
  for(const role of seed.roles){
    await client.query("DELETE FROM public.role_permissions WHERE role_id=$1",[role.id]);
    const permissionRows=Object.entries(role.permissions||{});if(permissionRows.length)await client.query("INSERT INTO public.role_permissions(role_id,permission_key,enabled) SELECT $1,* FROM unnest($2::text[],$3::boolean[])",[role.id,permissionRows.map(r=>r[0]),permissionRows.map(r=>r[1])]);
    await client.query("DELETE FROM public.role_scopes WHERE role_id=$1",[role.id]);
    const scopeRows=Object.entries(role.scopes||{});if(scopeRows.length)await client.query("INSERT INTO public.role_scopes(role_id,resource,scope) SELECT $1,* FROM unnest($2::text[],$3::text[])",[role.id,scopeRows.map(r=>r[0]),scopeRows.map(r=>r[1])]);
  }
  const owner=seed.owner;
  await client.query(`INSERT INTO public.users(id,name,login,password_hash,role_id,business_role,is_owner,avatar_url,profile_status,active,team_id,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,true,$9,NULL,$10,$11) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,login=EXCLUDED.login,password_hash=EXCLUDED.password_hash,role_id=EXCLUDED.role_id,business_role=EXCLUDED.business_role,is_owner=true,avatar_url=EXCLUDED.avatar_url,profile_status=EXCLUDED.profile_status,active=true,team_id=EXCLUDED.team_id,archived_at=NULL,updated_at=EXCLUDED.updated_at`,[owner.id,owner.name,owner.login,owner.passwordHash,owner.roleId,owner.role||"ADMIN",owner.avatarUrl||"",owner.profileStatus||"WORKING",owner.teamId||null,owner.createdAt||new Date().toISOString(),owner.updatedAt||new Date().toISOString()]);
  await client.query("DELETE FROM public.user_permission_overrides WHERE user_id=$1",[owner.id]);
  const overrides=Object.entries(owner.permissionOverrides||{});if(overrides.length)await client.query("INSERT INTO public.user_permission_overrides(user_id,permission_key,enabled) SELECT $1,* FROM unnest($2::text[],$3::boolean[])",[owner.id,overrides.map(r=>r[0]),overrides.map(r=>r[1])]);
  await client.query("DELETE FROM public.user_scope_overrides WHERE user_id=$1",[owner.id]);
  const scopes=Object.entries(owner.scopeOverrides||{});if(scopes.length)await client.query("INSERT INTO public.user_scope_overrides(user_id,resource,scope) SELECT $1,* FROM unnest($2::text[],$3::text[])",[owner.id,scopes.map(r=>r[0]),scopes.map(r=>r[1])]);

  for(const row of seed.statuses)await upsertReference(client,"statuses",row);
  for(const row of seed.leadSources)await upsertReference(client,"lead_sources",row);
  for(const row of seed.tags)await upsertReference(client,"tags",row);
  for(const row of seed.refusalReasons)await upsertReference(client,"refusal_reasons",row);
  for(const row of seed.paymentMethods)await upsertReference(client,"payment_methods",row);
  const branding=seed.meta.branding||{};
  await client.query(`INSERT INTO public.app_settings(id,schema_version,timezone,company_name,accent_color,logo_url,reminder_minutes,updated_by_user_id) VALUES('global',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET schema_version=EXCLUDED.schema_version,timezone=EXCLUDED.timezone,company_name=EXCLUDED.company_name,accent_color=EXCLUDED.accent_color,logo_url=EXCLUDED.logo_url,reminder_minutes=EXCLUDED.reminder_minutes,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,[seed.meta.version||1,seed.meta.timezone||"Asia/Almaty",branding.companyName||"Milton",branding.accentColor||"#3157D5",branding.logoUrl||"",seed.meta.reminderMinutes||30,owner.id]);
  return dbBusiness.rows[0];
}

async function main(){
  const source=JSON.parse(fs.readFileSync(SOURCE_FILE,"utf8")),seed=buildSeed(source);
  const summary={mode:apply?"apply":"dry-run",source:path.relative(ROOT,SOURCE_FILE),owner:{id:seed.owner.id,login:seed.owner.login},roles:seed.roles.map(r=>r.id),permissions:seed.permissions.length,statuses:seed.statuses.map(r=>r.id),leadSources:seed.leadSources.map(r=>r.id),tags:seed.tags.map(r=>r.id),refusalReasons:seed.refusalReasons.map(r=>r.id),paymentMethods:seed.paymentMethods.map(r=>r.id),branding:{companyName:seed.meta.branding?.companyName,accentColor:seed.meta.branding?.accentColor,hasLogo:Boolean(seed.meta.branding?.logoUrl)},businessImported:false};
  if(!apply){console.log(JSON.stringify(summary,null,2));return;}
  const config=storageConfig({rootDir:ROOT}),pool=new Pool({connectionString:config.databaseUrl,ssl:config.ssl?{rejectUnauthorized:false}:false,connectionTimeoutMillis:10000});const client=await pool.connect();
  try{await client.query("BEGIN");await importSeed(client,seed);await client.query("COMMIT");console.log(JSON.stringify({...summary,applied:true},null,2));}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();await pool.end();}
}

main().catch((error)=>{console.error(error.message);process.exitCode=1;});
