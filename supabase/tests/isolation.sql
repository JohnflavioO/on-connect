-- Proves the isolation guarantees of the schema. Run after the migrations:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/isolation.sql
-- Everything happens in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\set QUIET 1

-- Supabase ships these roles; create stand-ins on a plain Postgres.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

begin;

create function pg_temp.expect_failure(statement text, expected_state text, label text)
  returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate = expected_state then
      return;
    end if;
    raise exception 'FAIL [%]: expected SQLSTATE %, got % (%)',
      label, expected_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL [%]: statement succeeded but had to be rejected', label;
end
$$;

create function pg_temp.expect_count(query text, expected bigint, label text)
  returns void language plpgsql as $$
declare
  actual bigint;
begin
  execute format('select count(*) from (%s) q', query) into actual;
  if actual <> expected then
    raise exception 'FAIL [%]: expected % rows, got %', label, expected, actual;
  end if;
end
$$;

create function pg_temp.expect_affected(statement text, expected bigint, label text)
  returns void language plpgsql as $$
declare
  actual bigint;
begin
  execute statement;
  get diagnostics actual = row_count;
  if actual <> expected then
    raise exception 'FAIL [%]: expected % affected rows, got %', label, expected, actual;
  end if;
end
$$;

-- Fixed ids keep the assertions readable.
\set client_a '\'aaaaaaaa-0000-4000-8000-000000000001\''
\set client_b '\'bbbbbbbb-0000-4000-8000-000000000001\''
\set tenant_a '\'aaaaaaaa-0000-4000-8000-000000000002\''
\set tenant_b '\'bbbbbbbb-0000-4000-8000-000000000002\''
\set conn_a   '\'aaaaaaaa-0000-4000-8000-000000000003\''

set local role onconnect_app;

-- Application role must not be able to become the system role, even if it sets
-- the former session flag used by the old implementation.
-- CI connects as postgres (superuser), which can SET ROLE regardless of the
-- active role. Check the actual role membership instead.
select pg_temp.expect_count(
  $$select 1 where pg_has_role('onconnect_app', 'onconnect_system', 'MEMBER')$$,
  0, 'app is not a member of the system role');
set local onconnect.scope = 'system';
select pg_temp.expect_count('select 1 from onconnect.clients', 0, 'scope GUC cannot elevate app');
set local onconnect.scope = '';

-- ---------------------------------------------------------------- no context
select pg_temp.expect_count('select 1 from onconnect.clients', 0, 'no context sees no clients');
select pg_temp.expect_failure(
  $$insert into onconnect.clients (slug, name) values ('intruder', 'x')$$,
  '42501', 'no context cannot create a client');

-- -------------------------------------------------------------- system scope
reset role;
set local role onconnect_system;

insert into onconnect.clients (id, slug, name) values
  (:client_a, 'client-a', 'Client A'),
  (:client_b, 'client-b', 'Client B');

insert into onconnect.tenants (id, client_id, external_id, name, max_connections) values
  (:tenant_a, :client_a, 'org-1', 'Org of A', 2),
  (:tenant_b, :client_b, 'org-1', 'Org of B', 2);

insert into onconnect.connections (id, client_id, tenant_id, status, phone_number_id) values
  (:conn_a, :client_a, :tenant_a, 'connected', '100200300');

-- A connection cannot be paired with another tenant of the same client.
insert into onconnect.tenants (client_id, external_id, name) values
  (:client_a, 'org-2', 'Second org of A');
select pg_temp.expect_failure(
  format($$insert into onconnect.messages
    (client_id, tenant_id, connection_id, direction, status, message_type, counterpart, payload)
    select %L, id, %L, 'outbound', 'queued', 'text', '1234567890', '{}'::jsonb
    from onconnect.tenants where external_id = 'org-2'$$, :client_a, :conn_a),
  '23503', 'message cannot link connection to another tenant of same client');
select pg_temp.expect_failure(
  format($$insert into onconnect.webhook_events
    (client_id, tenant_id, connection_id, event_type, dedupe_key, payload, occurred_at)
    select %L, id, %L, 'message', 'cross-tenant', '{}'::jsonb, now()
    from onconnect.tenants where external_id = 'org-2'$$, :client_a, :conn_a),
  '23503', 'event cannot link connection to another tenant of same client');

-- A row may never mix one client's id with another client's tenant.
select pg_temp.expect_failure(
  format($$insert into onconnect.connections (client_id, tenant_id) values (%L, %L)$$,
         :client_b, :tenant_a),
  '23503', 'connection cannot point at another client''s tenant');

-- A phone number is live in one connection only, across all clients.
select pg_temp.expect_failure(
  format($$insert into onconnect.connections (client_id, tenant_id, phone_number_id)
           values (%L, %L, '100200300')$$, :client_b, :tenant_b),
  '23505', 'phone number cannot be connected twice');

-- ...but it can be reused once the first connection is soft-deleted.
savepoint reuse;
update onconnect.connections set deleted_at = now() where id = :conn_a;
insert into onconnect.connections (client_id, tenant_id, phone_number_id)
  values (:client_b, :tenant_b, '100200300');
