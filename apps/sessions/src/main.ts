import {
  QUEUE_NAMES,
  QUEUE_PREFIX,
  createLogger,
  createPostgresPool,
  createRedis,
  OUTBOUND_ATTEMPTS,
  createOutboundQueue,
  createMediaVault,
  createSecretBox,
  enqueueOutbound,
  fetchPublicBytes,
  sessionKeys,
  loadSessionsEnv,
  type OutboundJob,
  type SessionCommand,
} from "@on-connect/core";
import { Worker } from "bullmq";
import { createRedisAuthState } from "./auth-state.js";
import { guardConsole } from "./console-guard.js";
import { createBaileysSocketFactory, resolveWaVersion } from "./baileys-socket.js";
import { SessionManager } from "./session-manager.js";
import { createOutboundProcessor } from "./outbound.js";
import { createPostgresOutboundStore, createPostgresSessionStore } from "./store.js";

const SHUTDOWN_TIMEOUT_MS = 20_000;

/**
 * Owns the WhatsApp Web sockets. Runs as a single replica: two processes
 * opening the same session would replace each other's connection.
 */
async function main(): Promise<void> {
  const env = loadSessionsEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: "sessions" });
  // Before the library loads any socket: it prints session keys to the console.
  guardConsole(logger);

  const redis = createRedis({ url: env.REDIS_URL, connectionName: "sessions:state", logger });
  const commandConnection = createRedis({
    url: env.REDIS_URL,
    connectionName: "sessions:commands",
    logger,
  });
  const db = createPostgresPool({ connectionString: env.SYSTEM_DATABASE_URL, max: 5 }, (error) => {
    logger.warn({ err: error }, "idle database connection failed");
  });
  const box = createSecretBox(env.SESSION_STATE_KEY);
  const version = await resolveWaVersion(logger);
  const media = createMediaVault({
    key: env.MEDIA_KEY,
    dir: env.MEDIA_DIR,
    publicBaseUrl: env.PUBLIC_API_BASE_URL,
  });

  const manager = new SessionManager({
    store: createPostgresSessionStore(db),
    redis,
    createAuth: (connectionId) => createRedisAuthState(redis, box, connectionId),
    createSocket: createBaileysSocketFactory(logger, version, { maxMediaBytes: env.MEDIA_MAX_BYTES }),
    logger,
    maxSessions: env.SESSIONS_MAX,
    media,
  });

  // Retention: whole months of media older than MEDIA_RETENTION_DAYS go.
  const prune = async (): Promise<void> => {
    try {
      const removed = await media.pruneOlderThan(env.MEDIA_RETENTION_DAYS);
      if (removed > 0) logger.info({ months: removed }, "old media deleted");
    } catch (error) {
      logger.error({ err: error }, "media retention failed");
    }
  };
  const pruneTimer = setInterval(() => void prune(), 6 * 3_600_000);
  pruneTimer.unref();

  const worker = new Worker<SessionCommand>(
    QUEUE_NAMES.sessions,
    async (job) => {
      const command = job.data;
      switch (command.type) {
        case "start":
          return manager.start(command.connectionId);
        case "logout":
          return manager.logout(command.connectionId);
        case "pairing-code":
          return manager.requestPairingCode(command.connectionId, command.phoneNumber);
        case "profile-picture": {
          // "" means "asked, none": the API tells it apart from a timeout.
          const url = await manager.profilePictureUrl(command.connectionId, command.phoneNumber);
          await redis.set(sessionKeys.profilePicture(command.requestId), url ?? "", "EX", 60);
          return undefined;
        }
      }
    },
    { connection: commandConnection, prefix: QUEUE_PREFIX, concurrency: 10 },
  );
  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, command: job?.data.type, err: error }, "session command failed");
  });

  // Outbound sends live here because this process owns the sockets.
  const outboundConnection = createRedis({
    url: env.REDIS_URL,
    connectionName: "sessions:outbound",
    logger,
  });
  const processOutbound = createOutboundProcessor({
    store: createPostgresOutboundStore(db),
    sender: manager,
    fetchMedia: (url) => fetchPublicBytes(url, { maxBytes: env.MEDIA_MAX_BYTES, timeoutMs: 30_000 }),
    logger,
  });
  const outboundWorker = new Worker<OutboundJob>(
    QUEUE_NAMES.outbound,
    (job) => processOutbound({
      messageId: job.data.messageId,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? OUTBOUND_ATTEMPTS,
    }),
    { connection: outboundConnection, prefix: QUEUE_PREFIX, concurrency: 10 },
  );
  outboundWorker.on("failed", (job, error) => {
    logger.warn({ messageId: job?.data.messageId, attempt: job?.attemptsMade, err: error.message },
      "outbound attempt failed");
  });

  // Transactional outbox replay: a message whose queue job was lost (Redis
  // restart, API crash after commit) is enqueued again. The job id is the
  // message id, so a job that still exists is not duplicated.
  const outboundQueue = createOutboundQueue(redis);
  const replay = async (): Promise<void> => {
    try {
      const stale = await createPostgresOutboundStore(db).stalePending(120);
      for (const messageId of stale) await enqueueOutbound(outboundQueue, messageId);
      if (stale.length > 0) logger.info({ count: stale.length }, "replayed outbound messages");
    } catch (error) {
      logger.error({ err: error }, "outbox replay failed");
    }
  };
  const replayTimer = setInterval(() => void replay(), 60_000);
  replayTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const forced = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    // Sockets are closed, not logged out, so the next boot resumes them.
    clearInterval(replayTimer);
    clearInterval(pruneTimer);
    Promise.all([worker.close(), outboundWorker.close(), outboundQueue.close()])
      .then(() => {
        manager.stopAll();
      })
      .then(() => db.close())
      .then(() => Promise.all([redis.quit(), commandConnection.quit(), outboundConnection.quit()]))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  await Promise.all([worker.waitUntilReady(), outboundWorker.waitUntilReady()]);
  const restored = await manager.restoreAll();
  void replay();
  void prune();
  logger.info({ restored, max: env.SESSIONS_MAX }, "sessions ready");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
