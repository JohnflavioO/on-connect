-- On Connect: initial multi-tenant schema.
--
-- Isolation model
--   * Everything lives in the private schema `onconnect`. It is never added to
--     the Supabase Data API, and anon/authenticated/service_role get no
--     privileges on it, so nothing here is reachable with a Supabase API key.
--   * The backend connects as the dedicated role `onconnect_app` (not as
--     `postgres`, not as `service_role`). That role does not own the tables,
--     so row level security applies to it.
--   * Every transaction declares who it is acting for:
--         set local onconnect.client_id = '<uuid>';   -- one integrator
--   * System operations require the separate onconnect_system database role.
--     The application role cannot elevate privileges through session settings.
--     With neither set, every table returns zero rows and rejects writes.
--     A forgotten WHERE clause can therefore never cross integrators.
--
-- Naming
--   client  = an integrator system that calls the API (Tendi is the first).
--   tenant  = an organization inside a client (a Tendi customer).

create schema if not exists onconnect;

revoke all on schema onconnect from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'onconnect_app') then
    -- Created without login. The password is set out of band, never in Git:
    --   alter role onconnect_app with login password '...';
    create role onconnect_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'onconnect_system') then
    create role onconnect_system nologin;
  end if;
end
$;

grant usage on schema onconnect to onconnect_app, onconnect_system;

-- ---------------------------------------------------------------------------
-- Session context helpers
-- ---------------------------------------------------------------------------

create function onconnect.current_client_id() returns uuid
  language sql stable
  set search_path = ''
  as $$ select nullif(current_setting('onconnect.client_id', true), '')::uuid $$;

-- Unlike a custom GUC, current_user cannot be forged by onconnect_app.
create function onconnect.is_system() returns boolean
  language sql stable
  set search_path = ''
  as $ select current_user = 'onconnect_system' $;

create function onconnect.touch_updated_at() returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- clients: integrator systems
-- ---------------------------------------------------------------------------

create table onconnect.clients (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'suspended')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- client_api_credentials: service-to-service authentication
-- Only a hash of the secret is stored; the secret is shown once at creation.
-- ---------------------------------------------------------------------------

