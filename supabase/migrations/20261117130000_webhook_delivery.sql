-- On Connect: delivery of webhook events to integrators.
--
-- Every row inserted into webhook_events fans out, in the same transaction,
-- into one webhook_deliveries row per endpoint of that client that wants the
-- event. The worker (as onconnect_system) claims due deliveries, signs and
-- POSTs them, and records the outcome. An event can therefore never be
-- committed without its deliveries, and a delivery is retried until it
-- succeeds or runs out of attempts.

-- When the endpoint started failing without a success in between. Together
-- with consecutive_failures it decides when an endpoint is disabled: a short
-- outage of the integrator must not disable it, a dead URL must.
alter table onconnect.webhook_endpoints add column failing_since timestamptz;

create function onconnect.fan_out_webhook_event() returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  -- Runs as the role that inserted the event, so RLS still applies: an
  -- event of one client can only reach endpoints of the same client.
  insert into onconnect.webhook_deliveries (client_id, event_id, endpoint_id)
  select new.client_id, new.id, e.id
    from onconnect.webhook_endpoints e
   where e.client_id = new.client_id
     -- Paused endpoints keep accumulating deliveries and receive them when
     -- resumed. Disabled endpoints get nothing new.
     and e.status in ('active', 'paused')
     and (e.tenant_id is null or e.tenant_id = new.tenant_id)
     and (cardinality(e.event_types) = 0 or new.event_type = any (e.event_types));
  return null;
end
$$;

grant execute on function onconnect.fan_out_webhook_event() to onconnect_app, onconnect_system;

create trigger fan_out_webhook_event
  after insert on onconnect.webhook_events
  for each row execute function onconnect.fan_out_webhook_event();

-- Deleting an endpoint cascades to its deliveries; without this index the
-- cascade scans the whole table.
create index webhook_deliveries_endpoint_idx on onconnect.webhook_deliveries (endpoint_id);
