import { randomBytes } from "node:crypto";
import type { ClientTransaction } from "./db-transaction.js";

/**
 * Messages of the authenticated client. Outbound messages are written here
 * together with their message_jobs row (transactional outbox); the sessions
 * process sends them and records status. Every statement is scoped by
 * onconnect.current_client_id(); no function takes a client id.
 */

export type MessageStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "received";

export interface MessageContent {
  type: string;
  text?: string;
  caption?: string;
  mimetype?: string;
  fileName?: string;
  [key: string]: unknown;
}

export interface Message {
  id: string;
  connectionId: string;
  tenantExternalId: string;
  direction: "inbound" | "outbound";
  status: MessageStatus;
  /** The other party: phone digits, or an opaque WhatsApp id (see counterpartJid). */
  counterpart: string;
  counterpartJid: string | null;
  contactName: string | null;
  content: MessageContent;
  clientReference: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
}

interface MessageRow {
  id: string;
  connection_id: string;
  tenant_external_id: string;
  direction: Message["direction"];
  status: MessageStatus;
  counterpart: string;
  payload: { content?: MessageContent; jid?: string; pushName?: string };
  client_reference: string | null;
  provider_message_id: string | null;
  error_code: string | null;
  created_at: Date;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  failed_at: Date | null;
}

const SELECT = `SELECT m.id, m.connection_id, t.external_id AS tenant_external_id, m.direction,
       m.status, m.counterpart, m.payload, m.client_reference, m.provider_message_id,
       m.error_code, m.created_at, m.sent_at, m.delivered_at, m.read_at, m.failed_at
  FROM onconnect.messages m
  JOIN onconnect.tenants t ON t.id = m.tenant_id AND t.client_id = m.client_id`;

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    connectionId: row.connection_id,
    tenantExternalId: row.tenant_external_id,
    direction: row.direction,
    status: row.status,
    counterpart: row.counterpart,
    counterpartJid: row.payload.jid ?? null,
    contactName: row.payload.pushName ?? null,
    content: row.payload.content ?? { type: "unknown" },
    clientReference: row.client_reference,
    providerMessageId: row.provider_message_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    failedAt: row.failed_at,
  };
}

export class MessageRejectedError extends Error {
  constructor(readonly reason: "connection_not_found" | "connection_not_ready" | "tenant_inactive") {
    super(reason);
    this.name = "MessageRejectedError";
  }
}

/**
 * Stores an outbound text message and its outbox job in one transaction.
 * The caller dispatches it to the sessions process after commit; if that
 * dispatch is lost, the sessions process replays pending jobs.
 */
/**
 * A WhatsApp message id in the format WhatsApp Web uses. Set at creation when
 * the caller needs the id at once (the D-API layer answers with it); the
 * sessions process sends with a stored id instead of making a new one.
 */
export function generateWhatsappMessageId(): string {
  return `3EB0${randomBytes(10).toString("hex").toUpperCase()}`;
}

/**
 * What an outbound message carries. Media is given as a public HTTPS URL
 * the sessions process downloads (size-capped, public addresses only) right
 * before sending; the URL is kept with the message, the file is not.
 */
export type OutboundContent =
  | { type: "text"; text: string }
  | { type: "image" | "video"; url: string; caption?: string | null }
  | { type: "audio"; url: string; voice?: boolean }
  | { type: "document"; url: string; fileName?: string | null; mimetype?: string | null; caption?: string | null };

export async function createOutboundText(
  tx: ClientTransaction,
  input: {
    connectionId: string;
    to: string;
    text: string;
    clientReference?: string | null;
    providerMessageId?: string | null;
  },
): Promise<Message> {
  const { text, ...rest } = input;
  return createOutboundMessage(tx, { ...rest, content: { type: "text", text } });
}

export async function createOutboundMessage(
  tx: ClientTransaction,
  input: {
    connectionId: string;
    to: string;
    content: OutboundContent;
    clientReference?: string | null;
    providerMessageId?: string | null;
  },
): Promise<Message> {
  const connection = await tx.query<{
    id: string;
    tenant_id: string;
    provider: string;
    status: string;
    commercial_status: string;
    operational_status: string;
    operational_suspended_at: Date | null;
  }>(
    `SELECT c.id, c.tenant_id, c.provider, c.status, t.commercial_status, t.operational_status,
            c.operational_suspended_at
       FROM onconnect.connections c
       JOIN onconnect.tenants t ON t.id = c.tenant_id AND t.client_id = c.client_id
      WHERE c.client_id = onconnect.current_client_id() AND c.id = $1 AND c.deleted_at IS NULL`,
    [input.connectionId],
  );
  const row = connection.rows[0];
  if (!row) throw new MessageRejectedError("connection_not_found");
  if (row.commercial_status !== "active" || row.operational_status !== "active" ||
      row.operational_suspended_at !== null) {
    throw new MessageRejectedError("tenant_inactive");
  }
  if (row.provider !== "whatsapp_web" || row.status !== "connected") {
    throw new MessageRejectedError("connection_not_ready");
  }

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO onconnect.messages
       (client_id, tenant_id, connection_id, direction, status, message_type, counterpart,
        client_reference, payload, provider_message_id)
     VALUES (onconnect.current_client_id(), $1, $2, 'outbound', 'queued', $7, $3, $4, $5, $6)
     RETURNING id`,
    [
      row.tenant_id,
      row.id,
      input.to,
      input.clientReference ?? null,
      JSON.stringify({ content: input.content }),
      input.providerMessageId ?? null,
      input.content.type,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("Message insert returned no row");
  await tx.query(
    `INSERT INTO onconnect.message_jobs (client_id, message_id)
     VALUES (onconnect.current_client_id(), $1)`,
    [id],
  );
  const message = await findMessage(tx, id);
  if (!message) throw new Error("Created message is not visible");
  return message;
}

export async function findMessage(tx: ClientTransaction, id: string): Promise<Message | null> {
  const result = await tx.query<MessageRow>(
    `${SELECT} WHERE m.client_id = onconnect.current_client_id() AND m.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toMessage(row) : null;
}

export interface MessagePage {
  messages: Message[];
  /** Pass as `before` to fetch older messages; null on the last page. */
  nextCursor: string | null;
}

/** Newest first. The cursor is the id of the oldest message already returned. */
export async function listMessages(
  tx: ClientTransaction,
  connectionId: string,
  options: { limit: number; before?: string | undefined },
): Promise<MessagePage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), 100);
  const result = await tx.query<MessageRow>(
    `${SELECT}
      WHERE m.client_id = onconnect.current_client_id() AND m.connection_id = $1
        AND ($2::uuid IS NULL OR (m.created_at, m.id) < (
              SELECT b.created_at, b.id FROM onconnect.messages b
               WHERE b.id = $2 AND b.client_id = onconnect.current_client_id()))
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [connectionId, options.before ?? null, limit + 1],
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    messages: rows.map(toMessage),
    nextCursor: result.rows.length > limit && last ? last.id : null,
  };
}