rollback to savepoint reuse;

insert into onconnect.audit_log (client_id, actor_type, action, target_type)
  values (:client_a, 'system', 'tenant.created', 'tenant');

select pg_temp.expect_failure(
  $$update onconnect.audit_log set action = 'tampered'$$,
  '42501', 'audit log cannot be updated');
select pg_temp.expect_failure(
  $$delete from onconnect.audit_log$$,
  '42501', 'audit log cannot be deleted');

select pg_temp.expect_failure(
  format($$insert into onconnect.webhook_endpoints
             (client_id, url, secret_ciphertext, secret_nonce, secret_auth_tag, secret_key_version)
           values (%L, 'http://insecure.example', '\x00', decode(repeat('00', 12), 'hex'),
                   decode(repeat('00', 16), 'hex'), 1)$$, :client_a),
  '23514', 'webhook endpoint must be https');

select pg_temp.expect_failure(
  format($$insert into onconnect.provider_credentials
             (client_id, connection_id, ciphertext, nonce, auth_tag, key_version, token_type)
           values (%L, %L, '\x00', '\x00', decode(repeat('00', 16), 'hex'), 1, 'bearer')$$,
         :client_a, :conn_a),
  '23514', 'credential nonce must be 12 bytes');

-- ------------------------------------------------------------ acting as A
reset role;
set local role onconnect_app;
set local onconnect.client_id = :client_a;

select pg_temp.expect_count('select 1 from onconnect.clients', 1, 'A sees only itself');
select pg_temp.expect_count('select 1 from onconnect.tenants', 2, 'A sees both its tenants');
select pg_temp.expect_count(
  format('select 1 from onconnect.tenants where id = %L', :tenant_b), 0,
  'A cannot read B''s tenant by id');
select pg_temp.expect_count('select 1 from onconnect.connections', 1, 'A sees its connection');

select pg_temp.expect_failure(
  format($$insert into onconnect.tenants (client_id, external_id, name) values (%L, 'x', 'x')$$,
         :client_b),
  '42501', 'A cannot create a tenant for B');

select pg_temp.expect_failure(
  format($$update onconnect.tenants set client_id = %L where id = %L$$, :client_b, :tenant_a),
  '42501', 'A cannot move its tenant to B');

select pg_temp.expect_failure(
  $$insert into onconnect.clients (slug, name) values ('self-made', 'x')$$,
  '42501', 'A cannot create clients');

-- Writes aimed at rows the caller cannot see touch nothing.
select pg_temp.expect_affected(
  $$update onconnect.clients set name = 'renamed'$$, 0,
  'A cannot modify client rows, not even its own');
select pg_temp.expect_affected(
  format($$update onconnect.tenants set name = 'hijacked' where id = %L$$, :tenant_b), 0,
  'A cannot update B''s tenant');
select pg_temp.expect_affected(
  format($$delete from onconnect.tenants where id = %L$$, :tenant_b), 0,
  'A cannot delete B''s tenant');
-- A owns two tenants. Target the specific row and separately verify that
-- the other tenant is unchanged; a broad UPDATE would legitimately affect both.
select pg_temp.expect_affected(
  format($$update onconnect.tenants set name = 'Org of A, renamed' where id = %L$$, :tenant_a), 1,
  'A can update its selected tenant');
select pg_temp.expect_count(
  $select 1 from onconnect.tenants where external_id = 'org-2' and name = 'Second org of A'$,
  1, 'A second tenant remains unchanged');

select pg_temp.expect_count('select 1 from onconnect.audit_log', 1, 'A reads its own audit entries');

-- ------------------------------------------------------------ acting as B
set local onconnect.client_id = :client_b;

select pg_temp.expect_count('select 1 from onconnect.tenants', 1, 'B sees only its tenant');
select pg_temp.expect_count('select 1 from onconnect.connections', 0, 'B sees none of A''s connections');
select pg_temp.expect_count('select 1 from onconnect.audit_log', 0, 'B sees none of A''s audit entries');
select pg_temp.expect_count(
  $$select 1 from onconnect.tenants where name = 'hijacked'$$, 0, 'B''s tenant was not modified');

-- A malformed context fails closed instead of matching anything.
set local onconnect.client_id = 'not-a-uuid';
select pg_temp.expect_failure(
  'select 1 from onconnect.tenants', '22P02', 'malformed client id is an error');

-- ------------------------------------------------- Supabase API roles
reset role;
select pg_temp.expect_failure(
  'set local role anon; select 1 from onconnect.clients',
  '42501', 'anon has no access to the schema');
reset role;
select pg_temp.expect_failure(
  'set local role authenticated; select 1 from onconnect.clients',
  '42501', 'authenticated has no access to the schema');
reset role;

-- Every table in the schema must have RLS enabled and forced.
select pg_temp.expect_count(
  $$select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'onconnect' and c.relkind = 'r'
      and not (c.relrowsecurity and c.relforcerowsecurity)$$,
  0, 'every table has RLS enabled and forced');

rollback;

\echo isolation tests passed
