import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAdminApp } from "../src/app.js";
import { escapeHtml, formatPhone, maskUrl } from "../src/html.js";

const SECRET = "proxy-secret-proxy-secret-proxy-secret";
const ORIGIN = "https://onconnect.example.com";
const CONN = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

const connection = {
  id: CONN, session_key: "tendi-org-1", status: "connecting", status_reason: "waiting_for_scan",
  status_changed_at: new Date("2026-11-17T12:00:00Z"), display_phone_number: "5585999132494",
  verified_name: "<b>Loja</b>", tenant: "tendi-org-1", client_slug: "tendi", client_id: CLIENT,
  provider: "whatsapp_web", sent7: "3", received7: "5", label: null, created_at: new Date(),
};

function fakeQueries() {
  return {
    dashboard: vi.fn(async () => ({
      totals: { connected: "1", live: "2", clients: "1", tenants: "3", sent7: "86", received7: "81",
        pending: "0", dead24: "2", disabled: "0" },
      days: [{ day: "2026-11-17", sent: "10", received: "4" }],
    })),
    connections: vi.fn(async () => [connection]),
    connection: vi.fn(async (id: string) => (id === CONN ? connection : null)),
    auditConnection: vi.fn(async () => []),
    clients: vi.fn(async () => []),
    client: vi.fn(async (id: string) => id === CLIENT
      ? {
          client: { id: CLIENT, slug: "tendi", name: "Tendi", status: "active", created_at: new Date() },
          tenants: [],
          keys: [{ id: KEY, label: "prod", key_prefix: "V6vi0ShZDLKfpGzB", created_at: new Date(),
            last_used_at: null, revoked_at: null, expires_at: null }],
        }
      : null),
    createClient: vi.fn(async () => CLIENT),
    issueKey: vi.fn(async () => ({ key: "onc_NEWKEYPREFIX0000_secret-part", prefix: "NEWKEYPREFIX0000" })),
    revokeKey: vi.fn(async () => true),
    webhookEndpoints: vi.fn(async () => [{
      id: KEY, client_slug: "tendi", tenant: null, url: "https://tendi.example.com/api/webhooks/dapi/s3cr3t",
      payload_format: "dapi", event_types: [], status: "disabled", consecutive_failures: 12,
      failing_since: new Date(), disabled_at: new Date(), created_at: new Date(),
    }]),
    deliveries: vi.fn(async () => []),
    resendDelivery: vi.fn(async () => true),
    reactivateEndpoint: vi.fn(async () => true),
  };
}

let app: FastifyInstance | undefined;
let queries = fakeQueries();
const sessions = { start: vi.fn(async () => undefined), logout: vi.fn(async () => undefined),
  currentQr: vi.fn(async (): Promise<string | null> => "2@qr") };

