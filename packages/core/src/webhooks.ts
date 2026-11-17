import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { ClientTransaction } from "./db-transaction.js";
import type { SecretBox } from "./secret-box.js";
import type { AuditActor } from "./tenants.js";

/**
 * Webhook endpoints of the authenticated client, and the signing scheme
 * shared by the API (which issues secrets) and the worker (which signs).
 *
 * Same rules as every other repository: statements are scoped by
 * onconnect.current_client_id() and no function takes a client id. The
 * signing secret is shown once, at creation or rotation, and stored only
 * encrypted (AES-256-GCM, bound to the endpoint id).
 */

export const WEBHOOK_EVENT_TYPES = ["message.received", "message.status"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Endpoints per client. Each endpoint multiplies every event into a delivery. */
export const MAX_WEBHOOK_ENDPOINTS = 10;

/** Header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export const WEBHOOK_SIGNATURE_HEADER = "onconnect-signature";

/** Only version of the key that encrypts secrets. Bumped when it is rotated. */
export const WEBHOOK_SECRET_KEY_VERSION = 1;

export type WebhookEndpointStatus = "active" | "paused" | "disabled";

export interface WebhookEndpoint {
  id: string;
  url: string;
  /** Null: the endpoint receives events of every tenant of the client. */
  tenantExternalId: string | null;
  /** Empty: every event type. */
  eventTypes: WebhookEventType[];
  status: WebhookEndpointStatus;
  consecutiveFailures: number;
  failingSince: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** Additional authenticated data: a sealed secret only opens for its own endpoint. */
export function webhookSecretContext(endpointId: string): string {
  return `webhook-endpoint:${endpointId}`;
}

export function signWebhook(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * What an integrator does on receipt: recompute the HMAC over the raw body
 * and reject stale timestamps, so a captured request cannot be replayed.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^[0-9]{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || Math.abs(now - timestamp) > tolerance) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body).split("v1=")[1] ?? "", "hex");
  return signatures.some((candidate) => {
    const given = Buffer.from(candidate, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ---------------------------------------------------------------------------
// Destination checks (SSRF). The worker sits on the private Docker network
// with Redis, so a webhook URL must never reach a private address. The API
// rejects obvious cases at registration; the worker checks every resolved
// address again right before connecting.
// ---------------------------------------------------------------------------

// One list per family: a BlockList also matches IPv4 addresses against
// IPv4-mapped IPv6 rules, so ::ffff:0:0/96 in a shared list blocks all IPv4.
const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) return !blockedV6.check(address, "ipv6");
  return false;
}

export type WebhookUrlProblem =
  | "invalid_url"
  | "https_required"
  | "credentials_not_allowed"
  | "too_long"
  | "private_address";

/** Null when the URL may be registered; otherwise why not. */
export function checkWebhookUrl(raw: string): WebhookUrlProblem | null {
  if (raw.length > 2048) return "too_long";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "https:") return "https_required";
  if (url.username || url.password) return "credentials_not_allowed";
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (isIP(host)) return isPublicAddress(host) ? null : "private_address";
  // Single-label names resolve on the Docker network (e.g. "redis").
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal)$/.test(host)) {
    return "private_address";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repository (client-scoped)
// ---------------------------------------------------------------------------

export class WebhookEndpointError extends Error {
  constructor(readonly reason: "tenant_not_found" | "limit_reached") {
    super(reason);
    this.name = "WebhookEndpointError";
  }
}

interface EndpointRow {
  id: string;
  url: string;
  tenant_external_id: string | null;
  event_types: WebhookEventType[];
  status: WebhookEndpointStatus;
  consecutive_failures: number;
  failing_since: Date | null;
  disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `SELECT e.id, e.url, t.external_id AS tenant_external_id, e.event_types, e.status,
       e.consecutive_failures, e.failing_since, e.disabled_at, e.created_at, e.updated_at
  FROM onconnect.webhook_endpoints e
  LEFT JOIN onconnect.tenants t ON t.id = e.tenant_id AND t.client_id = e.client_id`;

const OWN = "e.client_id = onconnect.current_client_id()";

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    tenantExternalId: row.tenant_external_id,
    eventTypes: row.event_types,
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    failingSince: row.failing_since,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The URL may carry a token in its path or query, so only the host is audited. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function audit(
  tx: ClientTransaction,
  actor: AuditActor,
  action: string,
  endpointId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO onconnect.audit_log (client_id, actor_type, actor_id, action, target_type, target_id, metadata)
     VALUES (onconnect.current_client_id(), 'client', $1, $2, 'webhook_endpoint', $3, $4)`,
    [actor.credentialId, action, endpointId, JSON.stringify(metadata)],
  );
}

export async function findWebhookEndpoint(
  tx: ClientTransaction,
  id: string,
): Promise<WebhookEndpoint | null> {
  const result = await tx.query<EndpointRow>(`${SELECT} WHERE ${OWN} AND e.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toEndpoint(row) : null;
}

export async function listWebhookEndpoints(tx: ClientTransaction): Promise<WebhookEndpoint[]> {
  const result = await tx.query<EndpointRow>(`${SELECT} WHERE ${OWN} ORDER BY e.created_at, e.id`);
  return result.rows.map(toEndpoint);
}

export interface WebhookEndpointInput {
  url: string;
  tenantExternalId?: string | null;
  eventTypes?: WebhookEventType[];
}

/** The caller must have validated the URL with checkWebhookUrl. */
export async function createWebhookEndpoint(
  tx: ClientTransaction,
  actor: AuditActor,
  box: SecretBox,
  input: WebhookEndpointInput,
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  // Serializes creations of the same client, so two concurrent requests
  // cannot both pass the endpoint limit.
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtext('webhook_endpoints:' || onconnect.current_client_id()::text))",
  );

  let tenantId: string | null = null;
  if (input.tenantExternalId) {
    const tenant = await tx.query<{ id: string }>(
      `SELECT id FROM onconnect.tenants
        WHERE client_id = onconnect.current_client_id() AND external_id = $1`,
      [input.tenantExternalId],
    );
    tenantId = tenant.rows[0]?.id ?? null;
    if (!tenantId) throw new WebhookEndpointError("tenant_not_found");
  }

  const count = await tx.query<{ total: string }>(
    `SELECT count(*) AS total FROM onconnect.webhook_endpoints e WHERE ${OWN}`,
  );
  if (Number(count.rows[0]?.total ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
    throw new WebhookEndpointError("limit_reached");
  }

  const id = randomUUID();
  const secret = generateWebhookSecret();
  const sealed = box.sealParts(secret, webhookSecretContext(id));
  const eventTypes = [...new Set(input.eventTypes ?? [])];
  await tx.query(
    `INSERT INTO onconnect.webhook_endpoints
       (id, client_id, tenant_id, url, event_types,
        secret_ciphertext, secret_nonce, secret_auth_tag, secret_key_version)
     VALUES ($1, onconnect.current_client_id(), $2, $3, $4::text[], $5, $6, $7, $8)`,
    [id, tenantId, input.url, eventTypes, sealed.ciphertext, sealed.nonce, sealed.tag,
      WEBHOOK_SECRET_KEY_VERSION],
  );
  await audit(tx, actor, "webhook_endpoint.created", id, {
    host: hostOf(input.url),
    tenantExternalId: input.tenantExternalId ?? null,
    eventTypes,
  });

  const endpoint = await findWebhookEndpoint(tx, id);
  if (!endpoint) throw new Error("Created webhook endpoint is not visible");
  return { endpoint, secret };
}

export interface WebhookEndpointPatch {
  url?: string;
  eventTypes?: WebhookEventType[];
  /** "disabled" is set only by the worker; a client re-enables with "active". */
  status?: "active" | "paused";
}

export async function updateWebhookEndpoint(
  tx: ClientTransaction,
  actor: AuditActor,
  id: string,
  patch: WebhookEndpointPatch,
): Promise<WebhookEndpoint | null> {
  // Setting it active or pointing it elsewhere is the client saying "fixed":
  // the failure history starts over and retries waiting in backoff go now.
  const result = await tx.query(
    `UPDATE onconnect.webhook_endpoints e
        SET url = coalesce($2, e.url),
            event_types = coalesce($3::text[], e.event_types),
            status = coalesce($4, e.status),
            consecutive_failures = CASE WHEN $4 = 'active' OR $2 IS NOT NULL THEN 0
                                        ELSE e.consecutive_failures END,
            failing_since = CASE WHEN $4 = 'active' OR $2 IS NOT NULL THEN NULL
                                 ELSE e.failing_since END,
            disabled_at = CASE WHEN $4 IS NOT NULL THEN NULL ELSE e.disabled_at END
      WHERE ${OWN} AND e.id = $1`,
    [
      id,
      patch.url ?? null,
      patch.eventTypes ? [...new Set(patch.eventTypes)] : null,
      patch.status ?? null,
    ],
  );
  if (result.rowCount !== 1) return null;

  if (patch.status === "active" || patch.url !== undefined) {
    await tx.query(
      `UPDATE onconnect.webhook_deliveries d SET next_attempt_at = now()
        WHERE d.client_id = onconnect.current_client_id() AND d.endpoint_id = $1
          AND d.status IN ('pending', 'failed') AND d.next_attempt_at > now()`,
      [id],
    );
  }

  await audit(tx, actor, "webhook_endpoint.updated", id, {
    ...(patch.url === undefined ? {} : { host: hostOf(patch.url) }),
    ...(patch.eventTypes === undefined ? {} : { eventTypes: patch.eventTypes }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
  });
  return findWebhookEndpoint(tx, id);
}

/** Replaces the signing secret at once; the old one stops validating immediately. */
export async function rotateWebhookSecret(
  tx: ClientTransaction,
  actor: AuditActor,
  box: SecretBox,
  id: string,
): Promise<string | null> {
  const secret = generateWebhookSecret();
  const sealed = box.sealParts(secret, webhookSecretContext(id));
  const result = await tx.query(
    `UPDATE onconnect.webhook_endpoints e
        SET secret_ciphertext = $2, secret_nonce = $3, secret_auth_tag = $4, secret_key_version = $5
      WHERE ${OWN} AND e.id = $1`,
    [id, sealed.ciphertext, sealed.nonce, sealed.tag, WEBHOOK_SECRET_KEY_VERSION],
  );
  if (result.rowCount !== 1) return null;
  await audit(tx, actor, "webhook_endpoint.secret_rotated", id);
  return secret;
}

/** Deletes the endpoint and, by cascade, its pending deliveries. */
export async function deleteWebhookEndpoint(
  tx: ClientTransaction,
  actor: AuditActor,
  id: string,
): Promise<boolean> {
  const result = await tx.query(
    `DELETE FROM onconnect.webhook_endpoints e WHERE ${OWN} AND e.id = $1`,
    [id],
  );
  if (result.rowCount !== 1) return false;
  await audit(tx, actor, "webhook_endpoint.deleted", id);
  return true;
}
