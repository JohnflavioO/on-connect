import { initAuthCreds, makeWASocket } from "baileys";
import type * as Baileys from "baileys";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBaileysSocketFactory } from "../src/baileys-socket.js";
import type { OutgoingMedia } from "../src/outbound.js";
import type { SessionBehaviorStore } from "../src/store.js";

vi.mock("baileys", async (importOriginal) => ({
  ...await importOriginal<typeof Baileys>(),
  makeWASocket: vi.fn(),
}));

const PHONE = "5585999132494";
const REGISTERED_JID = "558599132494@s.whatsapp.net";
const MESSAGE_ID = "3EB0STABLE";

function setup() {
  const behavior = {
    loadSettings: vi.fn<SessionBehaviorStore["loadSettings"]>()
      .mockResolvedValue({ reject_calls: false, read_on_reply: false }),
    messagesToRead: vi.fn<SessionBehaviorStore["messagesToRead"]>().mockResolvedValue([]),
    recordReadReceipts: vi.fn<SessionBehaviorStore["recordReadReceipts"]>().mockResolvedValue(undefined),
  };
  const socket = {
    signalRepository: { lidMapping: { getLIDForPN: vi.fn(async () => "989898@lid") } },
    rejectCall: vi.fn(async () => undefined),
    readMessages: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ev: { on: vi.fn<(event: string, handler: unknown) => void>() },
    onWhatsApp: vi.fn<ReturnType<typeof makeWASocket>["onWhatsApp"]>()
      .mockResolvedValue([{ exists: true, jid: REGISTERED_JID }]),
    sendMessage: vi.fn(async () => ({ key: { id: MESSAGE_ID } })),
  };
  vi.mocked(makeWASocket).mockReturnValue(socket as unknown as ReturnType<typeof makeWASocket>);
  const adapter = createBaileysSocketFactory(pino({ level: "silent" }), undefined, {
    maxMediaBytes: 1024, behavior,
  })("connection-1", {
    state: { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => undefined } },
    saveCreds: async () => undefined,
    clear: async () => undefined,
  }, {
    onQr: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(),
    onCredsUpdate: vi.fn(), onMessages: vi.fn(), onStatus: vi.fn(),
  });
  return { socket, adapter, behavior };
}

const media = (type: OutgoingMedia["type"]): OutgoingMedia => ({
  type, bytes: Buffer.from("file"), mimetype: null,
  caption: "caption", fileName: "test.dat", voice: false,
});

afterEach(() => vi.clearAllMocks());

