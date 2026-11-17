import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, QUEUE_PREFIX, type OutboundJob } from "./queues.js";
import type { RedisClient } from "./redis.js";

/**
 * Contract between the API (producer) and the sessions process (owner of the
 * WhatsApp Web sockets). Commands travel through a BullMQ queue; the short
 * lived outputs a socket produces (QR codes, pairing codes) are written to
 * Redis with a TTL and read back by the API. Durable state lives in Postgres.
 */

export type SessionCommand =
  | { type: "start"; connectionId: string }
  | { type: "logout"; connectionId: string }
  | { type: "pairing-code"; connectionId: string; phoneNumber: string };

const KEY_PREFIX = `${QUEUE_PREFIX}:wa`;

export const sessionKeys = {
  /** Current QR payload while the connection waits to be scanned. */
  qr: (connectionId: string) => `${KEY_PREFIX}:qr:${connectionId}`,
  /** Pairing code produced on request, read once by the API. */
  pairingCode: (connectionId: string) => `${KEY_PREFIX}:pairing:${connectionId}`,
  /** Hash with the encrypted WhatsApp Web auth state of one connection. */
  authState: (connectionId: string) => `${KEY_PREFIX}:auth:${connectionId}`,
} as const;

/** WhatsApp rotates the QR roughly every 20 seconds. */
export const QR_TTL_SECONDS = 60;
export const PAIRING_CODE_TTL_SECONDS = 120;

/** What the API needs from the sessions process. */
export interface SessionGateway {
  start(connectionId: string): Promise<void>;
  logout(connectionId: string): Promise<void>;
  currentQr(connectionId: string): Promise<string | null>;
  /** Asks the socket for a pairing code and waits for it. Null on timeout. */
  requestPairingCode(connectionId: string, phoneNumber: string): Promise<string | null>;
  /**
   * Hands a stored outbound message to the sessions process. The job id is
   * the message id, so a replay from the outbox never sends twice.
   */
  dispatchMessage(messageId: string): Promise<void>;
}

export interface SessionGatewayOptions {
  redis: RedisClient;
  pairingTimeoutMs?: number;
  pollIntervalMs?: number;
}

export function createSessionGateway(options: SessionGatewayOptions): SessionGateway & {
  close(): Promise<void>;
} {
  const { redis } = options;
  const pairingTimeoutMs = options.pairingTimeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const outbound = createOutboundQueue(redis);
  const queue = new Queue<SessionCommand>(QUEUE_NAMES.sessions, {
    connection: redis,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 3 },
  });

  const send = async (command: SessionCommand): Promise<void> => {
    await queue.add(command.type, command);
  };

  return {
    start: (connectionId) => send({ type: "start", connectionId }),
    logout: (connectionId) => send({ type: "logout", connectionId }),
    currentQr: (connectionId) => redis.get(sessionKeys.qr(connectionId)),

    async requestPairingCode(connectionId, phoneNumber) {
      const key = sessionKeys.pairingCode(connectionId);
      await redis.del(key);
      await send({ type: "pairing-code", connectionId, phoneNumber });
      const deadline = Date.now() + pairingTimeoutMs;
      while (Date.now() < deadline) {
        // GETDEL: a pairing code is handed out once.
        const code = await redis.getdel(key);
        if (code) return code;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      return null;
    },

    dispatchMessage: (messageId) => enqueueOutbound(outbound, messageId),

    close: async () => {
      await Promise.all([queue.close(), outbound.close()]);
    },
  };
}

/**
 * Outbound sends retry for about 10 minutes (a session may be reconnecting);
 * after the last attempt the sessions process marks the message failed.
 */
export const OUTBOUND_ATTEMPTS = 8;

export function createOutboundQueue(redis: RedisClient): Queue<OutboundJob> {
  return new Queue<OutboundJob>(QUEUE_NAMES.outbound, {
    connection: redis,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: OUTBOUND_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
    },
  });
}

export async function enqueueOutbound(queue: Queue<OutboundJob>, messageId: string): Promise<void> {
  await queue.add("send", { messageId }, { jobId: messageId });
}
