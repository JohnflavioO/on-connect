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
  type MetaWebhookJob,
  type OutboundJob,
  type SessionCommand,
} from "@on-connect/core";
import { Worker } from "bullmq";
import { createRedisAuthState } from "./auth-state.js";
import { guardConsole } from "./console-guard.js";
import { createBaileysSocketFactory, resolveWaVersion } from "./baileys-socket.js";
import { createMetaGraph } from "./meta-graph.js";
import { StatusesPendingError, createMetaProvider } from "./meta-provider.js";
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

  const store = createPostgresSessionStore(db);
  const manager = new SessionManager({
    store,
    redis,
    createAuth: (connectionId) => createRedisAuthState(redis, box, connectionId),
    createSocket: createBaileysSocketFactory(logger, version, { maxMediaBytes: env.MEDIA_MAX_BYTES, behavior: store }),
    logger,
    maxSessions: env.SESSIONS_MAX,
    media,
  });

  // Meta Cloud API connections: no socket, the Graph API with one token.
  const meta = createMetaProvider({
    graph: env.META_ACCESS_TOKEN
      ? createMetaGraph({ token: env.META_ACCESS_TOKEN, version: env.META_GRAPH_VERSION })
      : null,
    store,
    media,
    maxMediaBytes: env.MEDIA_MAX_BYTES,
    logger,
  });
  const isMeta = async (connectionId: string) => (await store.load(connectionId))?.provider === "meta_cloud";

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
          return (await isMeta(command.connectionId))
            ? meta.check(command.connectionId)
            : manager.start(command.connectionId);
        case "logout":
          return (await isMeta(command.connectionId))
            ? meta.stop(command.connectionId)
            : manager.logout(command.connectionId);
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
    meta: meta.sender,
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

  // Signed Meta webhooks queued by the API. The job holds the body (message
  // content), so failures are logged with ids only.
  const metaConnection = createRedis({ url: env.REDIS_URL, connectionName: "sessions:meta", logger });
  const metaWorker = new Worker<MetaWebhookJob>(
    QUEUE_NAMES.metaWebhooks,
    (job) => meta.handleWebhook(job.data.payload),
    { connection: metaConnection, prefix: QUEUE_PREFIX, concurrency: 5 },
  );
  metaWorker.on("failed", (job, error) => {
    const level = error instanceof StatusesPendingError ? "info" : "error";
    logger[level]({ jobId: job?.id, attempt: job?.attemptsMade, err: error.message }, "meta webhook not stored yet");
  });

  // Meta numbers are checked again every 6 hours (name, quality, tier, token).
  const checkMeta = async (): Promise<void> => {
    try {
      for (const id of await store.metaCheckIds()) await meta.check(id);
    } catch (error) {
      logger.error({ err: error }, "meta number check failed");
    }
  };
  const metaTimer = setInterval(() => void checkMeta(), 6 * 3_600_000);
  metaTimer.unref();

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
    clearInterval(metaTimer);
    Promise.all([worker.close(), outboundWorker.close(), outboundQueue.close(), metaWorker.close()])
      .then(() => {
        manager.stopAll();
      })
      .then(() => db.close())
      .then(() => Promise.all([redis.quit(), commandConnection.quit(), outboundConnection.quit(), metaConnection.quit()]))
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

  await Promise.all([worker.waitUntilReady(), outboundWorker.waitUntilReady(), metaWorker.waitUntilReady()]);
  const restored = await manager.restoreAll();
  void replay();
  void prune();
  void checkMeta();
  logger.info({ restored, max: env.SESSIONS_MAX, meta: meta.sender !== null }, "sessions ready");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
