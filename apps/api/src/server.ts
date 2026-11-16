import { createLogger, createRedis, loadApiEnv, pingRedis } from "@on-connect/core";
import { buildApp } from "./app.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const env = loadApiEnv();
  const bootLogger = createLogger({ level: env.LOG_LEVEL, service: "api" });
  const redis = createRedis({ url: env.REDIS_URL, connectionName: "api", logger: bootLogger });

  const app = await buildApp({ env, checkRedis: () => pingRedis(redis) });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    const forced = setTimeout(() => {
      app.log.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    // Stop accepting connections and let in-flight requests finish first,
    // then release Redis.
    app
      .close()
      .then(() => redis.quit())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((error: unknown) => {
  // Boot failures (bad env, port in use) must be loud and exit non-zero so
  // the container restarts instead of idling half-started.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
