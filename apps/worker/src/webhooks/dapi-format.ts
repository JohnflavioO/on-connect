import type { ClaimedDelivery } from "./store.js";

/**
 * Webhook body in the D-API envelope, for endpoints registered through the
 * compatible session routes: `{ event, sessionId, traceId, data }`. Field
 * names follow what a D-API client reads (Tendi's webhook handler).
 */
export interface DapiEnvelope {
  event: string;
  sessionId: string;
  traceId: string;
  data: Record<string, unknown>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** D-API reports only connected / connecting / disconnected. */
function dapiConnectionStatus(status: string | null): string {
  if (status === "connected") return "connected";
  if (status === "disconnected" || status === "error") return "disconnected";
  return "connecting";
}

/** D-API message type words. A voice note is "ptt". */
function dapiMessageType(content: Record<string, unknown>): string {
  const type = text(content.type) ?? "unknown";
  if (type === "audio" && content.voice === true) return "ptt";
  return type;
}

/**
 * `messages.received` data, as D-API sends it for a 1:1 chat. With `fromMe`
 * (sent from the phone) the other party is in `to`, otherwise in `from`.
 * The jid is a phone JID when WhatsApp shared the number; otherwise the
 * opaque id, which a D-API client cannot turn into a phone (and skips).
 */
function receivedData(payload: Record<string, unknown>): Record<string, unknown> | null {
  const id = text(payload.providerMessageId);
  if (!id) return null; // Events stored before this layer existed carry no WhatsApp id.
  const content = record(payload.content);
  const fromMe = payload.fromMe === true;
  const digits = text(payload.from);
  const jid = payload.counterpartIsPhone === true && digits
    ? `${digits}@s.whatsapp.net`
    : text(payload.jid);
  const name = text(payload.contactName);
  const type = dapiMessageType(content);
  const caption = text(content.caption);
  const isMedia = ["image", "video", "audio", "ptt", "document", "sticker"].includes(type);
  const timestamp = Date.parse(text(payload.timestamp) ?? "");

  return {
    id,
    type,
    message: text(content.text) ?? caption,
    fromMe,
    from: fromMe ? {} : { jid, name },
    to: fromMe ? { jid } : {},
    from_name: fromMe ? null : name,
    timestamp: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null,
    is_group: false,
    ...(isMedia
      ? {
          media_data: { mimetype: text(content.mimetype), filename: text(content.fileName), caption },
          media_url: null,
        }
      : {}),
    ...(type === "location"
      ? { data: { latitude: content.latitude, longitude: content.longitude, name: content.name, address: content.address } }
      : {}),
    ...(type === "contact" ? { data: { displayName: content.displayName, vcard: content.vcard } } : {}),
  };
}

/** Null when the event has no D-API equivalent (yet): it is not sent. */
export function toDapiEnvelope(delivery: ClaimedDelivery): DapiEnvelope | null {
  const payload = record(delivery.payload);
  const sessionId = delivery.sessionId ?? text(payload.sessionId) ?? delivery.connectionId ??
    delivery.tenantExternalId;
  const envelope = (event: string, data: Record<string, unknown>): DapiEnvelope =>
    ({ event, sessionId, traceId: delivery.id, data });

  if (delivery.eventType === "connection.status") {
    return envelope("connection.status", {
      status: dapiConnectionStatus(text(payload.status)),
      phone: text(payload.phone),
      reason: text(payload.reason),
      connectionId: delivery.connectionId,
    });
  }

  if (delivery.eventType === "message.received") {
    const data = receivedData(payload);
    return data ? envelope("messages.received", data) : null;
  }

  if (delivery.eventType === "message.status") {
    // D-API reports delivery and read by WhatsApp id; "sent" is the answer to
    // the send call itself, and a failure has no D-API event.
    const messageId = text(payload.providerMessageId);
    const status = text(payload.status);
    if (!messageId || (status !== "delivered" && status !== "read")) return null;
    return envelope(status === "read" ? "message.read" : "message.delivered", {
      message_id: messageId,
      status,
    });
  }
  return null;
}
