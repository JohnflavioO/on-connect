import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type WAVersion,
} from "baileys";
import type { Logger } from "pino";
import { toInbound, toStatus } from "./message-mapping.js";
import type { CloseReason, SocketFactory } from "./session-manager.js";

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

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      // "append" is history and own-device echo; only live messages are forwarded.
      if (type !== "notify") return;
      const inbound = messages.map(toInbound).filter((m) => m !== null);
      if (inbound.length > 0) handlers.onMessages(inbound);
    });

    socket.ev.on("messages.update", (updates) => {
      const statuses = updates.map(toStatus).filter((s) => s !== null);
      if (statuses.length > 0) handlers.onStatus(statuses);
    });

    return {
      logout: () => socket.logout(),
      end: () => {
        void socket.end(undefined);
      },
      requestPairingCode: (phoneNumber) => socket.requestPairingCode(phoneNumber),
      newMessageId: () => generateMessageIDV2(socket.user?.id),
      async sendText(phoneNumber, text, messageId) {
        const sent = await socket.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text }, { messageId });
        return sent?.key.id ?? messageId;
      },
    };
  };
}
