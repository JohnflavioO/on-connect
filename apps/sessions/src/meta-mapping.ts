import type { MessageContent, OutboundContent } from "@on-connect/core";
import type { MetaOutgoing } from "./meta-graph.js";
import type { InboundMessage, StatusUpdate } from "./message-mapping.js";

/**
 * Meta webhook bodies to On Connect's own shapes, and outbound content to
 * Meta's. Inbound content uses the same fields as WhatsApp Web (type, text,
 * caption, mimetype, fileName...), so an integrator handles both alike.
 */

/** A received message, plus the Meta media id to fetch its file. */
export interface MetaInbound extends InboundMessage {
  mediaId: string | null;
}

/** Statuses carry Meta's error code when a message failed (e.g. meta_131047). */
export interface MetaStatus extends StatusUpdate {
  errorCode: string | null;
  timestamp: Date;
}

/** Everything one webhook body says about one phone number. */
export interface MetaChange {
  phoneNumberId: string;
  messages: MetaInbound[];
  statuses: MetaStatus[];
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const seconds = (value: unknown): Date => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

/** Media fields shared by image, video, audio, document and sticker. */
function media(type: string, part: Json | null): { content: MessageContent; mediaId: string | null } {
  const caption = str(part?.caption);
  const mimetype = str(part?.mime_type);
  return {
    content: { type, ...(caption ? { caption } : {}), ...(mimetype ? { mimetype } : {}) },
    mediaId: str(part?.id),
  };
}

function describe(message: Json): { content: MessageContent; mediaId: string | null } {
  const type = str(message.type) ?? "unknown";
  const part = obj(message[type]);
  switch (type) {
    case "text":
      return { content: { type: "text", text: str(part?.body) ?? "" }, mediaId: null };
    case "image":
    case "video":
    case "sticker":
      return media(type, part);
    case "audio": {
      const described = media("audio", part);
      return { ...described, content: { ...described.content, voice: part?.voice === true } };
    }
    case "document": {
      const described = media("document", part);
      const fileName = str(part?.filename);
      return { ...described, content: { ...described.content, ...(fileName ? { fileName } : {}) } };
    }
    case "location":
      return {
        content: {
          type: "location", latitude: num(part?.latitude), longitude: num(part?.longitude),
          name: str(part?.name), address: str(part?.address),
        },
        mediaId: null,
      };
    case "contacts": {
      const first = obj(arr(message.contacts)[0]);
      return {
        content: { type: "contact", displayName: str(obj(first?.name)?.formatted_name), vcard: null },
        mediaId: null,
      };
    }
    case "reaction":
      return {
        content: { type: "reaction", text: str(part?.emoji) ?? "", targetMessageId: str(part?.message_id) },
        mediaId: null,
      };
    case "button":
      // A tap on a template's quick-reply button.
      return { content: { type: "button", text: str(part?.text) ?? "", payload: str(part?.payload) }, mediaId: null };
    case "interactive": {
      const reply = obj(part?.button_reply) ?? obj(part?.list_reply);
      return {
        content: {
          type: "interactive", text: str(reply?.title) ?? "", replyId: str(reply?.id),
          ...(str(reply?.description) ? { description: str(reply?.description) } : {}),
        },
        mediaId: null,
      };
    }
    default:
      // Kept with its type so the integrator knows something arrived.
      return { content: { type }, mediaId: null };
  }
}

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/**
 * The messages and statuses of a WhatsApp Business Account webhook, grouped
 * by the phone number they belong to. Anything malformed or unknown is
 * skipped: Meta adds fields and change types over time.
 */
export function parseMetaWebhook(payload: unknown): MetaChange[] {
  const body = obj(payload);
  if (!body || body.object !== "whatsapp_business_account") return [];
  const changes: MetaChange[] = [];
  for (const entry of arr(body.entry)) {
    for (const change of arr(obj(entry)?.changes)) {
      const c = obj(change);
      const value = obj(c?.value);
      const phoneNumberId = str(obj(value?.metadata)?.phone_number_id);
      if (c?.field !== "messages" || !value || !phoneNumberId) continue;

      const names = new Map<string, string>();
      for (const contact of arr(value.contacts)) {
        const waId = str(obj(contact)?.wa_id);
        const name = str(obj(obj(contact)?.profile)?.name);
        if (waId && name) names.set(waId, name);
      }

      const messages: MetaInbound[] = [];
      for (const raw of arr(value.messages)) {
        const message = obj(raw);
        const from = str(message?.from);
        const id = str(message?.id);
        if (!message || !id || !from || !/^[0-9]{5,20}$/.test(from)) continue;
        const { content, mediaId } = describe(message);
        messages.push({
          providerId: id,
          jid: `${from}@s.whatsapp.net`,
          counterpart: from,
          counterpartIsPhone: true,
          pushName: names.get(from) ?? null,
          timestamp: seconds(message.timestamp),
          content,
          fromMe: false,
          mediaId,
        });
      }

      const statuses: MetaStatus[] = [];
      for (const raw of arr(value.statuses)) {
        const status = obj(raw);
        const id = str(status?.id);
        const state = str(status?.status);
        if (!status || !id || !state || !STATUSES.has(state)) continue;
        const code = num(obj(arr(status.errors)[0])?.code);
        statuses.push({
          providerId: id,
          status: state as MetaStatus["status"],
          errorCode: state === "failed" ? (code === null ? "meta_failed" : `meta_${code}`) : null,
          timestamp: seconds(status.timestamp),
        });
      }

      if (messages.length > 0 || statuses.length > 0) changes.push({ phoneNumberId, messages, statuses });
    }
  }
  return changes;
}

/** Outbound content as Meta expects it. Media goes by link: Meta fetches it. */
export function toMetaOutgoing(content: OutboundContent): MetaOutgoing {
  switch (content.type) {
    case "text":
      return { type: "text", text: { body: content.text, preview_url: false } };
    case "image":
    case "video": {
      const part = { link: content.url, ...(content.caption ? { caption: content.caption } : {}) };
      return content.type === "image" ? { type: "image", image: part } : { type: "video", video: part };
    }
    case "audio":
      return { type: "audio", audio: { link: content.url } };
    case "document":
      return {
        type: "document",
        document: {
          link: content.url,
          ...(content.fileName ? { filename: content.fileName } : {}),
          ...(content.caption ? { caption: content.caption } : {}),
        },
      };
  }
}
