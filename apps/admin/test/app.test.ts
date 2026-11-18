import { hashSync } from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminAuth } from "../src/admin-auth.js";
import { buildAdminApp } from "../src/app.js";
import { escapeHtml, formatPhone, maskUrl } from "../src/html.js";
import { trend } from "../src/dashboard.js";
import { maskPhone } from "../src/messages-page.js";
import { ago, evaluateHealth } from "../src/monitoring.js";
import type { AdminQueries, MonitoringTotals } from "../src/queries.js";

const SECRET = "proxy-secret-proxy-secret-proxy-secret";
const ORIGIN = "https://onconnect.example.com";
const PASSWORD = "local-test-password";
const HASH = hashSync(PASSWORD, 4);
const CONN = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";
const NATIVE = "44444444-4444-4444-8444-444444444444";

const connection = {
  id: CONN, session_key: "tendi-org-1", status: "connecting", status_reason: "waiting_for_scan",
  status_changed_at: new Date("2026-11-17T12:00:00Z"), display_phone_number: "5585999132494",
  verified_name: "<b>Loja</b>", tenant: "tendi-org-1", client_slug: "tendi", client_id: CLIENT,
  provider: "whatsapp_web", reject_calls: true, read_on_reply: false, sent7: "3", received7: "5", label: null, created_at: new Date(),
};

