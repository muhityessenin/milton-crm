"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Pool } = require("pg");
const { storageConfig } = require("../storage/config");

const ROOT = path.resolve(__dirname, "..");
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
};

const rolePermissions = {
  role_manager: ["clients.view","clients.create","clients.changeStatus","clients.addNotes","clients.viewHistory","schedule.view","schedule.viewOthers","schedule.scheduleTrial","schedule.rescheduleTrial","payments.view","payments.viewHistory","analytics.view","analytics.viewManager"],
  role_closer: ["dashboard.view","clients.view","clients.changeStatus","clients.addNotes","clients.viewHistory","schedule.view","schedule.createOwnAvailability","schedule.editOwnAvailability","schedule.rescheduleTrial","crm.view","crm.changeStatus","payments.view","payments.create","payments.viewHistory","analytics.view","analytics.viewCloser"],
};
const roleScopes = {
  role_admin: { clients: "ALL", schedule: "ALL", payments: "ALL", analytics: "ALL" },
  role_manager: { clients: "OWN", schedule: "ALL", payments: "OWN", analytics: "OWN" },
  role_closer: { clients: "OWN", schedule: "OWN", payments: "OWN", analytics: "OWN" },
};

async function main() {
  const config = storageConfig({ rootDir: ROOT });
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('milton_crm_initial_bootstrap'))");
    const existing = Number((await client.query("SELECT count(*) AS count FROM public.users")).rows[0].count);
    if (existing > 0) {
      await client.query("COMMIT");
      console.log(JSON.stringify({ bootstrap: "skipped", reason: "users_exist", users: existing }));
      return;
    }

    const login = String(process.env.INITIAL_ADMIN_LOGIN || "admin@milton.kz").trim();
    const name = String(process.env.INITIAL_ADMIN_NAME || "Milton Owner").trim();
    const password = String(process.env.INITIAL_ADMIN_PASSWORD || "");
    if (!login || !name || password.length < 12 || password.startsWith("CHANGE_ME")) {
      throw new Error("Set INITIAL_ADMIN_NAME, INITIAL_ADMIN_LOGIN and a unique INITIAL_ADMIN_PASSWORD of at least 12 characters");
    }

    const roles = [
      ["role_admin", "Администратор", "ADMIN", "ADMIN"],
      ["role_manager", "Менеджер", "MANAGER", "MANAGER"],
      ["role_closer", "Клоузер", "CLOSER", "CLOSER"],
    ];
    for (const role of roles) {
      await client.query(`INSERT INTO public.roles(id,name,system_key,base_role,is_system,active)
        VALUES($1,$2,$3,$4,true,true) ON CONFLICT(id) DO NOTHING`, role);
    }
    await client.query(`INSERT INTO public.role_permissions(role_id,permission_key,enabled)
      SELECT 'role_admin',permission_key,true FROM public.permissions ON CONFLICT(role_id,permission_key) DO NOTHING`);
    for (const [roleId, permissions] of Object.entries(rolePermissions)) {
      await client.query(`INSERT INTO public.role_permissions(role_id,permission_key,enabled)
        SELECT $1,permission_key,true FROM unnest($2::text[]) permission_key
        ON CONFLICT(role_id,permission_key) DO UPDATE SET enabled=true`, [roleId, permissions]);
    }
    for (const [roleId, scopes] of Object.entries(roleScopes)) {
      for (const [resource, scope] of Object.entries(scopes)) {
        await client.query(`INSERT INTO public.role_scopes(role_id,resource,scope) VALUES($1,$2,$3)
          ON CONFLICT(role_id,resource) DO UPDATE SET scope=EXCLUDED.scope`, [roleId, resource, scope]);
      }
    }

    const statuses = [
      ["st_scheduled","Запланирован","#4F6BED",1,"NONE",[]],
      ["st_completed","Завершён","#14A06F",2,"NONE",[]],
      ["st_reschedule","Перенесён","#9C6ADE",3,"REQUIRE_RESCHEDULE",["newSlotId"]],
      ["st_no_show","Неявка","#E7952C",4,"MARK_NO_SHOW",[]],
      ["st_refusal","Отказ","#D64C4C",5,"REQUIRE_REFUSAL_REASON",["refusalReasonId"]],
      ["st_payment","Оплата","#087F5B",6,"REQUIRE_PAYMENT",["amount","paymentMethodId","paymentDate"]],
    ];
    for (const row of statuses) await client.query(`INSERT INTO public.statuses(id,name,color,sort_order,action_type,required_fields)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, row);
    const references = {
      lead_sources: [["src_1","Instagram"],["src_2","TikTok"],["src_3","Рекомендация"],["src_4","Школа"]],
      refusal_reasons: [["reason_1","Цена"],["reason_2","Расписание"],["reason_3","Пока не готов"],["reason_4","Выбрал другую школу"]],
      payment_methods: [["method_1","Kaspi Gold"],["method_2","Kaspi Рассрочка"],["method_3","Наличные"],["method_4","Перевод"]],
    };
    for (const [table, rows] of Object.entries(references)) {
      for (const [index, row] of rows.entries()) await client.query(`INSERT INTO public.${table}(id,name,sort_order) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [row[0], row[1], index + 1]);
    }
    const tags = [["tag_1","Горячий","#FDE7E7"],["tag_2","VIP","#EEE7FD"],["tag_3","Повторный","#E7F6EE"],["tag_4","Школа","#E8F0FE"]];
    for (const [id, tagName, color] of tags) await client.query("INSERT INTO public.tags(id,name,color) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [id, tagName, color]);

    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await client.query(`INSERT INTO public.users(id,name,login,password_hash,role_id,business_role,is_owner,active)
      VALUES($1,$2,$3,$4,'role_admin','ADMIN',true,true)`, [ownerId, name, login, hashPassword(password)]);
    await client.query(`INSERT INTO public.app_settings(id,timezone,company_name,accent_color,reminder_minutes,updated_by_user_id)
      VALUES('global','Asia/Almaty','Milton','#3157D5',30,$1) ON CONFLICT(id) DO NOTHING`, [ownerId]);
    await client.query("COMMIT");
    console.log(JSON.stringify({ bootstrap: "created", ownerId, login }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Bootstrap failed: ${error.message}`);
  process.exitCode = 1;
});
