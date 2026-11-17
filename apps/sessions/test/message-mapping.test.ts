import { proto, type WAMessage, type WAMessageUpdate } from "baileys";
import { describe, expect, it } from "vitest";
import { toInbound, toStatus } from "../src/message-mapping.js";

const msg = (key: Partial<WAMessage["key"]>, message: WAMessage["message"], extra: Partial<WAMessage> = {}) =>
  ({
    key: { id: "MSG1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, ...key },
    message,
    messageTimestamp: 1_790_000_000,
    pushName: "Ana",
    ...extra,
  }) as WAMessage;

describe("toInbound", () => {
  it("maps a plain text from a phone JID", () => {
    expect(toInbound(msg({}, { conversation: "oi" }))).toEqual({
      providerId: "MSG1",
      jid: "5511999999999@s.whatsapp.net",
      counterpart: "5511999999999",
      counterpartIsPhone: true,
      pushName: "Ana",
      timestamp: new Date(1_790_000_000_000),
      content: { type: "text", text: "oi" },
      fromMe: false,
    });
  });

  it("maps a message the linked number sent from the phone, without its push name", () => {
    const result = toInbound(msg({ fromMe: true }, { conversation: "enviado do celular" }));
    expect(result).toMatchObject({
      providerId: "MSG1",
      counterpart: "5511999999999",
      fromMe: true,
      pushName: null,
      content: { type: "text", text: "enviado do celular" },
    });
  });

  it("uses the phone JID WhatsApp shares when the chat is addressed by LID", () => {
    const result = toInbound(msg(
      { remoteJid: "123456789012345@lid", remoteJidAlt: "5511988887777@s.whatsapp.net" },
      { extendedTextMessage: { text: "via lid" } },
    ));
    expect(result?.counterpart).toBe("5511988887777");
    expect(result?.counterpartIsPhone).toBe(true);
    expect(result?.jid).toBe("123456789012345@lid");
  });

  it("keeps an opaque LID when no phone is shared, flagged as not a phone", () => {
    const result = toInbound(msg({ remoteJid: "123456789012345@lid" }, { conversation: "x" }));
    expect(result?.counterpart).toBe("123456789012345");
    expect(result?.counterpartIsPhone).toBe(false);
  });

  it.each([
    ["group", msg({ remoteJid: "1203630@g.us" }, { conversation: "x" })],
    ["status broadcast", msg({ remoteJid: "status@broadcast" }, { conversation: "x" })],
    ["protocol message", msg({}, { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE } })],
    ["empty message", msg({}, undefined)],
    ["no id", msg({ id: null }, { conversation: "x" })],
  ])("ignores %s", (_label, message) => {
    expect(toInbound(message)).toBeNull();
  });

  it("describes media and other types without their payload", () => {
    expect(toInbound(msg({}, { imageMessage: { caption: "foto", mimetype: "image/jpeg" } }))?.content)
      .toEqual({ type: "image", caption: "foto", mimetype: "image/jpeg" });
    expect(toInbound(msg({}, { audioMessage: { mimetype: "audio/ogg", ptt: true } }))?.content)
      .toEqual({ type: "audio", mimetype: "audio/ogg", voice: true });
    expect(toInbound(msg({}, { documentMessage: { fileName: "a.pdf", mimetype: "application/pdf" } }))?.content)
      .toEqual({ type: "document", mimetype: "application/pdf", fileName: "a.pdf" });
    expect(toInbound(msg({}, { reactionMessage: { text: "👍", key: { id: "OUT1" } } }))?.content)
      .toEqual({ type: "reaction", text: "👍", targetMessageId: "OUT1" });
  });

  it("unwraps ephemeral messages", () => {
    const result = toInbound(msg({}, { ephemeralMessage: { message: { conversation: "some" } } }));
    expect(result?.content).toEqual({ type: "text", text: "some" });
  });
});

describe("toStatus", () => {
  const S = proto.WebMessageInfo.Status;
  const update = (status: proto.WebMessageInfo.Status | null, fromMe = true): WAMessageUpdate => ({
    key: { id: "OUT1", remoteJid: "5511999999999@s.whatsapp.net", fromMe },
    update: { status },
  });

  it.each([
    [S.SERVER_ACK, "sent"],
    [S.DELIVERY_ACK, "delivered"],
    [S.READ, "read"],
    [S.PLAYED, "read"],
    [S.ERROR, "failed"],
  ] as const)("maps WhatsApp status %i to %s", (status, expected) => {
    expect(toStatus(update(status))).toEqual({ providerId: "OUT1", status: expected });
  });

  it("ignores pending, missing status and messages not sent by us", () => {
    expect(toStatus(update(S.PENDING))).toBeNull();
    expect(toStatus(update(null))).toBeNull();
    expect(toStatus(update(S.DELIVERY_ACK, false))).toBeNull();
  });
});
