/**
 * Webhook endpoint routes against PostgreSQL 17: real API keys, real RLS.
 * The secret is returned once and stored only encrypted; another client's
 * endpoints answer 404.
 */
import {
  createApiKeyAuthenticator,
  createPostgresCredentialStore,
  createPostgresPool,
  createSecretBox,
  generateApiKey,
  loadApiEnv,
  webhookSecretContext,
} from "@on-connect/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeSessions } from "./support/fake-sessions.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1";
const PEPPER = "webhook-integration-pepper-webhook-integration";
const WEBHOOK_KEY = Buffer.alloc(32, 9).toString("base64");
const A = "aaaaaaaa-0000-4000-8000-000000000081";
const B = "bbbbbbbb-0000-4000-8000-000000000081";

interface EndpointBody {
  id: string;
  url: string;
  tenantExternalId: string | null;
  eventTypes: string[];
  status: string;
  consecutiveFailures: number;
  secret?: string;
}

describe.skipIf(!enabled)("webhook endpoints (PostgreSQL 17)", () => {
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

  const sql = async <Row>(text: string, params: readonly unknown[] = []) => {
    const connection = await admin.connect();
    try {
      return (await connection.query<Row>(text, params)).rows;
    } finally {
      connection.release();
    }
  };

  const call = (
    key: { key: string },
    method: "GET" | "POST" | "PATCH" | "DELETE",
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
    await sql("ALTER ROLE onconnect_app LOGIN PASSWORD 'integration-only'");
    await sql(
      "INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'webhooks-a', 'A'), ($2, 'webhooks-b', 'B')",
      [A, B],
    );
    for (const [client, key] of [[A, keyA], [B, keyB]] as const) {
      await sql(
        `INSERT INTO onconnect.client_api_credentials (client_id, label, key_prefix, secret_hash)
         VALUES ($1, 'webhooks', $2, $3)`,
        [client, key.prefix, key.secretHash],
      );
    }
    await sql(
      "INSERT INTO onconnect.tenants (client_id, external_id, name) VALUES ($1, 'shop', 'Shop'), ($2, 'b-shop', 'B')",
      [A, B],
    );
    app = await buildApp({
      env: loadApiEnv({
        LOG_LEVEL: "silent",
        REDIS_URL: "redis://localhost:6379",
        PUBLIC_API_BASE_URL: "http://localhost:8080",
        DATABASE_URL: "postgresql://unused@localhost/postgres",
        API_KEY_PEPPER: PEPPER,
        WEBHOOK_SECRET_KEY: WEBHOOK_KEY,
      }),
      checkRedis: async () => true,
      authenticator: createApiKeyAuthenticator({ store: createPostgresCredentialStore(db), pepper: PEPPER }),
      db,
      sessions: new FakeSessions(),
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await admin.close();
  });

  let created: EndpointBody;

  it("creates an endpoint and returns its secret once", async () => {
    const response = await call(keyA, "POST", "/v1/webhook-endpoints", {
      url: "https://tendi.example.com/hooks?token=t0k3n",
      tenantExternalId: "shop",
      eventTypes: ["message.received"],
    });
    expect(response.statusCode).toBe(201);
    created = response.json<EndpointBody>();
    expect(created).toMatchObject({
      url: "https://tendi.example.com/hooks?token=t0k3n",
      tenantExternalId: "shop",
      eventTypes: ["message.received"],
      status: "active",
      consecutiveFailures: 0,
    });
    expect(created.secret).toMatch(/^whsec_/);

    const read = await call(keyA, "GET", `/v1/webhook-endpoints/${created.id}`);
    expect(read.json<EndpointBody>().secret).toBeUndefined();
    const list = await call(keyA, "GET", "/v1/webhook-endpoints");
    expect(list.body).not.toContain("whsec_");
  });

  it("stores the secret only encrypted, bound to the endpoint", async () => {
    const [row] = await sql<{ client_id: string; secret_ciphertext: Buffer; secret_nonce: Buffer; secret_auth_tag: Buffer }>(
      "SELECT client_id, secret_ciphertext, secret_nonce, secret_auth_tag FROM onconnect.webhook_endpoints WHERE id = $1",
      [created.id],
    );
    if (!row) throw new Error("endpoint row missing");
    expect(row.client_id).toBe(A);
    expect(row.secret_ciphertext.toString("utf8")).not.toContain("whsec_");
    const opened = createSecretBox(WEBHOOK_KEY).openParts(
      { ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, tag: row.secret_auth_tag },
      webhookSecretContext(created.id),
    );
    expect(opened).toBe(created.secret);

    const audit = await sql<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM onconnect.audit_log WHERE action = 'webhook_endpoint.created' AND target_id = $1",
      [created.id],
    );
    expect(JSON.stringify(audit)).not.toContain("t0k3n");
  });

  it("rejects unsafe URLs, unknown tenants and unknown event types", async () => {
    const http = await call(keyA, "POST", "/v1/webhook-endpoints", { url: "http://tendi.example.com/h" });
    expect(http.statusCode).toBe(400);
    expect(http.json<{ error: string }>().error).toBe("invalid_webhook_url");
    const internal = await call(keyA, "POST", "/v1/webhook-endpoints", { url: "https://redis:6379/" });
    expect(internal.statusCode).toBe(400);
    const tenant = await call(keyA, "POST", "/v1/webhook-endpoints", {
      url: "https://tendi.example.com/h", tenantExternalId: "b-shop",
    });
    expect(tenant.statusCode).toBe(404);
    const type = await call(keyA, "POST", "/v1/webhook-endpoints", {
      url: "https://tendi.example.com/h", eventTypes: ["message.deleted"],
    });
    expect(type.statusCode).toBe(400);
    const forged = await call(keyA, "POST", "/v1/webhook-endpoints", {
      url: "https://tendi.example.com/h", clientId: B,
    });
    expect(forged.statusCode).toBe(400);
  });

  it("hides A's endpoint from B", async () => {
    const path = `/v1/webhook-endpoints/${created.id}`;
    expect((await call(keyB, "GET", path)).statusCode).toBe(404);
    expect((await call(keyB, "PATCH", path, { status: "paused" })).statusCode).toBe(404);
    expect((await call(keyB, "POST", `${path}/rotate-secret`)).statusCode).toBe(404);
    expect((await call(keyB, "DELETE", path)).statusCode).toBe(404);
    const list = await call(keyB, "GET", "/v1/webhook-endpoints");
    expect(list.json<{ webhookEndpoints: EndpointBody[] }>().webhookEndpoints).toEqual([]);
    const untouched = await call(keyA, "GET", path);
    expect(untouched.json<EndpointBody>().status).toBe("active");
  });

  it("updates, re-enables a disabled endpoint and rotates its secret", async () => {
    const path = `/v1/webhook-endpoints/${created.id}`;
    const paused = await call(keyA, "PATCH", path, { status: "paused", eventTypes: [] });
    expect(paused.json<EndpointBody>()).toMatchObject({ status: "paused", eventTypes: [] });

    await sql(
      `UPDATE onconnect.webhook_endpoints
          SET status = 'disabled', disabled_at = now(), consecutive_failures = 12, failing_since = now()
        WHERE id = $1`,
      [created.id],
    );
    const disabled = await call(keyA, "PATCH", path, { status: "disabled" });
    expect(disabled.statusCode).toBe(400);
    const active = await call(keyA, "PATCH", path, { status: "active" });
    expect(active.json<EndpointBody>()).toMatchObject({ status: "active", consecutiveFailures: 0 });

    const rotated = await call(keyA, "POST", `${path}/rotate-secret`);
    expect(rotated.statusCode).toBe(200);
    const { secret } = rotated.json<{ secret: string }>();
    expect(secret).toMatch(/^whsec_/);
    expect(secret).not.toBe(created.secret);
  });

  it("limits endpoints per client", async () => {
    for (let i = 0; i < 9; i += 1) {
      const response = await call(keyA, "POST", "/v1/webhook-endpoints", { url: `https://h${i}.example.com/` });
      expect(response.statusCode).toBe(201);
    }
    const over = await call(keyA, "POST", "/v1/webhook-endpoints", { url: "https://over.example.com/" });
    expect(over.statusCode).toBe(409);
    expect(over.json<{ error: string }>().error).toBe("webhook_endpoint_limit_reached");
  });

  it("deletes an endpoint", async () => {
    const path = `/v1/webhook-endpoints/${created.id}`;
    expect((await call(keyA, "DELETE", path)).statusCode).toBe(204);
    expect((await call(keyA, "GET", path)).statusCode).toBe(404);
    expect((await call(keyA, "DELETE", path)).statusCode).toBe(404);
  });
});
