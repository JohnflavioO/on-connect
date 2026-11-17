/** Sending and reading messages end to end against PostgreSQL 17. */
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
const PEPPER = "messages-integration-pepper-messages-integr";
const A = "aaaaaaaa-0000-4000-8000-000000000061";
const B = "bbbbbbbb-0000-4000-8000-000000000061";

interface MessageBody {
  id: string;
  status: string;
  direction: string;
  counterpart: string;
  content: { type: string; text?: string };
  clientReference: string | null;
}

describe.skipIf(!enabled)("messages (PostgreSQL 17)", () => {
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
  let connA = "";
  let sentId = "";

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
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: Record<string, unknown>,
  ) => app.inject({
    method, url, headers: { authorization: `Bearer ${key.key}` },
    ...(payload === undefined ? {} : { payload }),
  });

  beforeAll(async () => {
    await sql("ALTER ROLE onconnect_app LOGIN PASSWORD 'integration-only'");
    await sql("INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'msg-a', 'A'), ($2, 'msg-b', 'B')", [A, B]);
    for (const [client, key] of [[A, keyA], [B, keyB]] as const) {
      await sql(
        `INSERT INTO onconnect.client_api_credentials (client_id, label, key_prefix, secret_hash)
         VALUES ($1, 'messages', $2, $3)`, [client, key.prefix, key.secretHash]);
    }
    app = await buildApp({
      env: loadApiEnv({
        LOG_LEVEL: "silent", REDIS_URL: "redis://localhost:6379",
        PUBLIC_API_BASE_URL: "http://localhost:8080",
        DATABASE_URL: "postgresql://unused@localhost/postgres", API_KEY_PEPPER: PEPPER,
        WEBHOOK_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
        MEDIA_KEY: Buffer.alloc(32, 8).toString("base64"),
      }),
      checkRedis: async () => true,
      authenticator: createApiKeyAuthenticator({ store: createPostgresCredentialStore(db), pepper: PEPPER }),
      db,
      sessions,
    });
    await call(keyA, "PUT", "/v1/tenants/shop", { name: "A shop", maxConnections: 1 });
    connA = (await call(keyA, "POST", "/v1/tenants/shop/connections", {})).json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await admin.close();
  });

  it("refuses to send through a connection that is not connected", async () => {
    const response = await call(keyA, "POST", `/v1/connections/${connA}/messages`, { to: "5511988887777", text: "oi" });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe("connection_not_ready");
    expect(sessions.dispatched).toEqual([]);
  });

  it("queues a message with its outbox job and dispatches it", async () => {
    await sql("UPDATE onconnect.connections SET status = 'connected' WHERE id = $1", [connA]);
    const response = await call(keyA, "POST", `/v1/connections/${connA}/messages`, {
      to: "5511988887777", text: "Seu pedido saiu", clientReference: "order-42",
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<MessageBody>();
    expect(body).toMatchObject({
      status: "queued", direction: "outbound", counterpart: "5511988887777",
      content: { type: "text", text: "Seu pedido saiu" }, clientReference: "order-42",
    });
    expect(sessions.dispatched).toEqual([body.id]);
    sentId = body.id;
    const jobs = await sql<{ status: string; client_id: string }>(
      "SELECT status, client_id FROM onconnect.message_jobs WHERE message_id = $1", [body.id]);
    expect(jobs).toEqual([{ status: "pending", client_id: A }]);
  });

  it("lists messages newest first with a cursor, and reads one", async () => {
    await sql(
      `INSERT INTO onconnect.messages (client_id, tenant_id, connection_id, direction, status, message_type,
         counterpart, provider_message_id, payload, created_at)
       SELECT client_id, tenant_id, id, 'inbound', 'received', 'text', '5511988887777', 'API-IN-1',
              '{"content":{"type":"text","text":"obrigado"},"pushName":"Ana"}', now() + interval '1 second'
         FROM onconnect.connections WHERE id = $1`, [connA]);
    const page = await call(keyA, "GET", `/v1/connections/${connA}/messages?limit=1`);
    const first = page.json<{ messages: Array<MessageBody & { contactName: string }>; nextCursor: string }>();
    expect(first.messages.map((m) => m.direction)).toEqual(["inbound"]);
    expect(first.messages[0]?.contactName).toBe("Ana");
    const next = await call(keyA, "GET", `/v1/connections/${connA}/messages?limit=1&before=${first.nextCursor}`);
    expect(next.json<{ messages: MessageBody[]; nextCursor: null }>()).toMatchObject({
      messages: [{ id: sentId }], nextCursor: null,
    });
    expect((await call(keyA, "GET", `/v1/messages/${sentId}`)).json<MessageBody>().id).toBe(sentId);
  });

  it("does not let B send through, list or read A's messages", async () => {
    expect((await call(keyB, "POST", `/v1/connections/${connA}/messages`, { to: "5511988887777", text: "x" }))
      .statusCode).toBe(404);
    expect((await call(keyB, "GET", `/v1/messages/${sentId}`)).statusCode).toBe(404);
    const list = await call(keyB, "GET", `/v1/connections/${connA}/messages`);
    expect(list.json<{ messages: unknown[] }>().messages).toEqual([]);
    expect(sessions.dispatched).toHaveLength(1);
  });

  it("refuses to send for a suspended tenant", async () => {
    await call(keyA, "PUT", "/v1/tenants/shop/commercial-status", { status: "suspended" });
    const response = await call(keyA, "POST", `/v1/connections/${connA}/messages`, { to: "5511988887777", text: "x" });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe("tenant_inactive");
  });
});
