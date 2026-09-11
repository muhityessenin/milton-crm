BEGIN;

ALTER TABLE public.trials
  ADD COLUMN trial_type text NOT NULL DEFAULT 'FREE',
  ADD COLUMN trial_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN trial_payment_date date,
  ADD COLUMN registered_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN receipt_storage_key text,
  ADD COLUMN receipt_original_name text,
  ADD COLUMN receipt_mime_type text,
  ADD COLUMN receipt_size_bytes integer,
  ADD COLUMN receipt_uploaded_at timestamptz;

UPDATE public.trials
SET registered_by_user_id = manager_id,
    trial_payment_date = created_at::date
WHERE registered_by_user_id IS NULL;

ALTER TABLE public.trials
  ALTER COLUMN registered_by_user_id SET NOT NULL,
  ADD CONSTRAINT trials_type_check CHECK (trial_type IN ('FREE', 'PAID')),
  ADD CONSTRAINT trials_payment_check CHECK (
    (trial_type = 'FREE' AND trial_amount = 0 AND receipt_storage_key IS NULL) OR
    (trial_type = 'PAID' AND trial_amount > 0 AND trial_payment_date IS NOT NULL
      AND receipt_storage_key IS NOT NULL AND receipt_mime_type IS NOT NULL
      AND receipt_size_bytes > 0 AND receipt_uploaded_at IS NOT NULL)
  );

CREATE INDEX trials_trial_type_payment_date_idx
  ON public.trials (trial_type, trial_payment_date) WHERE trial_type = 'PAID';

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'public.availability_slots'::regclass
      AND c.contype = 'c'
      AND (pg_get_constraintdef(c.oid) ILIKE '%status%FREE%BOOKED%'
        OR pg_get_constraintdef(c.oid) ILIKE '%status = %booked_trial_id%')
  LOOP
    EXECUTE format('ALTER TABLE public.availability_slots DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE public.availability_slots
  ADD CONSTRAINT availability_slots_status_check CHECK (status IN ('FREE', 'BOOKED', 'OCCUPIED')),
  ADD CONSTRAINT availability_slots_booking_state_check CHECK (
    (status = 'FREE' AND booked_trial_id IS NULL) OR
    (status IN ('BOOKED', 'OCCUPIED') AND booked_trial_id IS NOT NULL)
  );

UPDATE public.availability_slots s
SET status='FREE', booked_trial_id=NULL
FROM public.trials t
WHERE t.id=s.booked_trial_id AND NOT t.active
  AND (t.attendance_outcome='RESCHEDULED' OR t.archive_interrupted_at IS NOT NULL);

CREATE OR REPLACE FUNCTION public.validate_trial_booking()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slot_row public.availability_slots%ROWTYPE;
BEGIN
  IF NOT NEW.active THEN RETURN NEW; END IF;
  SELECT * INTO slot_row FROM public.availability_slots WHERE id = NEW.slot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Availability slot % does not exist', NEW.slot_id USING ERRCODE = '23503'; END IF;
  IF slot_row.closer_id <> NEW.closer_id THEN RAISE EXCEPTION 'Trial closer does not match availability slot closer' USING ERRCODE = '23514'; END IF;
  IF slot_row.start_at <> NEW.scheduled_at THEN RAISE EXCEPTION 'Trial scheduled_at must match availability slot start_at' USING ERRCODE = '23514'; END IF;
  IF slot_row.status <> 'FREE' AND slot_row.booked_trial_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Availability slot % is already booked', NEW.slot_id USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_trial_slot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.availability_slots SET status = 'FREE', booked_trial_id = NULL
    WHERE id = OLD.slot_id AND booked_trial_id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.slot_id <> NEW.slot_id THEN
    UPDATE public.availability_slots SET status = 'FREE', booked_trial_id = NULL
    WHERE id = OLD.slot_id AND booked_trial_id = OLD.id;
  END IF;
  IF NEW.active THEN
    UPDATE public.availability_slots SET status = 'BOOKED', booked_trial_id = NEW.id WHERE id = NEW.slot_id;
  ELSIF NEW.attendance_outcome = 'RESCHEDULED' OR NEW.archive_interrupted_at IS NOT NULL THEN
    UPDATE public.availability_slots SET status = 'FREE', booked_trial_id = NULL
    WHERE id = NEW.slot_id AND booked_trial_id = NEW.id;
  ELSE
    UPDATE public.availability_slots SET status = 'OCCUPIED', booked_trial_id = NEW.id WHERE id = NEW.slot_id;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE public.availability_slots s
SET status = 'OCCUPIED', booked_trial_id = t.id
FROM (
  SELECT DISTINCT ON (slot_id) id, slot_id
  FROM public.trials
  WHERE NOT active AND attendance_outcome IS DISTINCT FROM 'RESCHEDULED' AND archive_interrupted_at IS NULL
  ORDER BY slot_id, created_at DESC
) t
WHERE t.slot_id = s.id;

UPDATE public.availability_slots s
SET status = 'BOOKED', booked_trial_id = t.id
FROM public.trials t
WHERE t.slot_id = s.id AND t.active;

CREATE OR REPLACE FUNCTION public.notify_milton_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('milton_crm_changes', json_build_object('table', TG_TABLE_NAME, 'operation', TG_OP)::text);
  RETURN NULL;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'clients','trials','availability_slots','payments','payment_corrections','notes','client_history',
    'notifications','users','roles','role_permissions','role_scopes','user_permission_overrides',
    'user_scope_overrides','statuses','lead_sources','tags','refusal_reasons','payment_methods','app_settings'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_realtime_change ON public.%I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_realtime_change AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.notify_milton_change()', table_name, table_name);
  END LOOP;
END;
$$;

INSERT INTO public.schema_migrations (version, name)
VALUES ('005', 'realtime_trial_receipts_and_schedule')
ON CONFLICT (version) DO NOTHING;

COMMIT;
