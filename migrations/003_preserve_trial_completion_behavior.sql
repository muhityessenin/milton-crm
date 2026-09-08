BEGIN;

-- The existing CRM can record a successful/payment result before the scheduled
-- trial time. Preserve that API behavior during the storage cutover. Result
-- attribution and active-slot constraints remain enforced independently.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = 'public.trials'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%completed_at IS NULL%completed_at >= scheduled_at%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.trials DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

INSERT INTO public.schema_migrations (version, name)
VALUES ('003', 'preserve_trial_completion_behavior')
ON CONFLICT (version) DO NOTHING;

COMMIT;
