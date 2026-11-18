alter table onconnect.connections
  add column reject_calls boolean not null default false,
  add column read_on_reply boolean not null default false;

alter table onconnect.messages
  add column read_receipt_sent_at timestamptz;

create index messages_pending_read_receipt_idx
  on onconnect.messages (connection_id, created_at desc, id desc)
  where direction = 'inbound'
    and read_receipt_sent_at is null
    and provider_message_id is not null;
