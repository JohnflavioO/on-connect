import { sameVerifyToken, verifyMetaSignature } from "@on-connect/core";
import type { FastifyPluginAsync } from "fastify";

export interface MetaWebhookRouteOptions {
  appSecret: string;
  verifyToken: string;
  /** Hands an accepted body to the sessions process (a queue in production). */
  enqueue: (payload: unknown) => Promise<void>;
}

/** Meta batches up to a few hundred changes; anything bigger is not Meta. */
const MAX_BODY_BYTES = 3 * 1_048_576;

/**
 * /webhooks/meta, called by Meta, not by integrators (no API key).
 *
 * GET answers the subscription check: Meta sends hub.verify_token (ours) and
 * hub.challenge, and expects the challenge back. POST carries messages and
 * statuses, signed with the app secret over the raw body; the signature is
 * checked before parsing, and only signed bodies reach the queue. The
 * response is quick (Meta retries slow or failed deliveries); storing
 * happens in the sessions process.
 */
export const metaWebhookRoutes: FastifyPluginAsync<MetaWebhookRouteOptions> = async (app, options) => {
  // Raw bytes for this route only: the signature covers the exact body.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES },
    (_request, body, done) => {
      done(null, body);
    });

  app.get<{ Querystring: Record<string, string | undefined> }>("/", async (request, reply) => {
    const query = request.query;
    if (query["hub.mode"] !== "subscribe" || !sameVerifyToken(query["hub.verify_token"], options.verifyToken)) {
      return reply.code(403).send({ error: "forbidden", message: "Verification failed", requestId: request.id });
    }
    const challenge = query["hub.challenge"] ?? "";
    // Echo only what Meta sends (digits); never reflect arbitrary text.
    if (!/^[0-9A-Za-z_-]{1,200}$/.test(challenge)) {
      return reply.code(400).send({ error: "bad_request", message: "Invalid challenge", requestId: request.id });
    }
    return reply.type("text/plain; charset=utf-8").send(challenge);
  });

  app.post("/", async (request, reply) => {
    const raw = request.body;
    const signature = request.headers["x-hub-signature-256"];
    if (!Buffer.isBuffer(raw) || !verifyMetaSignature(raw, typeof signature === "string" ? signature : undefined,
      options.appSecret)) {
      request.log.warn("meta webhook with an invalid signature refused");
      return reply.code(401).send({ error: "unauthorized", message: "Invalid signature", requestId: request.id });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "bad_request", message: "Invalid JSON", requestId: request.id });
    }
    // A failure here makes Meta retry later, which is what we want.
    await options.enqueue(payload);
    return reply.code(200).send({ status: "accepted" });
  });
};
