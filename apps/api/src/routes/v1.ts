import type { ApiKeyAuthenticator, DatabasePool, SessionGateway } from "@on-connect/core";
import type { FastifyPluginAsync } from "fastify";
import { principalOf, requireApiKey } from "../plugins/api-key-auth.js";
import { connectionRoutes } from "./connections.js";
import { tenantRoutes } from "./tenants.js";

export interface V1RouteOptions {
  authenticator: ApiKeyAuthenticator;
  db: DatabasePool;
  sessions: SessionGateway;
}

/** Integrator API. Every route in this scope requires a valid API key. */
export const v1Routes: FastifyPluginAsync<V1RouteOptions> = async (app, options) => {
  requireApiKey(app, options.authenticator);

  /** Lets an integrator check which identity its key resolves to. */
  app.get("/me", async (request) => {
    const principal = principalOf(request);
    return {
      clientId: principal.clientId,
      credentialId: principal.credentialId,
      scopes: principal.scopes,
    };
  });

  await app.register(tenantRoutes, { prefix: "/tenants", db: options.db });
  await app.register(connectionRoutes, { db: options.db, sessions: options.sessions });
};
