import type { FetchedBytes } from "@on-connect/core";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createOutboundProcessor, type MediaFetcher, type Sender } from "../src/outbound.js";
import { SessionNotReadyError } from "../src/session-manager.js";
import type { OutboundMessage, OutboundStore } from "../src/store.js";

function setup(
  message: Partial<OutboundMessage> | null = {},
  sender: Partial<Sender> = {},
  fetched: FetchedBytes = { ok: true, bytes: Buffer.from("file"), contentType: "image/jpeg" },
) {
  const row: OutboundMessage | null = message === null ? null : {
    id: "m1", connectionId: "c1", status: "queued", to: "5511999999999",
    content: { type: "text", text: "oi" }, providerMessageId: null, ...message,
  };
  const store = {
    load: vi.fn(async () => row),
    markSending: vi.fn(async () => undefined),
    markSent: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    stalePending: vi.fn(async () => []),
  } satisfies OutboundStore;
  const send = {
    newMessageId: vi.fn(() => "3EB0NEW"),
    sendText: vi.fn(async (_c: string, _to: string, _t: string, id: string) => id),
    sendMedia: vi.fn(async (_c: string, _to: string, _m: unknown, id: string) => id),
    ...sender,
  };
  const fetchMedia = vi.fn<MediaFetcher>(async () => fetched);
  const process = createOutboundProcessor({ store, sender: send, fetchMedia, logger: pino({ level: "silent" }) });
  return { store, send, fetchMedia, process };
}

const attempt = (n: number) => ({ messageId: "m1", attempt: n, maxAttempts: 3 });

describe("outbound processor", () => {
  it("stores the WhatsApp id before sending, then marks sent", async () => {
    const t = setup();
    expect(await t.process(attempt(1))).toBe("sent");
    expect(t.store.markSending).toHaveBeenCalledWith("m1", "3EB0NEW");
    expect(t.send.sendText).toHaveBeenCalledWith("c1", "5511999999999", "oi", "3EB0NEW");
    expect(t.store.markSent).toHaveBeenCalledWith("m1");
  });

  it("reuses the stored WhatsApp id on retry", async () => {
    const t = setup({ status: "sending", providerMessageId: "3EB0OLD" });
    await t.process(attempt(2));
    expect(t.send.newMessageId).not.toHaveBeenCalled();
    expect(t.send.sendText).toHaveBeenCalledWith("c1", "5511999999999", "oi", "3EB0OLD");
  });

  it.each(["sent", "delivered", "read", "failed"])("skips a message already %s", async (status) => {
    const t = setup({ status });
    expect(await t.process(attempt(1))).toBe("skipped");
    expect(t.send.sendText).not.toHaveBeenCalled();
  });

  it("skips a message that does not exist", async () => {
    expect(await setup(null).process(attempt(1))).toBe("skipped");
  });

  it("retries while the session is not open, then fails on the last attempt", async () => {
    const t = setup({}, { newMessageId: vi.fn(() => null) });
    await expect(t.process(attempt(1))).rejects.toBeInstanceOf(SessionNotReadyError);
    expect(t.store.markFailed).not.toHaveBeenCalled();
    expect(await t.process(attempt(3))).toBe("failed");
    expect(t.store.markFailed).toHaveBeenCalledWith("m1", "connection_not_ready", expect.any(String));
  });

  it("retries a failed send and records the error code on the last attempt", async () => {
    const t = setup({}, { sendText: vi.fn(async () => { throw new Error("socket closed"); }) });
    await expect(t.process(attempt(1))).rejects.toThrow("socket closed");
    expect(await t.process(attempt(3))).toBe("failed");
    expect(t.store.markFailed).toHaveBeenCalledWith("m1", "send_failed", "socket closed");
    expect(t.store.markSent).not.toHaveBeenCalled();
  });

  it("downloads a media message's file and sends it with its caption", async () => {
    const t = setup({ content: { type: "image", url: "https://files.example.com/a.jpg", caption: "foto" } });
    expect(await t.process(attempt(1))).toBe("sent");
    expect(t.fetchMedia).toHaveBeenCalledWith("https://files.example.com/a.jpg");
    expect(t.send.sendMedia).toHaveBeenCalledWith("c1", "5511999999999", {
      type: "image", bytes: Buffer.from("file"), mimetype: "image/jpeg", caption: "foto", fileName: null, voice: false,
    }, "3EB0NEW");
  });

  it("sends a voice note and a named document", async () => {
    const voice = setup({ content: { type: "audio", url: "https://f.example.com/v.ogg", voice: true } });
    await voice.process(attempt(1));
    expect(voice.send.sendMedia).toHaveBeenCalledWith("c1", "5511999999999",
      expect.objectContaining({ type: "audio", voice: true, caption: null }), "3EB0NEW");

    const doc = setup({
      content: { type: "document", url: "https://f.example.com/p", fileName: "proposta.pdf", mimetype: "application/pdf" },
    });
    await doc.process(attempt(1));
    expect(doc.send.sendMedia).toHaveBeenCalledWith("c1", "5511999999999", expect.objectContaining({
      type: "document", fileName: "proposta.pdf", mimetype: "application/pdf",
    }), "3EB0NEW");
  });

  it("fails a media message whose file cannot be downloaded, after the retries", async () => {
    const t = setup({ content: { type: "video", url: "https://f.example.com/x.mp4" } }, {},
      { ok: false, error: "http_403" });
    await expect(t.process(attempt(1))).rejects.toThrow("media_unavailable");
    expect(await t.process(attempt(3))).toBe("failed");
    expect(t.store.markFailed).toHaveBeenCalledWith("m1", "media_unavailable", "media_unavailable: http_403");
    expect(t.send.sendMedia).not.toHaveBeenCalled();
  });
});
