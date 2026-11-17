/**
 * Webhook fan-out (trigger) and the delivery store against PostgreSQL 17,
 * as onconnect_system exactly as in production.
 */
import { createPostgresPool } from "@on-connect/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresDeliveryStore } from "../src/webhooks/store.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1";
const CLIENT = "aaaaaaaa-0000-4000-8000-000000000071";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000071";
const SHOP = "aaaaaaaa-0000-4000-8000-000000000072";
const MALL = "aaaaaaaa-0000-4000-8000-000000000073";
const OTHER_TENANT = "bbbbbbbb-0000-4000-8000-000000000072";
const ALL = "aaaaaaaa-0000-4000-8000-000000000074";
const SHOP_ONLY = "aaaaaaaa-0000-4000-8000-000000000075";
const STATUS_ONLY = "aaaaaaaa-0000-4000-8000-000000000076";
const PAUSED = "aaaaaaaa-0000-4000-8000-000000000077";
const DISABLED = "aaaaaaaa-0000-4000-8000-000000000078";
const FOREIGN = "bbbbbbbb-0000-4000-8000-000000000074";

const POLICY = { disableAfterFailures: 3, disableAfterSeconds: 3_600 };

describe.skipIf(!enabled)("webhook deliveries as onconnect_system (PostgreSQL 17)", () => {
  const admin = createPostgresPool({
    host: "localhost", user: "postgres", password: "postgres", database: "postgres", max: 1,
  });
  const system = createPostgresPool({
    host: "localhost", user: "onconnect_system", password: "integration-only",
    database: "postgres", max: 2,
  });
  const store = createPostgresDeliveryStore(system);

  const sql = async <Row>(text: string, params: readonly unknown[] = []) => {
    const connection = await admin.connect();
    try {
      return (await connection.query<Row>(text, params)).rows;
    } finally {
      connection.release();
    }
  };

  const one = async <Row>(text: string, params: readonly unknown[] = []) => {
    const [row] = await sql<Row>(text, params);
    if (!row) throw new Error("expected a row");
    return row;
  };

  /** Inserts an event as onconnect_system, the role the sessions process uses. */
  const event = async (client: string, tenant: string, type: string, key: string) => {
    const connection = await system.connect();
    try {
      const result = await connection.query<{ id: string }>(
        `INSERT INTO onconnect.webhook_events (client_id, tenant_id, event_type, dedupe_key, payload, occurred_at)
         VALUES ($1, $2, $3, $4, '{"messageId":"m"}', now()) RETURNING id`,
        [client, tenant, type, key],
      );
      const id = result.rows[0]?.id; if (!id) throw new Error("event insert returned no row"); return id;
    } finally {
      connection.release();
    }
  };

  const deliveriesOf = (eventId: string) =>
    sql<{ endpoint_id: string }>(
      "SELECT endpoint_id FROM onconnect.webhook_deliveries WHERE event_id = $1 ORDER BY endpoint_id",
      [eventId],
    ).then((rows) => rows.map((row) => row.endpoint_id));

  beforeAll(async () => {
    await sql("ALTER ROLE onconnect_system LOGIN PASSWORD 'integration-only'");
    await sql(
      "INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'deliveries-a', 'A'), ($2, 'deliveries-b', 'B')",
      [CLIENT, OTHER],
    );
    await sql(
      `INSERT INTO onconnect.tenants (id, client_id, external_id, name)
       VALUES ($1, $3, 'shop', 'Shop'), ($2, $3, 'mall', 'Mall'), ($4, $5, 'other', 'Other')`,
      [SHOP, MALL, CLIENT, OTHER_TENANT, OTHER],
    );
    const endpoint = (id: string, client: string, tenant: string | null, types: string[], status: string) =>
      sql(
        `INSERT INTO onconnect.webhook_endpoints
           (id, client_id, tenant_id, url, event_types, status,
            secret_ciphertext, secret_nonce, secret_auth_tag, secret_key_version)
         VALUES ($1, $2, $3, $6, $4::text[], $5,
                 '\\x01', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 1)`,
        [id, client, tenant, types, status, `https://hooks.example.com/${id}`],
      );
    await endpoint(ALL, CLIENT, null, [], "active");
    await endpoint(SHOP_ONLY, CLIENT, SHOP, [], "active");
    await endpoint(STATUS_ONLY, CLIENT, null, ["message.status"], "active");
    await endpoint(PAUSED, CLIENT, null, [], "paused");
    await endpoint(DISABLED, CLIENT, null, [], "disabled");
    await endpoint(FOREIGN, OTHER, null, [], "active");
  });

  afterAll(async () => {
    await system.close();
    await admin.close();
  });

  it("fans an event out to the matching endpoints of its own client only", async () => {
    const received = await event(CLIENT, SHOP, "message.received", "fan-1");
    expect(await deliveriesOf(received)).toEqual([ALL, SHOP_ONLY, PAUSED].sort());

    const status = await event(CLIENT, MALL, "message.status", "fan-2");
    expect(await deliveriesOf(status)).toEqual([ALL, STATUS_ONLY, PAUSED].sort());

    const foreign = await event(OTHER, OTHER_TENANT, "message.received", "fan-3");
    expect(await deliveriesOf(foreign)).toEqual([FOREIGN]);
  });

  it("claims due deliveries of active endpoints once, with everything needed to send", async () => {
    const claimed = await store.claimDue(100, 60);
    const endpoints = claimed.map((d) => d.endpointId);
    expect(endpoints).not.toContain(PAUSED);
    expect(endpoints).not.toContain(DISABLED);
    expect(endpoints.filter((id) => id === ALL)).toHaveLength(2);
    const first = claimed.find((d) => d.endpointId === SHOP_ONLY);
    expect(first).toMatchObject({
      attempt: 1,
      eventType: "message.received",
      tenantExternalId: "shop",
      payload: { messageId: "m" },
      secretKeyVersion: 1,
    });
    expect(first?.secret.nonce).toHaveLength(12);

    // Leased: a second claim does not see them.
    expect(await store.claimDue(100, 60)).toEqual([]);
  });

  it("records success and resets the endpoint's failure streak", async () => {
    await sql(
      "UPDATE onconnect.webhook_endpoints SET consecutive_failures = 2, failing_since = now() WHERE id = $1",
      [SHOP_ONLY],
    );
    const row = await one<{ id: string }>(
      "SELECT id FROM onconnect.webhook_deliveries WHERE endpoint_id = $1", [SHOP_ONLY]);
    await store.markDelivered(row.id, 1, 204);
    const [delivery] = await sql<{ status: string; last_status_code: number; delivered: boolean }>(
      `SELECT status, last_status_code, delivered_at IS NOT NULL AS delivered
         FROM onconnect.webhook_deliveries WHERE id = $1`, [row.id]);
    expect(delivery).toEqual({ status: "delivered", last_status_code: 204, delivered: true });
    const [endpoint] = await sql<{ consecutive_failures: number; failing_since: Date | null }>(
      "SELECT consecutive_failures, failing_since FROM onconnect.webhook_endpoints WHERE id = $1",
      [SHOP_ONLY]);
    expect(endpoint).toEqual({ consecutive_failures: 0, failing_since: null });
  });

  it("ignores an update from an expired lease", async () => {
    const row = await one<{ id: string }>(
      "SELECT id FROM onconnect.webhook_deliveries WHERE endpoint_id = $1", [STATUS_ONLY]);
    await store.markDelivered(row.id, 7, 200);
    const [delivery] = await sql<{ status: string }>(
      "SELECT status FROM onconnect.webhook_deliveries WHERE id = $1", [row.id]);
    expect(delivery?.status).toBe("pending");
  });

  it("schedules retries, then kills the delivery and disables a long-failing endpoint", async () => {
    const row = await one<{ id: string }>(
      "SELECT id FROM onconnect.webhook_deliveries WHERE endpoint_id = $1", [STATUS_ONLY]);
    const id = row.id;
    const retryAt = new Date(Date.now() + 60_000);
    const first = await store.markFailed(id, 1, { statusCode: 500, error: "http_500" }, retryAt, POLICY);
    expect(first.endpointDisabled).toBe(false);
    const [failed] = await sql<{ status: string; last_error: string; next: Date }>(
      "SELECT status, last_error, next_attempt_at AS next FROM onconnect.webhook_deliveries WHERE id = $1", [id]);
    expect(failed).toMatchObject({ status: "failed", last_error: "http_500" });
    expect(failed?.next.getTime()).toBe(retryAt.getTime());

    // Failing for longer than the policy window, on enough attempts.
    await sql(
      `UPDATE onconnect.webhook_endpoints
          SET consecutive_failures = 2, failing_since = now() - interval '2 hours' WHERE id = $1`,
      [STATUS_ONLY]);
    await sql("UPDATE onconnect.webhook_deliveries SET attempts = 2 WHERE id = $1", [id]);
    const last = await store.markFailed(id, 2, { statusCode: null, error: "timeout" }, null, POLICY);
    expect(last.endpointDisabled).toBe(true);

    const [dead] = await sql<{ status: string }>(
      "SELECT status FROM onconnect.webhook_deliveries WHERE id = $1", [id]);
    expect(dead?.status).toBe("dead");
    const [endpoint] = await sql<{ status: string; consecutive_failures: number; disabled: boolean }>(
      `SELECT status, consecutive_failures, disabled_at IS NOT NULL AS disabled
         FROM onconnect.webhook_endpoints WHERE id = $1`, [STATUS_ONLY]);
    expect(endpoint).toEqual({ status: "disabled", consecutive_failures: 3, disabled: true });
  });

  it("does not disable an endpoint after a short outage", async () => {
    const row = await one<{ id: string }>(
      `SELECT d.id FROM onconnect.webhook_deliveries d
         JOIN onconnect.webhook_events e ON e.id = d.event_id
        WHERE d.endpoint_id = $1 AND e.dedupe_key = 'fan-1'`, [ALL]);
    await sql("UPDATE onconnect.webhook_endpoints SET consecutive_failures = 50, failing_since = now() WHERE id = $1",
      [ALL]);
    const result = await store.markFailed(row.id, 1, { statusCode: 502, error: "http_502" },
      new Date(Date.now() + 10_000), POLICY);
    expect(result.endpointDisabled).toBe(false);
  });

  it("gives no new deliveries to a disabled endpoint", async () => {
    const later = await event(CLIENT, SHOP, "message.status", "fan-4");
    expect(await deliveriesOf(later)).not.toContain(STATUS_ONLY);
  });
});