create table onconnect.client_api_credentials (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references onconnect.clients (id) on delete restrict,
  label         text not null,
  key_prefix    text not null unique check (key_prefix ~ '^[A-Za-z0-9_]{8,32}$'),
  secret_hash   text not null,
  scopes        text[] not null default '{}',
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index client_api_credentials_client_idx
  on onconnect.client_api_credentials (client_id);

-- ---------------------------------------------------------------------------
-- tenants: organizations of a client
--
-- Commercial state is reported by the client (plan, limits, delinquency).
-- Operational state is decided by On Connect (abuse, incident). They are
-- separate on purpose, and neither one deletes or disconnects anything.
-- ---------------------------------------------------------------------------

create table onconnect.tenants (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 uuid not null references onconnect.clients (id) on delete restrict,
  external_id               text not null check (length(external_id) between 1 and 200),
  name                      text not null,

  plan_code                 text,
  max_connections           integer not null default 0 check (max_connections >= 0),
  entitlements              jsonb not null default '{}'::jsonb,

  commercial_status         text not null default 'active'
                              check (commercial_status in ('active', 'suspended', 'canceled')),
  commercial_reason         text,
  commercial_changed_at     timestamptz,

  operational_status        text not null default 'active'
                              check (operational_status in ('active', 'suspended')),
  operational_reason        text,
  operational_changed_at    timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (client_id, external_id),
  -- Target for composite foreign keys: a child row can only reference a
  -- tenant that belongs to the same client.
  unique (id, client_id)
);

-- ---------------------------------------------------------------------------
-- connections: one WhatsApp number linked through a provider
--
-- `status` tracks the link with the provider (Meta). Operational suspension
-- is a separate flag, and commercial suspension lives on the tenant.
-- Rows are soft-deleted; a suspension never removes a connection.
-- ---------------------------------------------------------------------------

create table onconnect.connections (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 uuid not null,
  tenant_id                 uuid not null,
  provider                  text not null default 'meta_cloud' check (provider in ('meta_cloud')),
  label                     text,

  status                    text not null default 'pending'
                              check (status in ('pending', 'connecting', 'connected',
                                                'disconnected', 'error')),
  status_reason             text,
  status_changed_at         timestamptz not null default now(),

  operational_suspended_at  timestamptz,
  operational_reason        text,

  -- Meta identifiers. Not secrets.
  waba_id                   text,
  phone_number_id           text,
  display_phone_number      text,
  verified_name             text,
  quality_rating            text,
  messaging_limit_tier      text,
  last_health_check_at      timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz,

  foreign key (tenant_id, client_id)
    references onconnect.tenants (id, client_id) on delete restrict,
  unique (id, client_id),
  unique (id, client_id, tenant_id)
);

-- A Meta phone number can be live in exactly one connection, platform-wide.
create unique index connections_phone_number_uidx
  on onconnect.connections (provider, phone_number_id)
  where phone_number_id is not null and deleted_at is null;

create index connections_tenant_idx
  on onconnect.connections (tenant_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- provider_credentials: provider access tokens
--
-- Encrypted by the application with AES-256-GCM before they reach the
-- database. The key lives only in the server environment, so a database
-- leak or backup does not expose tokens. `key_version` allows rotation.
-- ---------------------------------------------------------------------------

create table onconnect.provider_credentials (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null,
  connection_id uuid not null unique,
  ciphertext    bytea not null,
  nonce         bytea not null check (octet_length(nonce) = 12),
  auth_tag      bytea not null check (octet_length(auth_tag) = 16),
  key_version   integer not null check (key_version > 0),
  token_type    text not null,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  foreign key (connection_id, client_id)
    references onconnect.connections (id, client_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- messages: every message sent or received through a connection
-- ---------------------------------------------------------------------------

create table onconnect.messages (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null,
  tenant_id             uuid not null,
  connection_id         uuid not null,
  direction             text not null check (direction in ('inbound', 'outbound')),
  status                text not null
                          check (status in ('queued', 'sending', 'sent', 'delivered',
                                            'read', 'failed', 'received')),
  message_type          text not null,
  -- The other party's WhatsApp id, digits only.
  counterpart           text not null check (counterpart ~ '^[0-9]{5,20}$'),
  -- The provider's id (wamid). Null until Meta accepts an outbound message.
  provider_message_id   text,
  -- The integrator's own id for an outbound message, echoed back in events.
  client_reference      text,
  payload               jsonb not null,
  error_code            text,
  error_detail          text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  sent_at               timestamptz,
  delivered_at          timestamptz,
  read_at               timestamptz,
  failed_at             timestamptz,

  foreign key (connection_id, client_id, tenant_id)
    references onconnect.connections (id, client_id, tenant_id) on delete restrict,
  foreign key (tenant_id, client_id)
    references onconnect.tenants (id, client_id) on delete restrict,
  unique (id, client_id)
);

-- Status callbacks arrive keyed by wamid; this also dedupes inbound messages.
create unique index messages_provider_id_uidx
  on onconnect.messages (connection_id, provider_message_id)
  where provider_message_id is not null;

create index messages_connection_created_idx
  on onconnect.messages (connection_id, created_at desc);

create index messages_client_reference_idx
  on onconnect.messages (client_id, client_reference)
  where client_reference is not null;

-- ---------------------------------------------------------------------------
-- message_jobs: transactional outbox for outbound sends
--
-- The API inserts the message and its job in one transaction. A dispatcher
-- then hands the job to BullMQ. If Redis is lost, pending rows are replayed,
-- so an accepted message is never silently dropped.
-- ---------------------------------------------------------------------------

create table onconnect.message_jobs (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null,
  message_id       uuid not null unique,
  status           text not null default 'pending'
                     check (status in ('pending', 'enqueued', 'done', 'failed', 'dead')),
  attempts         integer not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  foreign key (message_id, client_id)
    references onconnect.messages (id, client_id) on delete cascade
);

create index message_jobs_due_idx
  on onconnect.message_jobs (next_attempt_at) where status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- webhook_endpoints: where a client receives events
-- `tenant_id` null means the endpoint receives events for all its tenants.
-- The signing secret is encrypted the same way as provider credentials.
-- ---------------------------------------------------------------------------

create table onconnect.webhook_endpoints (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references onconnect.clients (id) on delete restrict,
  tenant_id            uuid,
  url                  text not null check (url ~ '^https://'),
  event_types          text[] not null default '{}',
  status               text not null default 'active'
                         check (status in ('active', 'paused', 'disabled')),
  secret_ciphertext    bytea not null,
  secret_nonce         bytea not null check (octet_length(secret_nonce) = 12),
  secret_auth_tag      bytea not null check (octet_length(secret_auth_tag) = 16),
  secret_key_version   integer not null check (secret_key_version > 0),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  disabled_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  foreign key (tenant_id, client_id)
    references onconnect.tenants (id, client_id) on delete restrict,
  unique (id, client_id)
);

create index webhook_endpoints_client_idx
  on onconnect.webhook_endpoints (client_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- webhook_events: normalized events produced for clients
-- ---------------------------------------------------------------------------

create table onconnect.webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null,
  tenant_id          uuid not null,
  connection_id      uuid,
  event_type         text not null,
  -- Stable key derived from the provider event, so a webhook Meta delivers
  -- twice produces one event.
  dedupe_key         text not null,
  payload            jsonb not null,
  occurred_at        timestamptz not null,
  created_at         timestamptz not null default now(),

  foreign key (tenant_id, client_id)
    references onconnect.tenants (id, client_id) on delete restrict,
  foreign key (connection_id, client_id, tenant_id)
    references onconnect.connections (id, client_id, tenant_id) on delete restrict,
  unique (client_id, dedupe_key),
  unique (id, client_id)
);

create index webhook_events_tenant_created_idx
  on onconnect.webhook_events (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- webhook_deliveries: one row per (event, endpoint), with retry state
-- ---------------------------------------------------------------------------

create table onconnect.webhook_deliveries (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null,
  event_id          uuid not null,
  endpoint_id       uuid not null,
  status            text not null default 'pending'
                      check (status in ('pending', 'delivered', 'failed', 'dead')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  last_status_code  integer,
  last_error        text,
  delivered_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  foreign key (event_id, client_id)
    references onconnect.webhook_events (id, client_id) on delete cascade,
  foreign key (endpoint_id, client_id)
    references onconnect.webhook_endpoints (id, client_id) on delete cascade,
  unique (event_id, endpoint_id)
);

create index webhook_deliveries_due_idx
  on onconnect.webhook_deliveries (next_attempt_at) where status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- idempotency_keys: makes retried API calls return the first result
-- ---------------------------------------------------------------------------

create table onconnect.idempotency_keys (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references onconnect.clients (id) on delete cascade,
  key              text not null check (length(key) between 8 and 200),
  -- Hash of method, path and body: the same key with a different request
  -- is rejected instead of replaying an unrelated response.
  request_hash     text not null,
  response_status  integer,
  response_body    jsonb,
  locked_at        timestamptz,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,

  unique (client_id, key)
);

create index idempotency_keys_expires_idx on onconnect.idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- audit_log: append-only record of administrative and commercial changes
-- ---------------------------------------------------------------------------

create table onconnect.audit_log (
  id           bigint generated always as identity primary key,
  client_id    uuid references onconnect.clients (id) on delete restrict,
  actor_type   text not null check (actor_type in ('client', 'system', 'admin')),
  actor_id     text,
  action       text not null,
  target_type  text not null,
  target_id    text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_client_created_idx on onconnect.audit_log (client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'clients', 'tenants', 'connections', 'provider_credentials', 'messages',
    'message_jobs', 'webhook_endpoints', 'webhook_deliveries'
  ] loop
    execute format(
      'create trigger touch_updated_at before update on onconnect.%I
         for each row execute function onconnect.touch_updated_at()', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges and row level security
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on all tables in schema onconnect to onconnect_app, onconnect_system;
grant execute on all functions in schema onconnect to onconnect_app, onconnect_system;
-- No role membership is granted: application credentials cannot SET ROLE to system.

-- The audit log is append-only for the application.
revoke update, delete on onconnect.audit_log from onconnect_app, onconnect_system;

do $$
declare
  t text;
begin
  -- Tables that carry client_id: visible to their own client, or to system scope.
  foreach t in array array[
    'client_api_credentials', 'tenants', 'connections', 'provider_credentials',
    'messages', 'message_jobs', 'webhook_endpoints', 'webhook_events',
    'webhook_deliveries', 'idempotency_keys', 'audit_log'
  ] loop
    execute format('alter table onconnect.%I enable row level security', t);
    execute format('alter table onconnect.%I force row level security', t);
    execute format(
      'create policy client_isolation on onconnect.%I for all to onconnect_app
         using (onconnect.is_system() or client_id = onconnect.current_client_id())
         with check (onconnect.is_system() or client_id = onconnect.current_client_id())', t);
  end loop;
end
$;

-- Separate explicit system policies; session GUCs cannot enable them.
do $
declare t text;
begin
  foreach t in array array[
    'client_api_credentials', 'tenants', 'connections', 'provider_credentials',
    'messages', 'message_jobs', 'webhook_endpoints', 'webhook_events',
    'webhook_deliveries', 'idempotency_keys', 'audit_log'
  ] loop
    execute format('create policy system_access on onconnect.%I for all to onconnect_system using (true) with check (true)', t);
  end loop;
end
$;

alter table onconnect.clients enable row level security;
alter table onconnect.clients force row level security;

-- A client can read its own row. Creating or changing clients is system-only.
create policy client_reads_itself on onconnect.clients for select to onconnect_app
  using (onconnect.is_system() or id = onconnect.current_client_id());
create policy system_manages_clients on onconnect.clients for all to onconnect_app
  using (onconnect.is_system())
  with check (onconnect.is_system());

create policy system_access on onconnect.clients for all to onconnect_system
  using (true) with check (true);
