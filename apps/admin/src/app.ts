import { timingSafeEqual } from "node:crypto";
import { WEBHOOK_EVENT_TYPES, loggerOptions, type SessionGateway } from "@on-connect/core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import QRCode from "qrcode";
import type { AdminAuth } from "./admin-auth.js";
import { PUBLIC_CSS } from "./public-css.js";
import { documentationPage } from "./documentation-page.js";
import { landingPage, loginPage } from "./public-pages.js";
import { CSS, JS } from "./assets.js";
import { FAVICON_SVG, ICON_PNG, LOGO_PNG } from "./brand.js";
import { connectionTable, dashboardView } from "./dashboard.js";
import { badge, formatDate, formatNumber, html, icon, maskUrl, page, type PageAlert } from "./html.js";
import { CONNECTION_TABS, connectionPage, type ConnectionTab } from "./connection-page.js";
import { endpointPage } from "./endpoint-page.js";
import { MESSAGE_STATUSES, messagesView, searchView } from "./messages-page.js";
import { evaluateHealth, monitoringView } from "./monitoring.js";
import {
  DELIVERY_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  MONITORING_WINDOWS,
  type MessageFilters,
  type Admin,
  type AdminQueries,
  type MonitoringPeriod,
} from "./queries.js";

export interface AdminAppOptions {
  queries: AdminQueries;
  sessions: Pick<SessionGateway, "start" | "logout" | "currentQr">;
  /** Caddy adds it to every proxied request; anything without it is refused. */
  proxySecret: string;
  auth: AdminAuth;
  /** Scheme and host of the panel, e.g. https://onconnect.tendidesk.com.br. */
  origin: string;
  logLevel: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

const CSP = [
  // Inline style attributes size the chart bars; scripts stay same-origin only.
  "default-src 'none'", "img-src 'self' data:", "style-src 'self' 'unsafe-inline'", "script-src 'self'",
  "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STATUS_FILTERS: Array<[string, string]> = [
  ["", "Todas"], ["connected", "Conectadas"], ["connecting", "Conectando"],
  ["disconnected", "Desconectadas"], ["error", "Com erro"], ["pending", "Pendentes"],
];

/**
 * The public site and super-admin panel are served through Caddy. Panel
 * requests require an admin session and form posts require the configured origin.
 */
export async function buildAdminApp(options: AdminAppOptions): Promise<FastifyInstance> {
  const { queries, sessions, auth } = options;
  const origin = new URL(options.origin).origin;

  const app = Fastify({
    logger: loggerOptions({ level: options.logLevel, service: "admin" }),
    bodyLimit: 65_536,
    routerOptions: { maxParamLength: 128 },
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health/live") return undefined;
    // Caddy sends the secret in X-OnConnect-Console-Secret. The older panel
    // read X-OnConnect-Admin-Secret behind basic_auth; using a new name keeps
    // a half-finished deploy (new Caddy, old panel) closed instead of open.
    if (!sameSecret(request.headers["x-onconnect-console-secret"] as string | undefined, options.proxySecret)) {
      return reply.code(404).send("Not found");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const from = request.headers.origin;
      if (from !== origin) {
        request.log.warn({ origin: from }, "admin form from another origin refused");
        return reply.code(403).send("Forbidden");
      }
    }
    const path = request.url.split("?", 1)[0];
    if (path === "/" || path === "/docs" || path === "/admin/login" || path === "/assets/on-connect.css"
      || path === "/admin/assets/admin.css" || path === "/admin/assets/logo.png"
      || path === "/admin/assets/icon.png" || path === "/admin/assets/favicon.svg") return undefined;
    if (!(await auth.authenticated(request.headers.cookie))) {
      if (request.method === "GET" || request.method === "HEAD") {
        return reply.redirect("/admin/login", 303);
      }
      return reply.code(401).send("Acesso restrito");
    }
    return undefined;
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("content-security-policy", CSP);
    reply.header("x-content-type-options", "nosniff");
    // no-referrer makes browsers send Origin: null on native form POSTs,
    // which our CSRF guard correctly rejects. Keep origins on same-site forms
    // without disclosing the panel URL to external sites.
    reply.header("referrer-policy", "same-origin");
    reply.header("cache-control", "no-store");
    reply.header("x-frame-options", "DENY");
    return payload;
  });

  const adminOf = (): Admin => ({ name: auth.username });

  // The bell must never break a page: when the totals cannot be read it
  // shows "unavailable" instead.
  const alertsOf = async (request: FastifyRequest): Promise<PageAlert[] | null> => {
    try {
      const totals = await queries.alertTotals();
      return totals ? evaluateHealth(totals, "24h").alerts : [];
    } catch (error) {
      request.log.warn({ err: error }, "admin alerts unavailable");
      return null;
    }
  };

  const show = async (reply: FastifyReply, request: FastifyRequest,
    options2: Omit<Parameters<typeof page>[0], "user" | "alerts">) =>
    reply.type("text/html; charset=utf-8").send(page({
      ...options2, user: adminOf().name, alerts: await alertsOf(request),
    }));

  const back = (reply: FastifyReply, location: string, notice: string) =>
    reply.redirect(`${location}${location.includes("?") ? "&" : "?"}ok=${encodeURIComponent(notice)}`, 303);

  const noticeOf = (request: FastifyRequest): string | null => {
    const ok = (request.query as Record<string, unknown> | undefined)?.ok;
    return typeof ok === "string" ? ok.slice(0, 200) : null;
  };

  const notFound = (reply: FastifyReply, request: FastifyRequest, what: string) =>
    show(reply.code(404), request, {
      title: "Não encontrado", active: "dashboard", body: html`<p class="muted">${what} não encontrado.</p>`,
    });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/admin/assets/logo.png", async (_request, reply) => reply.type("image/png").send(LOGO_PNG));
  app.get("/admin/assets/icon.png", async (_request, reply) => reply.type("image/png").send(ICON_PNG));
  app.get("/admin/assets/favicon.svg", async (_request, reply) => reply.type("image/svg+xml").send(FAVICON_SVG));
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(landingPage()));
  app.get("/docs", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(documentationPage(origin)));
  app.get("/assets/on-connect.css", async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(PUBLIC_CSS));
  app.get("/admin/login", async (request, reply) => {
    if (await auth.authenticated(request.headers.cookie)) return reply.redirect("/admin", 303);
    return reply.type("text/html; charset=utf-8").send(loginPage());
  });
  app.post<{ Body: unknown }>("/admin/login", { bodyLimit: 4096 }, async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown } | null | undefined;
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const ip = request.headers["x-onconnect-login-ip"];
    const address = typeof ip === "string" ? ip : request.ip;
    const result = await auth.signIn(address, username, password);
    // Every attempt is logged (never the password) so attacks show up in the logs.
    if (result.status === "ok") {
      request.log.info({ event: "admin.login", outcome: "ok", ip: address }, "admin signed in");
      return reply.header("set-cookie", result.cookie).redirect("/admin", 303);
    }
    const limited = result.status === "limited";
    request.log.warn({ event: "admin.login", outcome: limited ? `limited_${result.scope}` : "invalid", ip: address },
      "admin sign-in refused");
    if (limited) reply.header("retry-after", result.retryAfter);
    return reply.code(limited ? 429 : 401).type("text/html; charset=utf-8").send(loginPage(limited
      ? result.scope === "ip"
        ? "Muitas tentativas deste endereço. Aguarde 15 minutos e tente novamente."
        : "Muitas tentativas de acesso agora. Aguarde um minuto e tente novamente."
      : "Usuário ou senha inválidos."));
  });
  app.post("/admin/logout", async (request, reply) => {
    const cookie = await auth.signOut(request.headers.cookie);
    return reply.header("set-cookie", cookie).redirect("/admin/login", 303);
  });
  app.get("/admin/assets/admin.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(CSS));
  app.get("/admin/assets/admin.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").send(JS));

  // ---------------------------------------------------------------- Dashboard
  app.get<{ Querystring: { days?: string } }>("/admin", async (request, reply) => {
    const period = request.query.days === "30" ? 30 : request.query.days === "14" ? 14 : 7;
    const [data, rows] = await Promise.all([queries.dashboard(period), queries.connections({})]);
    return show(reply, request, {
      title: "Dashboard", active: "dashboard", notice: noticeOf(request),
      body: dashboardView(data, rows, period),
    });
  });

  // ---------------------------------------------------------------- Monitoring
  app.get<{ Querystring: { period?: string } }>("/admin/monitoring", async (request, reply) => {
    const period: MonitoringPeriod = request.query.period && Object.hasOwn(MONITORING_WINDOWS, request.query.period)
      ? request.query.period as MonitoringPeriod : "1h";
    return show(reply, request, {
      title: "Monitoramento", active: "monitoring", notice: noticeOf(request),
      body: monitoringView(await queries.monitoring(period), period),
    });
  });

  // ---------------------------------------------------------------- Messages
  app.get<{ Querystring: { direction?: string; status?: string; connection?: string; q?: string; page?: string } }>(
    "/admin/messages",
    async (request, reply) => {
      const query = request.query;
      const filters: MessageFilters = {
        direction: query.direction === "inbound" || query.direction === "outbound" ? query.direction : undefined,
        status: (MESSAGE_STATUSES as readonly string[]).includes(query.status ?? "") ? query.status : undefined,
        connection: query.connection && UUID.test(query.connection) ? query.connection : undefined,
        search: typeof query.q === "string" ? query.q.trim().slice(0, 100) || undefined : undefined,
      };
      const currentPage = typeof query.page === "string" && /^[1-9]d{0,3}$/.test(query.page) ? Number(query.page) : 1;
      const href = (changes: Partial<MessageFilters>) => {
        const next = { ...filters, page: currentPage, ...changes };
        const params = new URLSearchParams();
        if (next.direction) params.set("direction", next.direction);
        if (next.status) params.set("status", next.status);
        if (next.connection) params.set("connection", next.connection);
        if (next.search) params.set("q", next.search);
        if (next.page && next.page > 1) params.set("page", String(next.page));
        return `/admin/messages${params.size ? `?${params.toString()}` : ""}`;
      };
      const found = await queries.messages({ ...filters, page: currentPage });
      return show(reply, request, {
        title: "Mensagens", active: "messages", notice: noticeOf(request),
        body: messagesView(found.slice(0, MESSAGE_PAGE_SIZE), filters, currentPage, found.length > MESSAGE_PAGE_SIZE, href),
      });
    },
  );

  // ---------------------------------------------------------------- Search
  app.get<{ Querystring: { q?: string } }>("/admin/search", async (request, reply) => {
    const term = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) : "";
    const found = term.length >= 2
      ? await queries.search(term)
      : { connections: [], clients: [], endpoints: [] };
    return show(reply, request, {
      title: "Busca", active: "search", search: term, body: searchView(term.length >= 2 ? term : "", found),
    });
  });

  // ---------------------------------------------------------------- Connections
  app.get<{ Querystring: { status?: string; client?: string; q?: string } }>("/admin/connections", async (request, reply) => {
    const status = STATUS_FILTERS.some(([value]) => value && value === request.query.status)
      ? request.query.status : undefined;
    const client = request.query.client && SLUG.test(request.query.client) ? request.query.client : undefined;
    const search = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) || undefined : undefined;
    const rows = await queries.connections({ status, client, search });
    const filterUrl = (value: string) => {
      const params = new URLSearchParams();
      if (value) params.set("status", value);
      if (client) params.set("client", client);
      if (search) params.set("q", search);
      return `/admin/connections${params.size ? `?${params.toString()}` : ""}`;
    };
    return show(reply, request, {
      title: "Conexões", active: "connections", notice: noticeOf(request),
      body: html`
        <section class="overview-intro"><div><h2>Seus números, sob controle.</h2><p>Consulte o status de cada sessão e abra os detalhes para gerenciar o número ou o QR Code.</p></div><a class="button" href="${filterUrl(status ?? "")}">${icon("refresh")} Atualizar</a></section>
        <div class="connection-tabs" role="navigation" aria-label="Filtrar por status">${STATUS_FILTERS.map(([value, label]) => html`<a class="${(status ?? "") === value ? "selected" : ""}" href="${filterUrl(value)}" ${(status ?? "") === value ? html`aria-current="page"` : ""}>${label}</a>`)}</div>
        <section class="panel connections-panel"><form class="connection-search" method="get" action="/admin/connections">
          ${status ? html`<input type="hidden" name="status" value="${status}">` : ""}
          <label class="search-input">${icon("search")}<span class="sr-only">Buscar sessão, número ou nome</span><input name="q" placeholder="Buscar sessão, número ou nome…" value="${search ?? ""}" maxlength="100"></label>
          <label class="client-filter"><span class="sr-only">Slug do cliente</span><input name="client" placeholder="Cliente (slug)" value="${client ?? ""}" maxlength="63"></label>
          <button type="submit" class="button primary">Filtrar</button>${search || client || status ? html`<a class="button compact" href="/admin/connections">Limpar</a>` : ""}
        </form><div class="list-summary"><span>${formatNumber(rows.length)} ${rows.length === 1 ? "conexão encontrada" : "conexões encontradas"}</span><span>Até 500 conexões por consulta</span></div>
        ${connectionTable(rows)}</section>`,
    });
  });

  app.get<{ Params: { id: string }; Querystring: { tab?: string } }>("/admin/connections/:id", async (request, reply) => {
    if (!UUID.test(request.params.id)) return notFound(reply, request, "Conexão");
    const row = await queries.connection(request.params.id);
    if (!row) return notFound(reply, request, "Conexão");
    const tab: ConnectionTab = (CONNECTION_TABS as readonly string[]).includes(request.query.tab ?? "")
      ? request.query.tab as ConnectionTab : "conexao";
    const [history, deliveries] = tab === "historico"
      ? await Promise.all([queries.connectionHistory(row.id), queries.connectionDeliveries(row.id)])
      : [undefined, undefined];
    return show(reply, request, {
      title: row.session_key ?? row.tenant,
      active: "connections",
      notice: noticeOf(request),
      body: connectionPage(row, tab, { ...(history ? { history } : {}), ...(deliveries ? { deliveries } : {}) }),
    });
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/connections/:id/settings", async (request, reply) => {
      const { id } = request.params;
      if (!UUID.test(id)) return notFound(reply, request, "Conexão");
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
        return reply.code(400).send("Configuração inválida");
      }
      const { rejectCalls, readOnReply } = request.body as Record<string, unknown>;
      if ([rejectCalls, readOnReply].some((value) => value !== undefined && value !== "on")) {
        return reply.code(400).send("Configuração inválida");
      }
      if (!(await queries.updateConnectionBehavior(adminOf(), id, rejectCalls === "on", readOnReply === "on"))) {
        return notFound(reply, request, "Conexão");
      }
      return back(reply, `/admin/connections/${id}?tab=configuracoes`, "Configurações salvas.");
    },
  );

  // Deleting needs the word typed in the form, on top of the browser confirm.
  app.post<{ Params: { id: string }; Body: { confirm?: string } }>("/admin/connections/:id/delete", async (request, reply) => {
    const { id } = request.params;
    if (!UUID.test(id)) return reply.code(404).send("Not found");
    if (request.body.confirm !== "EXCLUIR") {
      return back(reply, `/admin/connections/${id}`, "Para excluir, digite EXCLUIR no campo de confirmação.");
    }
    if (!(await queries.deleteConnection(adminOf(), id))) return reply.code(404).send("Not found");
    await sessions.logout(id);
    return back(reply, "/admin/connections", "Conexão excluída. O número foi desconectado.");
  });

  app.get<{ Params: { id: string } }>("/admin/connections/:id/qr.json", async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: "not_found" });
    const row = await queries.connection(request.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const labels: Record<string, string> = {
      connected: "Conectado", connecting: "Conectando", pending: "Pendente",
      disconnected: "Desconectado", error: "Erro",
    };
    if (row.status === "connected") {
      return { status: row.status, statusLabel: labels[row.status], qrImage: null, message: "Número conectado." };
    }
    const qr = await sessions.currentQr(row.id);
    return {
      status: row.status,
      statusLabel: labels[row.status] ?? row.status,
      qrImage: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 280 }) : null,
      message: qr ? "" : "Sem QR no momento. Clique em \"Reiniciar\" para gerar um.",
    };
  });

  app.post<{ Params: { id: string; action: string } }>("/admin/connections/:id/:action", async (request, reply) => {
    const { id, action } = request.params;
    if (!UUID.test(id) || (action !== "restart" && action !== "logout")) return reply.code(404).send("Not found");
    const row = await queries.connection(id);
    if (!row) return reply.code(404).send("Not found");
    if (action === "restart") await sessions.start(id);
    else await sessions.logout(id);
    await queries.auditConnection(adminOf(), row.client_id, id,
      action === "restart" ? "connection.restarted" : "connection.logged_out");
    return back(reply, `/admin/connections/${id}`,
      action === "restart" ? "Reinício pedido. O QR aparece em alguns segundos." : "Desconexão pedida.");
  });

  // ---------------------------------------------------------------- Clients
  app.get("/admin/clients", async (request, reply) => {
    const rows = await queries.clients();
    return show(reply, request, {
      title: "Clientes",
      active: "clients",
      notice: noticeOf(request),
      body: html`
        <div class="panel">
          <table>
            <thead><tr><th>Cliente</th><th>Status</th><th>Tenants</th><th>Conexões</th><th>Chaves ativas</th><th>Criado</th></tr></thead>
            <tbody>
              ${rows.map((row) => html`<tr>
                <td><a href="/admin/clients/${row.id}">${row.name}</a><div class="muted mono">${row.slug}</div></td>
                <td>${badge(row.status)}</td>
                <td>${formatNumber(row.tenants)}</td>
                <td>${formatNumber(row.connected)} / ${formatNumber(row.live)}</td>
                <td>${formatNumber(row.keys)}</td>
                <td class="muted">${formatDate(row.created_at)}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <div class="panel">
          <h2 style="margin-top:0">Novo cliente integrador</h2>
          <form class="stack" method="post" action="/admin/clients">
            <input name="name" placeholder="Nome (ex.: Tendi)" required maxlength="100">
            <input name="slug" placeholder="slug (ex.: tendi)" required pattern="[a-z0-9][a-z0-9-]{1,62}">
            <button type="submit" class="primary">Criar cliente</button>
          </form>
        </div>`,
    });
  });

  app.post<{ Body: { name?: string; slug?: string } }>("/admin/clients", async (request, reply) => {
    const name = (request.body.name ?? "").trim().slice(0, 100);
    const slug = (request.body.slug ?? "").trim();
    if (!name || !SLUG.test(slug)) return back(reply, "/admin/clients", "Nome ou slug inválido.");
    const id = await queries.createClient(adminOf(), slug, name);
    if (!id) return back(reply, "/admin/clients", `O slug "${slug}" já existe.`);
    return back(reply, `/admin/clients/${id}`, "Cliente criado. Gere uma API key para ele.");
  });

  const clientPage = async (request: FastifyRequest, reply: FastifyReply, id: string, issued: { key: string } | null) => {
    const data = await queries.client(id);
    if (!data) return notFound(reply, request, "Cliente");
    const { client, tenants, keys } = data;
    return show(reply, request, {
      title: client.name,
      active: "clients",
      notice: noticeOf(request),
      body: html`
        <p class="muted">Slug <span class="mono">${client.slug}</span> · ${badge(client.status)} · criado em ${formatDate(client.created_at)}</p>
        ${issued ? html`
          <div class="panel">
            <h2 style="margin-top:0">Nova API key</h2>
            <p><strong>Copie agora: ela não aparece de novo.</strong> Guarde num gerenciador de senhas e não cole em conversas.</p>
            <div class="secret" id="new-key">${issued.key}</div>
            <div class="toolbar" style="margin-top:10px"><button type="button" data-copy="new-key">Copiar</button></div>
          </div>` : ""}
        <div class="panel">
          <h2 style="margin-top:0">API keys</h2>
          <table>
            <thead><tr><th>Prefixo</th><th>Rótulo</th><th>Criada</th><th>Último uso</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${keys.length === 0 ? html`<tr><td colspan="6" class="muted">Nenhuma chave.</td></tr>` : ""}
              ${keys.map((key) => html`<tr>
                <td class="mono">${key.key_prefix}</td>
                <td>${key.label}</td>
                <td class="muted">${formatDate(key.created_at)}</td>
                <td class="muted">${formatDate(key.last_used_at)}</td>
                <td>${key.revoked_at ? badge("revoked") : badge("active")}</td>
                <td>${key.revoked_at ? "" : html`
                  <form class="inline" method="post" action="/admin/clients/${client.id}/keys/${key.id}/revoke"
                    data-confirm="Revogar a chave ${key.key_prefix}? Quem usa essa chave para de funcionar na hora.">
                    <button type="submit" class="danger">Revogar</button>
                  </form>`}</td>
              </tr>`)}
            </tbody>
          </table>
          <form class="toolbar" method="post" action="/admin/clients/${client.id}/keys" style="margin-top:12px">
            <input name="label" placeholder="rótulo (ex.: tendi-production-3)" required maxlength="100">
            <button type="submit" class="primary">Gerar nova chave</button>
          </form>
        </div>
        <div class="panel">
          <h2 style="margin-top:0">Organizações (${formatNumber(tenants.length)})</h2>
          <table>
            <thead><tr><th>External id</th><th>Nome</th><th>Plano</th><th>Conexões</th><th>Comercial</th><th>Operacional</th></tr></thead>
            <tbody>
              ${tenants.length === 0 ? html`<tr><td colspan="6" class="muted">Nenhuma organização.</td></tr>` : ""}
              ${tenants.map((tenant) => html`<tr>
                <td class="mono"><a href="/admin/connections?client=${client.slug}">${tenant.external_id}</a></td>
                <td>${tenant.name}</td>
                <td>${tenant.plan_code ?? "—"}</td>
                <td>${formatNumber(tenant.live)} / ${formatNumber(tenant.max_connections)}</td>
                <td>${badge(tenant.commercial_status)}</td>
                <td>${badge(tenant.operational_status)}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>`,
    });
  };

  app.get<{ Params: { id: string } }>("/admin/clients/:id", async (request, reply) => {
    if (!UUID.test(request.params.id)) return notFound(reply, request, "Cliente");
    return clientPage(request, reply, request.params.id, null);
  });

  // The new key is rendered in the response (not redirected), so it never
  // travels in a URL and is shown exactly once.
  app.post<{ Params: { id: string }; Body: { label?: string } }>("/admin/clients/:id/keys", async (request, reply) => {
    if (!UUID.test(request.params.id)) return notFound(reply, request, "Cliente");
    const label = (request.body.label ?? "").trim().slice(0, 100);
    if (!label) return back(reply, `/admin/clients/${request.params.id}`, "Informe um rótulo para a chave.");
    const issued = await queries.issueKey(adminOf(), request.params.id, label);
    if (!issued) return notFound(reply, request, "Cliente");
    return clientPage(request, reply, request.params.id, issued);
  });

  app.post<{ Params: { id: string; keyId: string } }>(
    "/admin/clients/:id/keys/:keyId/revoke",
    async (request, reply) => {
      const { id, keyId } = request.params;
      if (!UUID.test(id) || !UUID.test(keyId)) return notFound(reply, request, "Chave");
      const revoked = await queries.revokeKey(adminOf(), id, keyId);
      return back(reply, `/admin/clients/${id}`, revoked ? "Chave revogada." : "A chave já estava revogada.");
    },
  );

  // ---------------------------------------------------------------- Webhooks
  app.get<{ Querystring: { show?: string; event?: string; q?: string; page?: string } }>("/admin/webhooks", async (request, reply) => {
    const scopes = [["problems", "Pendentes e problemas"], ["all", "Todas as entregas"],
      ["delivered", "Entregues"], ["pending", "Em fila"], ["failed", "Nova tentativa"], ["dead", "Desistidas"]] as const;
    const events = [["", "Todos os eventos"], ["message.received", "Mensagem recebida"],
      ["message.status", "Status de mensagem"], ["connection.status", "Status de conexão"]] as const;
    const selected = scopes.find(([value]) => value === request.query.show)?.[0] ?? "problems";
    const status = selected !== "all" && selected !== "problems" ? selected : undefined;
    const event = events.find(([value]) => value === request.query.event)?.[0] || undefined;
    const search = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) || undefined : undefined;
    const currentPage = typeof request.query.page === "string" && /^[1-9]\d{0,3}$/.test(request.query.page)
      ? Number(request.query.page) : 1;
    const href = (page: number) => {
      const params = new URLSearchParams();
      if (selected !== "problems") params.set("show", selected);
      if (event) params.set("event", event);
      if (search) params.set("q", search);
      if (page > 1) params.set("page", String(page));
      return `/admin/webhooks${params.size ? `?${params.toString()}` : ""}#deliveries`;
    };
    const [endpoints, found] = await Promise.all([
      queries.webhookEndpoints(),
      queries.deliveries(selected === "problems" ? "problems" : "all", { page: currentPage, status, event, search }),
    ]);
    const deliveries = found.slice(0, DELIVERY_PAGE_SIZE);
    const hasNext = found.length > DELIVERY_PAGE_SIZE;
    return show(reply, request, {
      title: "Webhooks",
      active: "webhooks",
      notice: noticeOf(request),
      body: html`
        <div class="panel">
          <h2 style="margin-top:0">Endpoints</h2>
          <div class="table-wrap"><table class="webhook-endpoints">
            <thead><tr><th>Cliente</th><th>Destino</th><th>Formato</th><th>Eventos</th><th>Status</th><th>Falhas</th><th></th></tr></thead>
            <tbody>
              ${endpoints.length === 0 ? html`<tr><td colspan="7" class="muted">Nenhum endpoint.</td></tr>` : ""}
              ${endpoints.map((endpoint) => html`<tr>
                <td>${endpoint.client_slug}${endpoint.tenant ? html`<div class="muted mono">${endpoint.tenant}</div>` : ""}</td>
                <td class="mono">${maskUrl(endpoint.url)}</td>
                <td>${endpoint.payload_format === "dapi" ? "Compatibilidade" : "On Connect"}</td>
                <td class="muted">${endpoint.event_types.length === 0 ? "todos" : endpoint.event_types.join(", ")}</td>
                <td>${badge(endpoint.status)}</td>
                <td>${formatNumber(endpoint.consecutive_failures)}${endpoint.failing_since
                  ? html`<div class="muted">desde ${formatDate(endpoint.failing_since)}</div>` : ""}</td>
                <td><a class="button compact" href="/admin/webhooks/endpoints/${endpoint.id}">Gerenciar</a></td>
              </tr>`)}
            </tbody>
          </table></div>
        </div>
        <section class="panel" id="deliveries">
          <div class="section-heading"><div><h2>Histórico de entregas</h2><p class="section-description">Cada evento gera um registro. Consulte o histórico por páginas ou filtre uma sessão.</p></div><a class="button compact" href="${href(currentPage)}">${icon("refresh")} Atualizar</a></div>
          <form class="toolbar delivery-filters" action="/admin/webhooks#deliveries" method="get">
            <label><span class="sr-only">Status das entregas</span><select name="show">${scopes.map(([value, label]) => html`<option value="${value}" ${value === selected ? html`selected` : ""}>${label}</option>`)}</select></label>
            <label><span class="sr-only">Tipo de evento</span><select name="event">${events.map(([value, label]) => html`<option value="${value}" ${value === (event ?? "") ? html`selected` : ""}>${label}</option>`)}</select></label>
            <label><span class="sr-only">Cliente ou sessão</span><input name="q" value="${search ?? ""}" maxlength="100" placeholder="Cliente ou sessão…"></label>
            <button class="button primary" type="submit">Filtrar</button><a class="button compact" href="/admin/webhooks#deliveries">Limpar</a>
          </form>
          <div class="list-summary"><span>Página ${formatNumber(currentPage)} · ${formatNumber(deliveries.length)} ${deliveries.length === 1 ? "registro" : "registros"}</span><span>${DELIVERY_PAGE_SIZE} registros por página</span></div>
          <div class="table-wrap delivery-table" tabindex="0" role="region" aria-label="Entregas de webhook da página atual"><table>
            <thead><tr><th>Quando</th><th>Cliente / sessão</th><th>Evento</th><th>Status</th><th>Tentativas</th><th>Resultado</th><th><span class="sr-only">Ações</span></th></tr></thead>
            <tbody>
              ${deliveries.length === 0 ? html`<tr><td colspan="7"><div class="empty-state">${icon("webhook")}<strong>Nenhuma entrega encontrada nesta página.</strong><span>Não há registros para os filtros selecionados. Consulte as outras páginas ou altere os filtros.</span></div></td></tr>` : ""}
              ${deliveries.map((delivery) => html`<tr>
                <td class="muted">${formatDate(delivery.updated_at)}</td>
                <td>${delivery.client_slug}<div class="muted mono">${delivery.session ?? ""}</div></td>
                <td class="mono">${delivery.event_type}</td>
                <td>${badge(delivery.status)}${delivery.status === "failed"
                  ? html`<div class="muted">próxima: ${formatDate(delivery.next_attempt_at)}</div>` : ""}</td>
                <td>${formatNumber(delivery.attempts)}</td>
                <td class="mono">${delivery.last_error ?? (delivery.last_status_code ? `HTTP ${delivery.last_status_code}` : "—")}</td>
                <td>${delivery.status === "failed" || delivery.status === "dead" ? html`
                  <form class="inline" method="post" action="/admin/webhooks/deliveries/${delivery.id}/resend">
                    <button type="submit">Reenviar</button>
                  </form>` : ""}</td>
              </tr>`)}
            </tbody>
          </table></div>
          <nav class="pagination" aria-label="Páginas do histórico de webhooks">
            ${currentPage > 1 ? html`<a class="button compact" rel="prev" href="${href(currentPage - 1)}">Anterior</a>` : html`<span class="button compact disabled" aria-disabled="true">Anterior</span>`}
            <span>Página ${formatNumber(currentPage)}</span>
            ${hasNext && currentPage < 9999 ? html`<a class="button compact" rel="next" href="${href(currentPage + 1)}">Próxima ${icon("arrow")}</a>` : html`<span class="button compact disabled" aria-disabled="true">Próxima</span>`}
          </nav>
        </section>`,
    });
  });

  app.post<{ Params: { id: string } }>("/admin/webhooks/deliveries/:id/resend", async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send("Not found");
    const done = await queries.resendDelivery(adminOf(), request.params.id);
    return back(reply, "/admin/webhooks", done ? "Entrega colocada para reenvio." : "Essa entrega não pode ser reenviada.");
  });

  app.get<{ Params: { id: string } }>("/admin/webhooks/endpoints/:id", async (request, reply) => {
    if (!UUID.test(request.params.id)) return notFound(reply, request, "Endpoint");
    const endpoint = await queries.webhookEndpoint(request.params.id);
    if (!endpoint) return notFound(reply, request, "Endpoint");
    return show(reply, request, {
      title: "Endpoint de webhook", active: "webhooks", notice: noticeOf(request),
      body: endpointPage(endpoint),
    });
  });

  app.post<{ Params: { id: string } }>("/admin/webhooks/endpoints/:id/pause", async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send("Not found");
    const done = await queries.pauseEndpoint(adminOf(), request.params.id);
    return back(reply, `/admin/webhooks/endpoints/${request.params.id}`,
      done ? "Endpoint pausado. As entregas ficam guardadas até reativar." : "Só um endpoint ativo pode ser pausado.");
  });

  // Checkboxes arrive as event_<type>=on; "all" means every event ([]).
  app.post<{ Params: { id: string }; Body: Record<string, string | undefined> }>(
    "/admin/webhooks/endpoints/:id/events",
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID.test(id)) return reply.code(404).send("Not found");
      const location = `/admin/webhooks/endpoints/${id}`;
      const chosen = request.body.mode === "all"
        ? []
        : WEBHOOK_EVENT_TYPES.filter((type) => request.body[`event_${type}`] === "on");
      if (request.body.mode !== "all" && chosen.length === 0) {
        return back(reply, location, "Escolha pelo menos um evento, ou marque \"Todos os eventos\".");
      }
      const done = await queries.setEndpointEvents(adminOf(), id, chosen);
      return back(reply, location, done
        ? "Eventos atualizados."
        : "Os eventos deste endpoint são definidos pela camada de compatibilidade e não podem ser mudados aqui.");
    },
  );

  app.post<{ Params: { id: string } }>("/admin/webhooks/endpoints/:id/reactivate", async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send("Not found");
    const done = await queries.reactivateEndpoint(adminOf(), request.params.id);
    return back(reply, `/admin/webhooks/endpoints/${request.params.id}`,
      done ? "Endpoint reativado. As entregas que esperavam saem agora." : "O endpoint já estava ativo.");
  });

  app.setNotFoundHandler((request, reply) => {
    void notFound(reply, request, "Página");
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "admin request failed");
    void reply.code(500).type("text/html; charset=utf-8").send(page({
      title: "Erro", active: "dashboard", user: adminOf().name,
      body: html`<p>Algo deu errado. Veja os logs do serviço <span class="mono">admin</span> (request ${request.id}).</p>`,
    }));
  });

  return app;
}