async function start() {
  queries = fakeQueries();
  app = await buildAdminApp({
    queries, sessions,
    proxySecret: SECRET, origin: ORIGIN, logLevel: "silent",
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

const viaCaddy = { "x-onconnect-admin-secret": SECRET, "x-onconnect-admin-user": "john" };
/** `origin: null` sends no Origin header at all. */
const post = (instance: FastifyInstance, url: string, body = "", origin: string | null = ORIGIN) =>
  instance.inject({
    method: "POST", url, payload: body,
    headers: { ...viaCaddy, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
  });

describe("access guard", () => {
  it("hides the panel from anything that did not come through Caddy", async () => {
    const instance = await start();
    for (const headers of [{}, { "x-onconnect-admin-secret": "wrong" }]) {
      const response = await instance.inject({ method: "GET", url: "/admin", headers });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("Dashboard");
    }
    expect(queries.dashboard).not.toHaveBeenCalled();
    expect((await instance.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });

  it("refuses state changes from another site or without an Origin", async () => {
    const instance = await start();
    expect((await post(instance, `/admin/connections/${CONN}/logout`, "", "https://evil.example")).statusCode).toBe(403);
    expect((await post(instance, `/admin/connections/${CONN}/logout`, "", null)).statusCode).toBe(403);
    expect(sessions.logout).not.toHaveBeenCalled();
  });

  it("sends strict security headers", async () => {
    const response = await (await start()).inject({ method: "GET", url: "/admin", headers: viaCaddy });
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("pages", () => {
  it("renders the dashboard with the 7-day numbers", async () => {
    const response = await (await start()).inject({ method: "GET", url: "/admin", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Conexões ativas");
    expect(response.body).toContain(">86<");
    expect(response.body).toContain("john");
  });

  it("lists connections and escapes what comes from WhatsApp", async () => {
    const response = await (await start()).inject({ method: "GET", url: "/admin/connections?status=connecting", headers: viaCaddy });
    expect(response.body).toContain("tendi-org-1");
    expect(response.body).toContain("+55 (85) 99913-2494");
    expect(response.body).toContain("&lt;b&gt;Loja&lt;/b&gt;");
    expect(response.body).not.toContain("<b>Loja</b>");
    expect(queries.connections).toHaveBeenCalledWith({ status: "connecting", client: undefined });
  });

  it("serves the QR of a waiting connection as an image", async () => {
    const response = await (await start()).inject({ method: "GET", url: `/admin/connections/${CONN}/qr.json`, headers: viaCaddy });
    const body = response.json<{ status: string; qrImage: string }>();
    expect(body.status).toBe("connecting");
    expect(body.qrImage).toMatch(/^data:image\/png;base64,/);
  });

  it("restarts and logs out a connection, audited under the admin's name", async () => {
    const instance = await start();
    const restart = await post(instance, `/admin/connections/${CONN}/restart`);
    expect(restart.statusCode).toBe(303);
    expect(sessions.start).toHaveBeenCalledWith(CONN);
    await post(instance, `/admin/connections/${CONN}/logout`);
    expect(sessions.logout).toHaveBeenCalledWith(CONN);
    expect(queries.auditConnection).toHaveBeenCalledWith({ name: "john" }, CLIENT, CONN, "connection.logged_out");
  });

  it("shows a new API key once, in the page body, never in a redirect URL", async () => {
    const response = await post(await start(), `/admin/clients/${CLIENT}/keys`, "label=prod-2");
    expect(response.statusCode).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain("onc_NEWKEYPREFIX0000_secret-part");
    expect(queries.issueKey).toHaveBeenCalledWith({ name: "john" }, CLIENT, "prod-2");
  });

  it("revokes a key and creates a client", async () => {
    const instance = await start();
    const revoke = await post(instance, `/admin/clients/${CLIENT}/keys/${KEY}/revoke`);
    expect(revoke.statusCode).toBe(303);
    expect(queries.revokeKey).toHaveBeenCalledWith({ name: "john" }, CLIENT, KEY);

    const bad = await post(instance, "/admin/clients", "name=X&slug=Bad Slug");
    expect(bad.headers.location).toContain("inv%C3%A1lido");
    expect(queries.createClient).not.toHaveBeenCalled();
    const created = await post(instance, "/admin/clients", "name=Outro&slug=outro");
    expect(created.headers.location).toBe(`/admin/clients/${CLIENT}?ok=${encodeURIComponent("Cliente criado. Gere uma API key para ele.")}`);
  });

  it("shows webhook endpoints without the secret in their path", async () => {
    const response = await (await start()).inject({ method: "GET", url: "/admin/webhooks", headers: viaCaddy });
    expect(response.body).toContain("https://tendi.example.com/…");
    expect(response.body).not.toContain("s3cr3t");
    expect(response.body).toContain("Reativar");
  });

  it("answers unknown ids and pages with 404", async () => {
    const instance = await start();
    expect((await instance.inject({ method: "GET", url: "/admin/connections/not-a-uuid", headers: viaCaddy })).statusCode).toBe(404);
    expect((await instance.inject({ method: "GET", url: `/admin/clients/${CONN}`, headers: viaCaddy })).statusCode).toBe(404);
    expect((await instance.inject({ method: "GET", url: "/admin/nothing", headers: viaCaddy })).statusCode).toBe(404);
  });
});

describe("html helpers", () => {
  it("escapes, masks and formats", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(maskUrl("https://h.example.com/api/webhooks/secret?x=1")).toBe("https://h.example.com/…");
    expect(maskUrl("https://h.example.com/")).toBe("https://h.example.com");
    expect(formatPhone("5585999132494")).toBe("+55 (85) 99913-2494");
    expect(formatPhone("14155550100")).toBe("+14155550100");
  });
});
