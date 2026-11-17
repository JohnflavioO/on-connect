import {
  QUEUE_NAMES,
  QUEUE_PREFIX,
  createLogger,
  createPostgresPool,
  createRedis,
  createSecretBox,
  loadSessionsEnv,
  type SessionCommand,
} from "@on-connect/core";
import { Worker } from "bullmq";
import { createRedisAuthState } from "./auth-state.js";
import { createBaileysSocketFactory, resolveWaVersion } from "./baileys-socket.js";
import { SessionManager } from "./session-manager.js";
import { createPostgresSessionStore } from "./store.js";

const SHUTDOWN_TIMEOUT_MS = 20_000;

/**
 * Owns the WhatsApp Web sockets. Runs as a single replica: two processes
 * opening the same session would replace each other's connection.
 */
async function main(): Promise<void> {
  const env = loadSessionsEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: "sessions" });

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

  const manager = new SessionManager({
    store: createPostgresSessionStore(db),
    redis,
    createAuth: (connectionId) => createRedisAuthState(redis, box, connectionId),
    createSocket: createBaileysSocketFactory(logger, version),
    logger,
    maxSessions: env.SESSIONS_MAX,
  });

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
      }
    },
    { connection: commandConnection, prefix: QUEUE_PREFIX, concurrency: 10 },
  );
  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, command: job?.data.type, err: error }, "session command failed");
  });

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
    worker
      .close()
      .then(() => {
        manager.stopAll();
      })
      .then(() => db.close())
      .then(() => Promise.all([redis.quit(), commandConnection.quit()]))
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

  await worker.waitUntilReady();
  const restored = await manager.restoreAll();
  logger.info({ restored, max: env.SESSIONS_MAX }, "sessions ready");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
