BEGIN;

-- Status behavior is configurable and independent of its display name.
ALTER TABLE public.statuses
  ADD COLUMN IF NOT EXISTS partial_payment boolean NOT NULL DEFAULT false;

-- Deal metadata complements the existing payments ledger. Remaining balance is
-- always derived from non-voided payments and is deliberately not duplicated.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS total_deal_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS remaining_payment_due_date date,
  ADD COLUMN IF NOT EXISTS prepayment_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_total_deal_amount_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_total_deal_amount_check
      CHECK (total_deal_amount IS NULL OR total_deal_amount > 0);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS clients_remaining_payment_due_idx
  ON public.clients(remaining_payment_due_date)
  WHERE total_deal_amount IS NOT NULL AND archived_at IS NULL;

-- One durable logical balance reminder per user/client. Snoozing and resolving
-- update this record instead of inserting duplicates on each refresh.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_client_balance_uidx
  ON public.notifications(user_id, client_id, type)
  WHERE trial_id IS NULL AND client_id IS NOT NULL AND type = 'PREPAYMENT_BALANCE_DUE';

INSERT INTO public.schema_migrations(version,name)
VALUES ('009','prepayment_and_client_timestamps')
ON CONFLICT(version) DO NOTHING;

COMMIT;
