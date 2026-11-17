import type { ClientTransaction } from "./db-transaction.js";

/**
 * Tenant access for an authenticated client.
 *
 * Every function runs inside withClientTransaction, so RLS already limits
 * rows to the caller's client. On top of that, each statement names
 * `onconnect.current_client_id()` explicitly, and the client id is never a
 * parameter: there is no argument a caller could forge to reach another
 * client's tenants. Tenants are addressed by the integrator's own
 * external_id, never by a bare internal id.
 */

export const COMMERCIAL_STATUSES = ["active", "suspended", "canceled"] as const;
export type CommercialStatus = (typeof COMMERCIAL_STATUSES)[number];

export interface Tenant {
  id: string;
  externalId: string;
  name: string;
  planCode: string | null;
  maxConnections: number;
  entitlements: Record<string, unknown>;
  commercialStatus: CommercialStatus;
  commercialReason: string | null;
  commercialChangedAt: Date | null;
  operationalStatus: "active" | "suspended";
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantInput {
  name: string;
  planCode?: string | null;
  maxConnections?: number;
  entitlements?: Record<string, unknown>;
}

/** Who performed a write, recorded in the audit log. */
export interface AuditActor {
  credentialId: string;
}

interface TenantRow {
  id: string;
  external_id: string;
  name: string;
  plan_code: string | null;
  max_connections: number;
  entitlements: Record<string, unknown>;
  commercial_status: CommercialStatus;
  commercial_reason: string | null;
  commercial_changed_at: Date | null;
  operational_status: "active" | "suspended";
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, external_id, name, plan_code, max_connections, entitlements,
  commercial_status, commercial_reason, commercial_changed_at,
  operational_status, created_at, updated_at`;
const QUALIFIED_COLUMNS = `t.id, t.external_id, t.name, t.plan_code, t.max_connections, t.entitlements,
  t.commercial_status, t.commercial_reason, t.commercial_changed_at,
  t.operational_status, t.created_at, t.updated_at`;

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    externalId: row.external_id,
    name: row.name,
    planCode: row.plan_code,
    maxConnections: row.max_connections,
    entitlements: row.entitlements,
    commercialStatus: row.commercial_status,
    commercialReason: row.commercial_reason,
    commercialChangedAt: row.commercial_changed_at,
    operationalStatus: row.operational_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function audit(
  tx: ClientTransaction,
  actor: AuditActor,
  action: string,
  tenantId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO onconnect.audit_log (client_id, actor_type, actor_id, action, target_type, target_id, metadata)
     VALUES (onconnect.current_client_id(), 'client', $1, $2, 'tenant', $3, $4)`,
    [actor.credentialId, action, tenantId, JSON.stringify(metadata)],
  );
}

export async function findTenant(tx: ClientTransaction, externalId: string): Promise<Tenant | null> {
  const result = await tx.query<TenantRow>(
    `SELECT ${COLUMNS} FROM onconnect.tenants
      WHERE client_id = onconnect.current_client_id() AND external_id = $1`,
    [externalId],
  );
  const row = result.rows[0];
  return row ? toTenant(row) : null;
}

export interface TenantPage {
  tenants: Tenant[];
  /** Pass as `after` to fetch the next page; null on the last page. */
  nextCursor: string | null;
}

export async function listTenants(
  tx: ClientTransaction,
  options: { limit: number; after?: string | undefined },
): Promise<TenantPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), 100);
  const result = await tx.query<TenantRow>(
    `SELECT ${COLUMNS} FROM onconnect.tenants
      WHERE client_id = onconnect.current_client_id()
        AND ($1::text IS NULL OR external_id > $1)
      ORDER BY external_id
      LIMIT $2`,
    [options.after ?? null, limit + 1],
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    tenants: rows.map(toTenant),
    nextCursor: result.rows.length > limit && last ? last.external_id : null,
  };
}

/** Creates the tenant or replaces its descriptive and commercial-plan fields. */
export async function upsertTenant(
  tx: ClientTransaction,
  actor: AuditActor,
  externalId: string,
  input: TenantInput,
): Promise<{ tenant: Tenant; created: boolean }> {
  const result = await tx.query<TenantRow & { created: boolean }>(
    `INSERT INTO onconnect.tenants (client_id, external_id, name, plan_code, max_connections, entitlements)
     VALUES (onconnect.current_client_id(), $1, $2, $3, $4, $5)
     ON CONFLICT (client_id, external_id) DO UPDATE
       SET name = excluded.name,
           plan_code = excluded.plan_code,
           max_connections = excluded.max_connections,
           entitlements = excluded.entitlements
     RETURNING ${COLUMNS}, (xmax = 0) AS created`,
    [
      externalId,
      input.name,
      input.planCode ?? null,
      input.maxConnections ?? 0,
      JSON.stringify(input.entitlements ?? {}),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Tenant upsert returned no row");
  await audit(tx, actor, row.created ? "tenant.created" : "tenant.updated", row.id, {
    externalId,
    planCode: row.plan_code,
    maxConnections: row.max_connections,
  });
  return { tenant: toTenant(row), created: row.created };
}

/**
 * Records the commercial state reported by the client. It never disconnects
 * or deletes anything; enforcement reads this flag.
 */
export async function setCommercialStatus(
  tx: ClientTransaction,
  actor: AuditActor,
  externalId: string,
  status: CommercialStatus,
  reason: string | null,
): Promise<Tenant | null> {
  const result = await tx.query<TenantRow & { previous_status: CommercialStatus }>(
    `UPDATE onconnect.tenants t
        SET commercial_status = $2,
            commercial_reason = $3,
            commercial_changed_at = CASE WHEN t.commercial_status IS DISTINCT FROM $2
                                         THEN now() ELSE t.commercial_changed_at END
       FROM (SELECT id, commercial_status AS previous_status FROM onconnect.tenants
              WHERE client_id = onconnect.current_client_id() AND external_id = $1
              FOR UPDATE) prev
      WHERE t.id = prev.id
      RETURNING ${QUALIFIED_COLUMNS}, prev.previous_status`,
    [externalId, status, reason],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.previous_status !== status) {
    await audit(tx, actor, "tenant.commercial_status_changed", row.id, {
      externalId,
      from: row.previous_status,
      to: status,
      reason,
    });
  }
  return toTenant(row);
}
