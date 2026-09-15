BEGIN;

DO $$
DECLARE
  missing_tables text[];
  permission_count integer;
BEGIN
  SELECT array_agg(expected.table_name ORDER BY expected.table_name)
  INTO missing_tables
  FROM unnest(ARRAY[
    'app_settings', 'audit_logs', 'availability_slots', 'client_history',
    'client_tags', 'clients', 'lead_sources', 'notes', 'notifications',
    'payment_corrections', 'payment_methods', 'payments', 'permissions',
    'refusal_reasons', 'role_permissions', 'role_scopes', 'roles',
    'saved_filters', 'schema_migrations', 'sessions', 'statuses', 'tags',
    'trials', 'user_permission_overrides', 'user_scope_overrides', 'users'
  ]) AS expected(table_name)
  WHERE to_regclass('public.' || expected.table_name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Missing tables: %', missing_tables;
  END IF;

  SELECT count(*) INTO permission_count FROM public.permissions;
  IF permission_count <> 45 THEN
    RAISE EXCEPTION 'Expected 45 permission definitions, found %', permission_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '001')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '002')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '003')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '004')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '005')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '006')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '007')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '008')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '009')
    OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '010') THEN
    RAISE EXCEPTION 'Expected schema migration versions 001 through 010';
  END IF;
END;
$$;

DO $$
DECLARE
  data_type_value text;
BEGIN
  SELECT data_type INTO data_type_value
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'payment_date';
  IF data_type_value <> 'date' THEN
    RAISE EXCEPTION 'payments.payment_date must be DATE, found %', data_type_value;
  END IF;

  SELECT data_type INTO data_type_value
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'amount';
  IF data_type_value <> 'numeric' THEN
    RAISE EXCEPTION 'payments.amount must be NUMERIC, found %', data_type_value;
  END IF;

  SELECT data_type INTO data_type_value
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'trials' AND column_name = 'scheduled_at';
  IF data_type_value <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'trials.scheduled_at must be TIMESTAMPTZ, found %', data_type_value;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'trials_one_active_per_slot_uidx'
  ) THEN
    RAISE EXCEPTION 'Missing active-slot double-booking index';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'users_single_owner_uidx'
  ) THEN
    RAISE EXCEPTION 'Missing single-owner index';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='version')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='version') THEN
    RAISE EXCEPTION 'Missing optimistic version columns';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='payments_actor_idempotency_uidx') THEN
    RAISE EXCEPTION 'Missing payment idempotency index';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='trials' AND column_name='trial_type')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='trials' AND column_name='receipt_storage_key') THEN
    RAISE EXCEPTION 'Missing paid-trial receipt metadata columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='trial_duration_minutes'
  ) THEN
    RAISE EXCEPTION 'Missing optional per-Closer trial duration column';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='statuses' AND column_name='partial_payment')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='total_deal_amount')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='remaining_payment_due_date')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='status_changed_at') THEN
    RAISE EXCEPTION 'Missing prepayment or client timestamp columns';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='notifications_user_client_balance_uidx') THEN
    RAISE EXCEPTION 'Missing durable prepayment reminder index';
  END IF;
END;
$$;

INSERT INTO public.roles (id, name, system_key, base_role, is_system)
VALUES
  ('test_role_admin', 'Test Admin', NULL, 'ADMIN', false),
  ('test_role_manager', 'Test Manager', NULL, 'MANAGER', false),
  ('test_role_closer', 'Test Closer', NULL, 'CLOSER', false);

INSERT INTO public.role_permissions (role_id, permission_key, enabled)
VALUES ('test_role_manager', 'clients.view', true);

INSERT INTO public.role_scopes (role_id, resource, scope)
VALUES ('test_role_manager', 'clients', 'OWN');

INSERT INTO public.users (
  id, name, login, password_hash, role_id, business_role, is_owner
) VALUES
  ('test_owner', 'Test Admin', 'owner.schema.test@milton.local', 'test-hash', 'test_role_admin', 'ADMIN', false),
  ('test_manager', 'Test Manager', 'manager.schema.test@milton.local', 'test-hash', 'test_role_manager', 'MANAGER', false),
  ('test_closer', 'Test Closer', 'closer.schema.test@milton.local', 'test-hash', 'test_role_closer', 'CLOSER', false);

