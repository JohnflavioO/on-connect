import { createHmac } from "node:crypto";
import { createApiKeyAuthenticator, loadApiEnv, redactUrl, type DatabasePool } from "@on-connect/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeSessions } from "./support/fake-sessions.js";

const APP_SECRET = "meta-app-secret-for-tests-only";
const VERIFY_TOKEN = "meta-verify-token-for-tests";

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  REDIS_URL: "redis://localhost:6379",
  PUBLIC_API_BASE_URL: "http://localhost:8080",
  DATABASE_URL: "postgresql://onconnect_app:unused@localhost:5432/postgres",
  API_KEY_PEPPER: "api-test-pepper-api-test-pepper-api-test",
  WEBHOOK_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  MEDIA_KEY: Buffer.alloc(32, 8).toString("base64"),
};

const unusedDb: DatabasePool = {
  connect: async () => {
    throw new Error("the Meta webhook route must not reach the database");
  },
};

let app: FastifyInstance | undefined;
let enqueue = vi.fn<(payload: unknown) => Promise<void>>(async () => undefined);

async function start(meta: Record<string, string> = { META_APP_SECRET: APP_SECRET, META_VERIFY_TOKEN: VERIFY_TOKEN }) {
  enqueue = vi.fn<(payload: unknown) => Promise<void>>(async () => undefined);
  app = await buildApp({
    env: loadApiEnv({ ...baseEnv, ...meta }),
    checkRedis: async () => true,
    authenticator: createApiKeyAuthenticator({ pepper: baseEnv.API_KEY_PEPPER, store: { findByPrefix: async () => null } }),
    db: unusedDb,
    sessions: new FakeSessions(),
    enqueueMetaWebhook: enqueue,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "111" } } }] }],
});

describe("Meta webhook receiver", () => {
  it("answers the subscription check only with the right verify token", async () => {
    const instance = await start();
    const ok = await instance.inject({
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("1158201444");
    const wrong = await instance.inject({ url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
    expect(wrong.statusCode).toBe(403);
    const reflected = await instance.inject({
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=%3Cscript%3E`,
    });
    expect(reflected.statusCode).toBe(400);
  });

  it("queues a correctly signed body as parsed JSON", async () => {
    const instance = await start();
    const response = await instance.inject({
      method: "POST", url: "/webhooks/meta", payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    });
    expect(response.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(JSON.parse(body));
  });

  it("refuses a missing, wrong or tampered signature without queueing", async () => {
    const instance = await start();
    const cases = [
      {},
      { "x-hub-signature-256": sign(body, "another-secret-entirely") },
      { "x-hub-signature-256": sign(`${body} `) },
      { "x-hub-signature-256": "sha1=abc" },
    ];
    for (const headers of cases) {
      const response = await instance.inject({
        method: "POST", url: "/webhooks/meta", payload: body,
        headers: { "content-type": "application/json", ...headers },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("asks Meta to retry when the queue is down", async () => {
    const instance = await start();
    enqueue.mockRejectedValueOnce(new Error("redis down"));
    const response = await instance.inject({
      method: "POST", url: "/webhooks/meta", payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    });
    expect(response.statusCode).toBe(500);
  });

  it("does not exist when Meta is not configured", async () => {
    const instance = await start({});
    expect((await instance.inject({ method: "POST", url: "/webhooks/meta", payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } })).statusCode).toBe(404);
  });

  it("never logs the verify token", () => {
    expect(redactUrl("/webhooks/meta?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=1"))
      .toBe("/webhooks/meta?[REDACTED]");
  });

  it("requires the app secret and the verify token together", () => {
    expect(() => loadApiEnv({ ...baseEnv, META_APP_SECRET: APP_SECRET })).toThrow(/META_VERIFY_TOKEN/);
  });
});

describe("Meta settings from docker compose", () => {
  it("treats empty values as not set", () => {
    const env = loadApiEnv({ ...baseEnv, META_APP_SECRET: "", META_VERIFY_TOKEN: "" });
    expect(env.META_APP_SECRET).toBeUndefined();
    expect(env.META_VERIFY_TOKEN).toBeUndefined();
  });
});
