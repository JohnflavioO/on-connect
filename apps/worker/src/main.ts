import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  createLogger,
  createRedis,
  loadWorkerEnv,
  type SystemPingJob,
} from "@on-connect/core";
import { Queue, Worker } from "bullmq";
import { createSystemProcessor } from "./processors/system.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: "worker" });

  // BullMQ needs a dedicated blocking connection per worker, separate from
  // the one used to enqueue.
  const workerConnection = createRedis({
    url: env.REDIS_URL,
    connectionName: "worker:consume",
    logger,
  });
  const queueConnection = createRedis({
    url: env.REDIS_URL,
    connectionName: "worker:produce",
    logger,
  });

  const systemQueue = new Queue<SystemPingJob>(QUEUE_NAMES.system, {
    connection: queueConnection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  const systemWorker = new Worker<SystemPingJob>(
    QUEUE_NAMES.system,
    createSystemProcessor(logger),
    { connection: workerConnection, prefix: QUEUE_PREFIX, concurrency: env.WORKER_CONCURRENCY },
  );

  systemWorker.on("failed", (job, error) => {
    logger.error(
      { queue: QUEUE_NAMES.system, jobId: job?.id, attempt: job?.attemptsMade, err: error },
      "job failed",
    );
  });
  systemWorker.on("error", (error) => {
    logger.error({ queue: QUEUE_NAMES.system, err: error }, "worker error");
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

    // close() waits for in-flight jobs, so a deploy never cuts a job in half.
    systemWorker
      .close()
      .then(() => systemQueue.close())
      .then(() => Promise.all([workerConnection.quit(), queueConnection.quit()]))
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

  await systemWorker.waitUntilReady();
  logger.info({ queues: [QUEUE_NAMES.system], concurrency: env.WORKER_CONCURRENCY }, "worker ready");

  await systemQueue.add("ping", { requestedAt: new Date().toISOString() });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
