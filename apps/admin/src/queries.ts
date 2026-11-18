import { generateApiKey, type DatabasePool } from "@on-connect/core";

/**
 * Reads and writes of the super-admin panel, as onconnect_system (every
 * client). Every write is audited with actor_type 'admin' and the name the
 * admin logged in with. Message content is never read here: only counts.
 */

export interface Admin {
  /** The authenticated administrator, for the audit log. */
  name: string;
}

export const DELIVERY_PAGE_SIZE = 25;
export interface DeliveryFilters {
  page?: number;
  status?: "pending" | "failed" | "dead" | "delivered" | undefined;
  event?: "connection.status" | "message.received" | "message.status" | undefined;
  search?: string | undefined;
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
        reject_calls: boolean; read_on_reply: boolean;
      }>(
        `SELECT c.id, c.session_key, c.status, c.status_reason, c.status_changed_at, c.display_phone_number,
                c.verified_name, t.external_id AS tenant, cl.slug AS client_slug, cl.id AS client_id, c.provider,
                c.reject_calls, c.read_on_reply,
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

    async updateConnectionBehavior(admin: Admin, id: string, rejectCalls: boolean, readOnReply: boolean) {
      const [row] = await run<{ updated: boolean }>(
        `WITH updated AS (
           UPDATE onconnect.connections
              SET reject_calls = $3, read_on_reply = $4
            WHERE id = $1 AND deleted_at IS NULL AND provider = 'whatsapp_web'
            RETURNING id, client_id, reject_calls, read_on_reply
         )
         INSERT INTO onconnect.audit_log (client_id, actor_type, actor_id, action, target_type, target_id, metadata)
         SELECT client_id, 'admin', $2, 'connection.settings_updated', 'connection', id::text,
                jsonb_build_object('rejectCalls', reject_calls, 'readOnReply', read_on_reply)
           FROM updated
         RETURNING true AS updated`,
        [id, admin.name, rejectCalls, readOnReply],
      );
      return row?.updated ?? false;
    },

    auditConnection: (admin: Admin, clientId: string, connectionId: string, action: string) =>
      audit(admin, clientId, action, "connection", connectionId),

    /** Status changes of one connection, newest first (from connection.status events). */
    connectionHistory(id: string) {
      return run<{ status: string; previous_status: string | null; reason: string | null; at: Date }>(
        `SELECT payload ->> 'status' AS status, payload ->> 'previousStatus' AS previous_status,
                payload ->> 'reason' AS reason, created_at AS at
           FROM onconnect.webhook_events
          WHERE connection_id = $1 AND event_type = 'connection.status'
          ORDER BY created_at DESC, id DESC
          LIMIT 50`,
        [id],
      );
    },

    /** Latest webhook deliveries of events produced by one connection. */
    connectionDeliveries(id: string) {
      return run<{
        id: string; event_type: string; status: string; attempts: number; last_status_code: number | null;
        last_error: string | null; updated_at: Date;
      }>(
        `SELECT d.id, ev.event_type, d.status, d.attempts, d.last_status_code, d.last_error, d.updated_at
           FROM onconnect.webhook_deliveries d
           JOIN onconnect.webhook_events ev ON ev.id = d.event_id
          WHERE ev.connection_id = $1
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT 20`,
        [id],
      );
    },

    /**
     * Retires the connection (soft delete, like the API does); the caller then
     * logs the socket out. The status change emits connection.status.
     */
    async deleteConnection(admin: Admin, id: string): Promise<boolean> {
      const [row] = await run<{ client_id: string; session_key: string | null }>(
        `UPDATE onconnect.connections
            SET deleted_at = now(), status = 'disconnected', status_reason = 'deleted_by_admin',
                status_changed_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING client_id, session_key`,
        [id],
      );
      if (!row) return false;
      await audit(admin, row.client_id, "connection.deleted", "connection", id, { sessionId: row.session_key });
      return true;
    },

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

    async webhookEndpoint(id: string) {
      const [row] = await run<{
        id: string; client_id: string; client_slug: string; tenant: string | null; url: string;
        payload_format: string; event_types: string[]; status: string; consecutive_failures: number;
        failing_since: Date | null; disabled_at: Date | null; created_at: Date; queued: string;
      }>(
        `SELECT e.id, e.client_id, cl.slug AS client_slug, t.external_id AS tenant, e.url, e.payload_format,
                e.event_types, e.status, e.consecutive_failures, e.failing_since, e.disabled_at, e.created_at,
                (SELECT count(*) FROM onconnect.webhook_deliveries d
                  WHERE d.endpoint_id = e.id AND d.status IN ('pending', 'failed')) AS queued
           FROM onconnect.webhook_endpoints e
           JOIN onconnect.clients cl ON cl.id = e.client_id
           LEFT JOIN onconnect.tenants t ON t.id = e.tenant_id
          WHERE e.id = $1`,
        [id],
      );
      return row ?? null;
    },

    /** Paused endpoints keep collecting deliveries and get them on reactivation. */
    async pauseEndpoint(admin: Admin, id: string): Promise<boolean> {
      const [row] = await run<{ client_id: string }>(
        `UPDATE onconnect.webhook_endpoints SET status = 'paused'
          WHERE id = $1 AND status = 'active' RETURNING client_id`,
        [id],
      );
      if (!row) return false;
      await audit(admin, row.client_id, "webhook_endpoint.paused", "webhook_endpoint", id);
      return true;
    },

    /**
     * Event subscription of a native endpoint ([] = every event). D-API
     * endpoints are refused: the compatible session routes reset their list.
     */
    async setEndpointEvents(admin: Admin, id: string, eventTypes: string[]): Promise<boolean> {
      const [row] = await run<{ client_id: string }>(
        `UPDATE onconnect.webhook_endpoints SET event_types = $2::text[]
          WHERE id = $1 AND payload_format = 'onconnect' RETURNING client_id`,
        [id, eventTypes],
      );
      if (!row) return false;
      await audit(admin, row.client_id, "webhook_endpoint.events_changed", "webhook_endpoint", id, { eventTypes });
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

    deliveries(scope: "problems" | "all", filters: DeliveryFilters = {}) {
      const page = Math.max(1, Math.min(9999, Math.floor(filters.page ?? 1) || 1));
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
          WHERE ($1 = 'all' OR d.status IN ('pending', 'failed', 'dead'))
            AND ($2::text IS NULL OR d.status = $2)
            AND ($3::text IS NULL OR ev.event_type = $3)
            AND ($4::text IS NULL OR strpos(lower(concat_ws(' ', cl.slug, c.session_key, t.external_id)), lower($4::text)) > 0)
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT $5 OFFSET $6`,
        [scope, filters.status ?? null, filters.event ?? null, filters.search ?? null,
          DELIVERY_PAGE_SIZE + 1, (page - 1) * DELIVERY_PAGE_SIZE],
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

    /**
     * Platform health over a rolling window: what is wrong now and how the
     * traffic moved, in buckets sized to the window. Counts and timings only.
     */
    async monitoring(period: MonitoringPeriod) {
      const { window, stride } = MONITORING_WINDOWS[period];
      const [totals] = await run<MonitoringTotals>(
        `WITH w AS (SELECT now() - $1::interval AS since)
         SELECT
           (SELECT count(*) FROM onconnect.connections WHERE deleted_at IS NULL) AS live,
           (SELECT count(*) FROM onconnect.connections WHERE deleted_at IS NULL AND status = 'connected') AS connected,
           (SELECT count(*) FROM onconnect.webhook_events, w
             WHERE event_type = 'connection.status' AND created_at >= w.since
               AND payload ->> 'status' IN ('disconnected', 'error')) AS drops,
           (SELECT count(*) FROM onconnect.messages, w
             WHERE direction = 'inbound' AND created_at >= w.since) AS received,
           (SELECT count(*) FROM onconnect.messages, w
             WHERE direction = 'outbound' AND created_at >= w.since) AS sent,
           (SELECT count(*) FROM onconnect.messages, w
             WHERE direction = 'outbound' AND status = 'failed' AND failed_at >= w.since) AS send_failed,
           (SELECT count(*) FROM onconnect.messages
             WHERE direction = 'outbound' AND status IN ('queued', 'sending')
               AND created_at < now() - interval '5 minutes') AS send_stuck,
           (SELECT max(created_at) FROM onconnect.messages WHERE direction = 'inbound') AS last_received_at,
           (SELECT count(*) FROM onconnect.webhook_deliveries, w
             WHERE status = 'delivered' AND delivered_at >= w.since) AS delivered,
           (SELECT count(*) FROM onconnect.webhook_deliveries, w
             WHERE status = 'failed' AND updated_at >= w.since) AS retrying,
           (SELECT count(*) FROM onconnect.webhook_deliveries, w
             WHERE status = 'dead' AND updated_at >= w.since) AS dead,
           (SELECT count(*) FROM onconnect.webhook_deliveries WHERE status IN ('pending', 'failed')) AS queued,
           (SELECT round(avg(extract(epoch FROM d.delivered_at - e.created_at) * 1000))
              FROM onconnect.webhook_deliveries d
              JOIN onconnect.webhook_events e ON e.id = d.event_id, w
             WHERE d.status = 'delivered' AND d.delivered_at >= w.since) AS delivery_ms,
           (SELECT count(*) FROM onconnect.webhook_endpoints WHERE status = 'disabled') AS disabled_endpoints`,
        [window],
      );

      // One row per bucket, aligned to the stride, oldest first. Each series
      // counts the moment its row changed state in that bucket.
      const buckets = await run<MonitoringBucket>(
        `WITH b AS (
           SELECT generate_series(date_bin($2::interval, now() - $1::interval, timestamptz '2000-01-01'),
                                  now(), $2::interval) AS at
         ), m AS (
           SELECT date_bin($2::interval, created_at, timestamptz '2000-01-01') AS at,
                  count(*) FILTER (WHERE direction = 'inbound') AS received,
                  count(*) FILTER (WHERE direction = 'outbound') AS sent
             FROM onconnect.messages WHERE created_at >= now() - $1::interval - $2::interval GROUP BY 1
         ), f AS (
           SELECT date_bin($2::interval, failed_at, timestamptz '2000-01-01') AS at, count(*) AS send_failed
             FROM onconnect.messages
            WHERE status = 'failed' AND failed_at >= now() - $1::interval - $2::interval GROUP BY 1
         ), ok AS (
           SELECT date_bin($2::interval, delivered_at, timestamptz '2000-01-01') AS at, count(*) AS delivered
             FROM onconnect.webhook_deliveries
            WHERE status = 'delivered' AND delivered_at >= now() - $1::interval - $2::interval GROUP BY 1
         ), bad AS (
           SELECT date_bin($2::interval, updated_at, timestamptz '2000-01-01') AS at, count(*) AS webhook_failed
             FROM onconnect.webhook_deliveries
            WHERE status IN ('failed', 'dead') AND updated_at >= now() - $1::interval - $2::interval GROUP BY 1
         ), c AS (
           SELECT date_bin($2::interval, created_at, timestamptz '2000-01-01') AS at, count(*) AS drops
             FROM onconnect.webhook_events
            WHERE event_type = 'connection.status' AND payload ->> 'status' IN ('disconnected', 'error')
              AND created_at >= now() - $1::interval - $2::interval GROUP BY 1
         )
         SELECT b.at, coalesce(m.received, 0) AS received, coalesce(m.sent, 0) AS sent,
                coalesce(f.send_failed, 0) AS send_failed, coalesce(ok.delivered, 0) AS delivered,
                coalesce(bad.webhook_failed, 0) AS webhook_failed, coalesce(c.drops, 0) AS drops
           FROM b
           LEFT JOIN m USING (at) LEFT JOIN f USING (at) LEFT JOIN ok USING (at)
           LEFT JOIN bad USING (at) LEFT JOIN c USING (at)
          ORDER BY b.at`,
        [window, stride],
      );

      const problems = await run<{
        id: string; session_key: string | null; tenant: string; client_slug: string; status: string;
        status_reason: string | null; status_changed_at: Date;
      }>(
        `SELECT c.id, c.session_key, t.external_id AS tenant, cl.slug AS client_slug, c.status,
                c.status_reason, c.status_changed_at
           FROM onconnect.connections c
           JOIN onconnect.tenants t ON t.id = c.tenant_id
           JOIN onconnect.clients cl ON cl.id = c.client_id
          WHERE c.deleted_at IS NULL AND c.status <> 'connected'
          ORDER BY c.status_changed_at DESC LIMIT 10`,
      );
      return { totals, buckets, problems };
    },
  };
}

export type MonitoringPeriod = "1h" | "24h" | "7d" | "30d";

/** Window and bucket size per period: about 24 to 60 points per chart. */
export const MONITORING_WINDOWS: Record<MonitoringPeriod, { window: string; stride: string; label: string }> = {
  "1h": { window: "1 hour", stride: "1 minute", label: "Última hora" },
  "24h": { window: "24 hours", stride: "1 hour", label: "24 horas" },
  "7d": { window: "7 days", stride: "6 hours", label: "7 dias" },
  "30d": { window: "30 days", stride: "1 day", label: "30 dias" },
};

export interface MonitoringTotals {
  live: string; connected: string; drops: string;
  received: string; sent: string; send_failed: string; send_stuck: string; last_received_at: Date | null;
  delivered: string; retrying: string; dead: string; queued: string; delivery_ms: string | null;
  disabled_endpoints: string;
}

export interface MonitoringBucket {
  at: Date; received: string; sent: string; send_failed: string;
  delivered: string; webhook_failed: string; drops: string;
}

export type AdminQueries = ReturnType<typeof createAdminQueries>;
