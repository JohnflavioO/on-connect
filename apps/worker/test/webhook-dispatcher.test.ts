import { randomBytes } from "node:crypto";
import {
  createLogger,
  createSecretBox,
  verifyWebhookSignature,
  webhookSecretContext,
} from "@on-connect/core";
import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  createWebhookDispatcher,
  retryDelaySeconds,
} from "../src/webhooks/dispatcher.js";
import type { ClaimedDelivery, DeliveryOutcome, DeliveryStore } from "../src/webhooks/store.js";
import type { WebhookRequest, WebhookResult } from "../src/webhooks/transport.js";
import { createHttpsSender, publicOnlyLookup } from "../src/webhooks/transport.js";

const logger = createLogger({ level: "silent", service: "test" });
const box = createSecretBox(randomBytes(32).toString("base64"));
const SECRET = "whsec_test-secret";
const NOW = new Date("2026-11-17T12:00:00Z");

function delivery(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  const endpointId = overrides.endpointId ?? "ep-1";
  return {
    id: "del-1",
    attempt: 1,
    eventId: "evt-1",
    eventType: "message.received",
    payload: { messageId: "msg-1", content: { type: "text", text: "olá" } },
    occurredAt: new Date("2026-11-17T11:59:00Z"),
    tenantExternalId: "shop",
    connectionId: "conn-1",
    endpointId,
    url: "https://tendi.example.com/hooks",
    secret: box.sealParts(SECRET, webhookSecretContext(endpointId)),
    secretKeyVersion: 1,
    ...overrides,
  };
}

class FakeStore implements DeliveryStore {
  delivered: { id: string; attempt: number; statusCode: number }[] = [];
  failed: { id: string; attempt: number; outcome: DeliveryOutcome; retryAt: Date | null }[] = [];
  disableNext = false;
  constructor(private due: ClaimedDelivery[]) {}

  async claimDue(limit: number) {
    return this.due.splice(0, limit);
  }

  async markDelivered(id: string, attempt: number, statusCode: number) {
    this.delivered.push({ id, attempt, statusCode });
  }

  async markFailed(id: string, attempt: number, outcome: DeliveryOutcome, retryAt: Date | null) {
    this.failed.push({ id, attempt, outcome, retryAt });
    return { endpointDisabled: this.disableNext };
  }
}

function dispatcher(store: DeliveryStore, respond: (request: WebhookRequest) => WebhookResult) {
  const sent: WebhookRequest[] = [];
  const instance = createWebhookDispatcher({
    store,
    box,
    logger,
    batchSize: 10,
    now: () => NOW,
    random: () => 0.5,
    send: async (request) => {
      sent.push(request);
      return respond(request);
    },
  });
  return { instance, sent };
}

