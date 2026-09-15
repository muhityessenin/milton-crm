BEGIN;

-- Stable keys let the calendar workflow survive administrator renames.
ALTER TABLE public.statuses
  ADD COLUMN IF NOT EXISTS system_key text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.lead_sources ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.tags ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS statuses_system_key_uidx
  ON public.statuses(system_key) WHERE system_key IS NOT NULL;

UPDATE public.statuses
SET system_key='PLANNED',
    name=CASE WHEN lower(name) IN ('scheduled','запланирован','запланированное') THEN 'Запланированные' ELSE name END,
    updated_at=now()
WHERE id='st_scheduled' AND system_key IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.statuses WHERE system_key='TODAY') THEN
    IF EXISTS (SELECT 1 FROM public.statuses WHERE lower(name)='сегодняшние') THEN
      UPDATE public.statuses SET system_key='TODAY',updated_at=now()
      WHERE id=(SELECT id FROM public.statuses WHERE lower(name)='сегодняшние' ORDER BY sort_order,id LIMIT 1);
    ELSE
      INSERT INTO public.statuses(id,name,color,sort_order,action_type,required_fields,active,system_key)
      VALUES ('st_today','Сегодняшние','#14A06F',0,'NONE','{}',true,'TODAY');
    END IF;
  END IF;
END;
$$;

INSERT INTO public.permissions(permission_key,module,action,description)
VALUES ('payments.delete','payments','delete','Удаление ошибочной или дублирующей оплаты с сохранением аудита')
ON CONFLICT(permission_key) DO NOTHING;

INSERT INTO public.role_permissions(role_id,permission_key,enabled)
SELECT id,'payments.delete',true FROM public.roles WHERE system_key='ADMIN'
ON CONFLICT(role_id,permission_key) DO NOTHING;

INSERT INTO public.schema_migrations(version,name)
VALUES ('010','operational_statuses_and_safe_reference_delete')
ON CONFLICT(version) DO NOTHING;

COMMIT;
