import {
  COMMERCIAL_STATUSES,
  findTenant,
  listTenants,
  setCommercialStatus,
  upsertTenant,
  withClientTransaction,
  type CommercialStatus,
  type DatabasePool,
  type TenantInput,
} from "@on-connect/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { principalOf } from "../plugins/api-key-auth.js";

export interface TenantRouteOptions {
  db: DatabasePool;
}

// The integrator's own identifier. Restricted to a URL-safe set so it can
// sit in a path without ambiguity; the database caps it at 200 characters.
const EXTERNAL_ID = "^[A-Za-z0-9._:@-]{1,200}$";

const externalIdParams = {
  type: "object",
  required: ["externalId"],
  additionalProperties: false,
  properties: { externalId: { type: "string", pattern: EXTERNAL_ID } },
} as const;

interface ExternalIdParams {
  externalId: string;
}

function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  // Same answer whether the tenant does not exist or belongs to another
  // client, so ids of other clients cannot be probed.
  return reply.code(404).send({
    error: "not_found",
    message: "Tenant not found",
    requestId: request.id,
  });
}

/** Tenants of the authenticated client. Registered behind requireApiKey. */
export const tenantRoutes: FastifyPluginAsync<TenantRouteOptions> = async (app, { db }) => {
  app.get<{ Querystring: { limit?: number; after?: string } }>(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            after: { type: "string", pattern: EXTERNAL_ID },
          },
        },
      },
    },
    async (request) => {
      const { limit = 50, after } = request.query;
      return withClientTransaction(db, principalOf(request), (tx) =>
        listTenants(tx, { limit, after }));
    },
  );

  app.get<{ Params: ExternalIdParams }>(
    "/:externalId",
    { schema: { params: externalIdParams } },
    async (request, reply) => {
      const tenant = await withClientTransaction(db, principalOf(request), (tx) =>
        findTenant(tx, request.params.externalId));
      return tenant ?? notFound(request, reply);
    },
  );

  app.put<{ Params: ExternalIdParams; Body: TenantInput }>(
    "/:externalId",
    {
      schema: {
        params: externalIdParams,
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            planCode: { type: ["string", "null"], minLength: 1, maxLength: 100 },
            maxConnections: { type: "integer", minimum: 0, maximum: 10_000 },
            entitlements: { type: "object", maxProperties: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const { tenant, created } = await withClientTransaction(db, principal, (tx) =>
        upsertTenant(tx, principal, request.params.externalId, request.body));
      return reply.code(created ? 201 : 200).send(tenant);
    },
  );

  app.put<{
    Params: ExternalIdParams;
    Body: { status: CommercialStatus; reason?: string | null };
  }>(
    "/:externalId/commercial-status",
    {
      schema: {
        params: externalIdParams,
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: [...COMMERCIAL_STATUSES] },
            reason: { type: ["string", "null"], maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const { status, reason = null } = request.body;
      const tenant = await withClientTransaction(db, principal, (tx) =>
        setCommercialStatus(tx, principal, request.params.externalId, status, reason));
      return tenant ?? notFound(request, reply);
    },
  );
};
