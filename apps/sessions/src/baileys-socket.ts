import { MEDIA_CONTENT_TYPES } from "@on-connect/core";
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  getContentType,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent,
  type AnyMessageContent,
  type WAMessage,
  type WAVersion,
} from "baileys";
import type { Logger } from "pino";
import { toInbound, toStatus, type InboundMessage } from "./message-mapping.js";
import type { CloseReason, SocketFactory } from "./session-manager.js";
import { phoneFromJid, type SessionBehaviorStore } from "./store.js";

/** Read receipts per reply: at most this many batches of 100 messages. */
const READ_BATCHES = 5;

function closeReason(statusCode: number | undefined): CloseReason {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return "logged_out";
    case DisconnectReason.restartRequired:
      return "restart_required";
    case DisconnectReason.connectionReplaced:
      return "replaced";
    case DisconnectReason.timedOut:
      return "timed_out";
    default:
      return "other";
  }
}

/**
 * The WhatsApp Web version is looked up once per process; if the lookup
 * fails, the library's built-in version is used.
 */
export async function resolveWaVersion(logger: Logger): Promise<WAVersion | undefined> {
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ version: version.join("."), isLatest }, "whatsapp web version");
    return version;
  } catch (error) {
    logger.warn({ err: error }, "could not fetch whatsapp web version, using library default");
    return undefined;
  }
}

