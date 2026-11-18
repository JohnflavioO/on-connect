import type { DefaultJobOptions } from "bullmq";

/**
 * Single source of truth for queue names, shared by the API (producer) and
 * the worker (consumer). A queue is added here in the pull request that
 * introduces its processor.
 */
export const QUEUE_NAMES = {
  /** Internal plumbing check: proves API -> Redis -> worker end to end. */
  system: "system",
  /** Commands for the sessions process (start, logout, pairing code). */
  sessions: "sessions",
  /** Outbound messages, consumed by the sessions process (it owns the sockets). */
  outbound: "outbound",
  /** Signed Meta webhooks, accepted by the API, stored by the sessions process. */
  metaWebhooks: "meta-webhooks",
} as const;

/** One Meta webhook body, already checked against its signature by the API. */
export interface MetaWebhookJob {
  payload: unknown;
}

/** Payload of an outbound job: everything else is read from the database. */
export interface OutboundJob {
  messageId: string;
}

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Prefix for every BullMQ key, so the Redis instance can be inspected safely. */
export const QUEUE_PREFIX = "onconnect";

/**
 * Defaults applied to every job unless a queue overrides them: bounded
 * retries with exponential backoff, and bounded retention so Redis memory
 * does not grow without limit.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

export interface SystemPingJob {
  requestedAt: string;
}
