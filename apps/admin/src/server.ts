import {
  createLogger,
  createPostgresPool,
  createRedis,
  createSessionGateway,
  loadAdminEnv,
} from "@on-connect/core";
import { createAdminAuth } from "./admin-auth.js";
import { buildAdminApp } from "./app.js";
import { createAdminQueries } from "./queries.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Super-admin panel. Reached only through Caddy. */
async function main(): Promise<void> {
  const env = loadAdminEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: "admin" });
  const redis = createRedis({ url: env.REDIS_URL, connectionName: "admin", logger });
  const db = createPostgresPool({ connectionString: env.SYSTEM_DATABASE_URL, max: 4 }, (error) => {
    logger.warn({ err: error }, "idle database connection failed");
  });
  const sessions = createSessionGateway({ redis });

  const app = await buildAdminApp({
    queries: createAdminQueries(db, env.API_KEY_PEPPER),
    sessions,
    auth: createAdminAuth({ username: env.ADMIN_USER, passwordHash: env.ADMIN_PASSWORD_HASH, store: redis }),
    proxySecret: env.ADMIN_PROXY_SECRET,
    origin: env.ADMIN_ORIGIN,
    logLevel: env.LOG_LEVEL,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    forced.unref();
    app
      .close()
      .then(() => sessions.close())
      .then(() => Promise.all([redis.quit(), db.close()]))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  await app.listen({ host: env.ADMIN_HOST, port: env.ADMIN_PORT });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
