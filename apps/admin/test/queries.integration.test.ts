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
});
