import { PAIRING_CODE_TTL_SECONDS, QR_TTL_SECONDS, sessionKeys } from "@on-connect/core";
import type { Logger } from "pino";
import type { StoredAuthState } from "./auth-state.js";
import type { InboundMessage, StatusUpdate } from "./message-mapping.js";
import type { ConnectedAccount, SessionStore } from "./store.js";

/** Why a socket closed, normalized from the library's disconnect codes. */
export type CloseReason =
  | "logged_out"
  | "restart_required"
  | "replaced"
  | "timed_out"
  | "other";

export interface SocketHandlers {
  onQr(qr: string): void;
  onOpen(account: ConnectedAccount): void;
  onClose(reason: CloseReason, detail: string): void;
  onCredsUpdate(): void;
  onMessages(messages: InboundMessage[]): void;
  onStatus(updates: StatusUpdate[]): void;
}

/** The part of a WhatsApp Web socket the manager drives. */
export interface WaSocket {
  logout(): Promise<void>;
  end(): void;
  requestPairingCode(phoneNumber: string): Promise<string>;
  /** A fresh WhatsApp message id, stored before sending so retries reuse it. */
  newMessageId(): string;
  /** Sends text to a phone number; resolves with the WhatsApp message id. */
  sendText(phoneNumber: string, text: string, messageId: string): Promise<string>;
}

/** Thrown when a send targets a connection with no open socket here. */
export class SessionNotReadyError extends Error {
  constructor(readonly connectionId: string) {
    super("connection_not_ready");
    this.name = "SessionNotReadyError";
  }
}

export type SocketFactory = (
  connectionId: string,
  auth: StoredAuthState,
  handlers: SocketHandlers,
) => WaSocket;

export interface ManagerRedis {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

export interface SessionManagerOptions {
  store: SessionStore;
  redis: ManagerRedis;
  createAuth: (connectionId: string) => Promise<StoredAuthState>;
  createSocket: SocketFactory;
  logger: Logger;
  maxSessions: number;
  /** Injected so tests do not wait for real backoff. */
  schedule?: (fn: () => void, ms: number) => void;
  qrWaitMs?: number;
}

interface Running {
  auth: StoredAuthState;
  socket: WaSocket | null;
  attempts: number;
  stopping: boolean;
  qrSeen: boolean;
  qrWaiters: Array<() => void>;
  /** True between "open" and the next close: sends are only attempted then. */
  open: boolean;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Owns every WhatsApp Web socket of this process: opens them, persists their
 * keys, publishes QR and pairing codes, records status, and reconnects with
 * exponential backoff. Commands for one connection run one at a time.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Running>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly qrWaitMs: number;

  constructor(private readonly options: SessionManagerOptions) {
    this.schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref());
    this.qrWaitMs = options.qrWaitMs ?? 20_000;
  }

  get size(): number {
    return this.sessions.size;
  }

  isRunning(connectionId: string): boolean {
    return this.sessions.has(connectionId);
  }

  start(connectionId: string): Promise<void> {
    return this.serialized(connectionId, () => this.startUnlocked(connectionId));
  }

  logout(connectionId: string): Promise<void> {
    return this.serialized(connectionId, () => this.logoutUnlocked(connectionId, "logged_out"));
  }

  requestPairingCode(connectionId: string, phoneNumber: string): Promise<void> {
    return this.serialized(connectionId, async () => {
      await this.startUnlocked(connectionId);
      const session = this.sessions.get(connectionId);
      if (!session || session.auth.state.creds.registered) return;
      // The library accepts a pairing request only once the socket is up and
      // offering a QR; until then the request is rejected.
      await this.waitForQr(session);
      if (!session.socket) return;
      const code = await session.socket.requestPairingCode(phoneNumber);
      await this.options.redis.set(
        sessionKeys.pairingCode(connectionId),
        code,
        "EX",
        PAIRING_CODE_TTL_SECONDS,
      );
    });
  }

  /** Reopens every connection that was live when the process stopped. */
  async restoreAll(): Promise<number> {
    const ids = await this.options.store.liveIds();
    for (const id of ids) {
      try {
        await this.start(id);
      } catch (error) {
        this.options.logger.error({ connectionId: id, err: error }, "failed to restore session");
      }
    }
    return ids.length;
  }

  /** Closes sockets without logging out, so they resume on the next boot. */
  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stopping = true;
      session.socket?.end();
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------

  private async serialized<T>(connectionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(connectionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(connectionId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(connectionId) === next) this.locks.delete(connectionId);
    }
  }

  private async startUnlocked(connectionId: string): Promise<void> {
    if (this.sessions.has(connectionId)) return;
    const { store, logger } = this.options;
    const row = await store.load(connectionId);
    if (!row || row.deleted || row.provider !== "whatsapp_web") {
      logger.warn({ connectionId }, "start ignored: connection not found or retired");
      return;
    }
    if (this.sessions.size >= this.options.maxSessions) {
      await store.setStatus(connectionId, "error", "capacity_exceeded");
      logger.error({ connectionId, max: this.options.maxSessions }, "session capacity exceeded");
      return;
    }
    const session: Running = {
      auth: await this.options.createAuth(connectionId),
      socket: null,
      attempts: 0,
      stopping: false,
      qrSeen: false,
      qrWaiters: [],
      open: false,
    };
    this.sessions.set(connectionId, session);
    await store.setStatus(connectionId, "connecting", "starting");
    this.open(connectionId, session);
  }

