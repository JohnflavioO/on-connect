import {
  MessageRejectedError,
  createOutboundText,
  findMessage,
  listMessages,
  withClientTransaction,
  type DatabasePool,
  type SessionGateway,
} from "@on-connect/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { principalOf } from "../plugins/api-key-auth.js";

export interface MessageRouteOptions {
  db: DatabasePool;
  sessions: SessionGateway;
}

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const idParams = (name: string) => ({
  type: "object",
  required: [name],
  additionalProperties: false,
  properties: { [name]: { type: "string", pattern: UUID } },
}) as const;

/** WhatsApp caps a text message at 4096 characters. */
const MAX_TEXT = 4096;

const REJECTIONS: Record<MessageRejectedError["reason"], [number, string, string]> = {
  connection_not_found: [404, "not_found", "Connection not found"],
  connection_not_ready: [409, "connection_not_ready", "Connection is not connected"],
  tenant_inactive: [409, "tenant_inactive", "Tenant or connection is suspended"],
};

function problem(request: FastifyRequest, reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message, requestId: request.id });
}

/**
 * Messages of the caller's connections. Sending stores the message and its
 * outbox job in one transaction, then hands it to the sessions process; the
 * response is 202 because delivery happens asynchronously.
 */
export const messageRoutes: FastifyPluginAsync<MessageRouteOptions> = async (app, { db, sessions }) => {
  app.post<{
    Params: { id: string };
    Body: { to: string; text: string; clientReference?: string | null };
  }>(
    "/connections/:id/messages",
    {
      schema: {
        params: idParams("id"),
        body: {
          type: "object",
          required: ["to", "text"],
          additionalProperties: false,
          properties: {
            // Digits only, with country code: 5511999999999.
            to: { type: "string", pattern: "^[1-9][0-9]{9,14}$" },
            text: { type: "string", minLength: 1, maxLength: MAX_TEXT },
            clientReference: { type: ["string", "null"], minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const message = await withClientTransaction(db, principalOf(request), (tx) =>
          createOutboundText(tx, {
            connectionId: request.params.id,
            to: request.body.to,
            text: request.body.text,
            clientReference: request.body.clientReference ?? null,
          }));
        try {
          await sessions.dispatchMessage(message.id);
        } catch (error) {
          // Stored and committed: the outbox replay sends it within minutes.
          request.log.error({ messageId: message.id, err: error }, "failed to dispatch message");
        }
        return await reply.code(202).send(message);
      } catch (error) {
        if (error instanceof MessageRejectedError) {
          const [status, code, text] = REJECTIONS[error.reason];
          return problem(request, reply, status, code, text);
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number; before?: string } }>(
    "/connections/:id/messages",
    {
      schema: {
        params: idParams("id"),
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            before: { type: "string", pattern: UUID },
          },
        },
      },
    },
    async (request) => {
      const { limit = 50, before } = request.query;
      return withClientTransaction(db, principalOf(request), (tx) =>
        listMessages(tx, request.params.id, { limit, before }));
    },
  );

  app.get<{ Params: { messageId: string } }>(
    "/messages/:messageId",
    { schema: { params: idParams("messageId") } },
    async (request, reply) => {
      const message = await withClientTransaction(db, principalOf(request), (tx) =>
        findMessage(tx, request.params.messageId));
      return message ?? problem(request, reply, 404, "not_found", "Message not found");
    },
  );
};
