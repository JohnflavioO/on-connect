import type { MessageContent, MessageStatus } from "@on-connect/core";
import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WAMessageUpdate,
} from "baileys";

/** An inbound message reduced to what On Connect stores and forwards. */
export interface InboundMessage {
  providerId: string;
  /** The sender's chat JID as WhatsApp addressed it (may be an opaque @lid). */
  jid: string;
  /** Phone digits when WhatsApp exposes them, otherwise the opaque id digits. */
  counterpart: string;
  counterpartIsPhone: boolean;
  pushName: string | null;
  timestamp: Date;
  content: MessageContent;
  /**
   * Sent by the linked number itself from another device (the phone). The
   * counterpart is then the recipient. Messages this process sent through
   * the API are deduplicated by their WhatsApp id when stored.
   */
  fromMe: boolean;
}

export interface StatusUpdate {
  providerId: string;
  status: Extract<MessageStatus, "sent" | "delivered" | "read" | "failed">;
}

const userDigits = (jid: string | null | undefined): string | null => {
  const user = jid?.split("@")[0]?.split(":")[0] ?? "";
  return /^[0-9]{5,20}$/.test(user) ? user : null;
};

/** Message types that carry no user-visible content. */
const IGNORED_TYPES = new Set<string>([
  "protocolMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "pollUpdateMessage",
  "keepInChatMessage",
]);

function describe(message: proto.IMessage): MessageContent | null {
  const type = getContentType(message);
  if (!type || IGNORED_TYPES.has(type)) return null;
  switch (type) {
    case "conversation":
      return { type: "text", text: message.conversation ?? "" };
    case "extendedTextMessage":
      return { type: "text", text: message.extendedTextMessage?.text ?? "" };
    case "imageMessage":
      return media("image", message.imageMessage);
    case "videoMessage":
      return media("video", message.videoMessage);
    case "documentMessage":
      return { ...media("document", message.documentMessage),
        ...(message.documentMessage?.fileName ? { fileName: message.documentMessage.fileName } : {}) };
    case "audioMessage":
      return { ...media("audio", message.audioMessage), voice: Boolean(message.audioMessage?.ptt) };
    case "stickerMessage":
      return media("sticker", message.stickerMessage);
    case "locationMessage":
      return {
        type: "location",
        latitude: message.locationMessage?.degreesLatitude ?? null,
        longitude: message.locationMessage?.degreesLongitude ?? null,
        name: message.locationMessage?.name ?? null,
        address: message.locationMessage?.address ?? null,
      };
    case "contactMessage":
      return {
        type: "contact",
        displayName: message.contactMessage?.displayName ?? null,
        vcard: message.contactMessage?.vcard ?? null,
      };
    case "reactionMessage":
      return {
        type: "reaction",
        text: message.reactionMessage?.text ?? "",
        targetMessageId: message.reactionMessage?.key?.id ?? null,
      };
    default:
      // Kept with its type so the integrator knows something arrived.
      return { type };
  }
}

function media(
  type: string,
  part: { caption?: string | null; mimetype?: string | null } | null | undefined,
): MessageContent {
  return {
    type,
    ...(part?.caption ? { caption: part.caption } : {}),
    ...(part?.mimetype ? { mimetype: part.mimetype } : {}),
  };
}

/**
 * Maps one message of a 1:1 chat, received or sent from the phone. Returns
 * null for what On Connect does not forward yet: groups, broadcasts/status,
 * and protocol noise (edits, deletions, key distribution).
 */
export function toInbound(message: WAMessage): InboundMessage | null {
  const key = message.key;
  const jid = key.remoteJid;
  if (!key.id || !jid) return null;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid)) return null;

  const content = normalizeMessageContent(message.message);
  if (!content) return null;
  const described = describe(content);
  if (!described) return null;

  // With LID addressing the chat id is opaque; the phone JID, when WhatsApp
  // shares it, arrives in remoteJidAlt.
  const phone = userDigits(jid.endsWith("@s.whatsapp.net") ? jid : key.remoteJidAlt);
  const counterpart = phone ?? userDigits(jid);
  if (!counterpart) return null;

  const seconds = Number(message.messageTimestamp ?? 0);
  return {
    providerId: key.id,
    jid,
    counterpart,
    counterpartIsPhone: phone !== null,
    // On an own message the push name is the linked number's, not the contact's.
    pushName: key.fromMe ? null : message.pushName ?? null,
    timestamp: seconds > 0 ? new Date(seconds * 1000) : new Date(),
    content: described,
    fromMe: key.fromMe === true,
  };
}

/** Maps the WhatsApp delivery receipts of messages we sent. */
export function toStatus(update: WAMessageUpdate): StatusUpdate | null {
  const id = update.key.id;
  const status = update.update.status;
  if (!id || !update.key.fromMe || status === undefined || status === null) return null;
  const Status = proto.WebMessageInfo.Status;
  const mapped =
    status === Status.ERROR ? "failed"
    : status === Status.SERVER_ACK ? "sent"
    : status === Status.DELIVERY_ACK ? "delivered"
    : status === Status.READ || status === Status.PLAYED ? "read"
    : null;
  return mapped ? { providerId: id, status: mapped } : null;
}
