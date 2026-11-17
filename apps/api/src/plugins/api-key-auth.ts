import type { ApiKeyAuthenticator, ApiKeyPrincipal } from "@on-connect/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Set only by the API-key hook, from a verified credential. */
    principal: ApiKeyPrincipal | null;
  }
}

const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

/**
 * Extracts the key from `Authorization: Bearer <key>` only. Keys in query
 * strings, bodies or custom headers are ignored: they end up in access logs,
 * proxies and browser history.
 */
function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  return BEARER_PATTERN.exec(header.trim())?.[1] ?? "";
}

function unauthorized(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header("www-authenticate", 'Bearer realm="on-connect"')
    .send({
      error: "unauthorized",
      message: "Missing or invalid API key",
      requestId: request.id,
    });
}

/**
 * Adds API-key authentication to every route registered in `scope`.
 * Must be called inside an encapsulated plugin so health probes stay public.
 */
export function requireApiKey(scope: FastifyInstance, authenticator: ApiKeyAuthenticator): void {
  scope.decorateRequest("principal", null);

  scope.addHook("onRequest", async (request, reply) => {
    const result = await authenticator.authenticate(bearerToken(request));
    if (!result.ok) {
      // The reason helps operators; it never reaches the caller.
      request.log.info({ authFailure: result.reason }, "api key rejected");
      return unauthorized(request, reply);
    }
    request.principal = result.principal;
    return undefined;
  });
}

/** For handlers behind requireApiKey: the principal is guaranteed. */
export function principalOf(request: FastifyRequest): ApiKeyPrincipal {
  if (!request.principal) {
    throw new Error("Route is not protected by requireApiKey");
  }
  return request.principal;
}
