import {
  CompatSessionError,
  MessageRejectedError,
  checkWebhookUrl,
  createOutboundMessage,
  deleteCompatSession,
  findCompatSession,
  findMessage,
  generateWhatsappMessageId,
  QR_TTL_SECONDS,
  setCompatWebhook,
  upsertCompatSession,
  withClientTransaction,
  type ApiKeyAuthenticator,
  type CompatSession,
  type DatabasePool,
  type OutboundContent,
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
  /** How long a send waits for its outcome before answering "queued". */
  sendWaitMs?: number;
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

const SEND_ERRORS: Record<MessageRejectedError["reason"], [number, string]> = {
  connection_not_found: [404, "Session not found"],
  connection_not_ready: [400, "Session is not connected"],
  tenant_inactive: [403, "Session is suspended"],
};

const COMPAT_ERRORS: Record<CompatSessionError["reason"], [number, string]> = {
  tenant_inactive: [409, "Session is suspended"],
  limit_reached: [409, "Session limit reached for this sessionId"],
  webhook_limit_reached: [409, "Webhook limit reached"],
};

export const dapiCompatRoutes: FastifyPluginAsync<DapiCompatRouteOptions> = async (app, options) => {
  const { authenticator, db, sessions, webhookSecrets } = options;
  const sendWaitMs = options.sendWaitMs ?? 10_000;

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

  /**
   * D-API answers a send with the WhatsApp message id, which its client keeps
   * to match "delivered"/"read" later. The id is generated here and stored
   * with the message, so the sessions process sends under that same id. The
   * call waits briefly for the real outcome: a fast failure is reported as
   * an error; a send still queued (session reconnecting) is accepted and
   * retried in the background, as the native API does.
   */
  const send = async (
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: string,
    rawTo: string,
    content: OutboundContent,
  ) => {
    const to = rawTo.split("@")[0]?.replace(/\D/g, "") ?? "";
    if (!/^[0-9]{8,15}$/.test(to)) return fail(reply, 400, "to must be a phone number with country code");
    if (content.type !== "text") {
      const issue = checkWebhookUrl(content.url);
      if (issue) return fail(reply, 400, "media URL must be a public https URL");
    }
    {
      const principal = principalOf(request);
      const providerMessageId = generateWhatsappMessageId();
      let messageId: string;
      try {
        messageId = await withClientTransaction(db, principal, async (tx) => {
          const session = await findCompatSession(tx, sessionId);
          if (!session) throw new MessageRejectedError("connection_not_found");
          const message = await createOutboundMessage(tx, {
            connectionId: session.connectionId,
            to,
            content,
            providerMessageId,
          });
          return message.id;
        });
      } catch (error) {
        if (error instanceof MessageRejectedError) {
          const [status, message] = SEND_ERRORS[error.reason];
          return fail(reply, status, message);
        }
        throw error;
      }
      try {
        await sessions.dispatchMessage(messageId);
      } catch (error) {
        // Stored with its outbox job: the sessions process replays it.
        request.log.error({ messageId, err: error }, "failed to dispatch outbound message");
      }

      // Media is downloaded and uploaded to WhatsApp first: give it longer.
      const deadline = Date.now() + (content.type === "text" ? sendWaitMs : sendWaitMs * 2.5);
      let status = "queued";
      let errorCode: string | null = null;
      while (Date.now() < deadline) {
        const current = await withClientTransaction(db, principal, (tx) => findMessage(tx, messageId));
        status = current?.status ?? status;
        errorCode = current?.errorCode ?? null;
        if (status !== "queued" && status !== "sending") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (status === "failed") {
        return reply.code(502).send({
          success: false,
          error: `Message could not be sent (${errorCode ?? "send_failed"})`,
          statusCode: 502,
          messageId: providerMessageId,
        });
      }
      const key = { id: providerMessageId, remoteJid: `${to}@s.whatsapp.net`, fromMe: true };
      return {
        success: true,
        messageId: providerMessageId,
        status,
        data: { messageId: providerMessageId, id: providerMessageId, key, status },
      };
    }
  };

  const sendSchema = (required: string[], properties: Record<string, object>) => ({
    schema: {
      body: {
        type: "object",
        required: ["sessionId", "to", ...required],
        properties: {
          sessionId: { type: "string", pattern: SESSION_ID },
          to: { type: "string", minLength: 8, maxLength: 64 },
          caption: { type: ["string", "null"], maxLength: 4096 },
          ...properties,
        },
      },
    },
  });
  const MEDIA_URL = { type: "string", minLength: 9, maxLength: 4096 };

  type SendBody = { sessionId: string; to: string; caption?: string | null };

  app.post<{ Body: SendBody & { text: string } }>(
    "/messages/send/text",
    sendSchema(["text"], { text: { type: "string", minLength: 1, maxLength: 4096 } }),
    async (request, reply) => send(request, reply, request.body.sessionId, request.body.to,
      { type: "text", text: request.body.text }),
  );

  app.post<{ Body: SendBody & { image: string } }>(
    "/messages/send/image",
    sendSchema(["image"], { image: MEDIA_URL }),
    async (request, reply) => send(request, reply, request.body.sessionId, request.body.to,
      { type: "image", url: request.body.image, caption: request.body.caption ?? null }),
  );

  app.post<{ Body: SendBody & { video: string } }>(
    "/messages/send/video",
    sendSchema(["video"], { video: MEDIA_URL }),
    async (request, reply) => send(request, reply, request.body.sessionId, request.body.to,
      { type: "video", url: request.body.video, caption: request.body.caption ?? null }),
  );

  app.post<{ Body: SendBody & { audio: string; ptt?: boolean } }>(
    "/messages/send/audio",
    sendSchema(["audio"], { audio: MEDIA_URL, ptt: { type: "boolean" } }),
    async (request, reply) => send(request, reply, request.body.sessionId, request.body.to,
      { type: "audio", url: request.body.audio, voice: request.body.ptt === true }),
  );

  app.post<{ Body: SendBody & { document: string; fileName?: string; mimetype?: string } }>(
    "/messages/send/document",
    sendSchema(["document"], {
      document: MEDIA_URL,
      fileName: { type: "string", maxLength: 255 },
      mimetype: { type: "string", maxLength: 255 },
    }),
    async (request, reply) => send(request, reply, request.body.sessionId, request.body.to, {
      type: "document",
      url: request.body.document,
      fileName: request.body.fileName ?? null,
      mimetype: request.body.mimetype ?? null,
      caption: request.body.caption ?? null,
    }),
  );

  /**
   * The contact's WhatsApp profile picture, asked of the session's socket.
   * `profilePictureUrl` is null when the contact hides or has no picture.
   */
  app.get<{ Params: { phone: string }; Querystring: { sessionId: string } }>(
    "/contacts/:phone/avatar",
    {
      schema: {
        params: {
          type: "object",
          required: ["phone"],
          properties: { phone: { type: "string", pattern: "^[0-9]{8,15}$" } },
        },
        querystring: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", pattern: SESSION_ID } },
        },
      },
    },
    async (request, reply) => {
      const session = await load(request, request.query.sessionId);
      if (!session) return notFound(reply);
      if (session.status !== "connected") return fail(reply, 400, "Session is not connected");
      const url = await sessions.requestProfilePicture(session.connectionId, request.params.phone);
      if (url === undefined) return fail(reply, 504, "Profile picture lookup timed out");
      return { success: true, data: { profilePictureUrl: url, url } };
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
