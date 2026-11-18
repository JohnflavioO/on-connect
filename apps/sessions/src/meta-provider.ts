import { randomInt } from "node:crypto";
import type { OutboundContent, SealedParts } from "@on-connect/core";
import type { Logger } from "pino";
import { MetaApiError, type MetaGraph } from "./meta-graph.js";
import { parseMetaWebhook, toMetaOutgoing, type MetaInbound } from "./meta-mapping.js";
import type { MetaSender } from "./outbound.js";
import type { MetaConnectionStore, SessionStore } from "./store.js";

/** Store side the Meta provider needs (onconnect_system). */
export type MetaProviderStore = Pick<SessionStore, "load" | "setStatus" | "recordInbound" | "recordStatus">
  & MetaConnectionStore;

/**
 * A status can arrive before the send that produced it has stored Meta's id
 * (the webhook races the Graph API response). Recent unknown statuses make
 * the job retry; older ones are for messages On Connect never sent.
 */
const STATUS_RACE_MS = 5 * 60_000;

export class StatusesPendingError extends Error {
  constructor(readonly count: number) {
    super(`${count} Meta statuses refer to messages not stored yet`);
    this.name = "StatusesPendingError";
  }
}

/** No token for this connection: neither its own (Embedded Signup) nor the server's. */
export class MetaNotConfiguredError extends MetaApiError {
  constructor() {
    super(0, null, false, "Meta Cloud API is not configured for this connection");
    this.name = "MetaNotConfiguredError";
  }

  override get errorCode(): string {
    return "meta_not_configured";
  }
}

/** What the customer's credential holds, encrypted in provider_credentials. */
interface StoredCredential {
  token: string;
  /** The two-step PIN set when the number was registered (needed to register it again). */
  pin: string;
}

const credentialContext = (connectionId: string) => `meta_credential:${connectionId}`;

/**
 * The Meta Cloud API side of the sessions process. There is no socket: a
 * connection is "connected" when Meta confirms its phone number id, messages
 * go out through the Graph API (see outbound.ts) and come in through
 * webhooks (handleWebhook), already checked by the API.
 *
 * Tokens: a number onboarded by Embedded Signup uses its customer's own
 * token (stored encrypted); numbers of On Connect's own WhatsApp account use
 * the server's token (META_ACCESS_TOKEN).
 */
