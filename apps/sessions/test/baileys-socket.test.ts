import { initAuthCreds, makeWASocket } from "baileys";
import type * as Baileys from "baileys";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBaileysSocketFactory } from "../src/baileys-socket.js";
import type { OutgoingMedia } from "../src/outbound.js";

vi.mock("baileys", async (importOriginal) => ({
  ...await importOriginal<typeof Baileys>(),
  makeWASocket: vi.fn(),
}));

const PHONE = "5585999132494";
const REGISTERED_JID = "558599132494@s.whatsapp.net";
const MESSAGE_ID = "3EB0STABLE";

function setup() {
  const socket = {
    ev: { on: vi.fn() },
    onWhatsApp: vi.fn<ReturnType<typeof makeWASocket>["onWhatsApp"]>()
      .mockResolvedValue([{ exists: true, jid: REGISTERED_JID }]),
    sendMessage: vi.fn(async () => ({ key: { id: MESSAGE_ID } })),
  };
  vi.mocked(makeWASocket).mockReturnValue(socket as unknown as ReturnType<typeof makeWASocket>);
  const adapter = createBaileysSocketFactory(pino({ level: "silent" }), undefined, {
    maxMediaBytes: 1024,
  })("connection-1", {
    state: { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => undefined } },
    saveCreds: async () => undefined,
    clear: async () => undefined,
  }, {
    onQr: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(),
    onCredsUpdate: vi.fn(), onMessages: vi.fn(), onStatus: vi.fn(),
  });
  return { socket, adapter };
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
