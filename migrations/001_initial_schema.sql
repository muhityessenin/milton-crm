BEGIN;

CREATE TABLE public.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum_sha256 text,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.roles (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  system_key text UNIQUE CHECK (system_key IS NULL OR system_key IN ('ADMIN', 'MANAGER', 'CLOSER')),
  base_role text NOT NULL CHECK (base_role IN ('ADMIN', 'MANAGER', 'CLOSER')),
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active AND archived_at IS NULL) OR (NOT active))
);

CREATE TABLE public.permissions (
  permission_key text PRIMARY KEY,
  module text NOT NULL CHECK (btrim(module) <> ''),
  action text NOT NULL CHECK (btrim(action) <> ''),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module, action),
  CHECK (permission_key = module || '.' || action)
);

CREATE TABLE public.role_permissions (
  role_id text NOT NULL REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.permissions(permission_key) ON UPDATE CASCADE ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE public.role_scopes (
  role_id text NOT NULL REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE,
  resource text NOT NULL CHECK (resource IN ('clients', 'schedule', 'payments', 'analytics')),
  scope text NOT NULL CHECK (scope IN ('OWN', 'TEAM', 'ALL')),
  PRIMARY KEY (role_id, resource)
);

CREATE TABLE public.users (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  login text NOT NULL CHECK (btrim(login) <> ''),
  password_hash text NOT NULL CHECK (btrim(password_hash) <> ''),
  role_id text NOT NULL REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  business_role text NOT NULL CHECK (business_role IN ('ADMIN', 'MANAGER', 'CLOSER')),
  is_owner boolean NOT NULL DEFAULT false,
  avatar_url text NOT NULL DEFAULT '',
  profile_status text NOT NULL DEFAULT 'WORKING'
    CHECK (profile_status IN ('WORKING', 'DAY_OFF', 'NOT_ACCEPTING')),
  active boolean NOT NULL DEFAULT true,
  team_id text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active AND archived_at IS NULL) OR (NOT active)),
  CHECK (NOT is_owner OR (business_role = 'ADMIN' AND active AND archived_at IS NULL))
);

CREATE UNIQUE INDEX users_login_lower_uidx ON public.users (lower(login));
CREATE UNIQUE INDEX users_single_owner_uidx ON public.users (is_owner) WHERE is_owner;
CREATE INDEX users_role_active_idx ON public.users (role_id, active);
CREATE INDEX users_team_active_idx ON public.users (team_id, active) WHERE team_id IS NOT NULL;

CREATE TABLE public.user_permission_overrides (
  user_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.permissions(permission_key) ON UPDATE CASCADE ON DELETE CASCADE,
  enabled boolean NOT NULL,
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE public.user_scope_overrides (
  user_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  resource text NOT NULL CHECK (resource IN ('clients', 'schedule', 'payments', 'analytics')),
  scope text NOT NULL CHECK (scope IN ('OWN', 'TEAM', 'ALL')),
  PRIMARY KEY (user_id, resource)
);

CREATE TABLE public.statuses (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  color text NOT NULL DEFAULT '#7C879E' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer NOT NULL DEFAULT 0,
  action_type text NOT NULL DEFAULT 'NONE'
    CHECK (action_type IN ('NONE', 'MARK_NO_SHOW', 'REQUIRE_REFUSAL_REASON', 'REQUIRE_RESCHEDULE', 'REQUIRE_PAYMENT')),
  required_fields text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active AND archived_at IS NULL) OR (NOT active)),
  CHECK (
    (action_type IN ('NONE', 'MARK_NO_SHOW') AND required_fields = '{}') OR
    (action_type = 'REQUIRE_REFUSAL_REASON' AND required_fields = ARRAY['refusalReasonId']::text[]) OR
    (action_type = 'REQUIRE_RESCHEDULE' AND required_fields = ARRAY['newSlotId']::text[]) OR
    (action_type = 'REQUIRE_PAYMENT' AND required_fields = ARRAY['amount', 'paymentMethodId', 'paymentDate']::text[])
  )
);

CREATE UNIQUE INDEX statuses_name_lower_uidx ON public.statuses (lower(name));
CREATE INDEX statuses_active_sort_idx ON public.statuses (active, sort_order);

CREATE TABLE public.lead_sources (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active AND archived_at IS NULL) OR (NOT active))
);

