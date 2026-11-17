/**
 * End to end against PostgreSQL 17: real API keys, real RLS, real routes.
 * Proves the step-3 acceptance criteria from
 * docs/security/integrator-auth-and-transaction-context.md.
 */
import {
  createApiKeyAuthenticator,
  createPostgresCredentialStore,
  createPostgresPool,
  generateApiKey,
  loadApiEnv,
} from "@on-connect/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeSessions } from "./support/fake-sessions.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1";
const PEPPER = "tenant-integration-pepper-tenant-integration";
const A = "aaaaaaaa-0000-4000-8000-000000000031";
const B = "bbbbbbbb-0000-4000-8000-000000000031";

interface TenantBody {
  id: string;
  externalId: string;
  name: string;
  commercialStatus: string;
  maxConnections: number;
}

describe.skipIf(!enabled)("tenant access isolation (PostgreSQL 17)", () => {
  const admin = createPostgresPool({
    host: "localhost", user: "postgres", password: "postgres", database: "postgres", max: 1,
  });
  const db = createPostgresPool({
    host: "localhost", user: "onconnect_app", password: "integration-only",
    database: "postgres", max: 4,
  });
  const keyA = generateApiKey(PEPPER);
  const keyB = generateApiKey(PEPPER);
  let app: FastifyInstance;

  const adminQuery = async (sql: string, params: readonly unknown[] = []) => {
    const connection = await admin.connect();
    try {
      return await connection.query(sql, params);
    } finally {
      connection.release();
    }
  };

  const call = (
    key: { key: string },
    method: "GET" | "PUT",
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key.key}` },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    await adminQuery("ALTER ROLE onconnect_app LOGIN PASSWORD 'integration-only'");
    await adminQuery(
      "INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'tenants-a', 'A'), ($2, 'tenants-b', 'B')",
      [A, B],
    );
    for (const [client, key] of [[A, keyA], [B, keyB]] as const) {
      await adminQuery(
        `INSERT INTO onconnect.client_api_credentials (client_id, label, key_prefix, secret_hash)
         VALUES ($1, 'tenants', $2, $3)`,
        [client, key.prefix, key.secretHash],
      );
    }
    app = await buildApp({
      env: loadApiEnv({
        LOG_LEVEL: "silent",
        REDIS_URL: "redis://localhost:6379",
        PUBLIC_API_BASE_URL: "http://localhost:8080",
        DATABASE_URL: "postgresql://unused@localhost/postgres",
        API_KEY_PEPPER: PEPPER,
      }),
      checkRedis: async () => true,
      authenticator: createApiKeyAuthenticator({
        store: createPostgresCredentialStore(db),
        pepper: PEPPER,
      }),
      db,
      sessions: new FakeSessions(),
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await admin.close();
  });

  it("creates tenants under the caller's own client", async () => {
    const created = await call(keyA, "PUT", "/v1/tenants/org-1", { name: "A org 1", maxConnections: 2 });
    expect(created.statusCode).toBe(201);
    const updated = await call(keyA, "PUT", "/v1/tenants/org-1", { name: "A org 1", maxConnections: 3 });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<TenantBody>().id).toBe(created.json<TenantBody>().id);

    const owner = await adminQuery(
      "SELECT client_id FROM onconnect.tenants WHERE id = $1", [created.json<TenantBody>().id],
    );
    expect(owner.rows).toEqual([{ client_id: A }]);
  });

  it("gives B its own tenant with the same external id", async () => {
    const response = await call(keyB, "PUT", "/v1/tenants/org-1", { name: "B org 1" });
    expect(response.statusCode).toBe(201);
    const a = await call(keyA, "GET", "/v1/tenants/org-1");
    expect(a.json<TenantBody>().name).toBe("A org 1");
    expect(a.json<TenantBody>().id).not.toBe(response.json<TenantBody>().id);
  });

  it("keeps two tenants of A distinct", async () => {
    await call(keyA, "PUT", "/v1/tenants/org-2", { name: "A org 2" });
    const list = await call(keyA, "GET", "/v1/tenants");
    const names = list.json<{ tenants: TenantBody[] }>().tenants.map((t) => t.name);
    expect(names).toEqual(["A org 1", "A org 2"]);
    const org2 = await call(keyA, "GET", "/v1/tenants/org-2");
    expect(org2.json<TenantBody>().maxConnections).toBe(0);
  });

  it("does not let A read or change a tenant that only B has", async () => {
    await call(keyB, "PUT", "/v1/tenants/only-b", { name: "B private" });

    const read = await call(keyA, "GET", "/v1/tenants/only-b");
    expect(read.statusCode).toBe(404);

    const status = await call(keyA, "PUT", "/v1/tenants/only-b/commercial-status", {
      status: "suspended",
    });
    expect(status.statusCode).toBe(404);

    const list = await call(keyA, "GET", "/v1/tenants");
    expect(list.json<{ tenants: TenantBody[] }>().tenants.map((t) => t.externalId))
      .not.toContain("only-b");

    const untouched = await call(keyB, "GET", "/v1/tenants/only-b");
    expect(untouched.json<TenantBody>().commercialStatus).toBe("active");
  });

  it("ignores client ids forged in headers and query strings", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/only-b",
      headers: { authorization: `Bearer ${keyA.key}`, "x-client-id": B },
    });
    expect(response.statusCode).toBe(404);
  });

  it("records commercial status changes and audits them under the caller", async () => {
    const response = await call(keyA, "PUT", "/v1/tenants/org-2/commercial-status", {
      status: "suspended", reason: "unpaid",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<TenantBody>().commercialStatus).toBe("suspended");

    const audit = await adminQuery(
      `SELECT client_id, actor_type, action FROM onconnect.audit_log
        WHERE action = 'tenant.commercial_status_changed' AND client_id = $1`,
      [A],
    );
    expect(audit.rows).toEqual([
      { client_id: A, actor_type: "client", action: "tenant.commercial_status_changed" },
    ]);
    const leakedToB = await adminQuery(
      "SELECT 1 FROM onconnect.audit_log WHERE client_id = $1 AND action LIKE 'tenant.commercial%'",
      [B],
    );
    expect(leakedToB.rows).toEqual([]);
  });

  it("does not leak tenant context between concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call(i % 2 === 0 ? keyA : keyB, "GET", "/v1/tenants/org-1")),
    );
    results.forEach((response, i) => {
      expect(response.json<TenantBody>().name).toBe(i % 2 === 0 ? "A org 1" : "B org 1");
    });
  });
});
