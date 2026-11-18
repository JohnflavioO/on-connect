import type { OutboundContent } from "@on-connect/core";
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

/**
 * The Meta Cloud API side of the sessions process. There is no socket: a
 * connection is "connected" when Meta confirms its phone number id with our
 * token, messages go out through the Graph API (see outbound.ts) and come in
 * through webhooks (handleWebhook), already checked by the API.
 */
export function createMetaProvider(deps: {
  graph: MetaGraph | null;
  store: MetaProviderStore;
  media: { save(bytes: Buffer, meta: { mimetype: string | null }): Promise<string> } | null;
  maxMediaBytes: number;
  logger: Logger;
  now?: () => Date;
}) {
  const { graph, store, media, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const sender: MetaSender | null = graph
    ? { send: (phoneNumberId: string, to: string, content: OutboundContent) =>
        graph.sendMessage(phoneNumberId, to, toMetaOutgoing(content)) }
    : null;

  /** Downloads a received file into the vault; on any failure the message keeps no link. */
  const withMedia = async (connectionId: string, message: MetaInbound): Promise<MetaInbound> => {
    if (!message.mediaId || !graph || !media) return message;
    try {
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

  return {
    sender,

    /**
     * Confirms the number with Meta and stores what Meta reports (name,
     * quality, messaging tier). Used on start/restart and periodically. A
     * transient failure leaves a connected number connected.
     */
    async check(connectionId: string): Promise<void> {
      const row = await store.load(connectionId);
      if (!row || row.deleted || row.provider !== "meta_cloud") return;
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
    },

    /** "Desconectar" on a Meta number: On Connect stops using it; nothing changes at Meta. */
    async stop(connectionId: string): Promise<void> {
      const row = await store.load(connectionId);
      if (!row || row.provider !== "meta_cloud") return;
      await store.setStatus(connectionId, "disconnected", "logged_out");
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