CREATE UNIQUE INDEX lead_sources_name_lower_uidx ON public.lead_sources (lower(name));
CREATE INDEX lead_sources_active_sort_idx ON public.lead_sources (active, sort_order);

CREATE TABLE public.tags (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  color text NOT NULL DEFAULT '#EDF0F5' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active AND archived_at IS NULL) OR (NOT active))
);

CREATE UNIQUE INDEX tags_name_lower_uidx ON public.tags (lower(name));
CREATE INDEX tags_active_sort_idx ON public.tags (active, sort_order);

CREATE TABLE public.refusal_reasons (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active AND archived_at IS NULL) OR (NOT active))
);

CREATE UNIQUE INDEX refusal_reasons_name_lower_uidx ON public.refusal_reasons (lower(name));
CREATE INDEX refusal_reasons_active_sort_idx ON public.refusal_reasons (active, sort_order);

CREATE TABLE public.payment_methods (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active AND archived_at IS NULL) OR (NOT active))
);

CREATE UNIQUE INDEX payment_methods_name_lower_uidx ON public.payment_methods (lower(name));
CREATE INDEX payment_methods_active_sort_idx ON public.payment_methods (active, sort_order);

CREATE TABLE public.clients (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  normalized_phone text NOT NULL UNIQUE CHECK (normalized_phone ~ '^\+7[0-9]{10}$'),
  original_phone text NOT NULL CHECK (btrim(original_phone) <> ''),
  original_manager_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  current_manager_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  current_closer_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  current_status_id text NOT NULL REFERENCES public.statuses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  lead_source_id text REFERENCES public.lead_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  registration_comment text NOT NULL DEFAULT '',
  archived_at timestamptz,
  archived_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  archive_reason text CHECK (archive_reason IS NULL OR archive_reason IN ('DUPLICATE', 'TEST', 'ERROR')),
  permanently_deleted_at timestamptz,
  permanently_deleted_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (archived_at IS NULL AND archived_by_user_id IS NULL AND archive_reason IS NULL) OR
    (archived_at IS NOT NULL AND archived_by_user_id IS NOT NULL AND archive_reason IS NOT NULL)
  ),
  CHECK (
    (permanently_deleted_at IS NULL AND permanently_deleted_by_user_id IS NULL) OR
    (permanently_deleted_at IS NOT NULL AND permanently_deleted_by_user_id IS NOT NULL)
  )
);

