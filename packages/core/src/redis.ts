import { Redis } from "ioredis";
import type { Logger } from "pino";

export type RedisClient = Redis;

export interface RedisConfig {
  url: string;
  /** Shown in `CLIENT LIST` on the server, to tell processes apart. */
  connectionName: string;
  logger: Logger;
}

/**
 * Creates the Redis connection used by BullMQ and by the API.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ workers: blocking
 * commands must wait for a reconnect instead of failing after N retries.
 */
export function createRedis(config: RedisConfig): RedisClient {
  const client = new Redis(config.url, {
    connectionName: config.connectionName,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  // The URL may carry a password, so only the message is logged.
  client.on("error", (error: Error) => {
    config.logger.error({ err: { message: error.message } }, "redis connection error");
  });
  client.on("reconnecting", () => {
    config.logger.warn("redis reconnecting");
  });

  return client;
}

/** Resolves true when Redis answers PING within the timeout. Never throws. */
export async function pingRedis(client: RedisClient, timeoutMs = 1_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([client.ping().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
