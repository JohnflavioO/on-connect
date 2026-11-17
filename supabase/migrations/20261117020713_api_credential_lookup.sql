-- On Connect: API-key credential lookup before a client is known.
--
-- Authentication has a chicken-and-egg problem: client_api_credentials is
-- isolated by client_id, but the caller's client_id is exactly what the API
-- key is supposed to prove. The application role therefore cannot read the
-- credential row directly.
--
-- This migration adds one narrow SECURITY DEFINER function that returns the
-- verifier for a single, exact key prefix. It runs as the dedicated role
-- onconnect_auth, which can only SELECT the columns needed for
-- verification. The function never verifies the secret itself: the
-- verifier is an HMAC keyed with a server-side pepper that never reaches the
-- database, so a database dump or arbitrary SQL as onconnect_app cannot turn
-- a returned hash back into a usable key.
--
-- onconnect_app is not a member of onconnect_auth and cannot SET ROLE to it.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'onconnect_auth') then
    create role onconnect_auth nologin noinherit;
  end if;
end
$$;

grant usage on schema onconnect to onconnect_auth;

grant select (id, client_id, key_prefix, secret_hash, scopes, expires_at, revoked_at)
  on onconnect.client_api_credentials to onconnect_auth;
grant select (id, status) on onconnect.clients to onconnect_auth;

create policy auth_lookup on onconnect.client_api_credentials
  for select to onconnect_auth using (true);
create policy auth_lookup on onconnect.clients
  for select to onconnect_auth using (true);

create function onconnect.lookup_api_credential(p_key_prefix text)
  returns table (
    credential_id  uuid,
    client_id      uuid,
    secret_hash    text,
    scopes         text[],
    expires_at     timestamptz,
    revoked_at     timestamptz,
    client_status  text
  )
  language sql stable
  security definer
  set search_path = ''
  as $$
    select c.id, c.client_id, c.secret_hash, c.scopes, c.expires_at, c.revoked_at, cl.status
      from onconnect.client_api_credentials c
      join onconnect.clients cl on cl.id = c.client_id
     where c.key_prefix = p_key_prefix
  $$;

-- Functions are executable by PUBLIC by default; restrict it to the API role.
revoke all on function onconnect.lookup_api_credential(text) from public;
grant execute on function onconnect.lookup_api_credential(text) to onconnect_app;

-- A non-superuser can only hand the function to a role it can SET ROLE to and
-- that holds CREATE on the schema. The admin running migrations is already
-- more privileged than onconnect_auth; CREATE is withdrawn right after.
grant onconnect_auth to current_user;
grant create on schema onconnect to onconnect_auth;
alter function onconnect.lookup_api_credential(text) owner to onconnect_auth;
revoke create on schema onconnect from onconnect_auth;
