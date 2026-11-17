import {
  createApiKeyAuthenticator,
  generateApiKey,
  loadApiEnv,
  type CredentialRecord,
  type DatabasePool,
} from "@on-connect/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeSessions } from "./support/fake-sessions.js";

const PEPPER = "api-test-pepper-api-test-pepper-api-test";
const CLIENT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT_B = "bbbbbbbb-0000-4000-8000-000000000001";

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  REDIS_URL: "redis://localhost:6379",
  PUBLIC_API_BASE_URL: "http://localhost:8080",
  DATABASE_URL: "postgresql://onconnect_app:unused@localhost:5432/postgres",
  API_KEY_PEPPER: PEPPER,
  WEBHOOK_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
};

// In-memory credential table: key A is valid, key B belongs to another
// client, the revoked key is revoked.
const keyA = generateApiKey(PEPPER);
const keyB = generateApiKey(PEPPER);
const revokedKey = generateApiKey(PEPPER);
const credentials = new Map<string, CredentialRecord>([
  [keyA.prefix, record("cred-a", CLIENT_A, keyA.secretHash)],
  [keyB.prefix, record("cred-b", CLIENT_B, keyB.secretHash)],
  [revokedKey.prefix, { ...record("cred-r", CLIENT_A, revokedKey.secretHash), revokedAt: new Date() }],
]);

function record(credentialId: string, clientId: string, secretHash: string): CredentialRecord {
  return {
    credentialId, clientId, secretHash, scopes: ["messages:send"],
    expiresAt: null, revokedAt: null, clientStatus: "active",
  };
}

const authenticator = createApiKeyAuthenticator({
  pepper: PEPPER,
  store: { findByPrefix: async (prefix) => credentials.get(prefix) ?? null },
});

// Database stand-in for unit tests: any route that reaches it fails loudly,
// and the counter proves that rejected requests never touch the database.
let dbConnects = 0;
const unusedDb: DatabasePool = {
  connect: async () => {
    dbConnects += 1;
    throw new Error("unit tests must not reach the database");
  },
};

let app: FastifyInstance | undefined;

