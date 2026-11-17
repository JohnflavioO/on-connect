import {
  CompatSessionError,
  checkWebhookUrl,
  deleteCompatSession,
  findCompatSession,
  QR_TTL_SECONDS,
  setCompatWebhook,
  upsertCompatSession,
  withClientTransaction,
  type ApiKeyAuthenticator,
  type CompatSession,
  type DatabasePool,
  type SecretBox,
  type SessionGateway,
} from "@on-connect/core";
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { principalOf } from "../plugins/api-key-auth.js";

/**
 * D-API compatible routes (`/compat/dapi/api/v1`), so an integrator built on
 * D-API (Tendi) switches by changing its base URL and key. Only the session
 * routes that integrator uses are implemented; responses follow the D-API
 * envelope: `{ success, ... }` on success, `{ success: false, error,
 * statusCode }` on failure, with error texts its client matches on
 * ("Session not found", "QR code not available").
 *
 * Underneath, everything goes through the native, client-scoped repositories:
 * the API key alone decides the client, and another client's session is
 * "Session not found".
 */

export interface DapiCompatRouteOptions {
  authenticator: ApiKeyAuthenticator;
  db: DatabasePool;
  sessions: SessionGateway;
  webhookSecrets: SecretBox;
}

const SESSION_ID = "^[A-Za-z0-9._-]{1,100}$";

const sessionParams = {
  type: "object",
  required: ["sessionId"],
  additionalProperties: false,
  properties: { sessionId: { type: "string", pattern: SESSION_ID } },
} as const;

type Params = { sessionId: string };

/** D-API status words. Its clients treat anything not final as "pending". */
function dapiStatus(status: CompatSession["status"]): string {
  if (status === "pending") return "connecting";
  return status;
}

function fail(reply: FastifyReply, statusCode: number, error: string): FastifyReply {
  return reply.code(statusCode).send({ success: false, error, statusCode });
}

const URL_ERRORS = {
  invalid_url: "webhookUrl is not a valid URL",
  https_required: "webhookUrl must use https",
  credentials_not_allowed: "webhookUrl must not contain a user name or password",
  too_long: "webhookUrl is longer than 2048 characters",
  private_address: "webhookUrl must point to a public internet host",
} as const;

const COMPAT_ERRORS: Record<CompatSessionError["reason"], [number, string]> = {
  tenant_inactive: [409, "Session is suspended"],
  limit_reached: [409, "Session limit reached for this sessionId"],
  webhook_limit_reached: [409, "Webhook limit reached"],
};