/** Adapts Baileys to the manager's small, testable socket interface. */
export function createBaileysSocketFactory(
  logger: Logger,
  version: WAVersion | undefined,
  options: { maxMediaBytes: number; behavior: SessionBehaviorStore },
): SocketFactory {
  return (connectionId, auth, handlers) => {
    // The library is chatty at info level and may log message content.
    const libLogger = logger.child({ connectionId, lib: "baileys" }, { level: "warn" });
    const socket = makeWASocket({
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, libLogger),
      },
      ...(version ? { version } : {}),
      browser: Browsers.ubuntu("On Connect"),
      logger: libLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    socket.ev.on("creds.update", () => {
      handlers.onCredsUpdate();
    });

    socket.ev.on("connection.update", (update) => {
      if (update.qr) handlers.onQr(update.qr);
      if (update.connection === "open" && socket.user) {
        handlers.onOpen({ jid: socket.user.id, name: socket.user.name ?? null });
      }
      if (update.connection === "close") {
        const error = update.lastDisconnect?.error as
          | { output?: { statusCode?: number }; message?: string }
          | undefined;
        const statusCode = error?.output?.statusCode;
        handlers.onClose(closeReason(statusCode), `${statusCode ?? "?"} ${error?.message ?? ""}`.trim());
      }
    });

    // Media is fetched from WhatsApp's servers on demand; a file declared
    // larger than the limit is never downloaded.
    const downloader = (raw: WAMessage) => async (): Promise<Buffer | null> => {
      const content = normalizeMessageContent(raw.message);
      const type = content ? getContentType(content) : undefined;
      // fileLength is a number or a protobuf Long; Number() handles both.
      const part = content && type ? content[type] as { fileLength?: unknown } | undefined : undefined;
      if (Number(part?.fileLength ?? 0) > options.maxMediaBytes) return null;
      const bytes = await downloadMediaMessage(raw, "buffer", {}, {
        logger: libLogger,
        reuploadRequest: socket.updateMediaMessage,
      });
      return bytes.length > options.maxMediaBytes ? null : bytes;
    };

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" is live traffic. "append" also carries what the linked
      // number sends from the phone, so own messages are taken from both;
      // received ones only from "notify" (an "append" of them is history).
      // Own messages this process sent are dropped by the store's dedupe.
      const inbound: InboundMessage[] = [];
      for (const raw of messages) {
        const mapped = toInbound(raw);
        if (!mapped || (type !== "notify" && !mapped.fromMe)) continue;
        if ((MEDIA_CONTENT_TYPES as readonly string[]).includes(mapped.content.type)) {
          mapped.downloadMedia = downloader(raw);
        }
        inbound.push(mapped);
      }
      if (inbound.length > 0) handlers.onMessages(inbound);
    });

    socket.ev.on("messages.update", (updates) => {
      const statuses = updates.map(toStatus).filter((s) => s !== null);
      if (statuses.length > 0) handlers.onStatus(statuses);
    });

    socket.ev.on("call", (calls) => {
      const offers = calls.filter((call) => call.status === "offer" && !call.offline);
      if (offers.length === 0) return;
      void options.behavior.loadSettings(connectionId).then(async (settings) => {
        if (!settings?.reject_calls) return;
        for (const offer of offers) {
          try {
            await socket.rejectCall(offer.id, offer.from);
          } catch {
            logger.warn({ connectionId }, "could not reject WhatsApp call");
          }
        }
      }).catch(() => {
        logger.warn({ connectionId }, "could not load call settings");
      });
    });

    const recipientJid = async (phoneNumber: string): Promise<string> => {
      // WhatsApp may register a different phone JID (e.g. Brazil's ninth
      // digit). Use its answer instead of guessing or rewriting the number.
      const contacts = await socket.onWhatsApp(phoneNumber);
      if (!contacts) throw new Error("recipient_lookup_unavailable");
      const recipient = contacts.find((contact) => contact.exists && contact.jid);
      if (!recipient) throw new Error("recipient_not_on_whatsapp");
      return recipient.jid;
    };

    // "Mark as read on reply": after a send, the contact's earlier inbound
    // messages get read receipts. It runs after the send has returned (the
    // API never waits on it), only once at a time per contact, over the last
    // days (see messagesToRead) and at most READ_BATCHES x 100 messages.
    const reading = new Set<string>();
    const markEarlierAsRead = async (jid: string, before: Date): Promise<void> => {
      const phone = phoneFromJid(jid);
      if (!phone || reading.has(jid)) return;
      reading.add(jid);
      try {
        if (!(await options.behavior.loadSettings(connectionId))?.read_on_reply) return;
        const lid = await socket.signalRepository.lidMapping.getLIDForPN(jid).catch(() => null);
        const jids = lid ? [jid, lid] : [jid];
        for (let batch = 0; batch < READ_BATCHES; batch += 1) {
          const keys = await options.behavior.messagesToRead(connectionId, jids, phone, before);
          if (keys.length === 0) break;
          await socket.readMessages(keys);
          await options.behavior.recordReadReceipts(connectionId, keys.map((key) => key.id));
        }
      } catch {
        logger.warn({ connectionId }, "could not mark previous WhatsApp messages as read");
      } finally {
        reading.delete(jid);
      }
    };

    const sendTo = async (jid: string, content: AnyMessageContent, messageId: string): Promise<string> => {
      const before = new Date();
      const sent = await socket.sendMessage(jid, content, { messageId });
      // Never awaited: a slow or failing receipt must not delay or fail a
      // message WhatsApp already accepted.
      if (sent) void markEarlierAsRead(jid, before);
      return sent?.key.id ?? messageId;
    };

    return {
      logout: () => socket.logout(),
      end: () => {
        void socket.end(undefined);
      },
      requestPairingCode: (phoneNumber) => socket.requestPairingCode(phoneNumber),
      newMessageId: () => generateMessageIDV2(socket.user?.id),
      async sendText(phoneNumber, text, messageId) {
        const jid = await recipientJid(phoneNumber);
        return sendTo(jid, { text }, messageId);
      },
      async sendMedia(phoneNumber, media, messageId) {
        const jid = await recipientJid(phoneNumber);
        const caption = media.caption ? { caption: media.caption } : {};
        const mimetype = media.mimetype ? { mimetype: media.mimetype } : {};
        let content: AnyMessageContent;
        if (media.type === "image") content = { image: media.bytes, ...caption, ...mimetype };
        else if (media.type === "video") content = { video: media.bytes, ...caption, ...mimetype };
        else if (media.type === "audio") {
          content = {
            audio: media.bytes,
            ptt: media.voice,
            // A voice note must be Opus in Ogg for WhatsApp to play it as one.
            mimetype: media.voice ? "audio/ogg; codecs=opus" : media.mimetype ?? "audio/mp4",
          };
        } else {
          content = {
            document: media.bytes,
            fileName: media.fileName ?? "arquivo",
            mimetype: media.mimetype ?? "application/octet-stream",
            ...caption,
          };
        }
        return sendTo(jid, content, messageId);
      },
      async profilePictureUrl(phoneNumber) {
        try {
          return (await socket.profilePictureUrl(`${phoneNumber}@s.whatsapp.net`, "image")) ?? null;
        } catch {
          // WhatsApp answers "not-authorized" / 404 when the picture is hidden or absent.
          return null;
        }
      },
    };
  };
}
