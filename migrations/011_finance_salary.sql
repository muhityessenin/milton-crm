BEGIN;

CREATE TABLE IF NOT EXISTS public.teams (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_name_lower_uidx ON public.teams (lower(name));

INSERT INTO public.teams(id,name,created_at,updated_at)
SELECT DISTINCT u.team_id,u.team_id,now(),now() FROM public.users u
WHERE u.team_id IS NOT NULL AND btrim(u.team_id)<>'' ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.employee_compensation_history (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  sales_commission_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK (sales_commission_percent BETWEEN 0 AND 100),
  conducted_trial_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (conducted_trial_amount >= 0),
  effective_at timestamptz NOT NULL,
  changed_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employee_compensation_user_effective_idx ON public.employee_compensation_history(user_id,effective_at DESC);

CREATE TABLE IF NOT EXISTS public.payment_method_commission_history (
  id text PRIMARY KEY,
  payment_method_id text NOT NULL,
  bank_commission_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK (bank_commission_percent BETWEEN 0 AND 100),
  effective_at timestamptz NOT NULL,
  changed_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_method_commission_effective_idx ON public.payment_method_commission_history(payment_method_id,effective_at DESC);

CREATE TABLE IF NOT EXISTS public.finance_trial_bonus_statuses (
  status_id text PRIMARY KEY REFERENCES public.statuses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  configured_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  configured_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.statuses ADD COLUMN IF NOT EXISTS is_refund boolean NOT NULL DEFAULT false;

INSERT INTO public.permissions(permission_key,module,action,description) VALUES
  ('finance.own','finance','own','Свои финансы'),
  ('finance.team','finance','team','Финансы своей команды'),
  ('finance.allManagers','finance','allManagers','Финансы всех менеджеров'),
  ('finance.allClosers','finance','allClosers','Финансы всех клоузеров'),
  ('finance.companyTurnover','finance','companyTurnover','Общий оборот компании'),
  ('finance.allPayments','finance','allPayments','Все оплаты'),
  ('finance.allTrials','finance','allTrials','Все пробные'),
  ('finance.clientHistory','finance','clientHistory','История финансов клиента'),
  ('finance.export','finance','export','Экспорт финансов'),
  ('finance.manageRates','finance','manageRates','Настройка ставок'),
  ('finance.manageTeams','finance','manageTeams','Управление командами')
ON CONFLICT(permission_key) DO NOTHING;

INSERT INTO public.role_permissions(role_id,permission_key,enabled)
SELECT r.id,p.permission_key,true FROM public.roles r CROSS JOIN public.permissions p
WHERE r.system_key='ADMIN' AND p.module='finance'
ON CONFLICT(role_id,permission_key) DO UPDATE SET enabled=EXCLUDED.enabled;

INSERT INTO public.role_permissions(role_id,permission_key,enabled)
SELECT r.id,'finance.own',true FROM public.roles r WHERE r.system_key IN ('MANAGER','CLOSER')
ON CONFLICT(role_id,permission_key) DO UPDATE SET enabled=EXCLUDED.enabled;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['teams','employee_compensation_history','payment_method_commission_history','finance_trial_bonus_statuses'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname=table_name||'_realtime_change' AND NOT tgisinternal) THEN
      EXECUTE format('CREATE TRIGGER %I_realtime_change AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.notify_milton_change()',table_name,table_name);
    END IF;
  END LOOP;
END $$;

INSERT INTO public.schema_migrations(version,name) VALUES('011','finance_salary') ON CONFLICT(version) DO NOTHING;

COMMIT;