export function createMetaProvider(deps: {
  /** Graph client with the server's token; null when META_ACCESS_TOKEN is not set. */
  graph: MetaGraph | null;
  /** A Graph client for a given token (customers' tokens). */
  graphForToken?: (token: string) => MetaGraph;
  /** Encrypts customers' credentials; null disables Embedded Signup. */
  box?: { sealParts(plaintext: string, context: string): SealedParts; openParts(parts: SealedParts, context: string): string } | null;
  /** Swaps an Embedded Signup code for the customer's token; null when the app id/secret are not set. */
  exchangeCode?: ((code: string) => Promise<string>) | null;
  store: MetaProviderStore;
  media: { save(bytes: Buffer, meta: { mimetype: string | null }): Promise<string> } | null;
  maxMediaBytes: number;
  logger: Logger;
  now?: () => Date;
  newPin?: () => string;
}) {
  const { store, media, logger } = deps;
  const box = deps.box ?? null;
  const now = deps.now ?? (() => new Date());
  const newPin = deps.newPin ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
  const ownGraphs = new Map<string, MetaGraph>();

  /** The client for a connection: its customer's token when it has one, else the server's. */
  const graphFor = async (connectionId: string): Promise<MetaGraph | null> => {
    const cached = ownGraphs.get(connectionId);
    if (cached) return cached;
    if (box && deps.graphForToken) {
      const sealed = await store.loadMetaCredential(connectionId);
      if (sealed) {
        const credential = JSON.parse(box.openParts(sealed, credentialContext(connectionId))) as StoredCredential;
        const graph = deps.graphForToken(credential.token);
        ownGraphs.set(connectionId, graph);
        return graph;
      }
    }
    return deps.graph;
  };

  const sender: MetaSender | null = deps.graph || (box && deps.graphForToken)
    ? {
        async send(connectionId: string, phoneNumberId: string, to: string, content: OutboundContent) {
          const graph = await graphFor(connectionId);
          if (!graph) throw new MetaNotConfiguredError();
          return graph.sendMessage(phoneNumberId, to, toMetaOutgoing(content));
        },
      }
    : null;

  /** Downloads a received file into the vault; on any failure the message keeps no link. */
  const withMedia = async (connectionId: string, message: MetaInbound): Promise<MetaInbound> => {
    if (!message.mediaId || !media) return message;
    try {
      const graph = await graphFor(connectionId);
      if (!graph) return message;
      const info = await graph.mediaInfo(message.mediaId);
      if (info.fileSize !== null && info.fileSize > deps.maxMediaBytes) return message;
      const bytes = await graph.downloadMedia(info.url, deps.maxMediaBytes);
      if (!bytes || bytes.length === 0) return message;
      const mimetype = info.mimetype ?? (typeof message.content.mimetype === "string" ? message.content.mimetype : null);
      return { ...message, mediaUrl: await media.save(bytes, { mimetype }) };
    } catch (error) {
      logger.warn({ connectionId, providerId: message.providerId, code: error instanceof MetaApiError ? error.errorCode : undefined },
        "meta media not stored");
      return message;
    }
  };

  /**
   * Confirms the number with Meta and stores what Meta reports (name,
   * quality, messaging tier). Used on start/restart and periodically. A
   * transient failure leaves a connected number connected.
   */
  const check = async (connectionId: string): Promise<void> => {
    const row = await store.load(connectionId);
    if (!row || row.deleted || row.provider !== "meta_cloud") return;
    const graph = await graphFor(connectionId);
    if (!graph) {
      await store.setStatus(connectionId, "error", "meta_not_configured");
      return;
    }
    if (!row.phoneNumberId) {
      await store.setStatus(connectionId, "error", "meta_phone_number_missing");
      return;
    }
    try {
      await store.markMetaConnected(connectionId, await graph.phoneNumber(row.phoneNumberId));
    } catch (error) {
      const code = error instanceof MetaApiError ? error.errorCode : "meta_unreachable";
      const transient = !(error instanceof MetaApiError) || error.retryable;
      logger.warn({ connectionId, code }, "meta number check failed");
      if (transient && row.status === "connected") return;
      await store.setStatus(connectionId, "error", transient ? "meta_unreachable" : code);
    }
  };

  return {
    sender,
    check,

    /** "Desconectar" on a Meta number: On Connect stops using it; nothing changes at Meta. */
    async stop(connectionId: string): Promise<void> {
      const row = await store.load(connectionId);
      if (!row || row.provider !== "meta_cloud") return;
      await store.setStatus(connectionId, "disconnected", "logged_out");
    },

    /**
     * Finishes Embedded Signup for a connection the API just created: swaps
     * the code for the customer's token and stores it encrypted (with the
     * PIN), links the customer's account to the app (its webhooks then come
     * here), registers the number, and checks it. The error code of any
     * failure is recorded as the connection's status reason.
     */
    async signup(connectionId: string, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
      if (!box || !deps.exchangeCode || !deps.graphForToken) return { ok: false, error: "meta_signup_not_configured" };
      const row = await store.load(connectionId);
      if (!row || row.deleted || row.provider !== "meta_cloud" || !row.phoneNumberId || !row.wabaId) {
        return { ok: false, error: "connection_not_found" };
      }
      try {
        const token = await deps.exchangeCode(code);
        const pin = newPin();
        const credential: StoredCredential = { token, pin };
        await store.saveMetaCredential(connectionId,
          box.sealParts(JSON.stringify(credential), credentialContext(connectionId)), "business_integration");
        const graph = deps.graphForToken(token);
        ownGraphs.set(connectionId, graph);
        await graph.subscribeApp(row.wabaId);
        await graph.registerPhone(row.phoneNumberId, pin);
      } catch (error) {
        const reason = error instanceof MetaApiError ? error.errorCode : "meta_signup_failed";
        logger.warn({ connectionId, code: reason }, "meta embedded signup failed");
        await store.setStatus(connectionId, "error", reason);
        return { ok: false, error: reason };
      }
      await check(connectionId);
      return { ok: true };
    },

    /**
     * Stores the messages and statuses of one signed webhook body. Safe to
     * repeat: messages are deduplicated by Meta's id and statuses only move
     * forward. Throws (so the queue retries) when the database fails or a
     * recent status is for a message whose send has not stored its id yet.
     */
    async handleWebhook(payload: unknown): Promise<void> {
      let pending = 0;
      for (const change of parseMetaWebhook(payload)) {
        const connectionId = await store.metaConnectionId(change.phoneNumberId);
        if (!connectionId) {
          logger.warn({ phoneNumberId: change.phoneNumberId }, "meta webhook for a number with no connection");
          continue;
        }
        for (const message of change.messages) {
          await store.recordInbound(connectionId, await withMedia(connectionId, message));
        }
        for (const status of change.statuses) {
          await store.recordStatus(connectionId, status);
          if (now().getTime() - status.timestamp.getTime() < STATUS_RACE_MS
            && !(await store.knowsOutbound(connectionId, status.providerId))) pending += 1;
        }
      }
      if (pending > 0) throw new StatusesPendingError(pending);
    },
  };
}

export type MetaProvider = ReturnType<typeof createMetaProvider>;