async function start(
  overrides: Record<string, string> = {},
  checkRedis: () => Promise<boolean> = async () => true,
): Promise<FastifyInstance> {
  app = await buildApp({
    env: loadApiEnv({ ...baseEnv, ...overrides }),
    checkRedis,
    authenticator,
    db: unusedDb,
    sessions: new FakeSessions(),
  });
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

describe("API key authentication", () => {
  const me = (instance: FastifyInstance, headers: Record<string, string> = {}, url = "/v1/me") =>
    instance.inject({ method: "GET", url, headers });

  it("resolves the principal from a valid bearer key", async () => {
    const instance = await start();
    const response = await me(instance, { authorization: `Bearer ${keyA.key}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      clientId: CLIENT_A,
      credentialId: "cred-a",
      scopes: ["messages:send"],
    });
  });

  it("ignores client ids forged in headers, query and body", async () => {
    const instance = await start();
    const response = await instance.inject({
      method: "GET",
      url: `/v1/me?client_id=${CLIENT_B}&clientId=${CLIENT_B}`,
      headers: {
        authorization: `Bearer ${keyA.key}`,
        "x-client-id": CLIENT_B,
        "x-on-connect-client": CLIENT_B,
      },
    });
    expect(response.json<{ clientId: string }>().clientId).toBe(CLIENT_A);
  });

  it.each([
    ["no header", {}],
    ["empty bearer", { authorization: "Bearer " }],
    ["basic scheme", { authorization: `Basic ${keyA.key}` }],
    ["raw key without scheme", { authorization: keyA.key }],
    ["malformed key", { authorization: "Bearer onc_nope" }],
    ["unknown key", { authorization: `Bearer ${generateApiKey(PEPPER).key}` }],
    ["wrong secret", { authorization: `Bearer onc_${keyA.prefix}_${"A".repeat(43)}` }],
    ["revoked key", { authorization: `Bearer ${revokedKey.key}` }],
    ["key in custom header", { "x-api-key": keyA.key }],
  ] as const)("rejects %s with a generic 401", async (_label, headers) => {
    const instance = await start();
    const response = await me(instance, headers);
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    const body = response.json<{ error: string; message: string }>();
    expect(body.error).toBe("unauthorized");
    expect(body.message).toBe("Missing or invalid API key");
  });

  it("does not accept a key passed in the query string", async () => {
    const instance = await start();
    const response = await me(instance, {}, `/v1/me?api_key=${keyA.key}`);
    expect(response.statusCode).toBe(401);
  });

  it("accepts the bearer scheme case-insensitively", async () => {
    const instance = await start();
    const response = await me(instance, { authorization: `bearer ${keyA.key}` });
    expect(response.statusCode).toBe(200);
  });

  it("keeps health probes public", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
  });

  it("returns 500 without details when the credential store fails", async () => {
    app = await buildApp({
      env: loadApiEnv(baseEnv),
      checkRedis: async () => true,
      db: unusedDb,
      sessions: new FakeSessions(),
      authenticator: createApiKeyAuthenticator({
        pepper: PEPPER,
        store: {
          findByPrefix: async () => {
            throw new Error("password authentication failed for onconnect_app");
          },
        },
      }),
    });
    const response = await me(app, { authorization: `Bearer ${keyA.key}` });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("onconnect_app");
  });
});

describe("tenant routes: rejected before the database", () => {
  const auth = { authorization: `Bearer ${keyA.key}` };

  it("requires an API key", async () => {
    const instance = await start();
    const before = dbConnects;
    const response = await instance.inject({ method: "GET", url: "/v1/tenants/org-1" });
    expect(response.statusCode).toBe(401);
    expect(dbConnects).toBe(before);
  });

  it.each([
    ["external id with a slash", "PUT", "/v1/tenants/a%2Fb", { name: "x" }],
    ["external id with spaces", "GET", "/v1/tenants/a%20b", undefined],
    ["external id over 200 characters", "GET", `/v1/tenants/${"a".repeat(201)}`, undefined],
    ["missing name", "PUT", "/v1/tenants/org-1", {}],
    ["empty name", "PUT", "/v1/tenants/org-1", { name: "" }],
    ["client id in the body", "PUT", "/v1/tenants/org-1", { name: "x", clientId: CLIENT_B }],
    ["negative connection limit", "PUT", "/v1/tenants/org-1", { name: "x", maxConnections: -1 }],
    ["non-object entitlements", "PUT", "/v1/tenants/org-1", { name: "x", entitlements: [] }],
    ["unknown commercial status", "PUT", "/v1/tenants/org-1/commercial-status", { status: "deleted" }],
    ["page size above 100", "GET", "/v1/tenants?limit=101", undefined],
    ["unknown query parameter", "GET", "/v1/tenants?client_id=x", undefined],
  ] as const)("rejects %s with 400", async (_label, method, url, payload) => {
    const instance = await start();
    const before = dbConnects;
    const response = await instance.inject({
      method,
      url,
      headers: auth,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("bad_request");
    expect(dbConnects).toBe(before);
  });
});

describe("connection routes: rejected before the database", () => {
  const auth = { authorization: `Bearer ${keyA.key}` };
  const id = "aaaaaaaa-0000-4000-8000-0000000000c1";

  it("requires an API key", async () => {
    const instance = await start();
    const before = dbConnects;
    const response = await instance.inject({ method: "GET", url: `/v1/connections/${id}/qr` });
    expect(response.statusCode).toBe(401);
    expect(dbConnects).toBe(before);
  });

  it.each([
    ["non-uuid connection id", "GET", "/v1/connections/not-a-uuid", undefined],
    ["non-uuid id on qr", "GET", "/v1/connections/123/qr", undefined],
    ["label too long", "POST", "/v1/tenants/org-1/connections", { label: "x".repeat(101) }],
    ["unknown field on create", "POST", "/v1/tenants/org-1/connections", { provider: "meta_cloud" }],
    ["phone with plus sign", "POST", `/v1/connections/${id}/pairing-code`, { phoneNumber: "+5511999999999" }],
    ["phone too short", "POST", `/v1/connections/${id}/pairing-code`, { phoneNumber: "11999" }],
    ["missing phone", "POST", `/v1/connections/${id}/pairing-code`, {}],
  ] as const)("rejects %s with 400", async (_label, method, url, payload) => {
    const instance = await start();
    const before = dbConnects;
    const response = await instance.inject({
      method,
      url,
      headers: auth,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode).toBe(400);
    expect(dbConnects).toBe(before);
  });
});

describe("message routes: rejected before the database", () => {
  const auth = { authorization: `Bearer ${keyA.key}` };
  const id = "aaaaaaaa-0000-4000-8000-0000000000c1";

  it.each([
    ["missing text", { to: "5511999999999" }],
    ["empty text", { to: "5511999999999", text: "" }],
    ["text over 4096 characters", { to: "5511999999999", text: "x".repeat(4097) }],
    ["number with plus sign", { to: "+5511999999999", text: "oi" }],
    ["number with spaces", { to: "55 11 99999 9999", text: "oi" }],
    ["group id as recipient", { to: "120363000000000000@g.us", text: "oi" }],
    ["unknown field", { to: "5511999999999", text: "oi", connectionId: id }],
  ] as const)("rejects %s with 400", async (_label, payload) => {
    const instance = await start();
    const before = dbConnects;
    const response = await instance.inject({
      method: "POST", url: `/v1/connections/${id}/messages`, headers: auth, payload,
    });
    expect(response.statusCode).toBe(400);
    expect(dbConnects).toBe(before);
  });

  it("rejects malformed ids and cursors", async () => {
    const instance = await start();
    for (const url of ["/v1/messages/123", `/v1/connections/${id}/messages?before=abc`,
      `/v1/connections/${id}/messages?limit=500`]) {
      expect((await instance.inject({ method: "GET", url, headers: auth })).statusCode).toBe(400);
    }
  });
});