UPDATE public.users SET trial_duration_minutes = 40 WHERE id = 'test_closer';

DO $$
BEGIN
  BEGIN
    UPDATE public.users SET trial_duration_minutes = 9 WHERE id = 'test_closer';
    RAISE EXCEPTION 'Invalid Closer duration was not rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

INSERT INTO public.user_permission_overrides (user_id, permission_key, enabled)
VALUES ('test_manager', 'clients.archive', true);

INSERT INTO public.user_scope_overrides (user_id, resource, scope)
VALUES ('test_manager', 'analytics', 'TEAM');

INSERT INTO public.statuses (
  id, name, color, sort_order, action_type, required_fields
) VALUES
  ('test_status_scheduled', 'Test Scheduled', '#3157D5', 1, 'NONE', '{}'),
  ('test_status_payment', 'Test Payment', '#087F5B', 2, 'REQUIRE_PAYMENT', ARRAY['amount', 'paymentMethodId', 'paymentDate']);

INSERT INTO public.lead_sources (id, name, sort_order)
VALUES ('test_source', 'Test Source', 1);

INSERT INTO public.tags (id, name, color)
VALUES ('test_tag', 'Test Tag', '#EDF0F5');

INSERT INTO public.refusal_reasons (id, name, sort_order)
VALUES ('test_reason', 'Test Reason', 1);

INSERT INTO public.payment_methods (id, name, sort_order)
VALUES ('test_method', 'Test Method', 1);

INSERT INTO public.clients (
  id, name, normalized_phone, original_phone, original_manager_id,
  current_manager_id, current_closer_id, current_status_id, lead_source_id
) VALUES
  ('test_client_1', 'Schema Client One', '+77000000001', '+7 700 000 00 01',
   'test_manager', 'test_manager', 'test_closer', 'test_status_scheduled', 'test_source'),
  ('test_client_2', 'Schema Client Two', '+77000000002', '+7 700 000 00 02',
   'test_manager', 'test_manager', 'test_closer', 'test_status_scheduled', 'test_source');

INSERT INTO public.client_tags (client_id, tag_id)
VALUES ('test_client_1', 'test_tag');

DO $$
BEGIN
  BEGIN
    INSERT INTO public.clients (
      id, name, normalized_phone, original_phone, original_manager_id,
      current_manager_id, current_closer_id, current_status_id
    ) VALUES (
      'test_duplicate_phone', 'Duplicate Phone', '+77000000001', '+7 700 000 00 01',
      'test_manager', 'test_manager', 'test_closer', 'test_status_scheduled'
    );
    RAISE EXCEPTION 'Duplicate normalized phone was not rejected';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END;
$$;

INSERT INTO public.availability_slots (
  id, closer_id, start_at, end_at
) VALUES (
  'test_slot_1', 'test_closer', '2026-09-10 10:00:00+05', '2026-09-10 11:00:00+05'
);

INSERT INTO public.trials (
  id, client_id, manager_id, closer_id, slot_id, scheduled_at, status_at_booking_id, registered_by_user_id
) VALUES (
  'test_trial_1', 'test_client_1', 'test_manager', 'test_closer', 'test_slot_1',
  '2026-09-10 10:00:00+05', 'test_status_scheduled', 'test_manager'
);

DO $$
DECLARE
  slot_status text;
  slot_trial text;
BEGIN
  SELECT status, booked_trial_id INTO slot_status, slot_trial
  FROM public.availability_slots WHERE id = 'test_slot_1';
  IF slot_status <> 'BOOKED' OR slot_trial <> 'test_trial_1' THEN
    RAISE EXCEPTION 'Active trial did not synchronize the booked slot';
  END IF;

  BEGIN
    INSERT INTO public.trials (
      id, client_id, manager_id, closer_id, slot_id, scheduled_at, status_at_booking_id, registered_by_user_id
    ) VALUES (
      'test_trial_double_booking', 'test_client_2', 'test_manager', 'test_closer',
      'test_slot_1', '2026-09-10 10:00:00+05', 'test_status_scheduled', 'test_manager'
    );
    RAISE EXCEPTION 'Double booking was not rejected';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END;
$$;