function fakeQueries() {
  return {
    dashboard: vi.fn<AdminQueries["dashboard"]>(async () => ({
      totals: { connected: "1", live: "2", clients: "1", tenants: "3", sent7: "86", received7: "81", sent_prev: "40", received_prev: "90",
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
    deliveries: vi.fn<AdminQueries["deliveries"]>(async () => []),
    resendDelivery: vi.fn(async () => true),
    reactivateEndpoint: vi.fn(async () => true),
    connectionHistory: vi.fn(async () => [
      { status: "connected", previous_status: "connecting", reason: null, at: new Date("2026-11-17T12:00:00Z") },
      { status: "disconnected", previous_status: "connected", reason: "logged_out", at: new Date("2026-11-17T11:00:00Z") },
    ]),
    connectionDeliveries: vi.fn(async () => [{
      id: KEY, event_type: "message.received", status: "delivered", attempts: 1, last_status_code: 200,
      last_error: null, updated_at: new Date("2026-11-17T12:01:00Z"),
    }]),
    deleteConnection: vi.fn(async () => true),
    updateConnectionBehavior: vi.fn(async () => true),
    webhookEndpoint: vi.fn(async (id: string) => id === KEY || id === NATIVE
      ? {
          id, client_id: CLIENT, client_slug: "tendi", tenant: null,
          url: "https://tendi.example.com/api/webhooks/dapi/s3cr3t", payload_format: id === KEY ? "dapi" : "onconnect",
          event_types: id === KEY ? ["connection.status", "message.received", "message.status"] : ["message.received"],
          status: "active", consecutive_failures: 0, failing_since: null, disabled_at: null,
          created_at: new Date(), queued: "0",
        }
      : null),
    pauseEndpoint: vi.fn(async () => true),
    setEndpointEvents: vi.fn(async (_admin: unknown, id: string) => id === NATIVE),
    alertTotals: vi.fn<AdminQueries["alertTotals"]>(async () => healthyTotals({ live: "2", connected: "1" })),
    messages: vi.fn<AdminQueries["messages"]>(async () => [{
      id: KEY, created_at: new Date("2026-11-17T12:00:00Z"), direction: "inbound", status: "received",
      message_type: "image", counterpart: "5585999132494", error_code: null, connection_id: CONN,
      session: "tendi-org-1", client_slug: "tendi",
    }]),
    search: vi.fn<AdminQueries["search"]>(async () => ({
      connections: [connection],
      clients: [{ id: CLIENT, slug: "tendi", name: "Tendi", status: "active" }],
      endpoints: [{ id: KEY, client_slug: "tendi", tenant: null, url: "https://tendi.example.com/api/webhooks/dapi/s3cr3t", status: "active" }],
    })),
    monitoring: vi.fn<AdminQueries["monitoring"]>(async () => ({
      totals: healthyTotals({ live: "2", connected: "1", dead: "1", delivered: "40", disabled_endpoints: "1" }),
      buckets: [
        { at: new Date("2026-11-17T15:00:00Z"), received: "3", sent: "2", send_failed: "0", delivered: "5", webhook_failed: "1", drops: "0" },
        { at: new Date("2026-11-17T15:01:00Z"), received: "0", sent: "1", send_failed: "1", delivered: "1", webhook_failed: "0", drops: "1" },
      ],
      problems: [{
        id: CONN, session_key: "tendi-org-1", tenant: "tendi-org-1", client_slug: "tendi", status: "disconnected",
        status_reason: "logged_out", status_changed_at: new Date("2026-11-17T14:00:00Z"),
      }],
    })),
  };
}

function healthyTotals(overrides: Partial<MonitoringTotals> = {}): MonitoringTotals {
  return {
    live: "2", connected: "2", drops: "0", received: "10", sent: "10", send_failed: "0", send_stuck: "0",
    last_received_at: new Date("2026-11-17T15:00:00Z"), delivered: "20", retrying: "0", dead: "0", queued: "0",
    delivery_ms: "250", disabled_endpoints: "0", ...overrides,
  };
}

let app: FastifyInstance | undefined;
let queries = fakeQueries();
const sessions = { start: vi.fn(async () => undefined), logout: vi.fn(async () => undefined),
  currentQr: vi.fn(async (): Promise<string | null> => "2@qr") };

const proxyHeaders = { "x-onconnect-console-secret": SECRET };
let viaCaddy = { ...proxyHeaders, cookie: "" };

/** In-memory stand-in for the Redis commands the sign-in uses. */
function memoryStore() {
  const keys = new Map<string, string>();
  const attempts = new Map<string, number>();
  return {
    get: async (key: string) => keys.get(key) ?? null,
    set: async (key: string, value: string) => { keys.set(key, value); },
    del: async (key: string) => Number(keys.delete(key)) + Number(attempts.delete(key)),
    eval: async (_script: string, _keyCount: number, key = "") => {
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      return count;
    },
  };
}

async function start(signedIn = true) {
  queries = fakeQueries();
  const keys = new Map<string, string>();
  const attempts = new Map<string, number>();
  const auth = createAdminAuth({
    username: "john", passwordHash: HASH,
    store: {
      get: async (key) => keys.get(key) ?? null,
      set: async (key, value) => { keys.set(key, value); },
      del: async (key) => Number(keys.delete(key)),
      eval: async (_script, _keyCount, key = "") => {
        const count = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, count);
        return count;
      },
    },
  });
  app = await buildAdminApp({
    queries, sessions, auth,
    proxySecret: SECRET, origin: ORIGIN, logLevel: "silent",
  });
  viaCaddy = { ...proxyHeaders, cookie: "" };
  if (signedIn) {
    const result = await auth.signIn("fixture", "john", PASSWORD);
    if (result.status !== "ok") throw new Error("Could not sign in test fixture");
    viaCaddy.cookie = result.cookie.split(";")[0] ?? "";
  }
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

/** `origin: null` sends no Origin header at all. */
const post = (instance: FastifyInstance, url: string, body = "", origin: string | null = ORIGIN) =>
  instance.inject({
    method: "POST", url, payload: body,
    headers: { ...viaCaddy, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
  });

describe("access guard", () => {
  it("hides the panel from anything that did not come through Caddy", async () => {
    const instance = await start();
    for (const headers of [{}, { "x-onconnect-console-secret": "wrong" }, { "x-onconnect-admin-secret": SECRET }]) {
      const response = await instance.inject({ method: "GET", url: "/admin", headers });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("Dashboard");
    }
    expect(queries.dashboard).not.toHaveBeenCalled();
    expect((await instance.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });

  it("refuses state changes from another site, an opaque origin or without an Origin", async () => {
    const instance = await start();
    expect((await post(instance, `/admin/connections/${CONN}/logout`, "", "https://evil.example")).statusCode).toBe(403);
    expect((await post(instance, `/admin/connections/${CONN}/logout`, "", null)).statusCode).toBe(403);
    expect((await post(instance, `/admin/connections/${CONN}/logout`, "", "null")).statusCode).toBe(403);
    expect(sessions.logout).not.toHaveBeenCalled();
    expect((await post(instance, `/admin/clients/${CLIENT}/keys`, "label=test", "null")).statusCode).toBe(403);
    expect(queries.issueKey).not.toHaveBeenCalled();
  });

  it("sends strict security headers", async () => {
    const response = await (await start()).inject({ method: "GET", url: "/admin", headers: viaCaddy });
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("same-origin");
  });
});

describe("public site and admin sign-in", () => {
  it("links the landing page to a branded login and protects private routes", async () => {
    const instance = await start(false);
    const home = await instance.inject({ url: "/", headers: proxyHeaders });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('href="/admin/login">Acessar conta');
    expect(home.body).toContain('id="como-funciona"');
    expect(home.body).toContain('id="plano"');
    expect(home.body).toContain('37,49');
    expect(home.body).toContain('aria-label="Links do rodapé"');
    expect(home.body).toContain('src="/admin/assets/logo.png"');
    const login = await instance.inject({ url: "/admin/login", headers: proxyHeaders });
    expect(login.body).toContain('autocomplete="current-password"');
    expect(login.body).toContain('src="/admin/assets/logo.png"');
    for (const path of ["/admin/assets/logo.png", "/admin/assets/icon.png", "/admin/assets/favicon.svg"]) {
      expect((await instance.inject({ url: path, headers: proxyHeaders })).statusCode).toBe(200);
    }
    const protectedRoute = await instance.inject({
      url: "/admin", headers: { ...proxyHeaders, "x-onconnect-admin-user": "john" },
    });
    expect(protectedRoute.statusCode).toBe(303);
    expect(protectedRoute.headers.location).toBe("/admin/login");
    expect((await post(instance, "/admin/logout")).statusCode).toBe(401);
    expect(queries.dashboard).not.toHaveBeenCalled();
  });

  it("authenticates the existing credential and revokes the session on logout", async () => {
    const instance = await start(false);
    const credentials = `username=john&password=${PASSWORD}`;
    expect((await post(instance, "/admin/login", credentials, "https://evil.example")).statusCode).toBe(403);
    const wrong = await post(instance, "/admin/login", "username=john&password=wrong");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain("Usuário ou senha inválidos.");
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    const signedIn = await post(instance, "/admin/login", credentials);
    expect(signedIn.statusCode).toBe(303);
    expect(signedIn.headers.location).toBe("/admin");
    const cookie = String(signedIn.headers["set-cookie"]);
    expect(cookie).toMatch(/^__Host-onconnect_admin=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800$/);
    viaCaddy.cookie = cookie.split(";")[0] ?? "";
    expect((await instance.inject({ url: "/admin", headers: viaCaddy })).statusCode).toBe(200);

    const signedOut = await post(instance, "/admin/logout");
    expect(signedOut.headers.location).toBe("/admin/login");
    expect(signedOut.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await instance.inject({ url: "/admin", headers: viaCaddy })).statusCode).toBe(303);
  });

  it("limits repeated invalid credentials", async () => {
    const instance = await start(false);
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await post(instance, "/admin/login", "username=john&password=wrong")).statusCode).toBe(401);
    }
    const limited = await post(instance, "/admin/login", `username=john&password=${PASSWORD}`);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("900");
    expect(limited.body).toContain("Aguarde 15 minutos");
  });

  it("resets the per-address count after a success", async () => {
    await start(false);
    const auth = createAdminAuth({ username: "john", passwordHash: HASH, store: memoryStore() });
    // 14 attempts from one address: more than its 10, fewer than the global 20.
    for (let round = 0; round < 2; round++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        expect((await auth.signIn("203.0.113.9", "john", "wrong")).status).toBe("invalid");
      }
      expect((await auth.signIn("203.0.113.9", "john", PASSWORD)).status).toBe("ok");
    }
  });

  it("limits attempts across many addresses so they cannot keep the server busy", async () => {
    const auth = createAdminAuth({ username: "john", passwordHash: HASH, store: memoryStore() });
    for (let attempt = 0; attempt < 20; attempt++) {
      expect((await auth.signIn(`198.51.100.${attempt}`, "john", "wrong")).status).toBe("invalid");
    }
    expect(await auth.signIn("198.51.100.200", "john", PASSWORD)).toMatchObject({
      status: "limited", scope: "global", retryAfter: 60,
    });
  });
});

describe("pages", () => {
  it("renders the dashboard with the 7-day numbers", async () => {
    const response = await (await start()).inject({ method: "GET", url: "/admin", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Conexões ativas");
    expect(response.body).toContain(">86<");
    expect(response.body).toContain("john");
    expect(response.body).toContain("Conexões recentes");
    expect(response.body).toContain("/admin/connections/" + CONN);
    expect(response.body).toContain('data-chart-toggle="sent"');
    expect(response.body).toContain("Desistidas em 24 h");
    expect(queries.dashboard).toHaveBeenCalledWith(7);
  });

  it("shows the brand logo and favicon on every page", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/admin/connections", headers: viaCaddy });
    expect(response.body).toContain('<img class="brand-logo" src="/admin/assets/logo.png"');
    expect(response.body).toContain('rel="icon" type="image/svg+xml" href="/admin/assets/favicon.svg"');
    expect(response.body).toContain('rel="icon" type="image/png" href="/admin/assets/icon.png"');
    for (const [path, type] of [
      ["/admin/assets/logo.png", "image/png"],
      ["/admin/assets/icon.png", "image/png"],
      ["/admin/assets/favicon.svg", "image/svg+xml"],
    ] as const) {
      const asset = await instance.inject({ method: "GET", url: path, headers: viaCaddy });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain(type);
    }
    const png = await instance.inject({ method: "GET", url: "/admin/assets/logo.png", headers: viaCaddy });
    expect(png.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    const svg = await instance.inject({ method: "GET", url: "/admin/assets/favicon.svg", headers: viaCaddy });
    expect(svg.body).toContain("data:image/png;base64,");
  });

  it("applies a supported chart period and rejects unsupported values by using the default", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/admin?days=30", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(queries.dashboard).toHaveBeenLastCalledWith(30);
    expect(response.body).toContain("Últimos 30 dias");
    await instance.inject({ method: "GET", url: "/admin?days=365", headers: viaCaddy });
    expect(queries.dashboard).toHaveBeenLastCalledWith(7);
  });

  it("shows empty states without inventing activity or success rates", async () => {
    const instance = await start();
    queries.dashboard.mockResolvedValue({ totals: undefined, days: [] });
    queries.connections.mockResolvedValue([]);
    const response = await instance.inject({ method: "GET", url: "/admin", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Nenhuma conexão cadastrada");
    expect(response.body).toContain("Suas conexões começam aqui.");
    expect(response.body).not.toMatch(/NaN|Infinity/);
  });

  it("lists connections and escapes what comes from WhatsApp", async () => {
    const response = await (await start()).inject({ method: "GET", url: "/admin/connections?status=connecting", headers: viaCaddy });
    expect(response.body).toContain("tendi-org-1");
    expect(response.body).toContain("+55 (85) 99913-2494");
    expect(response.body).toContain("&lt;b&gt;Loja&lt;/b&gt;");
    expect(response.body).not.toContain("<b>Loja</b>");
    expect(queries.connections).toHaveBeenCalledWith({ status: "connecting", client: undefined, search: undefined });
  });

  it("forwards a bounded search and preserves filters without rendering search markup", async () => {
    const response = await (await start()).inject({
      method: "GET", url: "/admin/connections?status=connected&client=tendi&q=%20%3Cscript%3E%20", headers: viaCaddy,
    });
    expect(response.statusCode).toBe(200);
    expect(queries.connections).toHaveBeenCalledWith({ status: "connected", client: "tendi", search: "<script>" });
    expect(response.body).toContain('value="&lt;script&gt;"');
    expect(response.body).not.toContain("<script>");
    expect(response.body).toContain("q=%3Cscript%3E");
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
    // Pause / reactivate / events live on the endpoint's own page now.
    expect(response.body).toContain(`/admin/webhooks/endpoints/${KEY}`);
    expect(response.body).toContain("Gerenciar");
  });

  it("shows 25 deliveries and carries active filters to both pagination links", async () => {
    const instance = await start();
    queries.deliveries.mockResolvedValue(Array.from({ length: 26 }, (_, n) => ({
      id: `${n}`, client_slug: "tendi", event_type: "message.received", session: `session-row-${n}-end`,
      url: "https://tendi.example.com/private-delivery-secret", status: "delivered", attempts: 1,
      last_status_code: 200, last_error: null, next_attempt_at: new Date(), updated_at: new Date(),
    })));
    const response = await instance.inject({ method: "GET", url: "/admin/webhooks?show=all&event=message.received&q=tendi&page=2", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(queries.deliveries).toHaveBeenCalledWith("all", { page: 2, status: undefined, event: "message.received", search: "tendi" });
    expect(response.body).toContain("session-row-24-end");
    expect(response.body).not.toContain("session-row-25-end");
    expect(response.body).toContain('rel="next" href="/admin/webhooks?show=all&amp;event=message.received&amp;q=tendi&amp;page=3#deliveries"');
    expect(response.body).toContain('rel="prev" href="/admin/webhooks?show=all&amp;event=message.received&amp;q=tendi#deliveries"');
    expect(response.body).not.toContain("private-delivery-secret");
  });

  it("defaults to pending/problems and bounds invalid pagination and filters", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/admin/webhooks?show=invalid&event=invalid&page=-1&q=%3Cscript%3E", headers: viaCaddy });
    expect(queries.deliveries).toHaveBeenCalledWith("problems", { page: 1, status: undefined, event: undefined, search: "<script>" });
    expect(response.body).toContain("Nenhuma entrega encontrada nesta página.");
    expect(response.body).toContain('value="&lt;script&gt;"');
    expect(response.body).not.toContain("<script>");
    expect(response.body).not.toContain('rel="prev"');
    expect(response.body).not.toContain('rel="next"');
    await instance.inject({ method: "GET", url: "/admin/webhooks?show=delivered&page=3", headers: viaCaddy });
    expect(queries.deliveries).toHaveBeenLastCalledWith("all", { page: 3, status: "delivered", event: undefined, search: undefined });
  });

  it("answers unknown ids and pages with 404", async () => {
    const instance = await start();
    expect((await instance.inject({ method: "GET", url: "/admin/connections/not-a-uuid", headers: viaCaddy })).statusCode).toBe(404);
    expect((await instance.inject({ method: "GET", url: `/admin/clients/${CONN}`, headers: viaCaddy })).statusCode).toBe(404);
    expect((await instance.inject({ method: "GET", url: "/admin/nothing", headers: viaCaddy })).statusCode).toBe(404);
  });
});

describe("connection tabs", () => {
  const get = async (instance: FastifyInstance, url: string) =>
    instance.inject({ method: "GET", url, headers: viaCaddy });

  it("opens on Conexão with actions, QR and the delete form", async () => {
    const response = await get(await start(), `/admin/connections/${CONN}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('aria-current="page">Conexão');
    expect(response.body).toContain(`/admin/connections/${CONN}/delete`);
    expect(response.body).toContain("data-qr-url");
    expect(queries.connectionHistory).not.toHaveBeenCalled();
  });

  it("shows the status history and this session's deliveries", async () => {
    const response = await get(await start(), `/admin/connections/${CONN}?tab=historico`);
    expect(queries.connectionHistory).toHaveBeenCalledWith(CONN);
    expect(response.body).toContain("Número desconectado no celular");
    expect(response.body).toContain("message.received");
  });

  it("shows ids to copy, and never an API key", async () => {
    const response = await get(await start(), `/admin/connections/${CONN}?tab=desenvolvedor`);
    expect(response.body).toContain('id="dev-session"');
    expect(response.body).toContain(CONN);
    expect(response.body).toContain("API key não aparece aqui");
    expect(response.body).not.toMatch(/onc_[A-Za-z0-9]{16}_/);
  });

  it("lists fixed behaviors and falls back to Conexão for an unknown tab", async () => {
    const instance = await start();
    expect((await get(instance, `/admin/connections/${CONN}?tab=configuracoes`)).body).toContain("Sempre ligado");
    expect((await get(instance, `/admin/connections/${CONN}?tab=nada`)).body).toContain('aria-current="page">Conexão');
  });

  it("renders saved settings and validates same-origin updates including disabling both", async () => {
    const instance = await start();
    const url = `/admin/connections/${CONN}/settings`;
    const settings = await get(instance, `/admin/connections/${CONN}?tab=configuracoes`);
    expect(settings.body).toContain('name="rejectCalls" type="checkbox" checked');
    expect(settings.body).toContain('name="readOnReply" type="checkbox" >');

    expect((await post(instance, url, "readOnReply=on", "https://another.example")).statusCode).toBe(403);
    expect((await post(instance, url, "readOnReply=invalid")).statusCode).toBe(400);
    expect(queries.updateConnectionBehavior).not.toHaveBeenCalled();

    expect((await post(instance, url, "readOnReply=on")).headers.location).toContain("?tab=configuracoes&ok=");
    expect(queries.updateConnectionBehavior).toHaveBeenLastCalledWith({ name: "john" }, CONN, false, true);
    expect((await post(instance, url)).statusCode).toBe(303);
    expect(queries.updateConnectionBehavior).toHaveBeenLastCalledWith({ name: "john" }, CONN, false, false);
  });

  it("deletes only when EXCLUIR is typed, then logs the number out", async () => {
    const instance = await start();
    const missing = await post(instance, `/admin/connections/${CONN}/delete`, "confirm=excluir");
    expect(missing.headers.location).toContain(`/admin/connections/${CONN}?ok=`);
    expect(queries.deleteConnection).not.toHaveBeenCalled();
    expect(sessions.logout).not.toHaveBeenCalled();

    const done = await post(instance, `/admin/connections/${CONN}/delete`, "confirm=EXCLUIR");
    expect(done.headers.location).toMatch(/^\/admin\/connections\?ok=/);
    expect(queries.deleteConnection).toHaveBeenCalledWith({ name: "john" }, CONN);
    expect(sessions.logout).toHaveBeenCalledWith(CONN);
  });
});

describe("webhook endpoint page", () => {
  it("shows a compatibility endpoint's events as fixed, without the secret path", async () => {
    const response = await (await start()).inject({ method: "GET", url: `/admin/webhooks/endpoints/${KEY}`, headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Compatibilidade (D-API)");
    expect(response.body).not.toContain("s3cr3t");
    expect(response.body).not.toContain("Salvar eventos");
    expect(response.body).toContain(`/admin/webhooks/endpoints/${KEY}/pause`);
  });

  it("lets a native endpoint choose events, refusing an empty choice", async () => {
    const instance = await start();
    const page = await instance.inject({ method: "GET", url: `/admin/webhooks/endpoints/${NATIVE}`, headers: viaCaddy });
    expect(page.body).toContain("Salvar eventos");

    const empty = await post(instance, `/admin/webhooks/endpoints/${NATIVE}/events`, "mode=some");
    expect(empty.headers.location).toContain("Escolha");
    expect(queries.setEndpointEvents).not.toHaveBeenCalled();

    await post(instance, `/admin/webhooks/endpoints/${NATIVE}/events`,
      "mode=some&event_message.status=on&event_connection.status=on&event_bogus=on");
    expect(queries.setEndpointEvents).toHaveBeenLastCalledWith({ name: "john" }, NATIVE, ["message.status", "connection.status"]);
    await post(instance, `/admin/webhooks/endpoints/${NATIVE}/events`, "mode=all");
    expect(queries.setEndpointEvents).toHaveBeenLastCalledWith({ name: "john" }, NATIVE, []);
  });

  it("explains when a compatibility endpoint's events cannot change, and pauses", async () => {
    const instance = await start();
    const refused = await post(instance, `/admin/webhooks/endpoints/${KEY}/events`, "mode=all");
    expect(decodeURIComponent(refused.headers.location as string)).toContain("compatibilidade");
    const paused = await post(instance, `/admin/webhooks/endpoints/${KEY}/pause`);
    expect(paused.headers.location).toContain(`/admin/webhooks/endpoints/${KEY}?ok=`);
    expect(queries.pauseEndpoint).toHaveBeenCalledWith({ name: "john" }, KEY);
  });
});

describe("monitoring", () => {
  const NOW = new Date("2026-11-17T15:05:00Z");
  const tones = (overrides: Partial<MonitoringTotals>) =>
    Object.fromEntries(evaluateHealth(healthyTotals(overrides), "24h", NOW).cards.map((c) => [c.key, c.tone]));

  it("calls everything healthy with no alerts when nothing is wrong", () => {
    const { cards, alerts } = evaluateHealth(healthyTotals(), "24h", NOW);
    expect(cards.map((c) => c.tone)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(alerts).toEqual([]);
  });

  it("grades connections: some down is attention, all down is critical", () => {
    expect(tones({ connected: "1" }).connections).toBe("warn");
    expect(tones({ connected: "0" }).connections).toBe("bad");
    expect(tones({ live: "0", connected: "0" }).connections).toBe("idle");
  });

  it("grades webhooks by success rate and treats a disabled endpoint as critical", () => {
    expect(tones({ delivered: "95", dead: "5" }).webhooks).toBe("warn");
    expect(tones({ delivered: "8", dead: "2", retrying: "2" }).webhooks).toBe("bad");
    expect(tones({ disabled_endpoints: "1" }).webhooks).toBe("bad");
    expect(tones({ delivered: "0" }).webhooks).toBe("idle");
  });

  it("grades sending by failures and messages stuck in the queue", () => {
    expect(tones({ send_failed: "1", sent: "99" }).sending).toBe("warn");
    expect(tones({ send_failed: "10", sent: "90" }).sending).toBe("bad");
    expect(tones({ send_stuck: "2" }).sending).toBe("warn");
    expect(tones({ sent: "0", send_failed: "0" }).sending).toBe("idle");
  });

  it("lists critical alerts before attention ones", () => {
    const { alerts } = evaluateHealth(healthyTotals({ connected: "1", disabled_endpoints: "1" }), "24h", NOW);
    expect(alerts.map((a) => a.tone)).toEqual(["bad", "warn"]);
    expect(alerts[0]?.text).toContain("desativado");
  });

  it("says how long ago things happened", () => {
    expect(ago(null, NOW)).toBe("nunca");
    expect(ago(new Date("2026-11-17T15:04:40Z"), NOW)).toBe("agora");
    expect(ago(new Date("2026-11-17T15:00:00Z"), NOW)).toBe("há 5 min");
    expect(ago(new Date("2026-11-17T12:05:00Z"), NOW)).toBe("há 3 h");
  });

  it("renders the page with alerts, cards, charts and the live refresh", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/admin/monitoring", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(queries.monitoring).toHaveBeenCalledWith("1h");
    expect(response.body).toContain("Monitoramento");
    expect(response.body).toContain("monitor-alert bad");
    expect(response.body).toContain("Crítico");
    expect(response.body).toContain("tendi-org-1");
    expect(response.body).toContain("data-autorefresh");
    expect(response.body).toContain('aria-current="page"');
  });

  it("accepts only known periods and refreshes itself only in the live view", async () => {
    const instance = await start();
    const week = await instance.inject({ method: "GET", url: "/admin/monitoring?period=7d", headers: viaCaddy });
    expect(queries.monitoring).toHaveBeenLastCalledWith("7d");
    expect(week.body).not.toContain("data-autorefresh");
    await instance.inject({ method: "GET", url: "/admin/monitoring?period=toString", headers: viaCaddy });
    expect(queries.monitoring).toHaveBeenLastCalledWith("1h");
  });
});

describe("dashboard package 1", () => {
  it("compares the message cards with the previous period", async () => {
    const response = await (await start()).inject({ method: "GET", url: "/admin", headers: viaCaddy });
    expect(response.body).toContain('<span class="metric-trend up">+115%</span>');
    expect(response.body).toContain('<span class="metric-trend down">−10%</span>');
    expect(response.body).toContain("/admin/messages?direction=outbound");
  });

  it("works out the trend text for edge cases", () => {
    expect(trend(0, 0)).toEqual({ text: "sem movimento", tone: "flat" });
    expect(trend(5, 0)).toEqual({ text: "novo no período", tone: "up" });
    expect(trend(101, 14)).toEqual({ text: "+621,4%", tone: "up" });
    expect(trend(3, 3)).toEqual({ text: "0%", tone: "flat" });
  });

  it("lists messages as metadata with the number partly hidden", async () => {
    const instance = await start();
    const response = await instance.inject({
      method: "GET", url: `/admin/messages?direction=inbound&status=received&connection=${CONN}&q=%2B55%2085%2099913-2494&page=2`, headers: viaCaddy,
    });
    expect(response.statusCode).toBe(200);
    expect(queries.messages).toHaveBeenCalledWith({
      direction: "inbound", status: "received", connection: CONN, search: "+55 85 99913-2494", page: 2,
    });
    expect(response.body).toContain("+55 (85) •••••-2494");
    expect(response.body).not.toContain("5585999132494");
    expect(response.body).toContain("Imagem");
  });

  it("drops unknown message filters instead of passing them to SQL", async () => {
    const instance = await start();
    await instance.inject({ method: "GET", url: "/admin/messages?direction=sideways&status=lost&connection=x&page=0", headers: viaCaddy });
    expect(queries.messages).toHaveBeenCalledWith({
      direction: undefined, status: undefined, connection: undefined, search: undefined, page: 1,
    });
  });

  it("masks numbers of any country", () => {
    expect(maskPhone("5585999132494")).toBe("+55 (85) •••••-2494");
    expect(maskPhone("447911123456")).toBe("+44••••••3456");
    expect(maskPhone("12345")).toBe("+•••••");
  });

  it("searches connections, clients and endpoints without showing the webhook path", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/admin/search?q=tendi", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(queries.search).toHaveBeenCalledWith("tendi");
    expect(response.body).toContain("/admin/connections/" + CONN);
    expect(response.body).toContain("/admin/clients/" + CLIENT);
    expect(response.body).toContain("/admin/webhooks/endpoints/" + KEY);
    expect(response.body).not.toContain("s3cr3t");
    expect(response.body).toContain('value="tendi"');
  });

  it("does not search for a single character", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/admin/search?q=t", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(queries.search).not.toHaveBeenCalled();
    expect(response.body).toContain("Digite o que procura.");
  });

  it("shows the alerts bell with the count on every page", async () => {
    const instance = await start();
    const response = await instance.inject({ method: "GET", url: "/admin/clients", headers: viaCaddy });
    expect(response.body).toContain('class="alerts-menu"');
    expect(response.body).toContain('<span class="alerts-count warn">1</span>');
    expect(response.body).toContain("1 de 2 conexões estão fora do ar.");
    expect(response.body).toContain("data-global-search");
  });

  it("keeps the page working when the alerts cannot be read", async () => {
    const instance = await start();
    queries.alertTotals.mockRejectedValue(new Error("db down"));
    const response = await instance.inject({ method: "GET", url: "/admin/clients", headers: viaCaddy });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Não foi possível ler os alertas agora.");
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
