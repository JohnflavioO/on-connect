import type { ConnectionStatus, DatabasePool, OutboundContent } from "@on-connect/core";
import type { InboundMessage, StatusUpdate } from "./message-mapping.js";

export interface ConnectedAccount {
  /** e.g. 5511999999999:12@s.whatsapp.net */
  jid: string;
  name: string | null;
}

export interface SessionRow {
  id: string;
  provider: string;
  status: ConnectionStatus;
  deleted: boolean;
}

/** Durable connection state, written with the onconnect_system role. */
export interface SessionStore {
  load(connectionId: string): Promise<SessionRow | null>;
  /** WhatsApp Web connections that should have an open socket. */
  liveIds(): Promise<string[]>;
  /** Ignored for retired (soft-deleted) connections. */
  setStatus(connectionId: string, status: ConnectionStatus, reason: string | null): Promise<void>;
  markConnected(connectionId: string, account: ConnectedAccount): Promise<"ok" | "number_in_use">;
  /** Stores an inbound message and its event once; duplicates are ignored. */
  recordInbound(connectionId: string, message: InboundMessage): Promise<boolean>;
  /** Moves an outbound message forward (sent → delivered → read), never back. */
  recordStatus(connectionId: string, update: StatusUpdate): Promise<boolean>;
}

export interface OutboundMessage {
  id: string;
  connectionId: string;
  status: string;
  to: string;
  content: OutboundContent;
  providerMessageId: string | null;
}

/** Outbox side of outbound sends, also written as onconnect_system. */
export interface OutboundStore {
  load(messageId: string): Promise<OutboundMessage | null>;
  /** Records the WhatsApp id before the send, so a retry reuses it. */
  markSending(messageId: string, providerMessageId: string): Promise<void>;
  markSent(messageId: string): Promise<void>;
  markFailed(messageId: string, code: string, detail: string): Promise<void>;
  /** Jobs still pending after `olderThanSeconds`: their queue entry may be lost. */
  stalePending(olderThanSeconds: number): Promise<string[]>;
}

/**
 * Digits of the phone number in a WhatsApp JID ("5511...:12@s.whatsapp.net").
 * Only the s.whatsapp.net domain carries a phone number; an "@lid" id is an
 * opaque WhatsApp identifier and must not be stored as one.
 */
export function phoneFromJid(jid: string): string | null {
  const [user = "", domain] = jid.split("@");
  if (domain !== "s.whatsapp.net") return null;
  const digits = user.split(":")[0] ?? "";
  return /^[0-9]{5,20}$/.test(digits) ? digits : null;
}

