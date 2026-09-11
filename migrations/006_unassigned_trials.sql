BEGIN;

ALTER TABLE public.clients ALTER COLUMN current_closer_id DROP NOT NULL;

ALTER TABLE public.trials
  ALTER COLUMN closer_id DROP NOT NULL,
  ALTER COLUMN slot_id DROP NOT NULL,
  ALTER COLUMN scheduled_at DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS assignment_state text NOT NULL DEFAULT 'SCHEDULED',
  ADD COLUMN IF NOT EXISTS preferred_time_text text,
  ADD COLUMN IF NOT EXISTS preferred_date date,
  ADD COLUMN IF NOT EXISTS preferred_start_time time,
  ADD COLUMN IF NOT EXISTS preferred_end_time time,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS assignment_version integer NOT NULL DEFAULT 1;

UPDATE public.trials
SET assignment_state='SCHEDULED', assigned_at=COALESCE(assigned_at,created_at)
WHERE slot_id IS NOT NULL;

ALTER TABLE public.trials
  ADD CONSTRAINT trials_assignment_state_check CHECK (assignment_state IN ('UNASSIGNED','SCHEDULED')),
  ADD CONSTRAINT trials_assignment_shape_check CHECK (
    (assignment_state='UNASSIGNED' AND closer_id IS NULL AND slot_id IS NULL AND scheduled_at IS NULL)
    OR
    (assignment_state='SCHEDULED' AND closer_id IS NOT NULL AND slot_id IS NOT NULL AND scheduled_at IS NOT NULL)
  ),
  ADD CONSTRAINT trials_preferred_range_check CHECK (
    preferred_start_time IS NULL OR preferred_end_time IS NULL OR preferred_end_time > preferred_start_time
  );

DROP INDEX IF EXISTS public.trials_one_active_per_slot_uidx;
CREATE UNIQUE INDEX trials_one_active_per_slot_uidx ON public.trials(slot_id)
  WHERE active AND assignment_state='SCHEDULED';
CREATE INDEX trials_unassigned_waiting_idx ON public.trials(created_at)
  WHERE active AND assignment_state='UNASSIGNED';

CREATE OR REPLACE FUNCTION public.validate_trial_booking()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slot_row public.availability_slots%ROWTYPE;
BEGIN
  IF NOT NEW.active OR NEW.assignment_state='UNASSIGNED' THEN RETURN NEW; END IF;
  SELECT * INTO slot_row FROM public.availability_slots WHERE id=NEW.slot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Availability slot % does not exist',NEW.slot_id USING ERRCODE='23503'; END IF;
  IF slot_row.closer_id<>NEW.closer_id THEN RAISE EXCEPTION 'Trial closer does not match availability slot closer' USING ERRCODE='23514'; END IF;
  IF slot_row.start_at<>NEW.scheduled_at THEN RAISE EXCEPTION 'Trial scheduled_at must match availability slot start_at' USING ERRCODE='23514'; END IF;
  IF slot_row.status<>'FREE' AND slot_row.booked_trial_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Availability slot % is already booked',NEW.slot_id USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_trial_slot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.slot_id IS NOT NULL THEN UPDATE public.availability_slots SET status='FREE',booked_trial_id=NULL WHERE id=OLD.slot_id AND booked_trial_id=OLD.id; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.slot_id IS NOT NULL AND OLD.slot_id IS DISTINCT FROM NEW.slot_id THEN
    UPDATE public.availability_slots SET status='FREE',booked_trial_id=NULL WHERE id=OLD.slot_id AND booked_trial_id=OLD.id;
  END IF;
  IF NEW.active AND NEW.assignment_state='SCHEDULED' THEN
    UPDATE public.availability_slots SET status='BOOKED',booked_trial_id=NEW.id WHERE id=NEW.slot_id;
  ELSIF NEW.slot_id IS NOT NULL AND (NEW.attendance_outcome='RESCHEDULED' OR NEW.archive_interrupted_at IS NOT NULL) THEN
    UPDATE public.availability_slots SET status='FREE',booked_trial_id=NULL WHERE id=NEW.slot_id AND booked_trial_id=NEW.id;
  ELSIF NEW.slot_id IS NOT NULL THEN
    UPDATE public.availability_slots SET status='OCCUPIED',booked_trial_id=NEW.id WHERE id=NEW.slot_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS unassigned_trial_reminder_minutes integer NOT NULL DEFAULT 120
  CHECK (unassigned_trial_reminder_minutes BETWEEN 0 AND 10080);

INSERT INTO public.permissions(permission_key,module,action)
VALUES ('schedule.assignUnassigned','schedule','assignUnassigned'),('schedule.reassignCloser','schedule','reassignCloser')
ON CONFLICT(permission_key) DO NOTHING;

INSERT INTO public.role_permissions(role_id,permission_key,enabled)
SELECT r.id,p.permission_key,true FROM public.roles r CROSS JOIN public.permissions p
WHERE r.system_key='ADMIN' AND p.permission_key IN ('schedule.assignUnassigned','schedule.reassignCloser')
ON CONFLICT(role_id,permission_key) DO UPDATE SET enabled=EXCLUDED.enabled;

INSERT INTO public.role_permissions(role_id,permission_key,enabled)
SELECT r.id,'schedule.assignUnassigned',true FROM public.roles r WHERE r.system_key='MANAGER'
ON CONFLICT(role_id,permission_key) DO NOTHING;

INSERT INTO public.schema_migrations(version,name)
VALUES ('006','unassigned_trials') ON CONFLICT(version) DO NOTHING;

COMMIT;
