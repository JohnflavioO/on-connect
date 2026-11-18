import {
  ConnectionLimitError,
  QR_TTL_SECONDS,
  createConnection,
  findConnection,
  listConnections,
  retireConnection,
  withClientTransaction,
  type Connection,
  type DatabasePool,
  type SessionGateway,
} from "@on-connect/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { principalOf } from "../plugins/api-key-auth.js";

export interface ConnectionRouteOptions {
  db: DatabasePool;
  sessions: SessionGateway;
}

const EXTERNAL_ID = "^[A-Za-z0-9._:@-]{1,200}$";
const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const tenantParams = {
  type: "object",
  required: ["externalId"],
  additionalProperties: false,
  properties: { externalId: { type: "string", pattern: EXTERNAL_ID } },
} as const;

const connectionParams = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID } },
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

const LIMIT_MESSAGES: Record<ConnectionLimitError["reason"], [number, string, string]> = {
  tenant_not_found: [404, "not_found", "Tenant not found"],
  tenant_inactive: [409, "tenant_inactive", "Tenant is suspended or canceled"],
  limit_reached: [409, "connection_limit_reached", "Tenant reached its max_connections"],
};

/**
 * WhatsApp Web connections. Every route first resolves the connection inside
 * a client-scoped transaction, so QR codes, pairing codes and logouts can
 * only target the caller's own connections.
 */
export const connectionRoutes: FastifyPluginAsync<ConnectionRouteOptions> = async (
  app,
  { db, sessions },
) => {
  const load = (request: FastifyRequest, id: string): Promise<Connection | null> =>
    withClientTransaction(db, principalOf(request), (tx) => findConnection(tx, id));

  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    problem(request, reply, 404, "not_found", "Connection not found");

  const alreadyConnected = (request: FastifyRequest, reply: FastifyReply) =>
    problem(request, reply, 409, "already_connected", "Connection is already linked");
  // QR and pairing codes exist only for WhatsApp Web; a Meta number is linked at Meta.
  const noQr = (request: FastifyRequest, reply: FastifyReply) =>
    problem(request, reply, 409, "not_supported_for_provider",
      "This connection uses the Meta Cloud API: it has no QR or pairing code");

  app.post<{ Params: { externalId: string }; Body: { label?: string | null } | undefined }>(
    "/tenants/:externalId/connections",
    {
      schema: {
        params: tenantParams,
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: { label: { type: ["string", "null"], maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      let connection: Connection;
      try {
        connection = await withClientTransaction(db, principal, (tx) =>
          createConnection(tx, principal, request.params.externalId, {
            label: request.body?.label ?? null,
          }));
      } catch (error) {
        if (error instanceof ConnectionLimitError) {
          const [status, code, message] = LIMIT_MESSAGES[error.reason];
          return problem(request, reply, status, code, message);
        }
        throw error;
      }
      try {
        await sessions.start(connection.id);
      } catch (error) {
        // The row exists; POST /connections/:id/restart retries the start.
        request.log.error({ connectionId: connection.id, err: error }, "failed to queue session start");
      }
      return reply.code(201).send(connection);
    },
  );

  app.get<{ Params: { externalId: string } }>(
    "/tenants/:externalId/connections",
    { schema: { params: tenantParams } },
    async (request) => ({
      connections: await withClientTransaction(db, principalOf(request), (tx) =>
        listConnections(tx, request.params.externalId)),
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/connections/:id",
    { schema: { params: connectionParams } },
    async (request, reply) => (await load(request, request.params.id)) ?? notFound(request, reply),
  );

  app.get<{ Params: { id: string } }>(
    "/connections/:id/qr",
    { schema: { params: connectionParams } },
    async (request, reply) => {
      const connection = await load(request, request.params.id);
      if (!connection) return notFound(request, reply);
      if (connection.provider !== "whatsapp_web") return noQr(request, reply);
      if (connection.status === "connected") return alreadyConnected(request, reply);
      const qr = await sessions.currentQr(connection.id);
      if (!qr) {
        return problem(request, reply, 404, "qr_not_available",
          "No QR right now. Wait a few seconds, or restart the connection if it expired.");
      }
      return {
        qr,
        qrImage: await QRCode.toDataURL(qr, { margin: 1, width: 320 }),
        refreshAfterSeconds: 15,
        maxAgeSeconds: QR_TTL_SECONDS,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/connections/:id/restart",
    { schema: { params: connectionParams } },
    async (request, reply) => {
      const connection = await load(request, request.params.id);
      if (!connection) return notFound(request, reply);
      if (connection.status === "connected") return alreadyConnected(request, reply);
      await sessions.start(connection.id);
      return reply.code(202).send({ status: "starting" });
    },
  );

  app.post<{ Params: { id: string }; Body: { phoneNumber: string } }>(
    "/connections/:id/pairing-code",
    {
      schema: {
        params: connectionParams,
        body: {
          type: "object",
          required: ["phoneNumber"],
          additionalProperties: false,
          // Digits only, with country code: 5511999999999.
          properties: { phoneNumber: { type: "string", pattern: "^[1-9][0-9]{9,14}$" } },
        },
      },
    },
    async (request, reply) => {
      const connection = await load(request, request.params.id);
      if (!connection) return notFound(request, reply);
      if (connection.provider !== "whatsapp_web") return noQr(request, reply);
      if (connection.status === "connected") return alreadyConnected(request, reply);
      const code = await sessions.requestPairingCode(connection.id, request.body.phoneNumber);
      if (!code) {
        return problem(request, reply, 504, "pairing_code_timeout",
          "The session did not produce a pairing code in time. Try again.");
      }
      return { pairingCode: code };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/connections/:id",
    { schema: { params: connectionParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const retired = await withClientTransaction(db, principal, (tx) =>
        retireConnection(tx, principal, request.params.id));
      if (!retired) return notFound(request, reply);
      await sessions.logout(request.params.id);
      return reply.code(204).send();
    },
  );
};