export function createPostgresSessionStore(pool: DatabasePool): SessionStore {
  const run = async <Row>(sql: string, params: readonly unknown[]) => {
    const connection = await pool.connect();
    try {
      return await connection.query<Row>(sql, params);
    } finally {
      connection.release();
    }
  };

  return {
    async load(connectionId) {
      const result = await run<{ id: string; provider: string; status: ConnectionStatus; deleted: boolean }>(
        `SELECT id, provider, status, deleted_at IS NOT NULL AS deleted
           FROM onconnect.connections WHERE id = $1`,
        [connectionId],
      );
      return result.rows[0] ?? null;
    },

    async liveIds() {
      const result = await run<{ id: string }>(
        `SELECT id FROM onconnect.connections
          WHERE provider = 'whatsapp_web' AND deleted_at IS NULL
            AND status IN ('connecting', 'connected')
          ORDER BY created_at`,
        [],
      );
      return result.rows.map((row) => row.id);
    },

    async setStatus(connectionId, status, reason) {
      await run(
        `UPDATE onconnect.connections
            SET status = $2,
                status_reason = $3,
                status_changed_at = CASE WHEN status IS DISTINCT FROM $2 THEN now()
                                         ELSE status_changed_at END
          WHERE id = $1 AND deleted_at IS NULL`,
        [connectionId, status, reason],
      );
    },

    async markConnected(connectionId, account) {
      try {
        await run(
          `UPDATE onconnect.connections
              SET status = 'connected', status_reason = NULL, status_changed_at = now(),
                  wa_jid = $2, display_phone_number = $3, verified_name = $4,
                  last_health_check_at = now()
            WHERE id = $1 AND deleted_at IS NULL`,
          [connectionId, account.jid, phoneFromJid(account.jid), account.name],
        );
        return "ok";
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return "number_in_use";
        throw error;
      }
    },

    async recordInbound(connectionId, message) {
      const payload = {
        content: message.content,
        jid: message.jid,
        pushName: message.pushName,
        counterpartIsPhone: message.counterpartIsPhone,
        fromMe: message.fromMe,
        mediaUrl: message.mediaUrl ?? null,
      };
      // Message and event in one statement: an event is never produced for a
      // duplicate (same connection + WhatsApp id), and never lost for a new one.
      // A message this process sent through the API already has its WhatsApp
      // id stored, so its own echo is a duplicate here.
      const result = await run<{ id: string }>(
        `WITH c AS (
           SELECT c.id, c.client_id, c.tenant_id, t.external_id
             FROM onconnect.connections c
             JOIN onconnect.tenants t ON t.id = c.tenant_id AND t.client_id = c.client_id
            WHERE c.id = $1 AND c.deleted_at IS NULL
         ), m AS (
           INSERT INTO onconnect.messages
             (client_id, tenant_id, connection_id, direction, status, message_type,
              counterpart, provider_message_id, payload, sent_at)
           SELECT client_id, tenant_id, id,
                  CASE WHEN $8 THEN 'outbound' ELSE 'inbound' END,
                  CASE WHEN $8 THEN 'sent' ELSE 'received' END,
                  $2, $3, $4, $5::jsonb,
                  CASE WHEN $8 THEN $6::timestamptz END
             FROM c
           ON CONFLICT (connection_id, provider_message_id) WHERE provider_message_id IS NOT NULL
             DO NOTHING
           RETURNING id, client_id, tenant_id, connection_id
         )
         INSERT INTO onconnect.webhook_events
           (client_id, tenant_id, connection_id, event_type, dedupe_key, payload, occurred_at)
         SELECT m.client_id, m.tenant_id, m.connection_id, 'message.received',
                'message.received:' || m.id,
                jsonb_build_object('messageId', m.id, 'connectionId', m.connection_id,
                                   'tenantExternalId', c.external_id, 'from', $3::text,
                                   'contactName', $7::text, 'content', $5::jsonb -> 'content',
                                   'providerMessageId', $4::text, 'fromMe', $8::boolean,
                                   'jid', $5::jsonb ->> 'jid',
                                   'counterpartIsPhone', ($5::jsonb ->> 'counterpartIsPhone')::boolean,
                                   'timestamp', $6::timestamptz,
                                   'mediaUrl', $5::jsonb ->> 'mediaUrl'),
                $6
           FROM m CROSS JOIN c
         RETURNING id`,
        [
          connectionId,
          message.content.type,
          message.counterpart,
          message.providerId,
          JSON.stringify(payload),
          message.timestamp,
          message.pushName,
          message.fromMe,
        ],
      );
      return result.rows.length > 0;
    },

    async recordStatus(connectionId, update) {
      const result = await run<{ id: string }>(
        `WITH m AS (
           UPDATE onconnect.messages m
              SET status = $3,
                  sent_at = CASE WHEN $3 = 'sent' THEN coalesce(m.sent_at, now()) ELSE m.sent_at END,
                  delivered_at = CASE WHEN $3 IN ('delivered', 'read')
                                      THEN coalesce(m.delivered_at, now()) ELSE m.delivered_at END,
                  read_at = CASE WHEN $3 = 'read' THEN coalesce(m.read_at, now()) ELSE m.read_at END,
                  failed_at = CASE WHEN $3 = 'failed' THEN now() ELSE m.failed_at END
            WHERE m.connection_id = $1 AND m.provider_message_id = $2 AND m.direction = 'outbound'
              AND (CASE m.status WHEN 'queued' THEN 0 WHEN 'sending' THEN 1 WHEN 'sent' THEN 2
                                 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 ELSE 5 END)
                < (CASE $3 WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 ELSE 5 END)
           RETURNING m.id, m.client_id, m.tenant_id, m.connection_id, m.client_reference,
                     m.provider_message_id
         )
         INSERT INTO onconnect.webhook_events
           (client_id, tenant_id, connection_id, event_type, dedupe_key, payload, occurred_at)
         SELECT client_id, tenant_id, connection_id, 'message.status',
                'message.status:' || id || ':' || $3,
                jsonb_build_object('messageId', id, 'connectionId', connection_id,
                                   'clientReference', client_reference, 'status', $3::text,
                                   'providerMessageId', provider_message_id),
                now()
           FROM m
         ON CONFLICT (client_id, dedupe_key) DO NOTHING
         RETURNING id`,
        [connectionId, update.providerId, update.status],
      );
      return result.rows.length > 0;
    },
  };
}

