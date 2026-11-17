import type { MediaVault } from "@on-connect/core";
import type { FastifyPluginAsync } from "fastify";

export interface MediaRouteOptions {
  vault: MediaVault;
}

/** Types a browser may render in place; anything else is a download. */
const INLINE = /^(image\/(jpeg|png|gif|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/;

/**
 * GET /media/:token serves received media. There is no API key: the
 * signed token is the credential (a capability URL, like D-API media links),
 * because integrators fetch these links from their own servers as plain
 * URLs. An invalid or altered token and a file deleted by retention are the
 * same 404.
 */
export const mediaRoutes: FastifyPluginAsync<MediaRouteOptions> = async (app, { vault }) => {
  app.get<{ Params: { token: string } }>(
    "/:token",
    {
      schema: {
        params: {
          type: "object",
          required: ["token"],
          additionalProperties: false,
          properties: { token: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" } },
        },
      },
    },
    async (request, reply) => {
      const media = await vault.read(request.params.token);
      if (!media) {
        return reply.code(404).send({ error: "not_found", message: "Media not found", requestId: request.id });
      }
      return reply
        .header("content-type", media.mimetype)
        .header("content-disposition", INLINE.test(media.mimetype) ? "inline" : "attachment")
        .header("cache-control", "private, max-age=86400")
        .send(media.bytes);
    },
  );
};
