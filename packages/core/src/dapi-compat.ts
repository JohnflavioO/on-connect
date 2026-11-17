import { ConnectionLimitError, createConnection, retireConnection } from "./connections.js";
import type { ClientTransaction } from "./db-transaction.js";
import type { SecretBox } from "./secret-box.js";
import type { AuditActor } from "./tenants.js";
import {
  createWebhookEndpoint,
  updateWebhookEndpoint,
  type WebhookEventType,
} from "./webhooks.js";

/**
 * D-API compatible sessions, for integrators that already speak that
 * contract (Tendi). A "session" is a live connection the integrator names
 * itself (session_key). Each session gets its own tenant, whose external id
 * is the session id, created on demand with room for one connection.
 *
 * Same rules as every repository: scoped by onconnect.current_client_id(),
 * no client id parameter, another client's session is simply not found.
 */

export const DAPI_SESSION_ID = /^[A-Za-z0-9._-]{1,100}$/;

/** Events the D-API envelope can carry today. Grows with each phase. */
export const DAPI_COMPAT_EVENTS: WebhookEventType[] = ["connection.status"];

export interface CompatSession {
  connectionId: string;
  sessionId: string;
  tenantExternalId: string;
  status: "pending" | "connecting" | "connected" | "disconnected" | "error";
  statusReason: string | null;
  phone: string | null;
  displayName: string | null;
}

export class CompatSessionError extends Error {
  constructor(readonly reason: "tenant_inactive" | "limit_reached" | "webhook_limit_reached") {
    super(reason);
    this.name = "CompatSessionError";
  }
}

interface SessionRow {
  id: string;
  session_key: string;
  tenant_external_id: string;
  status: CompatSession["status"];
  status_reason: string | null;
  display_phone_number: string | null;
  verified_name: string | null;
}

function toSession(row: SessionRow): CompatSession {
  return {
    connectionId: row.id,
    sessionId: row.session_key,
    tenantExternalId: row.tenant_external_id,
    status: row.status,
    statusReason: row.status_reason,
    phone: row.display_phone_number,
    displayName: row.verified_name,
  };
}

export async function findCompatSession(
  tx: ClientTransaction,
  sessionId: string,
): Promise<CompatSession | null> {
  const result = await tx.query<SessionRow>(
    `SELECT c.id, c.session_key, t.external_id AS tenant_external_id, c.status, c.status_reason,
            c.display_phone_number, c.verified_name
       FROM onconnect.connections c
       JOIN onconnect.tenants t ON t.id = c.tenant_id AND t.client_id = c.client_id
      WHERE c.client_id = onconnect.current_client_id() AND c.deleted_at IS NULL
        AND c.session_key = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row ? toSession(row) : null;
}

/**
 * Makes sure a live session with this id exists: reuses it, adopts the
 * tenant's unnamed connection, or creates tenant and connection. Calling it
 * again for an existing session changes nothing (the integrator retries).
 */
export async function upsertCompatSession(
  tx: ClientTransaction,
  actor: AuditActor,
  sessionId: string,
): Promise<{ session: CompatSession; created: boolean }> {
  // Two concurrent creations of the same session id must not race.
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtext('compat_session:' || onconnect.current_client_id()::text || ':' || $1))",
    [sessionId],
  );
  const existing = await findCompatSession(tx, sessionId);
  if (existing) return { session: existing, created: false };

  await tx.query(
    `INSERT INTO onconnect.tenants (client_id, external_id, name, max_connections)
     VALUES (onconnect.current_client_id(), $1, $1, 1)
     ON CONFLICT (client_id, external_id) DO NOTHING`,
    [sessionId],
  );

  const adopted = await tx.query<{ id: string }>(
    `UPDATE onconnect.connections c SET session_key = $1
      WHERE c.id = (SELECT c2.id FROM onconnect.connections c2
                      JOIN onconnect.tenants t ON t.id = c2.tenant_id AND t.client_id = c2.client_id
                     WHERE c2.client_id = onconnect.current_client_id() AND t.external_id = $1
                       AND c2.deleted_at IS NULL AND c2.session_key IS NULL
                     ORDER BY c2.created_at LIMIT 1)
      RETURNING c.id`,
    [sessionId],
  );

  if (adopted.rowCount === 0) {
    try {
      const connection = await createConnection(tx, actor, sessionId, { label: sessionId });
      await tx.query(
        `UPDATE onconnect.connections SET session_key = $2
          WHERE client_id = onconnect.current_client_id() AND id = $1`,
        [connection.id, sessionId],
      );
    } catch (error) {
      if (error instanceof ConnectionLimitError) {
        throw new CompatSessionError(
          error.reason === "tenant_inactive" ? "tenant_inactive" : "limit_reached",
        );
      }
      throw error;
    }
  }

  const session = await findCompatSession(tx, sessionId);
  if (!session) throw new Error("Created compat session is not visible");
  return { session, created: adopted.rowCount === 0 };
}

/**
 * Points the client's D-API webhook at `url`. The D-API contract sets the
 * URL per session, but an integrator uses one URL for all of them, so the
 * client keeps a single D-API endpoint and the last URL set wins. Setting it
 * also re-enables an endpoint the worker had disabled.
 */
export async function setCompatWebhook(
  tx: ClientTransaction,
  actor: AuditActor,
  box: SecretBox,
  url: string,
): Promise<void> {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtext('webhook_endpoints:' || onconnect.current_client_id()::text))",
  );
  const current = await tx.query<{ id: string; url: string; status: string; event_types: string[] }>(
    `SELECT id, url, status, event_types FROM onconnect.webhook_endpoints
      WHERE client_id = onconnect.current_client_id() AND payload_format = 'dapi'
      ORDER BY created_at LIMIT 1`,
  );
  const row = current.rows[0];
  if (!row) {
    try {
      await createWebhookEndpoint(tx, actor, box, {
        url,
        eventTypes: DAPI_COMPAT_EVENTS,
        payloadFormat: "dapi",
      });
    } catch (error) {
      if ((error as { reason?: string }).reason === "limit_reached") {
        throw new CompatSessionError("webhook_limit_reached");
      }
      throw error;
    }
    return;
  }
  const sameEvents = row.event_types.length === DAPI_COMPAT_EVENTS.length &&
    DAPI_COMPAT_EVENTS.every((type) => row.event_types.includes(type));
  if (row.url === url && row.status === "active" && sameEvents) return;
  await updateWebhookEndpoint(tx, actor, row.id, {
    url,
    eventTypes: DAPI_COMPAT_EVENTS,
    status: "active",
  });
}

/** Soft-deletes the session's connection; the caller logs the socket out. */
export async function deleteCompatSession(
  tx: ClientTransaction,
  actor: AuditActor,
  sessionId: string,
): Promise<string | null> {
  const session = await findCompatSession(tx, sessionId);
  if (!session) return null;
  return (await retireConnection(tx, actor, session.connectionId)) ? session.connectionId : null;
}
