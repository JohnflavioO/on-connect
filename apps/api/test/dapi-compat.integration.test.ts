/**
 * D-API compatible session routes against PostgreSQL 17: the calls Tendi
 * makes today (create, status, QR, connect, disconnect, delete, webhook), with
 * the bare `Authorization: <key>` header, the D-API envelopes, real RLS, and
 * the connection.status event fanned out to the client's D-API endpoint.
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
const PEPPER = "compat-integration-pepper-compat-integration";
const A = "aaaaaaaa-0000-4000-8000-000000000091";
const B = "bbbbbbbb-0000-4000-8000-000000000091";
const BASE = "/compat/dapi/api/v1";
const SESSION = "tendi-7f1c2d3e-0000-4000-8000-000000000091";
const HOOK = "https://tendi.example.com/api/webhooks/dapi/s3cr3t-path";

interface Envelope {
  success: boolean;
  error?: string;
  statusCode?: number;
  status?: string;
  data?: Record<string, unknown>;
}

describe.skipIf(!enabled)("D-API compatible sessions (PostgreSQL 17)", () => {
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

  const sql = async <Row>(text: string, params: readonly unknown[] = []) => {
    const connection = await admin.connect();
    try {
      return (await connection.query<Row>(text, params)).rows;
    } finally {
      connection.release();
    }
  };

  /** D-API style: the key goes bare in Authorization. */
  const call = (
    key: { key: string },
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url: `${BASE}${url}`,
      headers: { authorization: key.key },
      ...(payload === undefined ? {} : { payload }),
    });

  const connectionOf = async (client: string, sessionId: string) => {
    const [row] = await sql<{ id: string }>(
      "SELECT id FROM onconnect.connections WHERE client_id = $1 AND session_key = $2 AND deleted_at IS NULL",
      [client, sessionId],
    );
    if (!row) throw new Error("connection missing");
    return row.id;
  };

  beforeAll(async () => {
    await sql("ALTER ROLE onconnect_app LOGIN PASSWORD 'integration-only'");
    await sql(
      "INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'compat-a', 'A'), ($2, 'compat-b', 'B')",
      [A, B],
    );
    for (const [client, key] of [[A, keyA], [B, keyB]] as const) {
      await sql(
        `INSERT INTO onconnect.client_api_credentials (client_id, label, key_prefix, secret_hash)
         VALUES ($1, 'compat', $2, $3)`,
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
        WEBHOOK_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
      }),
      checkRedis: async () => true,
      authenticator: createApiKeyAuthenticator({ store: createPostgresCredentialStore(db), pepper: PEPPER }),
      db,
      sessions,
      compatSendWaitMs: 1_000,
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await admin.close();
  });

  it("rejects a missing or wrong key with the D-API envelope", async () => {
    const response = await app.inject({ method: "GET", url: `${BASE}/sessions/${SESSION}` });
    expect(response.statusCode).toBe(401);
    expect(response.json<Envelope>()).toEqual({ success: false, error: "Unauthorized", statusCode: 401 });
  });

  it("creates a session the way Tendi does, with its own tenant and webhook", async () => {
    const response = await call(keyA, "POST", "/sessions", {
      sessionId: SESSION,
      connectionMode: "qr",
      webhookUrl: HOOK,
      webhookConfig: { enabled: true, type: "single", events: { "connection.status": { enabled: true } } },
      ignoreGroups: true,
      ignoreStatus: true,
      historySync: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Envelope>()).toMatchObject({ success: true, sessionId: SESSION, status: "connecting" });

    const connectionId = await connectionOf(A, SESSION);
    expect(sessions.started).toContain(connectionId);

    const [tenant] = await sql<{ external_id: string; max_connections: number; client_id: string }>(
      `SELECT t.external_id, t.max_connections, t.client_id FROM onconnect.connections c
         JOIN onconnect.tenants t ON t.id = c.tenant_id WHERE c.id = $1`,
      [connectionId],
    );
    expect(tenant).toEqual({ external_id: SESSION, max_connections: 1, client_id: A });

    const endpoints = await sql<{ url: string; payload_format: string; event_types: string[]; tenant_id: string | null }>(
      "SELECT url, payload_format, event_types, tenant_id FROM onconnect.webhook_endpoints WHERE client_id = $1",
      [A],
    );
    expect(endpoints).toEqual([{
      url: HOOK, payload_format: "dapi",
      event_types: ["connection.status", "message.received", "message.status"], tenant_id: null,
    }]);
  });

  it("is idempotent: creating the same session again reuses it", async () => {
    const before = await connectionOf(A, SESSION);
    const again = await call(keyA, "POST", "/sessions", { sessionId: SESSION, webhookUrl: HOOK });
    expect(again.statusCode).toBe(200);
    expect(await connectionOf(A, SESSION)).toBe(before);
    const endpoints = await sql("SELECT 1 FROM onconnect.webhook_endpoints WHERE client_id = $1", [A]);
    expect(endpoints).toHaveLength(1);
  });

  it("reports status and the QR in the shapes Tendi reads", async () => {
    const status = await call(keyA, "GET", `/sessions/${SESSION}`);
    expect(status.json<Envelope>()).toMatchObject({
      success: true, data: { sessionId: SESSION, status: "connecting", phone: null },
    });

    const noQr = await call(keyA, "GET", `/sessions/${SESSION}/qr`);
    expect(noQr.statusCode).toBe(404);
    expect(noQr.json<Envelope>()).toEqual({ success: false, error: "QR code not available", statusCode: 404 });

    sessions.qr.set(await connectionOf(A, SESSION), "2@qr-payload");
    const qr = await call(keyA, "GET", `/sessions/${SESSION}/qr`);
    expect(qr.statusCode).toBe(200);
    const data = qr.json<Envelope>().data ?? {};
    expect(data).toMatchObject({ status: "connecting", qrCode: "2@qr-payload" });
    expect(String(data.qrCodeImage)).toMatch(/^data:image\/png;base64,/);
  });

  it("emits connection.status for the D-API endpoint when the number connects", async () => {
    const connectionId = await connectionOf(A, SESSION);
    // What the sessions process does on "open".
    await sql(
      `UPDATE onconnect.connections
          SET status = 'connected', status_reason = NULL, status_changed_at = now(),
              display_phone_number = '5585999990091'
        WHERE id = $1`,
      [connectionId],
    );
    const events = await sql<{ status: string; session: string; phone: string; deliveries: string }>(
      `SELECT e.payload ->> 'status' AS status, e.payload ->> 'sessionId' AS session,
              e.payload ->> 'phone' AS phone,
              (SELECT count(*) FROM onconnect.webhook_deliveries d WHERE d.event_id = e.id) AS deliveries
         FROM onconnect.webhook_events e
        WHERE e.connection_id = $1 AND e.event_type = 'connection.status'`,
      [connectionId],
    );
    expect(events).toEqual([{ status: "connected", session: SESSION, phone: "5585999990091", deliveries: "1" }]);

    // A write that does not change the status emits nothing.
    await sql("UPDATE onconnect.connections SET status_reason = 'x' WHERE id = $1", [connectionId]);
    const count = await sql("SELECT 1 FROM onconnect.webhook_events WHERE connection_id = $1", [connectionId]);
    expect(count).toHaveLength(1);

    const status = await call(keyA, "GET", `/sessions/${SESSION}`);
    expect(status.json<Envelope>().data).toMatchObject({ status: "connected", phone: "5585999990091" });
    const qr = await call(keyA, "GET", `/sessions/${SESSION}/qr`);
    expect(qr.json<Envelope>().data).toMatchObject({ status: "connected", qrCode: null });
  });

  it("does not let another client see or touch the session", async () => {
    for (const [method, path] of [
      ["GET", `/sessions/${SESSION}`],
      ["GET", `/sessions/${SESSION}/qr`],
      ["GET", `/sessions/${SESSION}/connect`],
      ["POST", `/sessions/${SESSION}/disconnect`],
      ["DELETE", `/sessions/${SESSION}`],
    ] as const) {
      const response = await call(keyB, method, path);
      expect(response.statusCode).toBe(404);
      expect(response.json<Envelope>().error).toBe("Session not found");
    }
    // B may use the same session id: it gets its own tenant and connection.
    const own = await call(keyB, "POST", "/sessions", { sessionId: SESSION });
    expect(own.statusCode).toBe(200);
    expect(await connectionOf(B, SESSION)).not.toBe(await connectionOf(A, SESSION));
  });

  it("disconnects, reconnects and repoints the webhook", async () => {
    const connectionId = await connectionOf(A, SESSION);
    const disconnect = await call(keyA, "POST", `/sessions/${SESSION}/disconnect`);
    expect(disconnect.json<Envelope>()).toMatchObject({ success: true, status: "disconnected" });
    expect(sessions.loggedOut).toContain(connectionId);

    await sql("UPDATE onconnect.connections SET status = 'disconnected' WHERE id = $1", [connectionId]);
    const started = sessions.started.length;
    const connect = await call(keyA, "GET", `/sessions/${SESSION}/connect`);
    expect(connect.json<Envelope>()).toMatchObject({ success: true, status: "connecting" });
    expect(sessions.started.length).toBe(started + 1);

    const moved = "https://new.tendi.example.com/api/webhooks/dapi/s3cr3t-path";
    expect((await call(keyA, "POST", `/sessions/${SESSION}/webhook`, { webhookUrl: moved })).statusCode).toBe(200);
    expect((await call(keyA, "POST", `/sessions/${SESSION}/webhook-config`, { enabled: true })).statusCode).toBe(200);
    const endpoints = await sql<{ url: string }>("SELECT url FROM onconnect.webhook_endpoints WHERE client_id = $1", [A]);
    expect(endpoints).toEqual([{ url: moved }]);

    const unsafe = await call(keyA, "POST", `/sessions/${SESSION}/webhook`, { webhookUrl: "http://tendi.example.com/x" });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json<Envelope>().success).toBe(false);
  });

  it("rejects what it does not support yet and invalid session ids", async () => {
    const pair = await call(keyA, "POST", "/sessions", { sessionId: "other-1", connectionMode: "pair", pairPhone: "5511" });
    expect(pair.statusCode).toBe(400);
    const bad = await call(keyA, "POST", "/sessions", { sessionId: "bad id!" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<Envelope>()).toMatchObject({ success: false, statusCode: 400 });
  });

  it("sends text and answers with the WhatsApp id the message is stored under", async () => {
    const connectionId = await connectionOf(A, SESSION);
    await sql("UPDATE onconnect.connections SET status = 'connected' WHERE id = $1", [connectionId]);
    const response = await call(keyA, "POST", "/messages/send/text", {
      sessionId: SESSION, to: "5585999990000@s.whatsapp.net", text: "Olá do Tendi",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ success: boolean; messageId: string; status: string; data: { key: { id: string } } }>();
    expect(body.success).toBe(true);
    expect(body.messageId).toMatch(/^3EB0[0-9A-F]{20}$/);
    expect(body.data.key.id).toBe(body.messageId);
    // Nothing sends in the test, so after the short wait it is still queued.
    expect(body.status).toBe("queued");

    const [row] = await sql<{ id: string; counterpart: string; client_id: string; provider_message_id: string }>(
      "SELECT id, counterpart, client_id, provider_message_id FROM onconnect.messages WHERE provider_message_id = $1",
      [body.messageId],
    );
    expect(row).toMatchObject({ counterpart: "5585999990000", client_id: A });
    expect(sessions.dispatched).toContain(row?.id);
  });

  it("reports a send that failed within the wait as an error", async () => {
    const send = call(keyA, "POST", "/messages/send/text", { sessionId: SESSION, to: "5585999990001", text: "x" });
    // What the sessions process does when the send fails.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sql(
      "UPDATE onconnect.messages SET status = 'failed', error_code = 'send_failed' WHERE counterpart = '5585999990001'",
    );
    const response = await send;
    expect(response.statusCode).toBe(502);
    expect(response.json<Envelope>()).toMatchObject({ success: false, statusCode: 502 });
  });

  it("refuses to send through a missing, foreign or disconnected session", async () => {
    const foreign = await call(keyB, "POST", "/messages/send/text", { sessionId: "nope-1", to: "5585999990000", text: "x" });
    expect(foreign.json<Envelope>()).toMatchObject({ error: "Session not found", statusCode: 404 });
    // B's session with the same id exists but is not connected.
    const notReady = await call(keyB, "POST", "/messages/send/text", { sessionId: SESSION, to: "5585999990000", text: "x" });
    expect(notReady.json<Envelope>()).toMatchObject({ error: "Session is not connected", statusCode: 400 });
    const badNumber = await call(keyA, "POST", "/messages/send/text", { sessionId: SESSION, to: "abc-12345", text: "x" });
    expect(badNumber.statusCode).toBe(400);
  });

  it("deletes the session and lets the same id be created again", async () => {
    const old = await connectionOf(A, SESSION);
    const deleted = await call(keyA, "DELETE", `/sessions/${SESSION}`);
    expect(deleted.json<Envelope>()).toMatchObject({ success: true });
    expect(sessions.loggedOut).toContain(old);
    expect((await call(keyA, "GET", `/sessions/${SESSION}`)).statusCode).toBe(404);

    const recreated = await call(keyA, "POST", "/sessions", { sessionId: SESSION });
    expect(recreated.statusCode).toBe(200);
    expect(await connectionOf(A, SESSION)).not.toBe(old);
  });
});
