/**
 * Panel queries against PostgreSQL 17 as onconnect_system: counts, the
 * lists across clients, key issuing/revoking and webhook recovery, all
 * audited as 'admin'.
 */
import { createApiKeyAuthenticator, createPostgresCredentialStore, createPostgresPool } from "@on-connect/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminQueries } from "../src/queries.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1";
const PEPPER = "admin-integration-pepper-admin-integration";
const CLIENT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const TENANT = "aaaaaaaa-0000-4000-8000-0000000000a2";
const CONN = "aaaaaaaa-0000-4000-8000-0000000000a3";
const ENDPOINT = "aaaaaaaa-0000-4000-8000-0000000000a4";
const EVENT = "aaaaaaaa-0000-4000-8000-0000000000a5";
const DELIVERY = "aaaaaaaa-0000-4000-8000-0000000000a6";
const admin = { name: "john" };

describe.skipIf(!enabled)("admin panel queries (PostgreSQL 17)", () => {
  const superuser = createPostgresPool({
    host: "localhost", user: "postgres", password: "postgres", database: "postgres", max: 1,
  });
  const system = createPostgresPool({
    host: "localhost", user: "onconnect_system", password: "integration-only", database: "postgres", max: 2,
  });
  const app = createPostgresPool({
    host: "localhost", user: "onconnect_app", password: "integration-only", database: "postgres", max: 1,
  });
  const queries = createAdminQueries(system, PEPPER);

  const sql = async <Row>(text: string, params: readonly unknown[] = []) => {
    const connection = await superuser.connect();
    try {
      return (await connection.query<Row>(text, params)).rows;
    } finally {
      connection.release();
    }
  };

  beforeAll(async () => {
    await sql("ALTER ROLE onconnect_system LOGIN PASSWORD 'integration-only'");
    await sql("ALTER ROLE onconnect_app LOGIN PASSWORD 'integration-only'");
    await sql("INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'admin-panel', 'Painel')", [CLIENT]);
    await sql(
      "INSERT INTO onconnect.tenants (id, client_id, external_id, name, max_connections) VALUES ($1, $2, 'loja', 'Loja', 1)",
      [TENANT, CLIENT],
    );
    await sql(
      `INSERT INTO onconnect.connections (id, client_id, tenant_id, provider, status, session_key, display_phone_number)
       VALUES ($1, $2, $3, 'whatsapp_web', 'connected', 'tendi-loja', '5585999990000')`,
      [CONN, CLIENT, TENANT],
    );
    for (const direction of ["outbound", "outbound", "inbound"]) {
      await sql(
        `INSERT INTO onconnect.messages (client_id, tenant_id, connection_id, direction, status, message_type, counterpart, payload)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'inbound' THEN 'received' ELSE 'sent' END, 'text', '5585999991111', '{}')`,
        [CLIENT, TENANT, CONN, direction],
      );
    }
    await sql(
      `INSERT INTO onconnect.webhook_endpoints
         (id, client_id, url, status, payload_format, consecutive_failures, disabled_at,
          secret_ciphertext, secret_nonce, secret_auth_tag, secret_key_version)
       VALUES ($1, $2, 'https://hooks.example.com/x', 'disabled', 'dapi', 12, now(),
               '\\x01', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 1)`,
      [ENDPOINT, CLIENT],
    );
    await sql(
      `INSERT INTO onconnect.webhook_events (id, client_id, tenant_id, connection_id, event_type, dedupe_key, payload, occurred_at)
       VALUES ($1, $2, $3, $4, 'message.received', 'admin-test-1', '{}', now())`,
      [EVENT, CLIENT, TENANT, CONN],
    );
    // A disabled endpoint gets no fan-out: the dead delivery is inserted by hand.
    await sql(
      `INSERT INTO onconnect.webhook_deliveries (id, client_id, event_id, endpoint_id, status, attempts, last_error)
       VALUES ($1, $2, $3, $4, 'dead', 12, 'http_500')`,
      [DELIVERY, CLIENT, EVENT, ENDPOINT],
    );
  });

  afterAll(async () => {
    await system.close();
    await app.close();
    await superuser.close();
  });

  it("counts the dashboard across clients", async () => {
    const { totals, days } = await queries.dashboard();
    expect(Number(totals?.connected)).toBeGreaterThanOrEqual(1);
    expect(Number(totals?.sent7)).toBeGreaterThanOrEqual(2);
    expect(Number(totals?.received7)).toBeGreaterThanOrEqual(1);
    expect(Number(totals?.disabled)).toBeGreaterThanOrEqual(1);
    expect(days).toHaveLength(7);
    const today = days.at(-1);
    expect(Number(today?.sent)).toBeGreaterThanOrEqual(2);
  });

  it("lists and filters connections, and reads one with its 7-day counts", async () => {
    const mine = await queries.connections({ client: "admin-panel" });
    expect(mine.map((c) => c.session_key)).toEqual(["tendi-loja"]);
    expect(await queries.connections({ client: "admin-panel", status: "error" })).toEqual([]);
    expect((await queries.connections({ client: "admin-panel", search: "TENDI-LOJA" })).map((c) => c.id)).toEqual([CONN]);
    expect((await queries.connections({ client: "admin-panel", search: "99990000" })).map((c) => c.id)).toEqual([CONN]);
    expect(await queries.connections({ client: "admin-panel", search: "%" })).toEqual([]);
    const one = await queries.connection(CONN);
    expect(one).toMatchObject({ client_slug: "admin-panel", tenant: "loja", sent7: "2", received7: "1" });
  });

  it("uses São Paulo calendar boundaries consistently for totals and daily chart data", async () => {
    const before = await queries.dashboard(7);
    const inserted = await sql<{ id: string }>(
      `INSERT INTO onconnect.messages
         (client_id, tenant_id, connection_id, direction, status, message_type, counterpart, payload, created_at)
       SELECT $1, $2, $3, 'outbound', 'sent', 'text', '5585999991111', '{}',
              ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - interval '6 days')
                AT TIME ZONE 'America/Sao_Paulo') + delta
         FROM (VALUES (interval '-1 second'), (interval '1 second')) AS boundaries(delta)
       RETURNING id`,
      [CLIENT, TENANT, CONN],
    );
    try {
      const after = await queries.dashboard(7);
      expect(Number(after.totals?.sent7) - Number(before.totals?.sent7)).toBe(1);
      for (const period of [7, 14, 30] as const) {
        const data = await queries.dashboard(period);
        expect(data.days).toHaveLength(period);
        expect(data.days.reduce((total, d) => total + Number(d.sent), 0)).toBe(Number(data.totals?.sent7));
        expect(data.days.reduce((total, d) => total + Number(d.received), 0)).toBe(Number(data.totals?.received7));
      }
    } finally {
      await sql("DELETE FROM onconnect.messages WHERE id = ANY($1::uuid[])", [inserted.map((m) => m.id)]);
    }
  });

  it("counts the previous period of the same length for the dashboard comparison", async () => {
    const before = await queries.dashboard(7);
    const inserted = await sql<{ id: string }>(
      `INSERT INTO onconnect.messages
         (client_id, tenant_id, connection_id, direction, status, message_type, counterpart, payload, created_at)
       VALUES ($1, $2, $3, 'inbound', 'received', 'text', '5585999991111', '{}', now() - interval '8 days'),
              ($1, $2, $3, 'inbound', 'received', 'text', '5585999991111', '{}', now() - interval '20 days')
       RETURNING id`,
      [CLIENT, TENANT, CONN],
    );
    try {
      const after = await queries.dashboard(7);
      // 8 days ago is in the previous 7 days; 20 days ago is in neither.
      expect(Number(after.totals?.received_prev) - Number(before.totals?.received_prev)).toBe(1);
      expect(after.totals?.received7).toBe(before.totals?.received7);
    } finally {
      await sql("DELETE FROM onconnect.messages WHERE id = ANY($1::uuid[])", [inserted.map((m) => m.id)]);
    }
  });

  it("lists messages as metadata, filtered and paged, never the payload", async () => {
    const all = await queries.messages({ connection: CONN });
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all[0]).not.toHaveProperty("payload");
    expect(all[0]).toMatchObject({ connection_id: CONN, session: "tendi-loja", client_slug: "admin-panel" });
    const inbound = await queries.messages({ connection: CONN, direction: "inbound" });
    expect(inbound.every((m) => m.direction === "inbound")).toBe(true);
    expect((await queries.messages({ connection: CONN, status: "sent" })).every((m) => m.status === "sent")).toBe(true);
    expect((await queries.messages({ search: "+55 (85) 99999-1111" })).length).toBeGreaterThanOrEqual(3);
    expect((await queries.messages({ search: "admin-panel" })).length).toBeGreaterThanOrEqual(3);
    expect(await queries.messages({ search: "99999" })).toEqual([]);
    expect(await queries.messages({ connection: CONN, page: 9999 })).toEqual([]);
  });

  it("searches connections, clients and endpoints by name, number and host", async () => {
    const byClient = await queries.search("Painel");
    expect(byClient.clients.map((c) => c.id)).toEqual([CLIENT]);
    const byNumber = await queries.search("99990000");
    expect(byNumber.connections.map((c) => c.id)).toEqual([CONN]);
    const byHost = await queries.search("hooks.example");
    expect(byHost.endpoints.map((e) => e.id)).toContain(ENDPOINT);
    // The path is not searchable: it may carry the integrator's secret.
    expect((await queries.search("/x")).endpoints).toEqual([]);
  });

  it("reads the last 24 hours of totals for the alerts bell", async () => {
    const totals = await queries.alertTotals();
    expect(Number(totals?.live)).toBeGreaterThanOrEqual(1);
    expect(Number(totals?.disabled_endpoints)).toBeGreaterThanOrEqual(1);
  });

  it("shows a client with tenants and keys, and refuses a duplicate slug", async () => {
    expect(await queries.createClient(admin, "admin-panel", "Dup")).toBeNull();
    const created = await queries.createClient(admin, "admin-panel-2", "Outro");
    expect(created).toMatch(/^[0-9a-f-]{36}$/);
    const detail = await queries.client(CLIENT);
    expect(detail?.tenants.map((t) => [t.external_id, t.live])).toEqual([["loja", "1"]]);
  });

  it("issues a key that authenticates, then revokes it", async () => {
    const issued = await queries.issueKey(admin, CLIENT, "panel-test");
    expect(issued?.key).toMatch(/^onc_/);
    const authenticator = createApiKeyAuthenticator({ store: createPostgresCredentialStore(app), pepper: PEPPER });
    const ok = await authenticator.authenticate(issued?.key);
    expect(ok.ok && ok.principal.clientId).toBe(CLIENT);

    const [key] = (await queries.client(CLIENT))?.keys ?? [];
    expect(await queries.revokeKey(admin, CLIENT, key?.id ?? "")).toBe(true);
    expect(await queries.revokeKey(admin, CLIENT, key?.id ?? "")).toBe(false);
    expect((await authenticator.authenticate(issued?.key)).ok).toBe(false);
  });

  it("paginates and filters webhook deliveries with a deterministic order for equal timestamps", async () => {
    const inserted = await sql<{ id: string; event_id: string }>(
      `WITH events AS (
         INSERT INTO onconnect.webhook_events
           (client_id, tenant_id, connection_id, event_type, dedupe_key, payload, occurred_at)
         SELECT $1, $2, $3, 'message.received', 'admin-page:' || gen_random_uuid(), '{}', now()
           FROM generate_series(1, 31)
         RETURNING id
       )
       INSERT INTO onconnect.webhook_deliveries (client_id, event_id, endpoint_id, status, attempts, updated_at)
       SELECT $1, events.id, $4, 'delivered', 1, '2026-01-01T00:00:00Z'::timestamptz FROM events
       RETURNING id, event_id`,
      [CLIENT, TENANT, CONN, ENDPOINT],
    );
    try {
      const filter = { status: "delivered", event: "message.received", search: "ADMIN-PANEL" } as const;
      const first = await queries.deliveries("all", { ...filter, page: 1 });
      const second = await queries.deliveries("all", { ...filter, page: 2 });
      expect(first).toHaveLength(26); // one extra row detects the next page
      expect(second).toHaveLength(6);
      expect(first[25]?.id).toBe(second[0]?.id);
      expect(new Set([...first.slice(0, 25), ...second].map((d) => d.id)).size).toBe(31);
      expect(await queries.deliveries("all", { ...filter, page: 3 })).toEqual([]);
      expect(await queries.deliveries("all", { ...filter, event: "message.status" })).toEqual([]);
      expect(await queries.deliveries("all", { ...filter, search: "%" })).toEqual([]);
      expect((await queries.deliveries("problems", { search: "admin-panel" })).map((d) => d.id)).toEqual([DELIVERY]);
    } finally {
      await sql("DELETE FROM onconnect.webhook_deliveries WHERE id = ANY($1::uuid[])", [inserted.map((d) => d.id)]);
      await sql("DELETE FROM onconnect.webhook_events WHERE id = ANY($1::uuid[])", [inserted.map((d) => d.event_id)]);
    }
  });

  it("resends a dead delivery and reactivates a disabled endpoint", async () => {
    const problems = await queries.deliveries("problems");
    expect(problems.find((d) => d.id === DELIVERY)).toMatchObject({ status: "dead", session: "tendi-loja" });
    expect(await queries.resendDelivery(admin, DELIVERY)).toBe(true);
    expect(await queries.resendDelivery(admin, DELIVERY)).toBe(false);
    const [delivery] = await sql<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM onconnect.webhook_deliveries WHERE id = $1", [DELIVERY]);
    expect(delivery).toEqual({ status: "pending", attempts: 0 });

    expect(await queries.reactivateEndpoint(admin, ENDPOINT)).toBe(true);
    const [endpoint] = await sql<{ status: string; consecutive_failures: number }>(
      "SELECT status, consecutive_failures FROM onconnect.webhook_endpoints WHERE id = $1", [ENDPOINT]);
    expect(endpoint).toEqual({ status: "active", consecutive_failures: 0 });
  });

  it("audits every write as the admin who made it", async () => {
    const rows = await sql<{ action: string; actor_type: string; actor_id: string }>(
      `SELECT action, actor_type, actor_id FROM onconnect.audit_log
        WHERE actor_type = 'admin' AND client_id = $1 ORDER BY id`, [CLIENT]);
    expect(rows.map((r) => r.action)).toEqual([
      "api_credential.issued", "api_credential.revoked", "webhook_delivery.resent", "webhook_endpoint.reactivated",
    ]);
    expect(rows.every((r) => r.actor_id === "john")).toBe(true);
  });

  it("reads a connection's status history and its session's deliveries", async () => {
    // Each real status change emits connection.status (trigger); a no-op does not.
    await sql("UPDATE onconnect.connections SET status = 'connecting', status_reason = 'reconnecting' WHERE id = $1", [CONN]);
    await sql("UPDATE onconnect.connections SET status = 'connected', status_reason = NULL WHERE id = $1", [CONN]);
    await sql("UPDATE onconnect.connections SET status = 'connected' WHERE id = $1", [CONN]);
    const history = await queries.connectionHistory(CONN);
    expect(history.slice(0, 2).map((h) => [h.previous_status, h.status])).toEqual([
      ["connecting", "connected"], ["connected", "connecting"],
    ]);
    expect(history[1]?.reason).toBe("reconnecting");
    const deliveries = await queries.connectionDeliveries(CONN);
    expect(deliveries.map((d) => d.id)).toContain(DELIVERY);
  });

  it("pauses endpoints and changes events only on native ones", async () => {
    const native = "aaaaaaaa-0000-4000-8000-0000000000a7";
    await sql(
      `INSERT INTO onconnect.webhook_endpoints
         (id, client_id, url, status, payload_format, secret_ciphertext, secret_nonce, secret_auth_tag, secret_key_version)
       VALUES ($1, $2, 'https://hooks.example.com/native', 'active', 'onconnect',
               '\\x01', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), 1)`,
      [native, CLIENT],
    );
    expect(await queries.setEndpointEvents(admin, native, ["message.status"])).toBe(true);
    expect((await queries.webhookEndpoint(native))?.event_types).toEqual(["message.status"]);
    // The D-API endpoint's events belong to the compatible session routes.
    expect(await queries.setEndpointEvents(admin, ENDPOINT, [])).toBe(false);

    expect(await queries.pauseEndpoint(admin, native)).toBe(true);
    expect(await queries.pauseEndpoint(admin, native)).toBe(false);
    expect((await queries.webhookEndpoint(native))?.status).toBe("paused");
    expect(await queries.reactivateEndpoint(admin, native)).toBe(true);
    expect((await queries.webhookEndpoint(native))?.status).toBe("active");
  });

  it("measures health per window, in buckets sized to the window", async () => {
    // A drop and a failed send, recorded now, must show in totals and in the last bucket.
    await sql("UPDATE onconnect.connections SET status = 'disconnected', status_reason = 'logged_out' WHERE id = $1", [CONN]);
    await sql(
      `INSERT INTO onconnect.messages (client_id, tenant_id, connection_id, direction, status, message_type,
         counterpart, payload, failed_at, error_code)
       VALUES ($1, $2, $3, 'outbound', 'failed', 'text', '5585999992222', '{}', now(), 'send_failed')`,
      [CLIENT, TENANT, CONN],
    );

    const sizes = { "1h": [60, 61], "24h": [24, 25], "7d": [28, 29], "30d": [30, 31] } as const;
    for (const [period, [min, max]] of Object.entries(sizes) as Array<[keyof typeof sizes, readonly [number, number]]>) {
      const { totals, buckets, problems } = await queries.monitoring(period);
      expect(buckets.length).toBeGreaterThanOrEqual(min);
      expect(buckets.length).toBeLessThanOrEqual(max);
      const first = buckets[0];
      const last = buckets.at(-1);
      if (!first || !last) throw new Error("no buckets");
      // Oldest first.
      expect(first.at.getTime()).toBeLessThan(last.at.getTime());
      expect(Number(totals?.drops)).toBeGreaterThanOrEqual(1);
      expect(Number(totals?.send_failed)).toBeGreaterThanOrEqual(1);
      expect(Number(last.drops)).toBeGreaterThanOrEqual(1);
      expect(Number(last.send_failed)).toBeGreaterThanOrEqual(1);
      expect(problems.map((p) => p.id)).toContain(CONN);
    }
    const hour = await queries.monitoring("1h");
    const sent = hour.buckets.reduce((sum, b) => sum + Number(b.sent), 0);
    expect(sent).toBe(Number(hour.totals?.sent));
  });

  it("persists connection settings and audits both values", async () => {
    expect(await queries.connection(CONN)).toMatchObject({ reject_calls: false, read_on_reply: false });
    expect(await queries.updateConnectionBehavior(admin, CONN, true, true)).toBe(true);
    expect(await queries.connection(CONN)).toMatchObject({ reject_calls: true, read_on_reply: true });
    const [entry] = await sql(
      "SELECT actor_id, metadata FROM onconnect.audit_log WHERE action = 'connection.settings_updated' AND target_id = $1",
      [CONN],
    );
    expect(entry).toEqual({ actor_id: "john", metadata: { rejectCalls: true, readOnReply: true } });
  });

  it("deletes a connection as a soft delete, emitting the status event and the audit", async () => {
    expect(await queries.deleteConnection(admin, CONN)).toBe(true);
    expect(await queries.deleteConnection(admin, CONN)).toBe(false);
    expect(await queries.connection(CONN)).toBeNull();
    expect(await queries.updateConnectionBehavior(admin, CONN, true, true)).toBe(false);
    const [row] = await sql<{ deleted: boolean; status: string; status_reason: string }>(
      "SELECT deleted_at IS NOT NULL AS deleted, status, status_reason FROM onconnect.connections WHERE id = $1", [CONN]);
    expect(row).toEqual({ deleted: true, status: "disconnected", status_reason: "deleted_by_admin" });
    const [audit] = await sql<{ actor_id: string }>(
      "SELECT actor_id FROM onconnect.audit_log WHERE action = 'connection.deleted' AND target_id = $1", [CONN]);
    expect(audit?.actor_id).toBe("john");
  });
  it("creates a Meta connection within the organization limit, once per phone number id", async () => {
    await sql(
      "INSERT INTO onconnect.tenants (client_id, external_id, name, max_connections) VALUES ($1, 'meta-loja', 'Meta', 1)",
      [CLIENT],
    );
    const input = { clientId: CLIENT, tenantExternalId: "meta-loja", phoneNumberId: "106540352242922",
      wabaId: "200000000000001", label: "Oficial" };
    const created = await queries.createMetaConnection(admin, input);
    expect(created).toHaveProperty("id");
    const id = "id" in created ? created.id : "";
    const [row] = await sql<Record<string, unknown>>(
      "SELECT provider, status, status_reason, phone_number_id, waba_id, label FROM onconnect.connections WHERE id = $1", [id]);
    expect(row).toEqual({ provider: "meta_cloud", status: "connecting", status_reason: "checking_meta",
      phone_number_id: "106540352242922", waba_id: "200000000000001", label: "Oficial" });
    const [audit] = await sql<{ actor_id: string; provider: string }>(
      `SELECT actor_id, metadata ->> 'provider' AS provider FROM onconnect.audit_log
        WHERE action = 'connection.created' AND target_id = $1`, [id]);
    expect(audit).toEqual({ actor_id: "john", provider: "meta_cloud" });

    expect(await queries.createMetaConnection(admin, { ...input, phoneNumberId: "999999999" }))
      .toEqual({ error: "limit_reached" });
    expect(await queries.createMetaConnection(admin, { ...input, tenantExternalId: "nope" }))
      .toEqual({ error: "tenant_not_found" });
    await sql("UPDATE onconnect.tenants SET max_connections = 5 WHERE client_id = $1 AND external_id = 'meta-loja'", [CLIENT]);
    expect(await queries.createMetaConnection(admin, input)).toEqual({ error: "number_in_use" });
    const one = await queries.connection(id);
    expect(one).toMatchObject({ provider: "meta_cloud", phone_number_id: "106540352242922", quality_rating: null });
  });
});
