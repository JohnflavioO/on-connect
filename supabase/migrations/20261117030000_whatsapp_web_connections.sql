-- On Connect: WhatsApp Web (unofficial, QR code) connections.
--
-- The first provider On Connect ships links a number through the WhatsApp
-- Web multi-device protocol instead of the Meta Cloud API. Meta Cloud stays
-- supported by the same table; `provider` tells them apart.
--
-- Session keys (the WhatsApp Web auth state) are NOT stored here: they are
-- written many times per minute and live encrypted in the local Redis of the
-- sessions process. This table keeps only what the API and integrators need.

alter table onconnect.connections drop constraint connections_provider_check;
alter table onconnect.connections
  add constraint connections_provider_check
  check (provider in ('meta_cloud', 'whatsapp_web'));

-- The linked account as WhatsApp reports it, e.g. 5511999999999@s.whatsapp.net.
alter table onconnect.connections add column wa_jid text;

-- A number may be live in one WhatsApp Web connection only. Two sessions on
-- the same number would deliver every inbound message twice.
create unique index connections_whatsapp_web_number_uidx
  on onconnect.connections (display_phone_number)
  where provider = 'whatsapp_web'
    and display_phone_number is not null
    and deleted_at is null;

-- The sessions process restores live sessions at boot.
create index connections_whatsapp_web_live_idx
  on onconnect.connections (status)
  where provider = 'whatsapp_web' and deleted_at is null;
