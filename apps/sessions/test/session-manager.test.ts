import { randomBytes } from "node:crypto";
import { createSecretBox, sessionKeys, type ConnectionStatus } from "@on-connect/core";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createRedisAuthState } from "../src/auth-state.js";
import {
  SessionManager,
  SessionNotReadyError,
  type SocketHandlers,
  type WaSocket,
} from "../src/session-manager.js";
import type { InboundMessage, StatusUpdate } from "../src/message-mapping.js";
import { phoneFromJid, type ConnectedAccount, type SessionStore } from "../src/store.js";
import { FakeRedis } from "./fakes.js";

const box = createSecretBox(randomBytes(32).toString("base64"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeStore implements SessionStore {
  rows = new Map<string, { provider: string; status: ConnectionStatus; deleted: boolean }>();
  statuses: Array<[string, ConnectionStatus, string | null]> = [];
  connected: Array<[string, ConnectedAccount]> = [];
  inbound: Array<[string, InboundMessage]> = [];
  statusUpdates: Array<[string, StatusUpdate]> = [];
  numberInUse = false;

  async load(id: string) {
    const row = this.rows.get(id);
    return row ? { id, phoneNumberId: null, ...row } : null;
  }
  async liveIds() {
    return [...this.rows].filter(([, r]) => !r.deleted && ["connecting", "connected"].includes(r.status))
      .map(([id]) => id);
  }
  async setStatus(id: string, status: ConnectionStatus, reason: string | null) {
    this.statuses.push([id, status, reason]);
    const row = this.rows.get(id);
    if (row && !row.deleted) row.status = status;
  }
  async recordInbound(id: string, message: InboundMessage) {
    this.inbound.push([id, message]);
    return true;
  }
  async recordStatus(id: string, update: StatusUpdate) {
    this.statusUpdates.push([id, update]);
    return true;
  }
  async markConnected(id: string, account: ConnectedAccount) {
    if (this.numberInUse) return "number_in_use" as const;
    this.connected.push([id, account]);
    const row = this.rows.get(id);
    if (row) row.status = "connected";
    return "ok" as const;
  }
}

function setup(options: {
  maxSessions?: number;
  media?: { save(bytes: Buffer, meta: { mimetype: string | null }): Promise<string> };
} = {}) {
  const store = new FakeStore();
  const redis = new FakeRedis();
  // Plain mock properties (not WaSocket methods), so assertions can reference them.
  const sockets: Array<{ id: string; handlers: SocketHandlers; socket: {
    logout: ReturnType<typeof vi.fn<() => Promise<void>>>;
    end: ReturnType<typeof vi.fn<() => void>>;
    requestPairingCode: ReturnType<typeof vi.fn<(phone: string) => Promise<string>>>;
    newMessageId: ReturnType<typeof vi.fn<() => string>>;
    sendText: ReturnType<typeof vi.fn<(to: string, text: string, id: string) => Promise<string>>>;
    sendMedia: ReturnType<typeof vi.fn<(to: string, media: unknown, id: string) => Promise<string>>>;
    profilePictureUrl: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  } }> = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const manager = new SessionManager({
    store,
    redis,
    createAuth: (id) => createRedisAuthState(redis, box, id),
    createSocket: (id, _auth, handlers) => {
      const socket: WaSocket & (typeof sockets)[number]["socket"] = {
        logout: vi.fn(async () => undefined),
        end: vi.fn(),
        requestPairingCode: vi.fn(async () => "ABCD-1234"),
        newMessageId: vi.fn(() => "3EB0TESTID"),
        sendText: vi.fn(async (_to: string, _text: string, id: string) => id),
        sendMedia: vi.fn(async (_to: string, _media: unknown, id: string) => id),
        profilePictureUrl: vi.fn(async () => null),
      };
      sockets.push({ id, handlers, socket });
      return socket;
    },
    logger: pino({ level: "silent" }),
    maxSessions: options.maxSessions ?? 10,
    ...(options.media ? { media: options.media } : {}),
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    qrWaitMs: 1_000,
  });
  const add = (id: string, status: ConnectionStatus = "pending") =>
    store.rows.set(id, { provider: "whatsapp_web", status, deleted: false });
  const last = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket opened");
    return socket;
  };
  return { store, redis, sockets, scheduled, manager, add, last };
}

describe("SessionManager", () => {
  it("publishes the QR and records the linked account on open", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    t.last().handlers.onQr("QR-PAYLOAD");
    await flush();
    expect(t.redis.strings.get(sessionKeys.qr("c1"))?.value).toBe("QR-PAYLOAD");
    expect(t.store.statuses.at(-1)).toEqual(["c1", "connecting", "waiting_for_scan"]);

    t.last().handlers.onOpen({ jid: "5511999999999:3@s.whatsapp.net", name: "Loja" });
    await flush();
    expect(t.store.connected).toEqual([["c1", { jid: "5511999999999:3@s.whatsapp.net", name: "Loja" }]]);
    expect(t.redis.strings.has(sessionKeys.qr("c1"))).toBe(false);
  });

  it("starts each connection once", async () => {
    const t = setup();
    t.add("c1");
    await Promise.all([t.manager.start("c1"), t.manager.start("c1")]);
    expect(t.sockets).toHaveLength(1);
  });

  it("ignores retired, unknown and non-WhatsApp-Web connections", async () => {
    const t = setup();
    t.store.rows.set("gone", { provider: "whatsapp_web", status: "pending", deleted: true });
    t.store.rows.set("meta", { provider: "meta_cloud", status: "pending", deleted: false });
    await t.manager.start("gone");
    await t.manager.start("meta");
    await t.manager.start("missing");
    expect(t.sockets).toHaveLength(0);
  });

  it("refuses to exceed the session capacity", async () => {
    const t = setup({ maxSessions: 1 });
    t.add("c1");
    t.add("c2");
    await t.manager.start("c1");
    await t.manager.start("c2");
    expect(t.sockets).toHaveLength(1);
    expect(t.store.statuses.at(-1)).toEqual(["c2", "error", "capacity_exceeded"]);
  });

  it("reconnects with exponential backoff on transient drops", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    t.last().handlers.onOpen({ jid: "5511999999999@s.whatsapp.net", name: null });
    await flush();
    t.last().handlers.onClose("other", "428 closed");
    await flush();
    t.scheduled.shift()?.fn();
    t.last().handlers.onClose("other", "408 lost");
    await flush();
    expect(t.scheduled.map((s) => s.ms)).toEqual([2_000]);
    expect(t.sockets).toHaveLength(2);
    expect(t.store.statuses.at(-1)).toEqual(["c1", "connecting", "reconnecting"]);
  });

  it("reopens immediately when the server requires a restart after pairing", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    t.last().handlers.onClose("restart_required", "515");
    await flush();
    expect(t.sockets).toHaveLength(2);
    expect(t.scheduled).toHaveLength(0);
  });

  it("forgets keys when the phone logs the session out", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    await (await createRedisAuthState(t.redis, box, "c1")).saveCreds();
    t.last().handlers.onClose("logged_out", "401");
    await flush();
    expect(t.redis.hashes.has(sessionKeys.authState("c1"))).toBe(false);
    expect(t.store.statuses.at(-1)).toEqual(["c1", "disconnected", "logged_out"]);
    expect(t.manager.isRunning("c1")).toBe(false);
  });

  it("stops instead of fighting a session that was replaced", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    t.last().handlers.onClose("replaced", "440");
    await flush();
    expect(t.scheduled).toHaveLength(0);
    expect(t.store.statuses.at(-1)).toEqual(["c1", "error", "connection_replaced"]);
  });

  it("marks an unscanned QR as expired instead of retrying forever", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    t.last().handlers.onClose("timed_out", "408");
    await flush();
    expect(t.store.statuses.at(-1)).toEqual(["c1", "disconnected", "qr_expired"]);
    expect(t.scheduled).toHaveLength(0);
  });

  it("logs out and errors when the number is already connected elsewhere", async () => {
    const t = setup();
    t.add("c1");
    t.store.numberInUse = true;
    await t.manager.start("c1");
    const { socket, handlers } = t.last();
    handlers.onOpen({ jid: "5511999999999@s.whatsapp.net", name: null });
    await flush();
    await flush();
    expect(socket.logout).toHaveBeenCalledOnce();
    expect(t.store.statuses.at(-1)).toEqual(["c1", "error", "number_already_connected"]);
  });

  it("logout ends the socket and removes keys and QR", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    t.last().handlers.onQr("QR");
    await flush();
    await t.manager.logout("c1");
    expect(t.last().socket.logout).toHaveBeenCalledOnce();
    expect(t.last().socket.end).toHaveBeenCalled();
    expect(t.redis.strings.has(sessionKeys.qr("c1"))).toBe(false);
    expect(t.store.statuses.at(-1)).toEqual(["c1", "disconnected", "logged_out"]);
    // Late events from the closed socket are ignored.
    t.last().handlers.onClose("other", "late");
    await flush();
    expect(t.scheduled).toHaveLength(0);
  });

  it("requests a pairing code once the socket offers a QR", async () => {
    const t = setup();
    t.add("c1");
    const pending = t.manager.requestPairingCode("c1", "5511999999999");
    await flush();
    await flush();
    t.last().handlers.onQr("QR");
    await pending;
    expect(t.last().socket.requestPairingCode).toHaveBeenCalledWith("5511999999999");
    expect(t.redis.strings.get(sessionKeys.pairingCode("c1"))?.value).toBe("ABCD-1234");
  });

  it("restores only live connections", async () => {
    const t = setup();
    t.add("live", "connected");
    t.add("waiting", "connecting");
    t.add("new", "pending");
    t.add("off", "disconnected");
    expect(await t.manager.restoreAll()).toBe(2);
    expect(t.sockets.map((s) => s.id).sort()).toEqual(["live", "waiting"]);
  });

  it("stopAll closes sockets without logging out", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    t.manager.stopAll();
    expect(t.last().socket.end).toHaveBeenCalled();
    expect(t.last().socket.logout).not.toHaveBeenCalled();
    expect(t.manager.size).toBe(0);
  });
});

