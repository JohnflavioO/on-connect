import { loadApiEnv } from "@on-connect/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  REDIS_URL: "redis://localhost:6379",
  PUBLIC_API_BASE_URL: "http://localhost:8080",
};

let app: FastifyInstance | undefined;

async function start(
  overrides: Record<string, string> = {},
  checkRedis: () => Promise<boolean> = async () => true,
): Promise<FastifyInstance> {
  app = await buildApp({ env: loadApiEnv({ ...baseEnv, ...overrides }), checkRedis });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("health", () => {
  it("reports liveness without touching dependencies", async () => {
    const instance = await start({}, async () => {
      throw new Error("must not be called");
    });
    const response = await instance.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("is ready when Redis answers", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", checks: { redis: "ok" } });
  });

  it("returns 503 when Redis is down", async () => {
    const instance = await start({}, async () => false);
    const response = await instance.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable", checks: { redis: "fail" } });
  });
});

describe("request handling", () => {
  it("returns a structured 404 with a request id", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: string; requestId: string }>();
    expect(body.error).toBe("not_found");
    expect(response.headers["x-request-id"]).toBe(body.requestId);
  });

  it("keeps a well-formed caller request id and replaces a malformed one", async () => {
    const instance = await start();
    const kept = await instance.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "tendi-req-12345" },
    });
    expect(kept.headers["x-request-id"]).toBe("tendi-req-12345");

    const replaced = await instance.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": 'bad id"\n{injected}' },
    });
    expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not leak internal error details", async () => {
    const instance = await start();
    instance.get("/boom", async () => {
      throw new Error("connection string postgres://user:pw@host");
    });
    const response = await instance.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("postgres://");
    expect(response.json<{ error: string }>().error).toBe("internal_error");
  });

  it("sets security headers", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/health/live" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("rate limits by client but never the health probes", async () => {
    const instance = await start({ RATE_LIMIT_MAX_PER_MINUTE: "2" });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await instance.inject({ method: "GET", url: "/nope" });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([404, 404, 429]);

    const limited = await instance.inject({ method: "GET", url: "/nope" });
    expect(limited.json<{ error: string }>().error).toBe("rate_limited");

    const probe = await instance.inject({ method: "GET", url: "/health/live" });
    expect(probe.statusCode).toBe(200);
  });
});