-- Existing CRM behavior: a trial can receive a payment/result before its
-- scheduled time. Migration 003 intentionally permits this representation.
UPDATE public.trials
SET active = false,
    completed_at = '2026-09-09 10:00:00+05',
    result_status_id = 'test_status_payment',
    result_at = '2026-09-09 10:00:00+05',
    result_actor_user_id = 'test_owner',
    attendance_outcome = 'REACHED'
WHERE id = 'test_trial_1';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.availability_slots WHERE id='test_slot_1' AND status='OCCUPIED' AND booked_trial_id='test_trial_1') THEN
    RAISE EXCEPTION 'Completed trial did not preserve its occupied historical slot';
  END IF;
END;
$$;

INSERT INTO public.payments (
  id, client_id, manager_attribution_id, closer_attribution_id, amount,
  payment_method_id, payment_date, created_by_user_id, voided_at
) VALUES (
  'test_payment_original', 'test_client_1', 'test_manager', 'test_closer', 45000.00,
  'test_method', DATE '2026-09-10', 'test_closer', now()
);

INSERT INTO public.payments (
  id, client_id, manager_attribution_id, closer_attribution_id, amount,
  payment_method_id, payment_date, created_by_user_id, corrected_from_payment_id
) VALUES (
  'test_payment_replacement', 'test_client_1', 'test_manager', 'test_closer', 47000.00,
  'test_method', DATE '2026-09-10', 'test_owner', 'test_payment_original'
);

INSERT INTO public.payment_corrections (
  id, original_payment_id, replacement_payment_id, corrected_by_user_id, old_value, new_value
) VALUES (
  'test_correction', 'test_payment_original', 'test_payment_replacement', 'test_owner',
  '{"amount":45000}'::jsonb, '{"amount":47000}'::jsonb
);

INSERT INTO public.notes (id, client_id, author_user_id, note_type, text)
VALUES ('test_note', 'test_client_1', 'test_manager', 'MANAGER_NOTE', 'Schema test note');

INSERT INTO public.client_history (id, client_id, actor_user_id, event_type, new_value)
VALUES ('test_history', 'test_client_1', 'test_manager', 'CLIENT_CREATED', '{"test":true}'::jsonb);

INSERT INTO public.notifications (id, user_id, client_id, trial_id, type, content)
VALUES ('test_notification', 'test_closer', 'test_client_1', 'test_trial_1', 'TRIAL_ASSIGNED', 'Schema test');

INSERT INTO public.saved_filters (id, user_id, module, name, filter_value, is_default)
VALUES ('test_filter', 'test_manager', 'analytics', 'Schema Test', '{"from":"2026-09-01"}'::jsonb, true);

UPDATE public.app_settings SET updated_by_user_id = 'test_owner' WHERE id = 'global';

INSERT INTO public.sessions (id, user_id, token_hash, expires_at)
VALUES ('test_session', 'test_owner', repeat('a', 64), now() + interval '1 hour');

DO $$
BEGIN
  BEGIN
    PERFORM set_config('milton.actor_user_id', 'test_manager', true);
    DELETE FROM public.clients WHERE id = 'test_client_1';
    RAISE EXCEPTION 'Non-owner client deletion was not rejected';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.users SET active = false, archived_at = now() WHERE id = 'usr_admin';
    RAISE EXCEPTION 'Owner deactivation was not rejected';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.users SET is_owner = true WHERE id = 'test_manager';
    RAISE EXCEPTION 'Owner privilege grant was not rejected';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

SELECT public.permanently_delete_client('test_client_1', 'usr_admin', 'УДАЛИТЬ');

DO $$
DECLARE
  freed_status text;
  freed_trial text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.clients WHERE id = 'test_client_1') THEN
    RAISE EXCEPTION 'Owner permanent delete did not remove the client';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE entity_id = 'test_client_1' AND action = 'CLIENT_PERMANENTLY_DELETED'
  ) THEN
    RAISE EXCEPTION 'Owner permanent delete did not create a protected audit record';
  END IF;

  SELECT status, booked_trial_id INTO freed_status, freed_trial
  FROM public.availability_slots WHERE id = 'test_slot_1';
  IF freed_status <> 'FREE' OR freed_trial IS NOT NULL THEN
    RAISE EXCEPTION 'Permanent deletion did not release the booked slot';
  END IF;
END;
$$;

ROLLBACK;