describe("SessionManager messages", () => {
  const inbound: InboundMessage = {
    providerId: "MSG1", jid: "5511999999999@s.whatsapp.net", counterpart: "5511999999999",
    counterpartIsPhone: true, pushName: "Ana", timestamp: new Date(0),
    content: { type: "text", text: "oi" }, fromMe: false,
  };

  it("records inbound messages and status updates for the right connection", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    t.last().handlers.onMessages([inbound]);
    t.last().handlers.onStatus([{ providerId: "OUT1", status: "delivered" }]);
    await flush();
    expect(t.store.inbound).toEqual([["c1", inbound]]);
    expect(t.store.statusUpdates).toEqual([["c1", { providerId: "OUT1", status: "delivered" }]]);
  });

  it("stores a media message's file and records the message with its link", async () => {
    const saved: Array<{ bytes: Buffer; mimetype: string | null }> = [];
    const t = setup({
      media: { save: async (bytes, meta) => { saved.push({ bytes, mimetype: meta.mimetype }); return "https://x/media/t.s"; } },
    });
    t.add("c1");
    await t.manager.start("c1");
    const photo = {
      ...inbound, content: { type: "image", mimetype: "image/jpeg" },
      downloadMedia: async () => Buffer.from("jpeg"),
    };
    t.last().handlers.onMessages([photo]);
    await flush();
    await flush();
    expect(saved).toEqual([{ bytes: Buffer.from("jpeg"), mimetype: "image/jpeg" }]);
    expect(t.store.inbound[0]?.[1].mediaUrl).toBe("https://x/media/t.s");
  });

  it("still records a media message whose file could not be downloaded", async () => {
    const t = setup({ media: { save: async () => "never" } });
    t.add("c1");
    await t.manager.start("c1");
    t.last().handlers.onMessages([{
      ...inbound, content: { type: "video" },
      downloadMedia: async () => { throw new Error("expired on WhatsApp"); },
    }]);
    await flush();
    await flush();
    expect(t.store.inbound).toHaveLength(1);
    expect(t.store.inbound[0]?.[1].mediaUrl).toBeUndefined();
  });

  it("keeps recording after one event fails", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    let calls = 0;
    t.store.recordInbound = async (id, message) => {
      calls += 1;
      if (calls === 1) throw new Error("db down");
      t.store.inbound.push([id, message]);
      return true;
    };
    t.last().handlers.onMessages([inbound, { ...inbound, providerId: "MSG2" }]);
    await flush();
    await flush();
    expect(t.store.inbound.map(([, m]) => m.providerId)).toEqual(["MSG2"]);
  });

  it("sends only through an open socket", async () => {
    const t = setup();
    t.add("c1");
    await t.manager.start("c1");
    expect(t.manager.newMessageId("c1")).toBeNull();
    await expect(t.manager.sendText("c1", "5511", "oi", "ID")).rejects.toBeInstanceOf(SessionNotReadyError);

    t.last().handlers.onOpen({ jid: "5511999999999@s.whatsapp.net", name: null });
    await flush();
    expect(t.manager.newMessageId("c1")).toBe("3EB0TESTID");
    expect(await t.manager.sendText("c1", "5511888888888", "oi", "ID1")).toBe("ID1");
    expect(t.last().socket.sendText).toHaveBeenCalledWith("5511888888888", "oi", "ID1");

    t.last().handlers.onClose("other", "lost");
    await flush();
    await expect(t.manager.sendText("c1", "5511", "oi", "ID")).rejects.toBeInstanceOf(SessionNotReadyError);
    await expect(t.manager.sendText("nope", "5511", "oi", "ID")).rejects.toBeInstanceOf(SessionNotReadyError);
  });
});

describe("phoneFromJid", () => {
  it.each([
    ["5511999999999:12@s.whatsapp.net", "5511999999999"],
    ["5511999999999@s.whatsapp.net", "5511999999999"],
    ["123456789012345@lid", null],
    ["status@broadcast", null],
    ["", null],
  ])("%s -> %s", (jid, phone) => {
    expect(phoneFromJid(jid)).toBe(phone);
  });
});
