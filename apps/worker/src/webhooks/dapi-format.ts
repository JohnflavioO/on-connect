import type { ClaimedDelivery } from "./store.js";

/**
 * Webhook body in the D-API envelope, for endpoints registered through the
 * compatible session routes: `{ event, sessionId, traceId, data }`. Field
 * names follow what a D-API client reads (Tendi's webhook handler).
 */
export interface DapiEnvelope {
  event: string;
  sessionId: string;
  traceId: string;
  data: Record<string, unknown>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** D-API reports only connected / connecting / disconnected. */
function dapiConnectionStatus(status: string | null): string {
  if (status === "connected") return "connected";
  if (status === "disconnected" || status === "error") return "disconnected";
  return "connecting";
}

/** Null when the event has no D-API equivalent (yet): it is not sent. */
export function toDapiEnvelope(delivery: ClaimedDelivery): DapiEnvelope | null {
  const payload = record(delivery.payload);
  const sessionId = delivery.sessionId ?? text(payload.sessionId) ?? delivery.connectionId ??
    delivery.tenantExternalId;

  if (delivery.eventType === "connection.status") {
    return {
      event: "connection.status",
      sessionId,
      traceId: delivery.id,
      data: {
        status: dapiConnectionStatus(text(payload.status)),
        phone: text(payload.phone),
        reason: text(payload.reason),
        connectionId: delivery.connectionId,
      },
    };
  }
  return null;
}
