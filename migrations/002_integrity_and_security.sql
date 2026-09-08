BEGIN;

CREATE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'roles', 'users', 'statuses', 'lead_sources', 'tags', 'refusal_reasons',
    'payment_methods', 'clients', 'availability_slots', 'trials', 'payments',
    'notes', 'saved_filters', 'app_settings'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;

CREATE FUNCTION public.enforce_user_role_alignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_business_role text;
BEGIN
  SELECT base_role INTO expected_business_role
  FROM public.roles
  WHERE id = NEW.role_id;

  IF expected_business_role IS NULL THEN
    RAISE EXCEPTION 'Role % does not exist', NEW.role_id USING ERRCODE = '23503';
  END IF;

  IF NEW.business_role <> expected_business_role THEN
    RAISE EXCEPTION 'User business_role must match role base_role'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER users_role_alignment
BEFORE INSERT OR UPDATE OF role_id, business_role ON public.users
FOR EACH ROW EXECUTE FUNCTION public.enforce_user_role_alignment();

CREATE FUNCTION public.protect_owner_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_role text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_owner THEN
      RAISE EXCEPTION 'Owner account cannot be deleted'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT OLD.is_owner AND NEW.is_owner THEN
    RAISE EXCEPTION 'Owner privilege is system-managed and cannot be granted'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.is_owner THEN
    SELECT base_role INTO next_role FROM public.roles WHERE id = NEW.role_id;
    IF NOT NEW.is_owner OR NOT NEW.active OR NEW.archived_at IS NOT NULL OR next_role <> 'ADMIN' THEN
      RAISE EXCEPTION 'Owner account cannot be downgraded, archived, or deactivated'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER users_protect_owner_update
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.protect_owner_user();

CREATE TRIGGER users_protect_owner_delete
BEFORE DELETE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.protect_owner_user();

CREATE FUNCTION public.validate_trial_booking()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  slot_row public.availability_slots%ROWTYPE;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;

  SELECT * INTO slot_row
  FROM public.availability_slots
  WHERE id = NEW.slot_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Availability slot % does not exist', NEW.slot_id
      USING ERRCODE = '23503';
  END IF;

  IF slot_row.closer_id <> NEW.closer_id THEN
    RAISE EXCEPTION 'Trial closer does not match availability slot closer'
      USING ERRCODE = '23514';
  END IF;

  IF slot_row.start_at <> NEW.scheduled_at THEN
    RAISE EXCEPTION 'Trial scheduled_at must match availability slot start_at'
      USING ERRCODE = '23514';
  END IF;

  IF slot_row.status = 'BOOKED' AND slot_row.booked_trial_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Availability slot % is already booked', NEW.slot_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trials_validate_booking
BEFORE INSERT OR UPDATE OF active, slot_id, closer_id, scheduled_at ON public.trials
FOR EACH ROW EXECUTE FUNCTION public.validate_trial_booking();

CREATE FUNCTION public.sync_trial_slot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.availability_slots
    SET status = 'FREE', booked_trial_id = NULL
    WHERE id = OLD.slot_id AND booked_trial_id = OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.slot_id <> NEW.slot_id OR (OLD.active AND NOT NEW.active)) THEN
    UPDATE public.availability_slots
    SET status = 'FREE', booked_trial_id = NULL
    WHERE id = OLD.slot_id AND booked_trial_id = OLD.id;
  END IF;

  IF NEW.active THEN
    UPDATE public.availability_slots
    SET status = 'BOOKED', booked_trial_id = NEW.id
    WHERE id = NEW.slot_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trials_sync_slot
AFTER INSERT OR UPDATE OF active, slot_id OR DELETE ON public.trials
FOR EACH ROW EXECUTE FUNCTION public.sync_trial_slot();

CREATE FUNCTION public.validate_payment_correction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  original_row public.payments%ROWTYPE;
  replacement_row public.payments%ROWTYPE;
