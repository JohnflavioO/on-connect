/**
 * The sessions process SQL against PostgreSQL 17, run as onconnect_system
 * exactly as in production (RLS on, no superuser).
 */
import { createPostgresPool } from "@on-connect/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/message-mapping.js";
import { createPostgresOutboundStore, createPostgresSessionStore } from "../src/store.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1";
const CLIENT = "aaaaaaaa-0000-4000-8000-000000000051";
const TENANT = "aaaaaaaa-0000-4000-8000-000000000052";
const CONN = "aaaaaaaa-0000-4000-8000-000000000053";
const OUT = "aaaaaaaa-0000-4000-8000-000000000054";

describe.skipIf(!enabled)("sessions store as onconnect_system (PostgreSQL 17)", () => {
  const admin = createPostgresPool({
    host: "localhost", user: "postgres", password: "postgres", database: "postgres", max: 1,
  });
  const system = createPostgresPool({
    host: "localhost", user: "onconnect_system", password: "integration-only",
    database: "postgres", max: 2,
  });
  const sessions = createPostgresSessionStore(system);
  const outbound = createPostgresOutboundStore(system);

  const sql = async <Row>(text: string, params: readonly unknown[] = []) => {
    const connection = await admin.connect();
    try {
      return (await connection.query<Row>(text, params)).rows;
    } finally {
      connection.release();
    }
  };

  const inbound = (providerId: string): InboundMessage => ({
    providerId, jid: "5511999999999@s.whatsapp.net", counterpart: "5511999999999",
    counterpartIsPhone: true, pushName: "Ana", timestamp: new Date("2026-11-17T10:00:00Z"),
    content: { type: "text", text: "olá" }, fromMe: false,
  });

  beforeAll(async () => {
    await sql("ALTER ROLE onconnect_system LOGIN PASSWORD 'integration-only'");
    await sql("INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'sessions-store', 'S')", [CLIENT]);
    await sql(
      "INSERT INTO onconnect.tenants (id, client_id, external_id, name, max_connections) VALUES ($1, $2, 'shop', 'Shop', 1)",
      [TENANT, CLIENT],
    );
    await sql(
      `INSERT INTO onconnect.connections (id, client_id, tenant_id, provider, status)
       VALUES ($1, $2, $3, 'whatsapp_web', 'connecting')`,
      [CONN, CLIENT, TENANT],
    );
  });

  afterAll(async () => {
    await system.close();
    await admin.close();
  });

  it("records connection status and the linked account", async () => {
    await sessions.setStatus(CONN, "connecting", "waiting_for_scan");
    expect(await sessions.markConnected(CONN, { jid: "5511977776666:4@s.whatsapp.net", name: "Loja" }))
      .toBe("ok");
    const [row] = await sql<{ status: string; display_phone_number: string; wa_jid: string }>(
      "SELECT status, display_phone_number, wa_jid FROM onconnect.connections WHERE id = $1", [CONN]);
    expect(row).toEqual({ status: "connected", display_phone_number: "5511977776666",
      wa_jid: "5511977776666:4@s.whatsapp.net" });
    expect(await sessions.liveIds()).toContain(CONN);
  });

  it("stores an inbound message and its event exactly once", async () => {
    expect(await sessions.recordInbound(CONN, inbound("IN-1"))).toBe(true);
    expect(await sessions.recordInbound(CONN, inbound("IN-1"))).toBe(false);

    const messages = await sql<{ status: string; counterpart: string; client_id: string; text: string }>(
      `SELECT status, counterpart, client_id, payload -> 'content' ->> 'text' AS text
         FROM onconnect.messages WHERE provider_message_id = 'IN-1' AND client_id = $1`, [CLIENT]);
    expect(messages).toEqual([{ status: "received", counterpart: "5511999999999", client_id: CLIENT, text: "olá" }]);

    const events = await sql<{ event_type: string; tenant: string; from: string; occurred_at: Date }>(
      `SELECT event_type, payload ->> 'tenantExternalId' AS tenant, payload ->> 'from' AS "from", occurred_at
         FROM onconnect.webhook_events WHERE event_type = 'message.received' AND client_id = $1`, [CLIENT]);
    expect(events).toEqual([{ event_type: "message.received", tenant: "shop", from: "5511999999999",
      occurred_at: new Date("2026-11-17T10:00:00Z") }]);
  });

  it("runs the outbound lifecycle and only moves status forward", async () => {
    await sql(
      `INSERT INTO onconnect.messages (id, client_id, tenant_id, connection_id, direction, status,
         message_type, counterpart, client_reference, payload)
       VALUES ($1, $2, $3, $4, 'outbound', 'queued', 'text', '5511988887777', 'order-42',
               '{"content":{"type":"text","text":"pedido"}}')`,
      [OUT, CLIENT, TENANT, CONN],
    );
    await sql("INSERT INTO onconnect.message_jobs (client_id, message_id) VALUES ($1, $2)", [CLIENT, OUT]);

    expect(await outbound.load(OUT)).toMatchObject({
      status: "queued", to: "5511988887777", content: { type: "text", text: "pedido" },
    });
    await outbound.markSending(OUT, "3EB0OUT");
    await outbound.markSending(OUT, "3EB0OTHER");
    expect((await outbound.load(OUT))?.providerMessageId).toBe("3EB0OUT");

    await outbound.markSent(OUT);
    expect(await sessions.recordStatus(CONN, { providerId: "3EB0OUT", status: "read" })).toBe(true);
    expect(await sessions.recordStatus(CONN, { providerId: "3EB0OUT", status: "delivered" })).toBe(false);

    const [row] = await sql<{ status: string; read: boolean; delivered: boolean; job: string }>(
      `SELECT m.status, m.read_at IS NOT NULL AS read, m.delivered_at IS NOT NULL AS delivered, j.status AS job
         FROM onconnect.messages m JOIN onconnect.message_jobs j ON j.message_id = m.id WHERE m.id = $1`, [OUT]);
    expect(row).toEqual({ status: "read", read: true, delivered: true, job: "done" });

    const events = await sql<{ status: string; ref: string }>(
      `SELECT payload ->> 'status' AS status, payload ->> 'clientReference' AS ref
         FROM onconnect.webhook_events WHERE event_type = 'message.status' AND payload ->> 'messageId' = $1
        ORDER BY payload ->> 'status' DESC`, [OUT]); // ids are random uuids
    expect(events).toEqual([{ status: "sent", ref: "order-42" }, { status: "read", ref: "order-42" }]);

    await outbound.markFailed(OUT, "send_failed", "late failure");
    expect((await outbound.load(OUT))?.status).toBe("read");
  });

  it("records a message sent from the phone as outbound, with what the D-API layer needs", async () => {
    expect(await sessions.recordInbound(CONN, { ...inbound("FROM-PHONE-1"), fromMe: true, pushName: null }))
      .toBe(true);
    const [row] = await sql<{ direction: string; status: string; sent: boolean }>(
      `SELECT direction, status, sent_at IS NOT NULL AS sent FROM onconnect.messages
        WHERE provider_message_id = 'FROM-PHONE-1'`);
    expect(row).toEqual({ direction: "outbound", status: "sent", sent: true });
    const [event] = await sql<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM onconnect.webhook_events
        WHERE event_type = 'message.received' AND payload ->> 'providerMessageId' = 'FROM-PHONE-1'`);
    expect(event?.payload).toMatchObject({
      fromMe: true, from: "5511999999999", providerMessageId: "FROM-PHONE-1",
      jid: "5511999999999@s.whatsapp.net", counterpartIsPhone: true,
      timestamp: "2026-11-17T10:00:00+00:00",
    });
  });

  it("drops the echo of a message sent through the API (same WhatsApp id)", async () => {
    // markSending stored 3EB0OUT before the send; the socket then echoes it.
    expect(await sessions.recordInbound(CONN, { ...inbound("3EB0OUT"), fromMe: true })).toBe(false);
    const events = await sql(
      "SELECT 1 FROM onconnect.webhook_events WHERE payload ->> 'providerMessageId' = '3EB0OUT' AND event_type = 'message.received'");
    expect(events).toEqual([]);
    // Status events carry the WhatsApp id the D-API layer reports by.
    const ids = await sql<{ id: string }>(
      `SELECT DISTINCT payload ->> 'providerMessageId' AS id FROM onconnect.webhook_events
        WHERE event_type = 'message.status' AND payload ->> 'messageId' = $1`, [OUT]);
    expect(ids).toEqual([{ id: "3EB0OUT" }]);
  });

  it("lists stale outbox jobs for replay", async () => {
    // updated_at is set by a trigger, so age is simulated with a zero threshold.
    await sql("UPDATE onconnect.message_jobs SET status = 'pending' WHERE message_id = $1", [OUT]);
    expect(await outbound.stalePending(0)).toContain(OUT);
    expect(await outbound.stalePending(3600)).not.toContain(OUT);
  });

  it("finds unacknowledged inbound messages for the recipient and records receipts", async () => {
    const phone = "5511999999999";
    const jid = `${phone}@s.whatsapp.net`;
    const lid = "123456789@lid";
    const cutoff = new Date("2100-01-01T00:00:00Z");
    expect(await sessions.loadSettings(CONN)).toEqual({ reject_calls: false, read_on_reply: false });
    expect(await sessions.messagesToRead(CONN, [jid, lid], phone, cutoff)).toEqual([]);

    await sql("UPDATE onconnect.connections SET reject_calls = true, read_on_reply = true WHERE id = $1", [CONN]);
    await sessions.recordInbound(CONN, { ...inbound("READ-LID"), jid: lid, counterpart: "123456789", counterpartIsPhone: false });
    await sessions.recordInbound(CONN, {
      ...inbound("OTHER"), jid: `${phone}@lid`, counterpartIsPhone: false,
    });

    expect(await sessions.loadSettings(CONN)).toEqual({ reject_calls: true, read_on_reply: true });
    expect(await sessions.messagesToRead(CONN, [jid, lid], phone, new Date(0))).toEqual([]);
    expect(await sessions.messagesToRead(CONN, [jid, lid], phone, cutoff)).toEqual([
      { id: "READ-LID", remoteJid: lid },
      { id: "IN-1", remoteJid: jid },
    ]);
    await sessions.recordReadReceipts(CONN, ["READ-LID", "IN-1"]);
    expect(await sessions.messagesToRead(CONN, [jid, lid], phone, cutoff)).toEqual([]);
  });

  it("ignores events for a retired connection", async () => {
    await sql("UPDATE onconnect.connections SET deleted_at = now() WHERE id = $1", [CONN]);
    expect(await sessions.recordInbound(CONN, inbound("IN-2"))).toBe(false);
    expect(await sessions.loadSettings(CONN)).toBeNull();
    await sessions.setStatus(CONN, "error", "should_not_apply");
    const [row] = await sql<{ status_reason: string | null }>(
      "SELECT status_reason FROM onconnect.connections WHERE id = $1", [CONN]);
    expect(row?.status_reason).not.toBe("should_not_apply");
  });
});
