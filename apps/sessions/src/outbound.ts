import type { FetchedBytes, OutboundContent } from "@on-connect/core";
import type { Logger } from "pino";
import { MetaApiError } from "./meta-graph.js";
import { SessionNotReadyError } from "./session-manager.js";
import type { OutboundMessage, OutboundStore } from "./store.js";

/** Sends through the Meta Cloud API; resolves with Meta's message id (wamid). */
export interface MetaSender {
  /** With the connection: a number onboarded by Embedded Signup sends with its own token. */
  send(connectionId: string, phoneNumberId: string, to: string, content: OutboundContent): Promise<string>;
}

/** A media file ready to hand to WhatsApp. */
export interface OutgoingMedia {
  type: "image" | "video" | "audio" | "document";
  bytes: Buffer;
  mimetype: string | null;
  caption: string | null;
  fileName: string | null;
  voice: boolean;
}

/** What the processor needs from the session manager. */
export interface Sender {
  newMessageId(connectionId: string): string | null;
  sendText(connectionId: string, phoneNumber: string, text: string, messageId: string): Promise<string>;
  sendMedia(connectionId: string, phoneNumber: string, media: OutgoingMedia, messageId: string): Promise<string>;
}

/** Downloads the file of a media message (public HTTPS only, size-capped). */
export type MediaFetcher = (url: string) => Promise<FetchedBytes>;

export interface OutboundAttempt {
  messageId: string;
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
}

class MediaUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`media_unavailable: ${code}`);
    this.name = "MediaUnavailableError";
  }
}

/**
 * Sends one queued message. Idempotent: a message already sent, failed or
 * delivered is left alone, and the WhatsApp id is stored before the send so a
 * retry after a crash reuses it instead of producing a second message id.
 * Throws to ask the queue for a retry; marks the message failed on the last.
 */
export function createOutboundProcessor(deps: {
  store: OutboundStore;
  sender: Sender;
  fetchMedia: MediaFetcher;
  logger: Logger;
  /** Meta Cloud API sends; null when META_ACCESS_TOKEN is not set. */
  meta?: MetaSender | null;
}) {
  const { store, sender, fetchMedia, logger } = deps;
  const meta = deps.meta ?? null;

  const send = async (connectionId: string, to: string, content: OutboundContent, providerId: string) => {
    if (content.type === "text") {
      await sender.sendText(connectionId, to, content.text, providerId);
      return;
    }
    const fetched = await fetchMedia(content.url);
    if (!fetched.ok) throw new MediaUnavailableError(fetched.error);
    await sender.sendMedia(connectionId, to, {
      type: content.type,
      bytes: fetched.bytes,
      mimetype: (content.type === "document" ? content.mimetype : null) ?? fetched.contentType,
      caption: content.type === "audio" ? null : content.caption ?? null,
      fileName: content.type === "document" ? content.fileName ?? null : null,
      voice: content.type === "audio" && content.voice === true,
    }, providerId);
  };

  /**
   * Meta assigns the message id when it accepts the send, so nothing is
   * stored before it. Errors Meta marks as permanent (closed 24 h window,
   * bad number, permissions) fail the message at once with Meta's code.
   * If the database fails right after Meta accepted, the retry sends again:
   * the Graph API has no idempotency key.
   */
  const sendViaMeta = async (message: OutboundMessage, attempt: number, maxAttempts: number) => {
    const last = attempt >= maxAttempts;
    if (!meta || !message.phoneNumberId) {
      await store.markFailed(message.id, "meta_not_configured", "Meta Cloud API is not configured for this connection");
      return "failed" as const;
    }
    await store.markSending(message.id, null);
    let wamid: string;
    try {
      wamid = await meta.send(message.connectionId, message.phoneNumberId, message.to, message.content);
    } catch (error) {
      const code = error instanceof MetaApiError ? error.errorCode : "send_failed";
      const retryable = !(error instanceof MetaApiError) || error.retryable;
      logger.warn({ messageId: message.id, attempt, code }, "meta send failed");
      if (last || !retryable) {
        await store.markFailed(message.id, code, error instanceof Error ? error.message : String(error));
        return "failed" as const;
      }
      throw error;
    }
    await store.markSent(message.id, wamid);
    return "sent" as const;
  };

  return async function processOutbound({ messageId, attempt, maxAttempts }: OutboundAttempt) {
    const message = await store.load(messageId);
    if (!message || !["queued", "sending"].includes(message.status)) return "skipped" as const;
    if (message.provider === "meta_cloud") return sendViaMeta(message, attempt, maxAttempts);

    const last = attempt >= maxAttempts;
    const providerId = message.providerMessageId ?? sender.newMessageId(message.connectionId);
    if (!providerId) {
      if (last) {
        await store.markFailed(messageId, "connection_not_ready", "Session was not open");
        return "failed" as const;
      }
      throw new SessionNotReadyError(message.connectionId);
    }

    await store.markSending(messageId, providerId);
    try {
      await send(message.connectionId, message.to, message.content, providerId);
    } catch (error) {
      const code = error instanceof SessionNotReadyError ? "connection_not_ready"
        : error instanceof MediaUnavailableError ? "media_unavailable"
        : "send_failed";
      logger.warn({ messageId, attempt, code }, "outbound send failed");
      if (last) {
        await store.markFailed(messageId, code, error instanceof Error ? error.message : String(error));
        return "failed" as const;
      }
      throw error;
    }
    await store.markSent(messageId);
    return "sent" as const;
  };
}
