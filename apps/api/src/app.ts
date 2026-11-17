import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import {
  loggerOptions,
  type ApiEnv,
  type ApiKeyAuthenticator,
  type DatabasePool,
  type SessionGateway,
} from "@on-connect/core";
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1.js";

/** External dependencies the API needs. Injected so tests can replace them. */
export interface AppDependencies {
  env: ApiEnv;
  /** Resolves true when Redis is reachable. */
  checkRedis: () => Promise<boolean>;
  /** Verifies integrator API keys. */
  authenticator: ApiKeyAuthenticator;
  /** onconnect_app pool; every query goes through withClientTransaction. */
  db: DatabasePool;
  /** Commands and QR codes of the WhatsApp Web sessions process. */
  sessions: SessionGateway;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { env } = deps;

  const app = Fastify({
    logger: loggerOptions({ level: env.LOG_LEVEL, service: "api" }),
    // Caddy reaches the API over the private Docker network, so forwarded
    // headers are trusted only from loopback and private addresses. A client
    // connecting from anywhere else cannot spoof its IP for rate limiting.
    trustProxy: ["loopback", "uniquelocal"],
    bodyLimit: 1_048_576,
    // Longer than any valid path parameter (external ids are capped at 200),
    // so an over-long id reaches schema validation and gets a 400, not a 404.
    routerOptions: { maxParamLength: 256 },
    ajv: {
      customOptions: {
        // Fastify's default silently drops unknown fields. Reject them, so a
        // caller sending e.g. a client id learns it is not accepted.
        removeAdditional: false,
      },
    },
    // Accept a caller-supplied request id only when it is well formed;
    // otherwise generate one, so log lines cannot be polluted by a header.
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && REQUEST_ID_PATTERN.test(supplied)
        ? supplied
        : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  await app.register(sensible);
  await app.register(helmet, {
    // JSON API: no documents are served, so nothing may be loaded or framed.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX_PER_MINUTE,
    timeWindow: "1 minute",
    // Probes come from Docker and Caddy on the internal network.
    allowList: (request) => request.url.startsWith("/health/"),
  });

  // Unknown routes count against the limit too, so path scanning is throttled.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) => {
    void reply.code(404).send({
      error: "not_found",
      message: "Route not found",
      requestId: request.id,
    });
  });

  app.setErrorHandler((error: { statusCode?: number; message?: string }, request, reply) => {
    const status =
      typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
      // Internal details stay in the logs; the caller gets the request id.
      void reply.code(status).send({
        error: "internal_error",
        message: "Internal server error",
        requestId: request.id,
      });
      return;
    }
    void reply.code(status).send({
      error: status === 429 ? "rate_limited" : "bad_request",
      message: error.message ?? "Request rejected",
      requestId: request.id,
    });
  });

  await app.register(healthRoutes, { prefix: "/health", checkRedis: deps.checkRedis });
  await app.register(v1Routes, {
    prefix: "/v1",
    authenticator: deps.authenticator,
    db: deps.db,
    sessions: deps.sessions,
  });

  return app;
}
