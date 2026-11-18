import { createHmac, timingSafeEqual } from "node:crypto";
import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, QUEUE_PREFIX, type MetaWebhookJob } from "./queues.js";
import type { RedisClient } from "./redis.js";

/**
 * Meta WhatsApp Cloud API: what the API and the sessions process share.
 *
 * Meta signs every webhook it sends with the app secret
 * (X-Hub-Signature-256: sha256=<hex HMAC of the raw body>). The API checks
 * it before accepting anything, then hands the body to the sessions process
 * through a queue; the sessions process (onconnect_system, media vault)
 * stores messages and statuses.
 */

/** True when `header` is Meta's signature of exactly these bytes. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Constant-time comparison of the subscription verify token. */
export function sameVerifyToken(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Queue of signed Meta webhook bodies (API -> sessions). Retries cover a
 * sessions restart; the body stays in Redis only until it is stored.
 */
export function createMetaWebhookQueue(redis: RedisClient): Queue<MetaWebhookJob> {
  return new Queue<MetaWebhookJob>(QUEUE_NAMES.metaWebhooks, {
    connection: redis,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 8, removeOnComplete: { age: 3600, count: 1_000 } },
  });
}
