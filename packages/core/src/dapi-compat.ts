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
export const DAPI_COMPAT_EVENTS: WebhookEventType[] = [
  "connection.status",
  "message.received",
  "message.status",
];

export interface CompatSession {
  connectionId: string;
  sessionId: string;
  tenantExternalId: string;
  status: "pending" | "connecting" | "connected" | "disconnected" | "error";
  statusReason: string | null;
  /** whatsapp_web (QR) or meta_cloud (official number, no QR). */
  provider: "whatsapp_web" | "meta_cloud";
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
  provider: CompatSession["provider"];
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
    provider: row.provider,
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
            c.provider, c.display_phone_number, c.verified_name
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

export class MetaSignupError extends Error {
  constructor(readonly reason: "session_in_use" | "number_in_use" | "tenant_inactive") {
    super(reason);
    this.name = "MetaSignupError";
  }
}

/**
 * Makes a Meta Cloud API number the connection of session `sessionId`, after
 * the integrator's customer finished Meta's Embedded Signup. The session's
 * tenant is created when missing (room for one connection, as above). A live
 * connection already in the session is refused unless `replace`: then it is
 * retired (soft delete) and its id returned, so the caller logs its WhatsApp
 * Web number out. The new connection waits ("connecting") for the sessions
 * process to finish onboarding with Meta.
 */
export async function attachMetaToSession(
  tx: ClientTransaction,
  actor: AuditActor,
  sessionId: string,
  input: { phoneNumberId: string; wabaId: string; replace: boolean },
): Promise<{ connectionId: string; replaced: string[] }> {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtext('compat_session:' || onconnect.current_client_id()::text || ':' || $1))",
    [sessionId],
  );
  await tx.query(
    `INSERT INTO onconnect.tenants (client_id, external_id, name, max_connections)
     VALUES (onconnect.current_client_id(), $1, $1, 1)
     ON CONFLICT (client_id, external_id) DO NOTHING`,
    [sessionId],
  );
  const tenant = await tx.query<{ id: string; commercial_status: string; operational_status: string }>(
    `SELECT id, commercial_status, operational_status FROM onconnect.tenants
      WHERE client_id = onconnect.current_client_id() AND external_id = $1 FOR UPDATE`,
    [sessionId],
  );
  const row = tenant.rows[0];
  if (!row) throw new Error("Session tenant is not visible");
  if (row.commercial_status !== "active" || row.operational_status !== "active") {
    throw new MetaSignupError("tenant_inactive");
  }
  const live = await tx.query<{ id: string }>(
    `SELECT id FROM onconnect.connections
      WHERE client_id = onconnect.current_client_id() AND deleted_at IS NULL
        AND (tenant_id = $1 OR session_key = $2)
      FOR UPDATE`,
    [row.id, sessionId],
  );
  const replaced = live.rows.map((connection) => connection.id);
  if (replaced.length > 0 && !input.replace) throw new MetaSignupError("session_in_use");
  for (const id of replaced) {
    await tx.query(
      `UPDATE onconnect.connections
          SET deleted_at = now(), status = 'disconnected', status_reason = 'replaced_by_official',
              status_changed_at = now()
        WHERE client_id = onconnect.current_client_id() AND id = $1`,
      [id],
    );
    await tx.query(
      `INSERT INTO onconnect.audit_log (client_id, actor_type, actor_id, action, target_type, target_id, metadata)
       VALUES (onconnect.current_client_id(), 'client', $1, 'connection.deleted', 'connection', $2, $3)`,
      [actor.credentialId, id, JSON.stringify({ reason: "replaced_by_official", sessionId })],
    );
  }
  // A failed insert must not leave the replacements behind: a savepoint
  // turns "number already live elsewhere" into a clean refusal.
  await tx.query("SAVEPOINT meta_signup_insert");
  let created: { id: string } | undefined;
  try {
    created = (await tx.query<{ id: string }>(
      `INSERT INTO onconnect.connections
         (client_id, tenant_id, provider, label, status, status_reason, phone_number_id, waba_id, session_key)
       VALUES (onconnect.current_client_id(), $1, 'meta_cloud', $2, 'connecting', 'meta_signup', $3, $4, $2)
       RETURNING id`,
      [row.id, sessionId, input.phoneNumberId, input.wabaId],
    )).rows[0];
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT meta_signup_insert");
    if ((error as { code?: string }).code === "23505") throw new MetaSignupError("number_in_use");
    throw error;
  }
  if (!created) throw new Error("Meta connection insert returned no row");
  await tx.query(
    `INSERT INTO onconnect.audit_log (client_id, actor_type, actor_id, action, target_type, target_id, metadata)
     VALUES (onconnect.current_client_id(), 'client', $1, 'connection.created', 'connection', $2, $3)`,
    [actor.credentialId, created.id, JSON.stringify({
      provider: "meta_cloud", sessionId, phoneNumberId: input.phoneNumberId, embeddedSignup: true, replaced,
    })],
  );
  return { connectionId: created.id, replaced };
}
