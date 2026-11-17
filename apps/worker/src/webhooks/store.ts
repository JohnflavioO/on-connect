import type { DatabasePool, SealedParts } from "@on-connect/core";

/** A delivery the worker holds a lease on, with everything needed to send it. */
export interface ClaimedDelivery {
  id: string;
  /** This attempt's number (1-based). Also the lease token. */
  attempt: number;
  eventId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  tenantExternalId: string;
  connectionId: string | null;
  endpointId: string;
  url: string;
  secret: SealedParts;
  secretKeyVersion: number;
}

export interface FailurePolicy {
  /** Disable only after at least this many failures in a row... */
  disableAfterFailures: number;
  /** ...spanning at least this long without a single success. */
  disableAfterSeconds: number;
}

export interface DeliveryOutcome {
  statusCode: number | null;
  error: string;
}

/** Delivery state, written as onconnect_system (every client's deliveries). */
export interface DeliveryStore {
  /**
   * Takes up to `limit` due deliveries of active endpoints and pushes their
   * next attempt `leaseSeconds` ahead, so a crash mid-send only delays them.
   */
  claimDue(limit: number, leaseSeconds: number): Promise<ClaimedDelivery[]>;
  markDelivered(id: string, attempt: number, statusCode: number): Promise<void>;
  /** `retryAt` null: no attempts left, the delivery is dead. */
  markFailed(
    id: string,
    attempt: number,
    outcome: DeliveryOutcome,
    retryAt: Date | null,
    policy: FailurePolicy,
  ): Promise<{ endpointDisabled: boolean }>;
}

interface ClaimRow {
  id: string;
  attempts: number;
  event_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  tenant_external_id: string;
  connection_id: string | null;
  endpoint_id: string;
  url: string;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_auth_tag: Buffer;
  secret_key_version: number;
}

export function createPostgresDeliveryStore(pool: DatabasePool): DeliveryStore {
  const run = async <Row>(sql: string, params: readonly unknown[]) => {
    const connection = await pool.connect();
    try {
      return await connection.query<Row>(sql, params);
    } finally {
      connection.release();
    }
  };

  return {
    async claimDue(limit, leaseSeconds) {
      // SKIP LOCKED: a second worker (or an overlapping tick) never takes
      // the same rows. The lease is the bumped next_attempt_at plus the
      // attempt counter, which later updates must match.
      const result = await run<ClaimRow>(
        `WITH due AS (
           SELECT d.id FROM onconnect.webhook_deliveries d
             JOIN onconnect.webhook_endpoints e ON e.id = d.endpoint_id
            WHERE d.status IN ('pending', 'failed') AND d.next_attempt_at <= now()
              AND e.status = 'active'
            ORDER BY d.next_attempt_at
            LIMIT $1
            FOR UPDATE OF d SKIP LOCKED
         )
         UPDATE onconnect.webhook_deliveries d
            SET attempts = d.attempts + 1,
                next_attempt_at = now() + make_interval(secs => $2)
           FROM due, onconnect.webhook_events ev, onconnect.webhook_endpoints e, onconnect.tenants t
          WHERE d.id = due.id AND ev.id = d.event_id AND e.id = d.endpoint_id AND t.id = ev.tenant_id
         RETURNING d.id, d.attempts, ev.id AS event_id, ev.event_type, ev.payload, ev.occurred_at,
                   t.external_id AS tenant_external_id, ev.connection_id, e.id AS endpoint_id, e.url,
                   e.secret_ciphertext, e.secret_nonce, e.secret_auth_tag, e.secret_key_version`,
        [limit, leaseSeconds],
      );
      return result.rows.map((row) => ({
        id: row.id,
        attempt: row.attempts,
        eventId: row.event_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: row.occurred_at,
        tenantExternalId: row.tenant_external_id,
        connectionId: row.connection_id,
        endpointId: row.endpoint_id,
        url: row.url,
        secret: { ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, tag: row.secret_auth_tag },
        secretKeyVersion: row.secret_key_version,
      }));
    },

    async markDelivered(id, attempt, statusCode) {
      await run(
        `WITH d AS (
           UPDATE onconnect.webhook_deliveries
              SET status = 'delivered', delivered_at = now(), last_status_code = $3, last_error = NULL
            WHERE id = $1 AND attempts = $2 AND status IN ('pending', 'failed')
           RETURNING endpoint_id
         )
         UPDATE onconnect.webhook_endpoints e
            SET consecutive_failures = 0, failing_since = NULL
           FROM d
          WHERE e.id = d.endpoint_id AND (e.consecutive_failures <> 0 OR e.failing_since IS NOT NULL)`,
        [id, attempt, statusCode],
      );
    },

    async markFailed(id, attempt, outcome, retryAt, policy) {
      const result = await run<{ disabled_now: boolean }>(
        `WITH d AS (
           UPDATE onconnect.webhook_deliveries
              SET status = CASE WHEN $5::timestamptz IS NULL THEN 'dead' ELSE 'failed' END,
                  next_attempt_at = coalesce($5::timestamptz, next_attempt_at),
                  last_status_code = $3, last_error = $4
            WHERE id = $1 AND attempts = $2 AND status IN ('pending', 'failed')
           RETURNING endpoint_id
         )
         -- The conditions read the row after its lock is taken, so concurrent
         -- failures of the same endpoint count correctly.
         UPDATE onconnect.webhook_endpoints w
            SET consecutive_failures = w.consecutive_failures + 1,
                failing_since = coalesce(w.failing_since, now()),
                status = CASE WHEN w.status = 'active'
                               AND w.consecutive_failures + 1 >= $6
                               AND coalesce(w.failing_since, now()) <= now() - make_interval(secs => $7)
                              THEN 'disabled' ELSE w.status END,
                disabled_at = CASE WHEN w.status = 'active'
                                    AND w.consecutive_failures + 1 >= $6
                                    AND coalesce(w.failing_since, now()) <= now() - make_interval(secs => $7)
                                   THEN now() ELSE w.disabled_at END
           FROM d
          WHERE w.id = d.endpoint_id
         RETURNING w.status = 'disabled' AND w.disabled_at = now() AS disabled_now`,
        [id, attempt, outcome.statusCode, outcome.error.slice(0, 200), retryAt,
          policy.disableAfterFailures, policy.disableAfterSeconds],
      );
      return { endpointDisabled: result.rows[0]?.disabled_now === true };
    },
  };
}
