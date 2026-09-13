BEGIN;

-- Current card reason. Historical reasons remain in client_history.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS current_reason_id text
  REFERENCES public.refusal_reasons(id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- A reschedule-later creates a new active, unassigned trial event while the
-- completed scheduled event remains immutable history.
ALTER TABLE public.trials
  ADD COLUMN IF NOT EXISTS pending_reschedule boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reschedule_reason_id text
    REFERENCES public.refusal_reasons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reschedule_from_trial_id text
    REFERENCES public.trials(id) ON UPDATE CASCADE ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_closer_id text
    REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS pending_reschedule_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_reschedule_by_user_id text
    REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.trials
  ADD CONSTRAINT trials_pending_reschedule_shape_check CHECK (
    NOT pending_reschedule OR (
      active
      AND assignment_state = 'UNASSIGNED'
      AND closer_id IS NULL
      AND slot_id IS NULL
      AND scheduled_at IS NULL
      AND reschedule_reason_id IS NOT NULL
      AND reschedule_from_trial_id IS NOT NULL
      AND pending_reschedule_at IS NOT NULL
      AND pending_reschedule_by_user_id IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS trials_pending_reschedule_idx
  ON public.trials(pending_reschedule_at)
  WHERE active AND pending_reschedule;

-- Snooze and resolution are state on one logical notification. They do not
-- create repeated notification rows.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS notifications_active_user_idx
  ON public.notifications(user_id, created_at DESC)
  WHERE resolved_at IS NULL;

INSERT INTO public.schema_migrations(version,name)
VALUES ('008','trial_operations')
ON CONFLICT(version) DO NOTHING;

COMMIT;