BEGIN
  SELECT * INTO original_row FROM public.payments WHERE id = NEW.original_payment_id;
  SELECT * INTO replacement_row FROM public.payments WHERE id = NEW.replacement_payment_id;

  IF original_row.client_id <> replacement_row.client_id THEN
    RAISE EXCEPTION 'Corrected payments must belong to the same client'
      USING ERRCODE = '23514';
  END IF;

  IF original_row.voided_at IS NULL THEN
    RAISE EXCEPTION 'Original payment must be voided before recording a correction'
      USING ERRCODE = '23514';
  END IF;

  IF replacement_row.voided_at IS NOT NULL OR replacement_row.corrected_from_payment_id IS DISTINCT FROM original_row.id THEN
    RAISE EXCEPTION 'Replacement payment must be active and reference the original payment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_corrections_validate
BEFORE INSERT OR UPDATE ON public.payment_corrections
FOR EACH ROW EXECUTE FUNCTION public.validate_payment_correction();

CREATE FUNCTION public.require_owner_for_client_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_id text;
  actor_is_owner boolean;
BEGIN
  actor_id := nullif(current_setting('milton.actor_user_id', true), '');

  SELECT is_owner INTO actor_is_owner
  FROM public.users
  WHERE id = actor_id AND active;

  IF actor_id IS NULL OR actor_is_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Permanent client deletion requires an active Owner account'
      USING ERRCODE = '42501';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER clients_owner_only_delete
BEFORE DELETE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.require_owner_for_client_delete();

CREATE FUNCTION public.permanently_delete_client(
  p_client_id text,
  p_actor_user_id text,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_client public.clients%ROWTYPE;
  actor_is_owner boolean;
  removed_trials bigint;
  removed_payments bigint;
  removed_notes bigint;
  removed_history bigint;
  audit_id text;
BEGIN
  IF p_confirmation <> 'УДАЛИТЬ' THEN
    RAISE EXCEPTION 'Strong confirmation is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT is_owner INTO actor_is_owner
  FROM public.users
  WHERE id = p_actor_user_id AND active;

  IF actor_is_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Only the active Owner can permanently delete clients'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target_client
  FROM public.clients
  WHERE id = p_client_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client % was not found', p_client_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO removed_trials FROM public.trials WHERE client_id = p_client_id;
  SELECT count(*) INTO removed_payments FROM public.payments WHERE client_id = p_client_id;
  SELECT count(*) INTO removed_notes FROM public.notes WHERE client_id = p_client_id;
  SELECT count(*) INTO removed_history FROM public.client_history WHERE client_id = p_client_id;

  PERFORM set_config('milton.actor_user_id', p_actor_user_id, true);
  DELETE FROM public.clients WHERE id = p_client_id;

  audit_id := 'audit_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  INSERT INTO public.audit_logs (
    id, actor_user_id, entity_type, entity_id, action, old_value, new_value
  ) VALUES (
    audit_id,
    p_actor_user_id,
    'CLIENT',
    p_client_id,
    'CLIENT_PERMANENTLY_DELETED',
    NULL,
    jsonb_build_object(
      'hardDeleted', true,
      'clientName', target_client.name,
      'relatedRecordsRemoved', jsonb_build_object(
        'trials', removed_trials,
        'payments', removed_payments,
        'notes', removed_notes,
        'history', removed_history
      )
    )
  );

  RETURN jsonb_build_object(
    'id', p_client_id,
    'hardDeleted', true,
    'relatedRecordsRemoved', jsonb_build_object(
      'trials', removed_trials,
      'payments', removed_payments,
      'notes', removed_notes,
      'history', removed_history
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.permanently_delete_client(text, text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT EXECUTE ON FUNCTION public.permanently_delete_client(text, text, text) TO service_role;
  END IF;
END;
$$;

INSERT INTO public.schema_migrations (version, name)
VALUES ('002', 'integrity_and_security');

COMMIT;
