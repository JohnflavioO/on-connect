import {
  WEBHOOK_SECRET_KEY_VERSION,
  WEBHOOK_SIGNATURE_HEADER,
  signWebhook,
  webhookSecretContext,
  type Logger,
  type SecretBox,
} from "@on-connect/core";
import { toDapiEnvelope } from "./dapi-format.js";
import type { ClaimedDelivery, DeliveryOutcome, DeliveryStore, FailurePolicy } from "./store.js";
import type { WebhookRequest, WebhookSender } from "./transport.js";

/**
 * Wait before attempt n+1, in seconds. Twelve attempts spread over about 28
 * hours: an integrator outage of a day loses nothing.
 */
export const RETRY_DELAYS_SECONDS = [
  10, 30, 60, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800, 43_200,
] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** An endpoint failing for a whole day, on at least 10 attempts, is disabled. */
export const DEFAULT_FAILURE_POLICY: FailurePolicy = {
  disableAfterFailures: 10,
  disableAfterSeconds: 24 * 3_600,
};

/** Longer than the request timeout, so a lease never expires mid-send. */
const LEASE_SECONDS = 60;

/** ±10 % jitter, so deliveries that failed together do not retry together. */
export function retryDelaySeconds(attempt: number, random: () => number = Math.random): number | null {
  const base = RETRY_DELAYS_SECONDS[attempt - 1];
  if (base === undefined) return null;
  return Math.round(base * (0.9 + random() * 0.2));
}

/**
 * Body and headers the integrator receives. The payload is never logged.
 * Null when the endpoint's format has no equivalent for this event.
 */
export function buildWebhookRequest(
  delivery: ClaimedDelivery,
  secret: string,
  nowSeconds: number,
): WebhookRequest | null {
  let body: string;
  if (delivery.payloadFormat === "dapi") {
    const envelope = toDapiEnvelope(delivery);
    if (!envelope) return null;
    body = JSON.stringify(envelope);
  } else {
    body = JSON.stringify({
      id: delivery.eventId,
      type: delivery.eventType,
      occurredAt: delivery.occurredAt.toISOString(),
      tenantExternalId: delivery.tenantExternalId,
      connectionId: delivery.connectionId,
      data: delivery.payload,
    });
  }
  return {
    url: delivery.url,
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "OnConnect-Webhooks/1",
      "onconnect-event-id": delivery.eventId,
      "onconnect-event-type": delivery.eventType,
      "onconnect-delivery-id": delivery.id,
      "onconnect-delivery-attempt": String(delivery.attempt),
      [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, nowSeconds, body),
    },
  };
}

export interface WebhookDispatcherOptions {
  store: DeliveryStore;
  /** Opens the endpoint secrets sealed by the API (WEBHOOK_SECRET_KEY). */
  box: SecretBox;
  send: WebhookSender;
  logger: Logger;
  /** Deliveries claimed and sent in parallel per tick. */
  batchSize: number;
  /** Idle wait between ticks when nothing was due. */
  pollIntervalMs?: number;
  policy?: FailurePolicy;
  now?: () => Date;
  random?: () => number;
}

export interface WebhookDispatcher {
  /** Claims and sends one batch. Resolves with the number of deliveries handled. */
  runOnce(): Promise<number>;
  /** Runs ticks until the returned stop() is called; stop() waits for the batch in flight. */
  start(): { stop(): Promise<void> };
}

export function createWebhookDispatcher(options: WebhookDispatcherOptions): WebhookDispatcher {
  const { store, box, send, logger, batchSize } = options;
  const policy = options.policy ?? DEFAULT_FAILURE_POLICY;
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  /** Null when the key version is unknown or the ciphertext does not open. */
  const openSecret = (delivery: ClaimedDelivery): string | null => {
    if (delivery.secretKeyVersion !== WEBHOOK_SECRET_KEY_VERSION) return null;
    try {
      return box.openParts(delivery.secret, webhookSecretContext(delivery.endpointId));
    } catch {
      return null;
    }
  };

  const deliverOne = async (delivery: ClaimedDelivery): Promise<void> => {
    const context = {
      deliveryId: delivery.id,
      eventId: delivery.eventId,
      endpointId: delivery.endpointId,
      attempt: delivery.attempt,
    };

    let outcome: DeliveryOutcome;
    const secret = openSecret(delivery);
    if (secret === null) {
      outcome = { statusCode: null, error: "secret_unavailable" };
    } else {
      const request = buildWebhookRequest(delivery, secret, Math.floor(now().getTime() / 1000));
      if (!request) {
        // Not a failure of the endpoint: its format cannot express this event.
        await store.markSkipped(delivery.id, delivery.attempt, "unsupported_event_for_format");
        logger.debug({ ...context, eventType: delivery.eventType }, "webhook delivery skipped");
        return;
      }
      const result = await send(request);
      if ("statusCode" in result && result.statusCode >= 200 && result.statusCode < 300) {
        await store.markDelivered(delivery.id, delivery.attempt, result.statusCode);
        logger.debug({ ...context, statusCode: result.statusCode }, "webhook delivered");
        return;
      }
      outcome = "statusCode" in result
        ? { statusCode: result.statusCode, error: `http_${result.statusCode}` }
        : { statusCode: null, error: result.error };
    }

    const delay = retryDelaySeconds(delivery.attempt, options.random);
    const retryAt = delay === null ? null : new Date(now().getTime() + delay * 1_000);
    const { endpointDisabled } = await store.markFailed(
      delivery.id, delivery.attempt, outcome, retryAt, policy,
    );
    logger.warn(
      { ...context, statusCode: outcome.statusCode, error: outcome.error, retryAt, dead: retryAt === null },
      "webhook delivery failed",
    );
    if (endpointDisabled) {
      logger.error({ endpointId: delivery.endpointId }, "webhook endpoint disabled after repeated failures");
    }
  };

  const runOnce = async (): Promise<number> => {
    const batch = await store.claimDue(batchSize, LEASE_SECONDS);
    await Promise.all(batch.map((delivery) =>
      deliverOne(delivery).catch((error: unknown) => {
        // The lease expires and the delivery is claimed again later.
        logger.error({ deliveryId: delivery.id, err: error }, "webhook delivery bookkeeping failed");
      })));
    return batch.length;
  };

  return {
    runOnce,
    start() {
      // Mutated from stop(); an object keeps the compiler from narrowing it.
      const state: { stopped: boolean; wake: (() => void) | null } = { stopped: false, wake: null };
      const stopping = (): boolean => state.stopped;
      const loop = (async () => {
        while (!stopping()) {
          let handled = 0;
          try {
            handled = await runOnce();
          } catch (error) {
            logger.error({ err: error }, "webhook dispatch tick failed");
          }
          // A full batch means more may be due: go again at once.
          if (handled < batchSize && !stopping()) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, pollIntervalMs);
              state.wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            state.wake = null;
          }
        }
      })();
      return {
        async stop() {
          state.stopped = true;
          state.wake?.();
          await loop;
        },
      };
    },
  };
}