  private open(connectionId: string, session: Running): void {
    session.socket = this.options.createSocket(connectionId, session.auth, {
      onQr: (qr) => {
        void this.handleQr(connectionId, session, qr);
      },
      onOpen: (account) => {
        void this.serialized(connectionId, () => this.handleOpen(connectionId, session, account));
      },
      onClose: (reason, detail) => {
        void this.serialized(connectionId, () =>
          this.handleClose(connectionId, session, reason, detail));
      },
      onCredsUpdate: () => {
        session.auth.saveCreds().catch((error: unknown) => {
          this.options.logger.error({ connectionId, err: error }, "failed to save credentials");
        });
      },
      onMessages: (messages) => {
        void this.record(connectionId, messages.map((m) => () =>
          this.options.store.recordInbound(connectionId, m)));
      },
      onStatus: (updates) => {
        void this.record(connectionId, updates.map((u) => () =>
          this.options.store.recordStatus(connectionId, u)));
      },
    });
  }

  /** Persists events one by one; a failure is logged and does not stop the rest. */
  private async record(connectionId: string, tasks: Array<() => Promise<unknown>>): Promise<void> {
    for (const task of tasks) {
      try {
        await task();
      } catch (error) {
        // Never log message content: only ids and the error.
        this.options.logger.error({ connectionId, err: error }, "failed to record message event");
      }
    }
  }

  /**
   * Sends a text through the connection's socket. Throws SessionNotReadyError
   * when the socket is not open here, so the caller can retry later.
   */
  async sendText(
    connectionId: string,
    phoneNumber: string,
    text: string,
    messageId: string,
  ): Promise<string> {
    const session = this.sessions.get(connectionId);
    if (!session?.open || !session.socket) throw new SessionNotReadyError(connectionId);
    return session.socket.sendText(phoneNumber, text, messageId);
  }

  /** A WhatsApp message id from the connection's socket, or null if not open. */
  newMessageId(connectionId: string): string | null {
    const session = this.sessions.get(connectionId);
    return session?.open && session.socket ? session.socket.newMessageId() : null;
  }

  private async handleQr(connectionId: string, session: Running, qr: string): Promise<void> {
    if (session.stopping) return;
    await this.options.redis.set(sessionKeys.qr(connectionId), qr, "EX", QR_TTL_SECONDS);
    if (!session.qrSeen) {
      session.qrSeen = true;
      await this.options.store.setStatus(connectionId, "connecting", "waiting_for_scan");
    }
    for (const resolve of session.qrWaiters.splice(0)) resolve();
  }

  private async handleOpen(
    connectionId: string,
    session: Running,
    account: ConnectedAccount,
  ): Promise<void> {
    if (session.stopping) return;
    session.attempts = 0;
    session.open = true;
    await this.options.redis.del(sessionKeys.qr(connectionId));
    const outcome = await this.options.store.markConnected(connectionId, account);
    if (outcome === "number_in_use") {
      this.options.logger.warn({ connectionId }, "number already connected elsewhere");
      await this.logoutUnlocked(connectionId, "number_already_connected", "error");
      return;
    }
    this.options.logger.info({ connectionId }, "whatsapp session open");
  }

  private async handleClose(
    connectionId: string,
    session: Running,
    reason: CloseReason,
    detail: string,
  ): Promise<void> {
    if (session.stopping || this.sessions.get(connectionId) !== session) return;
    const { store, logger } = this.options;
    session.open = false;
    logger.info({ connectionId, reason, detail }, "whatsapp session closed");

    if (reason === "logged_out") {
      await this.discard(connectionId, session);
      await store.setStatus(connectionId, "disconnected", "logged_out");
      return;
    }
    if (reason === "replaced") {
      // Another client took over this session. Reconnecting would only
      // fight it in a loop, so stop and keep the keys for a manual restart.
      session.stopping = true;
      this.sessions.delete(connectionId);
      await store.setStatus(connectionId, "error", "connection_replaced");
      return;
    }
    if (reason === "timed_out" && !session.auth.state.creds.registered) {
      // Nobody scanned the QR in time; the integrator restarts it on demand.
      await this.discard(connectionId, session);
      await store.setStatus(connectionId, "disconnected", "qr_expired");
      return;
    }
    if (reason === "restart_required") {
      // Expected right after pairing: the server asks for a fresh socket.
      this.open(connectionId, session);
      return;
    }

    const row = await store.load(connectionId);
    if (!row || row.deleted) {
      session.stopping = true;
      this.sessions.delete(connectionId);
      return;
    }
    session.attempts += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (session.attempts - 1));
    await store.setStatus(connectionId, "connecting", "reconnecting");
    this.schedule(() => {
      if (!session.stopping && this.sessions.get(connectionId) === session) {
        this.open(connectionId, session);
      }
    }, delay);
  }

  private async logoutUnlocked(
    connectionId: string,
    reason: string,
    status: "disconnected" | "error" = "disconnected",
  ): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (session) {
      session.stopping = true;
      try {
        await session.socket?.logout();
      } catch (error) {
        this.options.logger.warn({ connectionId, err: error }, "logout request failed");
      }
      session.socket?.end();
      await this.discard(connectionId, session);
    } else {
      // Not running here: still remove stored keys so nothing can resume it.
      await (await this.options.createAuth(connectionId)).clear();
      await this.options.redis.del(sessionKeys.qr(connectionId));
    }
    await this.options.store.setStatus(connectionId, status, reason);
  }

  private async discard(connectionId: string, session: Running): Promise<void> {
    session.stopping = true;
    this.sessions.delete(connectionId);
    await session.auth.clear();
    await this.options.redis.del(sessionKeys.qr(connectionId));
    for (const resolve of session.qrWaiters.splice(0)) resolve();
  }

  private waitForQr(session: Running): Promise<void> {
    if (session.qrSeen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for the session to offer a QR"));
      }, this.qrWaitMs);
      timer.unref();
      session.qrWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
