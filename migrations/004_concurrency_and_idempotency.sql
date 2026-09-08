BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS payments_actor_idempotency_uidx
  ON public.payments (created_by_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_trial_type_uidx
  ON public.notifications (user_id, type, trial_id)
  WHERE trial_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.bump_record_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_bump_version ON public.clients;
CREATE TRIGGER clients_bump_version
BEFORE UPDATE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.bump_record_version();

DROP TRIGGER IF EXISTS payments_bump_version ON public.payments;
CREATE TRIGGER payments_bump_version
BEFORE UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.bump_record_version();

INSERT INTO public.schema_migrations (version, name)
VALUES ('004', 'concurrency_and_idempotency')
ON CONFLICT (version) DO NOTHING;

COMMIT;
