import { generateApiKey, type DatabasePool } from "@on-connect/core";

/**
 * Reads and writes of the super-admin panel, as onconnect_system (every
 * client). Every write is audited with actor_type 'admin' and the name the
 * admin logged in with. Message content is never read here: only counts.
 */

export interface Admin {
  /** The Caddy basic-auth user, for the audit log. */
  name: string;
}

export function createAdminQueries(pool: DatabasePool, pepper: string) {
  const run = async <Row>(sql: string, params: readonly unknown[] = []) => {
    const connection = await pool.connect();
    try {
      return (await connection.query<Row>(sql, params)).rows;
    } finally {
      connection.release();
    }
  };

  const audit = (admin: Admin, clientId: string | null, action: string, targetType: string,
    targetId: string, metadata: Record<string, unknown> = {}) =>
    run(
      `INSERT INTO onconnect.audit_log (client_id, actor_type, actor_id, action, target_type, target_id, metadata)
       VALUES ($1, 'admin', $2, $3, $4, $5, $6)`,
      [clientId, admin.name, action, targetType, targetId, JSON.stringify(metadata)],
    );

  return {
    async dashboard(period: 7 | 14 | 30 = 7) {
      const [totals] = await run<{
        connected: string; live: string; clients: string; tenants: string;
        sent7: string; received7: string; pending: string; dead24: string; disabled: string;
      }>(
        `SELECT
           (SELECT count(*) FROM onconnect.connections WHERE deleted_at IS NULL AND status = 'connected') AS connected,
           (SELECT count(*) FROM onconnect.connections WHERE deleted_at IS NULL) AS live,
           (SELECT count(*) FROM onconnect.clients WHERE status = 'active') AS clients,
           (SELECT count(*) FROM onconnect.tenants) AS tenants,
           (SELECT count(*) FROM onconnect.messages
             WHERE direction = 'outbound' AND created_at >=
               ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - make_interval(days => $1::integer - 1))
                 AT TIME ZONE 'America/Sao_Paulo')
               AND created_at <= now()) AS sent7,
           (SELECT count(*) FROM onconnect.messages
             WHERE direction = 'inbound' AND created_at >=
               ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - make_interval(days => $1::integer - 1))
                 AT TIME ZONE 'America/Sao_Paulo')
               AND created_at <= now()) AS received7,
           (SELECT count(*) FROM onconnect.webhook_deliveries WHERE status IN ('pending', 'failed')) AS pending,
           (SELECT count(*) FROM onconnect.webhook_deliveries
             WHERE status = 'dead' AND updated_at > now() - interval '24 hours') AS dead24,
           (SELECT count(*) FROM onconnect.webhook_endpoints WHERE status = 'disabled') AS disabled`,
        [period],
      );
      const days = await run<{ day: string; sent: string; received: string }>(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                count(m.id) FILTER (WHERE m.direction = 'outbound') AS sent,
                count(m.id) FILTER (WHERE m.direction = 'inbound') AS received
           FROM generate_series(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - make_interval(days => $1::integer - 1),
                                date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo'), interval '1 day') AS d(day)
           LEFT JOIN onconnect.messages m
             ON m.created_at >= (d.day AT TIME ZONE 'America/Sao_Paulo')
            AND m.created_at < ((d.day + interval '1 day') AT TIME ZONE 'America/Sao_Paulo')
            AND m.created_at <= now()
          GROUP BY d.day ORDER BY d.day`,
        [period],
      );
      return { totals, days };
    },

    connections(filter: { status?: string | undefined; client?: string | undefined; search?: string | undefined }) {
      return run<{
        id: string; session_key: string | null; label: string | null; status: string; status_reason: string | null;
        status_changed_at: Date; display_phone_number: string | null; verified_name: string | null;
        tenant: string; client_slug: string; client_id: string; created_at: Date;
      }>(
        `SELECT c.id, c.session_key, c.label, c.status, c.status_reason, c.status_changed_at,
                c.display_phone_number, c.verified_name, t.external_id AS tenant,
                cl.slug AS client_slug, cl.id AS client_id, c.created_at
           FROM onconnect.connections c
           JOIN onconnect.tenants t ON t.id = c.tenant_id
           JOIN onconnect.clients cl ON cl.id = c.client_id
          WHERE c.deleted_at IS NULL
            AND ($1::text IS NULL OR c.status = $1)
            AND ($2::text IS NULL OR cl.slug = $2)
            AND ($3::text IS NULL OR strpos(lower(concat_ws(' ', c.session_key, c.label, t.external_id,
                 c.display_phone_number, c.verified_name)), lower($3::text)) > 0)
          ORDER BY c.status = 'connected', c.status_changed_at DESC
          LIMIT 500`,
        [filter.status ?? null, filter.client ?? null, filter.search ?? null],
      );
    },

    async connection(id: string) {
      const [row] = await run<{
        id: string; session_key: string | null; status: string; status_reason: string | null;
        status_changed_at: Date; display_phone_number: string | null; verified_name: string | null;
        tenant: string; client_slug: string; client_id: string; provider: string;
        sent7: string; received7: string;
      }>(
        `SELECT c.id, c.session_key, c.status, c.status_reason, c.status_changed_at, c.display_phone_number,
                c.verified_name, t.external_id AS tenant, cl.slug AS client_slug, cl.id AS client_id, c.provider,
                (SELECT count(*) FROM onconnect.messages m WHERE m.connection_id = c.id AND m.direction = 'outbound'
                    AND m.created_at > now() - interval '7 days') AS sent7,
                (SELECT count(*) FROM onconnect.messages m WHERE m.connection_id = c.id AND m.direction = 'inbound'
                    AND m.created_at > now() - interval '7 days') AS received7
           FROM onconnect.connections c
           JOIN onconnect.tenants t ON t.id = c.tenant_id
           JOIN onconnect.clients cl ON cl.id = c.client_id
          WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [id],
      );
      return row ?? null;
    },

    auditConnection: (admin: Admin, clientId: string, connectionId: string, action: string) =>
      audit(admin, clientId, action, "connection", connectionId),

    clients() {
      return run<{
        id: string; slug: string; name: string; status: string; created_at: Date;
        tenants: string; live: string; connected: string; keys: string;
      }>(
        `SELECT cl.id, cl.slug, cl.name, cl.status, cl.created_at,
                (SELECT count(*) FROM onconnect.tenants t WHERE t.client_id = cl.id) AS tenants,
                (SELECT count(*) FROM onconnect.connections c WHERE c.client_id = cl.id AND c.deleted_at IS NULL) AS live,
                (SELECT count(*) FROM onconnect.connections c WHERE c.client_id = cl.id AND c.deleted_at IS NULL
                    AND c.status = 'connected') AS connected,
                (SELECT count(*) FROM onconnect.client_api_credentials k WHERE k.client_id = cl.id
                    AND k.revoked_at IS NULL) AS keys
           FROM onconnect.clients cl ORDER BY cl.created_at`,
      );
    },

    async client(id: string) {
      const [client] = await run<{ id: string; slug: string; name: string; status: string; created_at: Date }>(
        "SELECT id, slug, name, status, created_at FROM onconnect.clients WHERE id = $1", [id]);
      if (!client) return null;
      const tenants = await run<{
        external_id: string; name: string; plan_code: string | null; max_connections: number;
        commercial_status: string; operational_status: string; live: string; created_at: Date;
      }>(
        `SELECT t.external_id, t.name, t.plan_code, t.max_connections, t.commercial_status, t.operational_status,
                (SELECT count(*) FROM onconnect.connections c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) AS live,
                t.created_at
           FROM onconnect.tenants t WHERE t.client_id = $1 ORDER BY t.created_at DESC LIMIT 500`,
        [id],
      );
      const keys = await run<{
        id: string; label: string; key_prefix: string; created_at: Date; last_used_at: Date | null;
        revoked_at: Date | null; expires_at: Date | null;
      }>(
        `SELECT id, label, key_prefix, created_at, last_used_at, revoked_at, expires_at
           FROM onconnect.client_api_credentials WHERE client_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      return { client, tenants, keys };
    },

    /** Null when the slug is taken. */
    async createClient(admin: Admin, slug: string, name: string): Promise<string | null> {
      const [row] = await run<{ id: string }>(
        `INSERT INTO onconnect.clients (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [slug, name],
      );
      if (!row) return null;
      await audit(admin, row.id, "client.created", "client", row.id, { slug });
      return row.id;
    },

    /** The new key, shown once; null when the client does not exist. */
    async issueKey(admin: Admin, clientId: string, label: string): Promise<{ key: string; prefix: string } | null> {
      const issued = generateApiKey(pepper);
      const [row] = await run<{ id: string }>(
        `INSERT INTO onconnect.client_api_credentials (client_id, label, key_prefix, secret_hash)
         SELECT id, $2, $3, $4 FROM onconnect.clients WHERE id = $1 RETURNING id`,
        [clientId, label, issued.prefix, issued.secretHash],
      );
      if (!row) return null;
      await audit(admin, clientId, "api_credential.issued", "api_credential", row.id, {
        keyPrefix: issued.prefix, label,
      });
      return { key: issued.key, prefix: issued.prefix };
    },

    async revokeKey(admin: Admin, clientId: string, keyId: string): Promise<boolean> {
      const [row] = await run<{ key_prefix: string }>(
        `UPDATE onconnect.client_api_credentials SET revoked_at = now()
          WHERE id = $1 AND client_id = $2 AND revoked_at IS NULL RETURNING key_prefix`,
        [keyId, clientId],
      );
      if (!row) return false;
      await audit(admin, clientId, "api_credential.revoked", "api_credential", keyId, { keyPrefix: row.key_prefix });
      return true;
    },

    webhookEndpoints() {
      return run<{
        id: string; client_slug: string; tenant: string | null; url: string; payload_format: string;
        event_types: string[]; status: string; consecutive_failures: number; failing_since: Date | null;
        disabled_at: Date | null; created_at: Date;
      }>(
        `SELECT e.id, cl.slug AS client_slug, t.external_id AS tenant, e.url, e.payload_format, e.event_types,
                e.status, e.consecutive_failures, e.failing_since, e.disabled_at, e.created_at
           FROM onconnect.webhook_endpoints e
           JOIN onconnect.clients cl ON cl.id = e.client_id
           LEFT JOIN onconnect.tenants t ON t.id = e.tenant_id
          ORDER BY cl.slug, e.created_at`,
      );
    },

    deliveries(status: "problems" | "all") {
      return run<{
        id: string; client_slug: string; event_type: string; session: string | null; url: string;
        status: string; attempts: number; last_status_code: number | null; last_error: string | null;
        next_attempt_at: Date; updated_at: Date;
      }>(
        `SELECT d.id, cl.slug AS client_slug, ev.event_type,
                coalesce(c.session_key, t.external_id) AS session, e.url, d.status, d.attempts,
                d.last_status_code, d.last_error, d.next_attempt_at, d.updated_at
           FROM onconnect.webhook_deliveries d
           JOIN onconnect.webhook_events ev ON ev.id = d.event_id
           JOIN onconnect.webhook_endpoints e ON e.id = d.endpoint_id
           JOIN onconnect.clients cl ON cl.id = d.client_id
           JOIN onconnect.tenants t ON t.id = ev.tenant_id
           LEFT JOIN onconnect.connections c ON c.id = ev.connection_id
          WHERE $1 = 'all' OR d.status IN ('pending', 'failed', 'dead')
          ORDER BY d.updated_at DESC
          LIMIT 200`,
        [status],
      );
    },

    /** A failed or abandoned delivery starts over: attempts reset, due now. */
    async resendDelivery(admin: Admin, id: string): Promise<boolean> {
      const [row] = await run<{ client_id: string }>(
        `UPDATE onconnect.webhook_deliveries
            SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
          WHERE id = $1 AND status IN ('failed', 'dead') RETURNING client_id`,
        [id],
      );
      if (!row) return false;
      await audit(admin, row.client_id, "webhook_delivery.resent", "webhook_delivery", id);
      return true;
    },

    async reactivateEndpoint(admin: Admin, id: string): Promise<boolean> {
      const [row] = await run<{ client_id: string }>(
        `UPDATE onconnect.webhook_endpoints
            SET status = 'active', consecutive_failures = 0, failing_since = NULL, disabled_at = NULL
          WHERE id = $1 AND status <> 'active' RETURNING client_id`,
        [id],
      );
      if (!row) return false;
      await run(
        `UPDATE onconnect.webhook_deliveries SET next_attempt_at = now()
          WHERE endpoint_id = $1 AND status IN ('pending', 'failed') AND next_attempt_at > now()`,
        [id],
      );
      await audit(admin, row.client_id, "webhook_endpoint.reactivated", "webhook_endpoint", id);
      return true;
    },
  };
}

export type AdminQueries = ReturnType<typeof createAdminQueries>;