describe("webhook dispatcher", () => {
  it("signs the exact body and marks a 2xx as delivered", async () => {
    const store = new FakeStore([delivery()]);
    const { instance, sent } = dispatcher(store, () => ({ statusCode: 204 }));
    expect(await instance.runOnce()).toBe(1);

    const [request] = sent;
    expect(request?.url).toBe("https://tendi.example.com/hooks");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      id: "evt-1",
      type: "message.received",
      occurredAt: "2026-11-17T11:59:00.000Z",
      tenantExternalId: "shop",
      connectionId: "conn-1",
      data: { messageId: "msg-1", content: { type: "text", text: "olá" } },
    });
    expect(request?.headers).toMatchObject({
      "content-type": "application/json",
      "onconnect-event-id": "evt-1",
      "onconnect-event-type": "message.received",
      "onconnect-delivery-id": "del-1",
      "onconnect-delivery-attempt": "1",
    });
    const signature = request?.headers["onconnect-signature"] ?? "";
    expect(verifyWebhookSignature(SECRET, signature, request?.body ?? "", {
      nowSeconds: NOW.getTime() / 1000,
    })).toBe(true);
    expect(store.delivered).toEqual([{ id: "del-1", attempt: 1, statusCode: 204 }]);
    expect(store.failed).toEqual([]);
  });

  it("schedules a retry with backoff on an HTTP error", async () => {
    const store = new FakeStore([delivery({ attempt: 3 })]);
    const { instance } = dispatcher(store, () => ({ statusCode: 503 }));
    await instance.runOnce();
    expect(store.failed).toEqual([{
      id: "del-1",
      attempt: 3,
      outcome: { statusCode: 503, error: "http_503" },
      retryAt: new Date(NOW.getTime() + 60_000),
    }]);
  });

  it("treats a redirect and a network error as failures", async () => {
    const store = new FakeStore([delivery({ id: "a" }), delivery({ id: "b" })]);
    const { instance } = dispatcher(store, (request) =>
      request.headers["onconnect-delivery-id"] === "a" ? { statusCode: 301 } : { error: "timeout" });
    await instance.runOnce();
    expect(store.failed.map((f) => f.outcome)).toEqual([
      { statusCode: 301, error: "http_301" },
      { statusCode: null, error: "timeout" },
    ]);
  });

  it("gives up after the last attempt", async () => {
    const store = new FakeStore([delivery({ attempt: MAX_ATTEMPTS })]);
    const { instance } = dispatcher(store, () => ({ statusCode: 500 }));
    await instance.runOnce();
    expect(store.failed[0]?.retryAt).toBeNull();
  });

  it("never sends when the secret cannot be opened", async () => {
    const store = new FakeStore([
      delivery({ endpointId: "ep-2", secret: box.sealParts(SECRET, webhookSecretContext("ep-1")) }),
      delivery({ id: "del-2", secretKeyVersion: 2 }),
    ]);
    const { instance, sent } = dispatcher(store, () => ({ statusCode: 200 }));
    await instance.runOnce();
    expect(sent).toEqual([]);
    expect(store.failed.map((f) => f.outcome.error)).toEqual(["secret_unavailable", "secret_unavailable"]);
  });

  it("keeps going when bookkeeping fails for one delivery", async () => {
    const store = new FakeStore([delivery({ id: "a" }), delivery({ id: "b" })]);
    const original = store.markDelivered.bind(store);
    store.markDelivered = async (id, attempt, status) => {
      if (id === "a") throw new Error("db down");
      await original(id, attempt, status);
    };
    const { instance } = dispatcher(store, () => ({ statusCode: 200 }));
    expect(await instance.runOnce()).toBe(2);
    expect(store.delivered.map((d) => d.id)).toEqual(["b"]);
  });

  it("stops its loop and waits for the batch in flight", async () => {
    const store = new FakeStore([delivery()]);
    const { instance } = dispatcher(store, () => ({ statusCode: 200 }));
    const running = instance.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await running.stop();
    expect(store.delivered).toHaveLength(1);
  });
});

describe("retry schedule", () => {
  it("grows and ends", () => {
    const fixed = () => 0.5;
    expect(retryDelaySeconds(1, fixed)).toBe(10);
    expect(retryDelaySeconds(MAX_ATTEMPTS - 1, fixed)).toBe(43_200);
    expect(retryDelaySeconds(MAX_ATTEMPTS, fixed)).toBeNull();
  });

  it("adds at most 10 % jitter", () => {
    expect(retryDelaySeconds(4, () => 0)).toBe(270);
    expect(retryDelaySeconds(4, () => 0.999_999)).toBe(330);
  });
});

describe("https sender", () => {
  it("refuses private destinations before connecting", async () => {
    const send = createHttpsSender({ timeoutMs: 1_000 });
    const request = { body: "{}", headers: {} };
    expect(await send({ ...request, url: "https://127.0.0.1/hook" })).toEqual({ error: "private_address" });
    expect(await send({ ...request, url: "http://example.com/hook" })).toEqual({ error: "https_required" });
  });

  it("blocks a name that resolves to a private address at connect time", async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      publicOnlyLookup("localhost", {}, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(error?.code).toBe("EBLOCKED");
  });
});
