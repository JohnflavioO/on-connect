import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAdminApp } from "../src/app.js";
import { escapeHtml, formatPhone, maskUrl } from "../src/html.js";
import { ago, evaluateHealth } from "../src/monitoring.js";
import type { AdminQueries, MonitoringTotals } from "../src/queries.js";

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
    dashboard: vi.fn<AdminQueries["dashboard"]>(async () => ({
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
    deliveries: vi.fn<AdminQueries["deliveries"]>(async () => []),
    resendDelivery: vi.fn(async () => true),
    reactivateEndpoint: vi.fn(async () => true),
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
    expect(response.body).toContain("Reativar");
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

describe("html helpers", () => {
  it("escapes, masks and formats", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(maskUrl("https://h.example.com/api/webhooks/secret?x=1")).toBe("https://h.example.com/…");
    expect(maskUrl("https://h.example.com/")).toBe("https://h.example.com");
    expect(formatPhone("5585999132494")).toBe("+55 (85) 99913-2494");
    expect(formatPhone("14155550100")).toBe("+14155550100");
  });
});