export function createPostgresOutboundStore(pool: DatabasePool): OutboundStore {
  const run = async <Row>(sql: string, params: readonly unknown[]) => {
    const connection = await pool.connect();
    try {
      return await connection.query<Row>(sql, params);
    } finally {
      connection.release();
    }
  };

  return {
    async load(messageId) {
      const result = await run<{
        id: string; connection_id: string; status: string; counterpart: string;
        content: OutboundContent | null; provider_message_id: string | null;
      }>(
        `SELECT id, connection_id, status, counterpart, payload -> 'content' AS content,
                provider_message_id
           FROM onconnect.messages WHERE id = $1 AND direction = 'outbound'`,
        [messageId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        connectionId: row.connection_id,
        status: row.status,
        to: row.counterpart,
        content: row.content ?? { type: "text", text: "" },
        providerMessageId: row.provider_message_id,
      };
    },

    async markSending(messageId, providerMessageId) {
      await run(
        `UPDATE onconnect.messages
            SET status = 'sending', provider_message_id = coalesce(provider_message_id, $2)
          WHERE id = $1 AND status IN ('queued', 'sending')`,
        [messageId, providerMessageId],
      );
      await run(
        `UPDATE onconnect.message_jobs SET status = 'enqueued', attempts = attempts + 1
          WHERE message_id = $1`,
        [messageId],
      );
    },

    async markSent(messageId) {
      // An event may already have moved it past "sent"; never move it back.
      await run(
        `WITH m AS (
           UPDATE onconnect.messages
              SET status = CASE WHEN status IN ('queued', 'sending') THEN 'sent' ELSE status END,
                  sent_at = coalesce(sent_at, now())
            WHERE id = $1
           RETURNING id, client_id, tenant_id, connection_id, client_reference, provider_message_id
         ), j AS (
           UPDATE onconnect.message_jobs SET status = 'done', last_error = NULL WHERE message_id = $1
         )
         INSERT INTO onconnect.webhook_events
           (client_id, tenant_id, connection_id, event_type, dedupe_key, payload, occurred_at)
         SELECT client_id, tenant_id, connection_id, 'message.status',
                'message.status:' || id || ':sent',
                jsonb_build_object('messageId', id, 'connectionId', connection_id,
                                   'clientReference', client_reference, 'status', 'sent',
                                   'providerMessageId', provider_message_id),
                now()
           FROM m
         ON CONFLICT (client_id, dedupe_key) DO NOTHING`,
        [messageId],
      );
    },

    async markFailed(messageId, code, detail) {
      await run(
        `WITH m AS (
           UPDATE onconnect.messages
              SET status = 'failed', failed_at = now(), error_code = $2, error_detail = $3
            WHERE id = $1 AND status IN ('queued', 'sending')
           RETURNING id, client_id, tenant_id, connection_id, client_reference, provider_message_id
         ), j AS (
           UPDATE onconnect.message_jobs SET status = 'dead', last_error = $2 WHERE message_id = $1
         )
         INSERT INTO onconnect.webhook_events
           (client_id, tenant_id, connection_id, event_type, dedupe_key, payload, occurred_at)
         SELECT client_id, tenant_id, connection_id, 'message.status',
                'message.status:' || id || ':failed',
                jsonb_build_object('messageId', id, 'connectionId', connection_id,
                                   'clientReference', client_reference, 'status', 'failed',
                                   'error', $2::text, 'providerMessageId', provider_message_id),
                now()
           FROM m
         ON CONFLICT (client_id, dedupe_key) DO NOTHING`,
        [messageId, code, detail.slice(0, 500)],
      );
    },

    async stalePending(olderThanSeconds) {
      const result = await run<{ message_id: string }>(
        // "enqueued" too: if Redis lost a job mid-retry it would otherwise
        // stay there forever. The queue's job id dedupes a job still alive.
        `SELECT j.message_id FROM onconnect.message_jobs j
          WHERE j.status IN ('pending', 'enqueued')
            AND j.updated_at < now() - make_interval(secs => $1)
          ORDER BY j.created_at LIMIT 500`,
        [olderThanSeconds],
      );
      return result.rows.map((row) => row.message_id);
    },
  };
}
