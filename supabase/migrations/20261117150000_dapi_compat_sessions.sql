-- On Connect: connection events and the D-API compatible session layer.
--
-- The first integrator (Tendi) already speaks the D-API contract: it names
-- each WhatsApp session itself ("tendi-<organization>") and expects webhooks
-- shaped as { event, sessionId, data }. This migration adds what that layer
-- needs, on top of the native model:
--   * connections.session_key: the integrator's own session id;
--   * webhook_endpoints.payload_format: native body or D-API envelope;
--   * a `connection.status` webhook event for every status change.

alter table onconnect.connections
  add column session_key text
    check (session_key is null or session_key ~ '^[A-Za-z0-9._-]{1,100}$');

-- A session id names one live connection of a client. Once retired, the same
-- id can be reused (the integrator deletes and recreates sessions).
create unique index connections_session_key_uidx
  on onconnect.connections (client_id, session_key)
  where session_key is not null and deleted_at is null;

alter table onconnect.webhook_endpoints
  add column payload_format text not null default 'onconnect'
    check (payload_format in ('onconnect', 'dapi'));

-- Every status change of a connection becomes a webhook event, whoever made
-- it (sessions process, API retirement): the trigger cannot be forgotten by
-- a new code path. It runs as the updating role, so RLS still applies.
create function onconnect.emit_connection_status_event() returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  insert into onconnect.webhook_events
    (client_id, tenant_id, connection_id, event_type, dedupe_key, payload, occurred_at)
  select new.client_id, new.tenant_id, new.id, 'connection.status',
         'connection.status:' || new.id || ':' || gen_random_uuid(),
         jsonb_build_object(
           'connectionId', new.id,
           'sessionId', new.session_key,
           'tenantExternalId', t.external_id,
           'status', new.status,
           'previousStatus', old.status,
           'reason', new.status_reason,
           'phone', new.display_phone_number),
         new.status_changed_at
    from onconnect.tenants t
   where t.id = new.tenant_id and t.client_id = new.client_id;
  return null;
end
$$;

grant execute on function onconnect.emit_connection_status_event() to onconnect_app, onconnect_system;

create trigger emit_connection_status_event
  after update of status on onconnect.connections
  for each row
  when (old.status is distinct from new.status)
  execute function onconnect.emit_connection_status_event();
