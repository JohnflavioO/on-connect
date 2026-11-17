import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createOutboundProcessor, type Sender } from "../src/outbound.js";
import { SessionNotReadyError } from "../src/session-manager.js";
import type { OutboundMessage, OutboundStore } from "../src/store.js";

function setup(message: Partial<OutboundMessage> | null = {}, sender: Partial<Sender> = {}) {
  const row: OutboundMessage | null = message === null ? null : {
    id: "m1", connectionId: "c1", status: "queued", to: "5511999999999", text: "oi",
    providerMessageId: null, ...message,
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
    ...sender,
  };
  const process = createOutboundProcessor({ store, sender: send, logger: pino({ level: "silent" }) });
  return { store, send, process };
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
});
