import type { Logger } from "pino";
import { SessionNotReadyError } from "./session-manager.js";
import type { OutboundStore } from "./store.js";

/** What the processor needs from the session manager. */
export interface Sender {
  newMessageId(connectionId: string): string | null;
  sendText(connectionId: string, phoneNumber: string, text: string, messageId: string): Promise<string>;
}

export interface OutboundAttempt {
  messageId: string;
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
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
  logger: Logger;
}) {
  const { store, sender, logger } = deps;

  return async function processOutbound({ messageId, attempt, maxAttempts }: OutboundAttempt) {
    const message = await store.load(messageId);
    if (!message || !["queued", "sending"].includes(message.status)) return "skipped" as const;

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
      await sender.sendText(message.connectionId, message.to, message.text, providerId);
    } catch (error) {
      const code = error instanceof SessionNotReadyError ? "connection_not_ready" : "send_failed";
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
