import type { FastifyPluginAsync } from "fastify";

export interface HealthRouteOptions {
  checkRedis: () => Promise<boolean>;
}

/**
 * /health/live  - the process is up. Used by Docker to restart a hung container.
 * /health/ready - the process can do useful work. Used by Caddy and deploys to
 *                 decide whether traffic may be sent here.
 */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, options) => {
  app.get("/live", { logLevel: "warn" }, async () => ({ status: "ok" }));

  app.get("/ready", { logLevel: "warn" }, async (_request, reply) => {
    const redis = await options.checkRedis();
    const ready = redis;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "unavailable",
      checks: { redis: redis ? "ok" : "fail" },
    });
  });
};
