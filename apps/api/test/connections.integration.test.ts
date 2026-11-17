/**
 * WhatsApp Web connections end to end against PostgreSQL 17: real keys,
 * real RLS, real routes. The sessions process is replaced by a fake gateway.
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
const PEPPER = "connection-integration-pepper-connection-int";
const A = "aaaaaaaa-0000-4000-8000-000000000041";
const B = "bbbbbbbb-0000-4000-8000-000000000041";

interface ConnectionBody {
  id: string;
  status: string;
  provider: string;
  tenantExternalId: string;
}

describe.skipIf(!enabled)("WhatsApp Web connections (PostgreSQL 17)", () => {
  const admin = createPostgresPool({
    host: "localhost", user: "postgres", password: "postgres", database: "postgres", max: 1,
  });
  const db = createPostgresPool({
    host: "localhost", user: "onconnect_app", password: "integration-only",
    database: "postgres", max: 4,
  });
  const keyA = generateApiKey(PEPPER);
  const keyB = generateApiKey(PEPPER);
  const sessions = new FakeSessions();
  let app: FastifyInstance;
  let connectionA = "";

  const sql = async (text: string, params: readonly unknown[] = []) => {
    const connection = await admin.connect();
    try {
      return await connection.query(text, params);
    } finally {
      connection.release();
    }
  };

  const call = (
    key: { key: string },
    method: "GET" | "POST" | "PUT" | "DELETE",
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
      "INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'conn-a', 'A'), ($2, 'conn-b', 'B')",
      [A, B],
    );
    for (const [client, key] of [[A, keyA], [B, keyB]] as const) {
      await sql(
        `INSERT INTO onconnect.client_api_credentials (client_id, label, key_prefix, secret_hash)
         VALUES ($1, 'connections', $2, $3)`,
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
      sessions,
    });
    await call(keyA, "PUT", "/v1/tenants/shop", { name: "A shop" });
    await call(keyB, "PUT", "/v1/tenants/shop", { name: "B shop", maxConnections: 1 });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await admin.close();
  });

  it("enforces the tenant's max_connections, which defaults to zero", async () => {
    const denied = await call(keyA, "POST", "/v1/tenants/shop/connections", {});
    expect(denied.statusCode).toBe(409);
    expect(denied.json<{ error: string }>().error).toBe("connection_limit_reached");

    await call(keyA, "PUT", "/v1/tenants/shop", { name: "A shop", maxConnections: 1 });
    const created = await call(keyA, "POST", "/v1/tenants/shop/connections", { label: "Atendimento" });
    expect(created.statusCode).toBe(201);
    const body = created.json<ConnectionBody>();
    expect(body).toMatchObject({ status: "pending", provider: "whatsapp_web", tenantExternalId: "shop" });
    expect(sessions.started).toContain(body.id);
    connectionA = body.id;

    const second = await call(keyA, "POST", "/v1/tenants/shop/connections", {});
    expect(second.statusCode).toBe(409);
  });

  it("returns 404 for a tenant the caller does not own", async () => {
    const response = await call(keyA, "POST", "/v1/tenants/not-mine/connections", {});
    expect(response.statusCode).toBe(404);
  });

  it("does not let B see, scan, pair or delete A's connection", async () => {
    sessions.qr.set(connectionA, "QR-OF-A");
    for (const [method, url, payload] of [
      ["GET", `/v1/connections/${connectionA}`, undefined],
      ["GET", `/v1/connections/${connectionA}/qr`, undefined],
      ["POST", `/v1/connections/${connectionA}/pairing-code`, { phoneNumber: "5511999999999" }],
      ["POST", `/v1/connections/${connectionA}/restart`, undefined],
      ["DELETE", `/v1/connections/${connectionA}`, undefined],
    ] as const) {
      const response = await call(keyB, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.body).not.toContain("QR-OF-A");
    }
    expect(sessions.pairingRequests).toEqual([]);
    expect(sessions.loggedOut).toEqual([]);
    const list = await call(keyB, "GET", "/v1/tenants/shop/connections");
    expect(list.json<{ connections: ConnectionBody[] }>().connections).toEqual([]);
  });

  it("serves A its QR as text and image", async () => {
    const response = await call(keyA, "GET", `/v1/connections/${connectionA}/qr`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ qr: string; qrImage: string }>();
    expect(body.qr).toBe("QR-OF-A");
    expect(body.qrImage.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("hands out a pairing code to the owner", async () => {
    const response = await call(keyA, "POST", `/v1/connections/${connectionA}/pairing-code`, {
      phoneNumber: "5511988887777",
    });
    expect(response.json()).toEqual({ pairingCode: "ABCD-1234" });
    expect(sessions.pairingRequests).toEqual([[connectionA, "5511988887777"]]);
  });

  it("refuses QR and pairing once connected", async () => {
    await sql(
      `UPDATE onconnect.connections SET status = 'connected', display_phone_number = '5511988887777'
        WHERE id = $1`,
      [connectionA],
    );
    expect((await call(keyA, "GET", `/v1/connections/${connectionA}/qr`)).statusCode).toBe(409);
    const connection = await call(keyA, "GET", `/v1/connections/${connectionA}`);
    expect(connection.json<{ phoneNumber: string }>().phoneNumber).toBe("5511988887777");
  });

  it("keeps a number live in one WhatsApp Web connection only", async () => {
    const created = await call(keyB, "POST", "/v1/tenants/shop/connections", {});
    const id = created.json<ConnectionBody>().id;
    await expect(sql(
      "UPDATE onconnect.connections SET display_phone_number = '5511988887777' WHERE id = $1",
      [id],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("retires a connection, logs it out and frees the slot", async () => {
    const deleted = await call(keyA, "DELETE", `/v1/connections/${connectionA}`);
    expect(deleted.statusCode).toBe(204);
    expect(sessions.loggedOut).toEqual([connectionA]);
    expect((await call(keyA, "GET", `/v1/connections/${connectionA}`)).statusCode).toBe(404);
    expect((await call(keyA, "DELETE", `/v1/connections/${connectionA}`)).statusCode).toBe(404);
    const again = await call(keyA, "POST", "/v1/tenants/shop/connections", {});
    expect(again.statusCode).toBe(201);
  });

  it("blocks new connections for a suspended tenant", async () => {
    await call(keyA, "PUT", "/v1/tenants/shop", { name: "A shop", maxConnections: 5 });
    await call(keyA, "PUT", "/v1/tenants/shop/commercial-status", { status: "suspended" });
    const response = await call(keyA, "POST", "/v1/tenants/shop/connections", {});
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe("tenant_inactive");
  });
});
