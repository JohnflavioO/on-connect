import { describe, expect, it } from "vitest";
import { EnvValidationError, loadApiEnv, loadWorkerEnv } from "../src/env.js";

const valid = {
  REDIS_URL: "redis://localhost:6379",
  PUBLIC_API_BASE_URL: "http://localhost:8080",
};

describe("loadApiEnv", () => {
  it("applies defaults and coerces numbers", () => {
    const env = loadApiEnv({ ...valid, API_PORT: "9000" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.API_PORT).toBe(9000);
    expect(env.API_HOST).toBe("0.0.0.0");
    expect(env.RATE_LIMIT_MAX_PER_MINUTE).toBe(300);
  });

  it("names every missing variable", () => {
    expect(() => loadApiEnv({})).toThrow(EnvValidationError);
    try {
      loadApiEnv({});
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("REDIS_URL");
      expect(message).toContain("PUBLIC_API_BASE_URL");
    }
  });

  it("never echoes a rejected value", () => {
    const secretLooking = "not-a-url-s3cr3t-value";
    try {
      loadApiEnv({ ...valid, REDIS_URL: secretLooking });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(secretLooking);
    }
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadApiEnv({ ...valid, API_PORT: "70000" })).toThrow(/API_PORT/);
  });
});

describe("loadWorkerEnv", () => {
  it("does not require API-only variables", () => {
    const env = loadWorkerEnv({ REDIS_URL: "rediss://cache.internal:6380" });
    expect(env.WORKER_CONCURRENCY).toBe(10);
  });
});