describe("Baileys outbound recipient resolution", () => {
  it("sends text to the registered JID and preserves the message id", async () => {
    const { socket, adapter } = setup();
    expect(await adapter.sendText(PHONE, "test", MESSAGE_ID)).toBe(MESSAGE_ID);
    expect(socket.onWhatsApp).toHaveBeenCalledWith(PHONE);
    expect(socket.sendMessage).toHaveBeenCalledWith(REGISTERED_JID, { text: "test" }, { messageId: MESSAGE_ID });
  });

  it.each(["image", "video", "audio", "document"] as const)("resolves the recipient for %s", async (type) => {
    const { socket, adapter } = setup();
    expect(await adapter.sendMedia(PHONE, media(type), MESSAGE_ID)).toBe(MESSAGE_ID);
    expect(socket.onWhatsApp).toHaveBeenCalledWith(PHONE);
    expect(socket.sendMessage).toHaveBeenCalledWith(
      REGISTERED_JID, expect.objectContaining({ [type]: Buffer.from("file") }), { messageId: MESSAGE_ID },
    );
  });

  it("does not remove digits when WhatsApp returns the original number", async () => {
    const { socket, adapter } = setup();
    const jid = `${PHONE}@s.whatsapp.net`;
    socket.onWhatsApp.mockResolvedValue([{ exists: true, jid }]);
    await adapter.sendText(PHONE, "test", MESSAGE_ID);
    expect(socket.sendMessage).toHaveBeenCalledWith(jid, { text: "test" }, { messageId: MESSAGE_ID });
  });

  it.each(["text", "image"] as const)("does not send %s to an unregistered recipient", async (type) => {
    const { socket, adapter } = setup();
    socket.onWhatsApp.mockResolvedValue([{ exists: false, jid: `${PHONE}@s.whatsapp.net` }]);
    const send = type === "text" ? adapter.sendText(PHONE, "test", MESSAGE_ID)
      : adapter.sendMedia(PHONE, media(type), MESSAGE_ID);
    await expect(send).rejects.toThrow("recipient_not_on_whatsapp");
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it("does not fall back to an unverified JID when lookup has no results", async () => {
    const { socket, adapter } = setup();
    for (const response of [undefined, []]) {
      socket.onWhatsApp.mockResolvedValue(response);
      await expect(adapter.sendText(PHONE, "test", MESSAGE_ID)).rejects.toThrow();
    }
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["text", "image"] as const)("propagates lookup errors for %s so the outbox can retry", async (type) => {
    const { socket, adapter } = setup();
    socket.onWhatsApp.mockRejectedValue(new Error("lookup timed out"));
    const send = type === "text" ? adapter.sendText(PHONE, "test", MESSAGE_ID)
      : adapter.sendMedia(PHONE, media(type), MESSAGE_ID);
    await expect(send).rejects.toThrow("lookup timed out");
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
});

describe("per-connection WhatsApp behavior", () => {
  it("rejects live offers only when enabled", async () => {
    const { socket, behavior } = setup();
    const onCalls = socket.ev.on.mock.calls.find(([event]) => event === "call")?.[1] as (calls: Baileys.WACallEvent[]) => void;
    const offers = [
      { id: "voice", from: REGISTERED_JID, status: "offer", offline: false },
      { id: "video", from: REGISTERED_JID, status: "offer", offline: false, isVideo: true },
      { id: "old", from: REGISTERED_JID, status: "offer", offline: true },
      { id: "ended", from: REGISTERED_JID, status: "reject", offline: false },
    ] as const;
    const calls = offers.map((offer) => ({ ...offer, chatId: REGISTERED_JID, date: new Date() }));

    onCalls(calls);
    await Promise.resolve();
    expect(socket.rejectCall).not.toHaveBeenCalled();

    behavior.loadSettings.mockResolvedValue({ reject_calls: true, read_on_reply: false });
    onCalls(calls);
    await vi.waitFor(() => {
      expect(socket.rejectCall.mock.calls).toEqual([
        ["voice", REGISTERED_JID], ["video", REGISTERED_JID],
      ]);
    });
  });

  it("marks earlier messages as read after a successful media send", async () => {
    const { socket, adapter, behavior } = setup();
    const keys = [{ id: "inbound", remoteJid: "989898@lid" }];
    behavior.loadSettings.mockResolvedValue({ reject_calls: false, read_on_reply: true });
    behavior.messagesToRead.mockResolvedValueOnce(keys);

    await expect(adapter.sendMedia(PHONE, media("image"), MESSAGE_ID)).resolves.toBe(MESSAGE_ID);

    expect(behavior.messagesToRead).toHaveBeenCalledWith(
      "connection-1", [REGISTERED_JID, "989898@lid"], "558599132494", expect.any(Date),
    );
    expect(socket.readMessages).toHaveBeenCalledExactlyOnceWith(keys);
    expect(behavior.recordReadReceipts).toHaveBeenCalledExactlyOnceWith("connection-1", ["inbound"]);
    expect(socket.sendMessage).toHaveBeenCalledBefore(socket.readMessages);
  });

  it("preserves the send result on a receipt failure without recording it", async () => {
    const { socket, adapter, behavior } = setup();
    behavior.loadSettings.mockResolvedValue({ reject_calls: false, read_on_reply: true });
    behavior.messagesToRead.mockResolvedValueOnce([{ id: "inbound", remoteJid: REGISTERED_JID }]);
    socket.readMessages.mockRejectedValueOnce(new Error("read failed"));

    await expect(adapter.sendText(PHONE, "reply", MESSAGE_ID)).resolves.toBe(MESSAGE_ID);
    expect(behavior.recordReadReceipts).not.toHaveBeenCalled();

    socket.sendMessage.mockRejectedValueOnce(new Error("send failed"));
    await expect(adapter.sendText(PHONE, "reply", MESSAGE_ID)).rejects.toThrow("send failed");
    expect(socket.readMessages).toHaveBeenCalledTimes(1);
  });
});