export const dapiCompatRoutes: FastifyPluginAsync<DapiCompatRouteOptions> = async (app, options) => {
  const { authenticator, db, sessions, webhookSecrets } = options;

  app.decorateRequest("principal", null);

  // D-API sends the key bare (`Authorization: <key>`); a Bearer prefix is
  // accepted too. Query strings and bodies are never read for credentials.
  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    const token = typeof header === "string" ? header.trim().replace(/^Bearer\s+/i, "") : undefined;
    const result = await authenticator.authenticate(token);
    if (!result.ok) {
      request.log.info({ authFailure: result.reason }, "api key rejected");
      return fail(reply, 401, "Unauthorized");
    }
    request.principal = result.principal;
    return undefined;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === "number" && error.statusCode >= 400
      ? error.statusCode
      : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "compat request failed");
      return fail(reply, status, "Internal server error");
    }
    return fail(reply, status, error.message);
  });

  const load = (request: FastifyRequest, sessionId: string) =>
    withClientTransaction(db, principalOf(request), (tx) => findCompatSession(tx, sessionId));

  const notFound = (reply: FastifyReply) => fail(reply, 404, "Session not found");

  const badWebhook = (reply: FastifyReply, url: string) => {
    const issue = checkWebhookUrl(url);
    return issue ? fail(reply, 400, URL_ERRORS[issue]) : null;
  };

  app.post<{ Body: { sessionId: string; connectionMode?: string; webhookUrl?: string } }>(
    "/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string", pattern: SESSION_ID },
            connectionMode: { type: "string", enum: ["qr", "pair"] },
            webhookUrl: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      const { sessionId, connectionMode, webhookUrl } = request.body;
      if (connectionMode === "pair") {
        return fail(reply, 400, "connectionMode pair is not supported yet; use qr");
      }
      if (webhookUrl !== undefined) {
        const rejected = badWebhook(reply, webhookUrl);
        if (rejected) return rejected;
      }
      const principal = principalOf(request);
      let session: CompatSession;
      let created: boolean;
      try {
        ({ session, created } = await withClientTransaction(db, principal, async (tx) => {
          const result = await upsertCompatSession(tx, principal, sessionId);
          if (webhookUrl !== undefined) await setCompatWebhook(tx, principal, webhookSecrets, webhookUrl);
          return result;
        }));
      } catch (error) {
        if (error instanceof CompatSessionError) {
          const [status, message] = COMPAT_ERRORS[error.reason];
          return fail(reply, status, message);
        }
        throw error;
      }
      if (session.status !== "connected") await sessions.start(session.connectionId);
      return {
        success: true,
        sessionId,
        status: session.status === "connected" ? "connected" : "connecting",
        message: created ? "Session created" : "Session already exists; started",
      };
    },
  );

  app.get<{ Params: Params }>(
    "/sessions/:sessionId",
    { schema: { params: sessionParams } },
    async (request, reply) => {
      const session = await load(request, request.params.sessionId);
      if (!session) return notFound(reply);
      return {
        success: true,
        data: {
          sessionId: session.sessionId,
          status: dapiStatus(session.status),
          statusReason: session.statusReason,
          phone: session.phone,
          phoneNumber: session.phone,
          displayName: session.displayName,
        },
      };
    },
  );

  app.get<{ Params: Params }>(
    "/sessions/:sessionId/connect",
    { schema: { params: sessionParams } },
    async (request, reply) => {
      const session = await load(request, request.params.sessionId);
      if (!session) return notFound(reply);
      if (session.status !== "connected") await sessions.start(session.connectionId);
      return {
        success: true,
        sessionId: session.sessionId,
        status: session.status === "connected" ? "connected" : "connecting",
      };
    },
  );

  app.get<{ Params: Params }>(
    "/sessions/:sessionId/qr",
    { schema: { params: sessionParams } },
    async (request, reply) => {
      const session = await load(request, request.params.sessionId);
      if (!session) return notFound(reply);
      if (session.status === "connected") {
        return {
          success: true,
          data: { sessionId: session.sessionId, status: "connected", qrCode: null, qrCodeImage: null },
        };
      }
      const qr = await sessions.currentQr(session.connectionId);
      if (!qr) return fail(reply, 404, "QR code not available");
      return {
        success: true,
        data: {
          sessionId: session.sessionId,
          status: "connecting",
          qrCode: qr,
          qrCodeImage: await QRCode.toDataURL(qr, { margin: 1, width: 320 }),
          qrCodeUpdatedAt: null,
          maxAgeSeconds: QR_TTL_SECONDS,
        },
      };
    },
  );

  app.post<{ Params: Params }>(
    "/sessions/:sessionId/disconnect",
    { schema: { params: sessionParams } },
    async (request, reply) => {
      const session = await load(request, request.params.sessionId);
      if (!session) return notFound(reply);
      // The sessions process logs the number out and records "disconnected";
      // the session stays, so /connect shows a new QR.
      await sessions.logout(session.connectionId);
      return { success: true, sessionId: session.sessionId, status: "disconnected" };
    },
  );

  app.delete<{ Params: Params }>(
    "/sessions/:sessionId",
    { schema: { params: sessionParams } },
    async (request, reply) => {
      const principal = principalOf(request);
      const connectionId = await withClientTransaction(db, principal, (tx) =>
        deleteCompatSession(tx, principal, request.params.sessionId));
      if (!connectionId) return notFound(reply);
      await sessions.logout(connectionId);
      return { success: true, sessionId: request.params.sessionId };
    },
  );

  app.post<{ Params: Params; Body: { webhookUrl: string } }>(
    "/sessions/:sessionId/webhook",
    {
      schema: {
        params: sessionParams,
        body: {
          type: "object",
          required: ["webhookUrl"],
          properties: { webhookUrl: { type: "string", maxLength: 2048 } },
        },
      },
    },
    async (request, reply) => {
      const rejected = badWebhook(reply, request.body.webhookUrl);
      if (rejected) return rejected;
      const principal = principalOf(request);
      let found: boolean;
      try {
        found = await withClientTransaction(db, principal, async (tx) => {
          if (!(await findCompatSession(tx, request.params.sessionId))) return false;
          await setCompatWebhook(tx, principal, webhookSecrets, request.body.webhookUrl);
          return true;
        });
      } catch (error) {
        if (error instanceof CompatSessionError) {
          const [status, message] = COMPAT_ERRORS[error.reason];
          return fail(reply, status, message);
        }
        throw error;
      }
      if (!found) return notFound(reply);
      return { success: true, sessionId: request.params.sessionId };
    },
  );

  // Per-event toggles are accepted for compatibility; the events sent are the
  // ones this layer supports (DAPI_COMPAT_EVENTS).
  app.post<{ Params: Params }>(
    "/sessions/:sessionId/webhook-config",
    { schema: { params: sessionParams, body: { type: "object" } } },
    async (request, reply) => {
      const session = await load(request, request.params.sessionId);
      if (!session) return notFound(reply);
      return { success: true, sessionId: session.sessionId };
    },
  );
};
