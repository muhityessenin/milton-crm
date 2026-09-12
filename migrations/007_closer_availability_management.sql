BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS trial_duration_minutes integer;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_trial_duration_minutes_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_trial_duration_minutes_check
  CHECK (trial_duration_minutes IS NULL OR trial_duration_minutes BETWEEN 10 AND 180);

INSERT INTO public.schema_migrations(version,name)
VALUES ('007','closer_availability_management')
ON CONFLICT(version) DO NOTHING;

COMMIT;
