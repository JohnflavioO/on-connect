import {
  WEBHOOK_EVENT_TYPES,
  WebhookEndpointError,
  checkWebhookUrl,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  findWebhookEndpoint,
  listWebhookEndpoints,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  withClientTransaction,
  type DatabasePool,
  type SecretBox,
  type WebhookEndpointPatch,
  type WebhookEventType,
} from "@on-connect/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { principalOf } from "../plugins/api-key-auth.js";

export interface WebhookEndpointRouteOptions {
  db: DatabasePool;
  /** Seals signing secrets before they reach the database. */
  webhookSecrets: SecretBox;
}

const EXTERNAL_ID = "^[A-Za-z0-9._:@-]{1,200}$";
const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParams = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID } },
} as const;

const url = { type: "string", minLength: 9, maxLength: 2048 } as const;
const eventTypes = {
  type: "array",
  maxItems: WEBHOOK_EVENT_TYPES.length,
  uniqueItems: true,
  items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] },
} as const;

function problem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error, message, requestId: request.id });
}

const URL_MESSAGES = {
  invalid_url: "url is not a valid URL",
  https_required: "url must use https",
  credentials_not_allowed: "url must not contain a user name or password",
  too_long: "url is longer than 2048 characters",
  private_address: "url must point to a public internet host",
} as const;

/**
 * Where the integrator receives events. The signing secret is returned only
 * by creation and rotation; reads never include it.
 */
export const webhookEndpointRoutes: FastifyPluginAsync<WebhookEndpointRouteOptions> = async (
  app,
  { db, webhookSecrets },
) => {
  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    problem(request, reply, 404, "not_found", "Webhook endpoint not found");

  const badUrl = (request: FastifyRequest, reply: FastifyReply, value: string) => {
    const issue = checkWebhookUrl(value);
    return issue ? problem(request, reply, 400, "invalid_webhook_url", URL_MESSAGES[issue]) : null;
  };

  app.post<{
    Body: { url: string; tenantExternalId?: string | null; eventTypes?: WebhookEventType[] };
  }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: {
            url,
            tenantExternalId: { type: ["string", "null"], pattern: EXTERNAL_ID },
            eventTypes,
          },
        },
      },
    },
    async (request, reply) => {
      const rejected = badUrl(request, reply, request.body.url);
      if (rejected) return rejected;
      const principal = principalOf(request);
      try {
        const { endpoint, secret } = await withClientTransaction(db, principal, (tx) =>
          createWebhookEndpoint(tx, principal, webhookSecrets, request.body));
        return await reply.code(201).send({ ...endpoint, secret });
      } catch (error) {
        if (error instanceof WebhookEndpointError) {
          return error.reason === "tenant_not_found"
            ? problem(request, reply, 404, "not_found", "Tenant not found")
            : problem(request, reply, 409, "webhook_endpoint_limit_reached",
              "Maximum number of webhook endpoints reached");
        }
        throw error;
      }
    },
  );

  app.get("/", async (request) => ({
    webhookEndpoints: await withClientTransaction(db, principalOf(request), listWebhookEndpoints),
  }));

  app.get<{ Params: { id: string } }>(
    "/:id",
    { schema: { params: idParams } },
    async (request, reply) =>
      (await withClientTransaction(db, principalOf(request), (tx) =>
        findWebhookEndpoint(tx, request.params.id))) ?? notFound(request, reply),
  );

  app.patch<{ Params: { id: string }; Body: WebhookEndpointPatch }>(
    "/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { url, eventTypes, status: { type: "string", enum: ["active", "paused"] } },
        },
      },
    },
    async (request, reply) => {
      if (request.body.url !== undefined) {
        const rejected = badUrl(request, reply, request.body.url);
        if (rejected) return rejected;
      }
      const principal = principalOf(request);
      const updated = await withClientTransaction(db, principal, (tx) =>
        updateWebhookEndpoint(tx, principal, request.params.id, request.body));
      return updated ?? notFound(request, reply);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/:id/rotate-secret",
    { schema: { params: idParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const secret = await withClientTransaction(db, principal, (tx) =>
        rotateWebhookSecret(tx, principal, webhookSecrets, request.params.id));
      return secret ? { secret } : notFound(request, reply);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const deleted = await withClientTransaction(db, principal, (tx) =>
        deleteWebhookEndpoint(tx, principal, request.params.id));
      return deleted ? reply.code(204).send() : notFound(request, reply);
    },
  );
};