CREATE INDEX clients_current_manager_idx ON public.clients (current_manager_id, archived_at);
CREATE INDEX clients_original_manager_idx ON public.clients (original_manager_id, created_at);
CREATE INDEX clients_current_closer_idx ON public.clients (current_closer_id, archived_at);
CREATE INDEX clients_current_status_idx ON public.clients (current_status_id, archived_at);
CREATE INDEX clients_lead_source_idx ON public.clients (lead_source_id, created_at);
CREATE INDEX clients_active_created_idx ON public.clients (created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX clients_archived_at_idx ON public.clients (archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE public.client_tags (
  client_id text NOT NULL REFERENCES public.clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES public.tags(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, tag_id)
);

CREATE INDEX client_tags_tag_idx ON public.client_tags (tag_id, client_id);

CREATE TABLE public.availability_slots (
  id text PRIMARY KEY,
  closer_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'FREE' CHECK (status IN ('FREE', 'BOOKED')),
  booked_trial_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (
    (status = 'FREE' AND booked_trial_id IS NULL) OR
    (status = 'BOOKED' AND booked_trial_id IS NOT NULL)
  ),
  UNIQUE (closer_id, start_at)
);

CREATE INDEX availability_slots_closer_time_idx ON public.availability_slots (closer_id, start_at);
CREATE INDEX availability_slots_free_idx ON public.availability_slots (closer_id, start_at) WHERE status = 'FREE';

CREATE TABLE public.trials (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES public.clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  manager_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  closer_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  slot_id text NOT NULL REFERENCES public.availability_slots(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  scheduled_at timestamptz NOT NULL,
  completed_at timestamptz,
  status_at_booking_id text NOT NULL REFERENCES public.statuses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  result_status_id text REFERENCES public.statuses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  result_at timestamptz,
  result_actor_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  attendance_outcome text CHECK (attendance_outcome IS NULL OR attendance_outcome IN ('REACHED', 'NO_SHOW', 'RESCHEDULED')),
  archive_interrupted_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_at IS NULL OR completed_at >= scheduled_at),
  CHECK ((result_status_id IS NULL AND result_at IS NULL AND result_actor_user_id IS NULL) OR result_status_id IS NOT NULL)
);

CREATE UNIQUE INDEX trials_one_active_per_slot_uidx ON public.trials (slot_id) WHERE active;
CREATE UNIQUE INDEX trials_one_active_per_client_uidx ON public.trials (client_id) WHERE active;
CREATE INDEX trials_client_scheduled_idx ON public.trials (client_id, scheduled_at DESC);
CREATE INDEX trials_manager_scheduled_idx ON public.trials (manager_id, scheduled_at);
CREATE INDEX trials_closer_scheduled_idx ON public.trials (closer_id, scheduled_at);
CREATE INDEX trials_status_result_idx ON public.trials (result_status_id, result_at);

ALTER TABLE public.availability_slots
  ADD CONSTRAINT availability_slots_booked_trial_fk
  FOREIGN KEY (booked_trial_id) REFERENCES public.trials(id)
  ON UPDATE CASCADE ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.payments (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES public.clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  manager_attribution_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  closer_attribution_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_method_id text NOT NULL REFERENCES public.payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  payment_date date NOT NULL,
  comment text NOT NULL DEFAULT '',
  created_by_user_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  corrected_from_payment_id text REFERENCES public.payments(id) ON UPDATE CASCADE ON DELETE SET NULL,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (corrected_from_payment_id IS NULL OR corrected_from_payment_id <> id)
);

CREATE INDEX payments_client_date_idx ON public.payments (client_id, payment_date DESC);
CREATE INDEX payments_manager_date_idx ON public.payments (manager_attribution_id, payment_date);
CREATE INDEX payments_closer_date_idx ON public.payments (closer_attribution_id, payment_date);
CREATE INDEX payments_method_date_idx ON public.payments (payment_method_id, payment_date);
CREATE INDEX payments_active_date_idx ON public.payments (payment_date DESC) WHERE voided_at IS NULL;
CREATE UNIQUE INDEX payments_one_replacement_per_payment_uidx
  ON public.payments (corrected_from_payment_id)
  WHERE corrected_from_payment_id IS NOT NULL;

CREATE TABLE public.payment_corrections (
  id text PRIMARY KEY,
  original_payment_id text NOT NULL UNIQUE REFERENCES public.payments(id) ON UPDATE CASCADE ON DELETE CASCADE,
  replacement_payment_id text NOT NULL UNIQUE REFERENCES public.payments(id) ON UPDATE CASCADE ON DELETE CASCADE,
  corrected_by_user_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT '',
  old_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (original_payment_id <> replacement_payment_id)
);

CREATE INDEX payment_corrections_created_idx ON public.payment_corrections (created_at DESC);

CREATE TABLE public.notes (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES public.clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  author_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  note_type text NOT NULL CHECK (note_type IN ('MANAGER_NOTE', 'CLOSER_NOTE', 'ADMIN_NOTE', 'SYSTEM_NOTE')),
  text text NOT NULL CHECK (btrim(text) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notes_client_created_idx ON public.notes (client_id, created_at DESC);
CREATE INDEX notes_author_created_idx ON public.notes (author_user_id, created_at DESC);

CREATE TABLE public.client_history (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES public.clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  actor_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_history_client_created_idx ON public.client_history (client_id, created_at DESC);
CREATE INDEX client_history_actor_created_idx ON public.client_history (actor_user_id, created_at DESC);
CREATE INDEX client_history_event_created_idx ON public.client_history (event_type, created_at DESC);

CREATE TABLE public.notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  client_id text REFERENCES public.clients(id) ON UPDATE CASCADE ON DELETE CASCADE,
  trial_id text REFERENCES public.trials(id) ON UPDATE CASCADE ON DELETE CASCADE,
  type text NOT NULL CHECK (btrim(type) <> ''),
  content text NOT NULL CHECK (btrim(content) <> ''),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_created_idx ON public.notifications (user_id, created_at DESC);
CREATE INDEX notifications_user_unread_idx ON public.notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_trial_type_uidx
  ON public.notifications (user_id, trial_id, type)
  WHERE trial_id IS NOT NULL;

CREATE TABLE public.audit_logs (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id text NOT NULL CHECK (btrim(entity_id) <> ''),
  action text NOT NULL CHECK (btrim(action) <> ''),
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON public.audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON public.audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON public.audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON public.audit_logs (action, created_at DESC);

CREATE TABLE public.saved_filters (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  module text NOT NULL CHECK (module IN ('clients', 'crm', 'schedule', 'analytics', 'payments')),
  name text NOT NULL CHECK (btrim(name) <> ''),
  filter_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module, name)
);

CREATE UNIQUE INDEX saved_filters_one_default_uidx
  ON public.saved_filters (user_id, module)
  WHERE is_default;

CREATE TABLE public.app_settings (
  id text PRIMARY KEY DEFAULT 'global' CHECK (id = 'global'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  timezone text NOT NULL DEFAULT 'Asia/Almaty' CHECK (btrim(timezone) <> ''),
  company_name text NOT NULL DEFAULT 'Milton' CHECK (btrim(company_name) <> ''),
  accent_color text NOT NULL DEFAULT '#3157D5' CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_url text NOT NULL DEFAULT '',
  reminder_minutes integer NOT NULL DEFAULT 30 CHECK (reminder_minutes BETWEEN 0 AND 1440),
  updated_by_user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9A-Fa-f]{64}$'),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_active_idx ON public.sessions (user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON public.sessions (expires_at);

INSERT INTO public.permissions (permission_key, module, action) VALUES
  ('dashboard.view', 'dashboard', 'view'),
  ('clients.view', 'clients', 'view'),
  ('clients.create', 'clients', 'create'),
  ('clients.edit', 'clients', 'edit'),
  ('clients.archive', 'clients', 'archive'),
  ('clients.changeStatus', 'clients', 'changeStatus'),
  ('clients.addNotes', 'clients', 'addNotes'),
  ('clients.viewHistory', 'clients', 'viewHistory'),
  ('clients.reassignManager', 'clients', 'reassignManager'),
  ('clients.reassignCloser', 'clients', 'reassignCloser'),
  ('schedule.view', 'schedule', 'view'),
  ('schedule.createOwnAvailability', 'schedule', 'createOwnAvailability'),
  ('schedule.editOwnAvailability', 'schedule', 'editOwnAvailability'),
  ('schedule.viewOthers', 'schedule', 'viewOthers'),
  ('schedule.manageOthers', 'schedule', 'manageOthers'),
  ('schedule.scheduleTrial', 'schedule', 'scheduleTrial'),
  ('schedule.rescheduleTrial', 'schedule', 'rescheduleTrial'),
  ('crm.view', 'crm', 'view'),
  ('crm.changeStatus', 'crm', 'changeStatus'),
  ('payments.view', 'payments', 'view'),
  ('payments.create', 'payments', 'create'),
  ('payments.edit', 'payments', 'edit'),
  ('payments.viewHistory', 'payments', 'viewHistory'),
  ('analytics.view', 'analytics', 'view'),
  ('analytics.viewManager', 'analytics', 'viewManager'),
  ('analytics.viewCloser', 'analytics', 'viewCloser'),
  ('analytics.viewSource', 'analytics', 'viewSource'),
  ('analytics.viewRefusal', 'analytics', 'viewRefusal'),
  ('analytics.export', 'analytics', 'export'),
  ('users.view', 'users', 'view'),
  ('users.create', 'users', 'create'),
  ('users.edit', 'users', 'edit'),
  ('users.archive', 'users', 'archive'),
  ('users.manageRoles', 'users', 'manageRoles'),
  ('users.managePermissions', 'users', 'managePermissions'),
  ('settings.manageStatuses', 'settings', 'manageStatuses'),
  ('settings.manageRefusalReasons', 'settings', 'manageRefusalReasons'),
  ('settings.manageLeadSources', 'settings', 'manageLeadSources'),
  ('settings.managePaymentMethods', 'settings', 'managePaymentMethods'),
  ('settings.manageTags', 'settings', 'manageTags'),
  ('settings.manageBranding', 'settings', 'manageBranding'),
  ('audit.view', 'audit', 'view');

INSERT INTO public.schema_migrations (version, name)
VALUES ('001', 'initial_schema');

COMMIT;
