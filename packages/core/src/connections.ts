import type { ClientTransaction } from "./db-transaction.js";
import type { AuditActor } from "./tenants.js";

/**
 * WhatsApp connections of the authenticated client. Same rules as tenants:
 * every statement is scoped by onconnect.current_client_id() and no function
 * takes a client id. The sessions process updates status with its own
 * system credentials; this module only creates, reads and retires rows.
 */

export type ConnectionStatus = "pending" | "connecting" | "connected" | "disconnected" | "error";

export interface Connection {
  id: string;
  tenantExternalId: string;
  /** The integrator's own session id (D-API compatible layer), if any. */
  sessionKey: string | null;
  provider: "whatsapp_web" | "meta_cloud";
  label: string | null;
  status: ConnectionStatus;
  statusReason: string | null;
  statusChangedAt: Date;
  phoneNumber: string | null;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ConnectionRow {
  id: string;
  tenant_external_id: string;
  session_key: string | null;
  provider: Connection["provider"];
  label: string | null;
  status: ConnectionStatus;
  status_reason: string | null;
  status_changed_at: Date;
  display_phone_number: string | null;
  verified_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `SELECT c.id, t.external_id AS tenant_external_id, c.session_key, c.provider, c.label, c.status,
       c.status_reason, c.status_changed_at, c.display_phone_number, c.verified_name,
       c.created_at, c.updated_at
  FROM onconnect.connections c
  JOIN onconnect.tenants t ON t.id = c.tenant_id AND t.client_id = c.client_id`;

const LIVE = "c.client_id = onconnect.current_client_id() AND c.deleted_at IS NULL";

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    tenantExternalId: row.tenant_external_id,
    sessionKey: row.session_key,
    provider: row.provider,
    label: row.label,
    status: row.status,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
    phoneNumber: row.display_phone_number,
    displayName: row.verified_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectionLimitError extends Error {
  constructor(readonly reason: "tenant_not_found" | "tenant_inactive" | "limit_reached") {
    super(reason);
    this.name = "ConnectionLimitError";
  }
}

/**
 * Creates a WhatsApp Web connection for a tenant, enforcing the tenant's
 * commercial and operational status and its max_connections. The tenant
 * row is locked so two concurrent requests cannot both pass the limit.
 */
export async function createConnection(
  tx: ClientTransaction,
  actor: AuditActor,
  tenantExternalId: string,
  input: { label?: string | null },
): Promise<Connection> {
  const tenant = await tx.query<{
    id: string;
    max_connections: number;
    commercial_status: string;
    operational_status: string;
    live: string;
  }>(
    `SELECT t.id, t.max_connections, t.commercial_status, t.operational_status,
            (SELECT count(*) FROM onconnect.connections c
              WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) AS live
       FROM onconnect.tenants t
      WHERE t.client_id = onconnect.current_client_id() AND t.external_id = $1
      FOR UPDATE`,
    [tenantExternalId],
  );
  const row = tenant.rows[0];
  if (!row) throw new ConnectionLimitError("tenant_not_found");
  if (row.commercial_status !== "active" || row.operational_status !== "active") {
    throw new ConnectionLimitError("tenant_inactive");
  }
  if (Number(row.live) >= row.max_connections) throw new ConnectionLimitError("limit_reached");

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO onconnect.connections (client_id, tenant_id, provider, label, status)
     VALUES (onconnect.current_client_id(), $1, 'whatsapp_web', $2, 'pending')
     RETURNING id`,
    [row.id, input.label ?? null],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("Connection insert returned no row");

  await tx.query(
    `INSERT INTO onconnect.audit_log (client_id, actor_type, actor_id, action, target_type, target_id, metadata)
     VALUES (onconnect.current_client_id(), 'client', $1, 'connection.created', 'connection', $2, $3)`,
    [actor.credentialId, id, JSON.stringify({ tenantExternalId, provider: "whatsapp_web" })],
  );

  const created = await findConnection(tx, id);
  if (!created) throw new Error("Created connection is not visible");
  return created;
}

export async function findConnection(tx: ClientTransaction, id: string): Promise<Connection | null> {
  const result = await tx.query<ConnectionRow>(`${SELECT} WHERE ${LIVE} AND c.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toConnection(row) : null;
}

export async function listConnections(
  tx: ClientTransaction,
  tenantExternalId: string,
): Promise<Connection[]> {
  const result = await tx.query<ConnectionRow>(
    `${SELECT} WHERE ${LIVE} AND t.external_id = $1 ORDER BY c.created_at`,
    [tenantExternalId],
  );
  return result.rows.map(toConnection);
}

/** Soft-deletes the connection. The caller then asks the sessions process to log out. */
export async function retireConnection(
  tx: ClientTransaction,
  actor: AuditActor,
  id: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE onconnect.connections c
        SET deleted_at = now(), status = 'disconnected', status_reason = 'deleted_by_client',
            status_changed_at = now()
      WHERE ${LIVE} AND c.id = $1`,
    [id],
  );
  if (result.rowCount !== 1) return false;
  await tx.query(
    `INSERT INTO onconnect.audit_log (client_id, actor_type, actor_id, action, target_type, target_id)
     VALUES (onconnect.current_client_id(), 'client', $1, 'connection.deleted', 'connection', $2)`,
    [actor.credentialId, id],
  );
  return true;
}
