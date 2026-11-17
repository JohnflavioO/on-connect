import { timingSafeEqual } from "node:crypto";
import { QR_TTL_SECONDS, loggerOptions, type SessionGateway } from "@on-connect/core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { CSS, JS } from "./assets.js";
import { connectionTable, dashboardView } from "./dashboard.js";
import { badge, formatDate, formatNumber, formatPhone, html, icon, maskUrl, page } from "./html.js";
import { DELIVERY_PAGE_SIZE, type Admin, type AdminQueries } from "./queries.js";

export interface AdminAppOptions {
  queries: AdminQueries;
  sessions: Pick<SessionGateway, "start" | "logout" | "currentQr">;
  /** Caddy adds it to every proxied request; anything without it is refused. */
  proxySecret: string;
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
 * The super-admin panel (server-rendered HTML under /admin). It trusts no
 * request that did not come through Caddy (proxy secret), and accepts state
 * changes only from its own pages (Origin check), since the browser re-sends
 * basic-auth credentials on any cross-site form post.
 */
export async function buildAdminApp(options: AdminAppOptions): Promise<FastifyInstance> {
  const { queries, sessions } = options;
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
    if (!sameSecret(request.headers["x-onconnect-admin-secret"] as string | undefined, options.proxySecret)) {
      // Not through Caddy: answer as if the panel did not exist.
      return reply.code(404).send("Not found");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const from = request.headers.origin;
      if (from !== origin) {
        request.log.warn({ origin: from }, "admin form from another origin refused");
        return reply.code(403).send("Forbidden");
      }
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

  const adminOf = (request: FastifyRequest): Admin => {
    const user = request.headers["x-onconnect-admin-user"];
    return { name: typeof user === "string" && user ? user.slice(0, 100) : "admin" };
  };

  const show = (reply: FastifyReply, request: FastifyRequest, options2: Omit<Parameters<typeof page>[0], "user">) =>
    reply.type("text/html; charset=utf-8").send(page({ ...options2, user: adminOf(request).name }));

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

  app.get<{ Params: { id: string } }>("/admin/connections/:id", async (request, reply) => {
    if (!UUID.test(request.params.id)) return notFound(reply, request, "Conexão");
    const row = await queries.connection(request.params.id);
    if (!row) return notFound(reply, request, "Conexão");
    const action = (path: string, label: string, confirm: string, tone = "") => html`
      <form class="inline" method="post" action="/admin/connections/${row.id}/${path}" data-confirm="${confirm}">
        <button type="submit" class="${tone}">${label}</button>
      </form>`;
    return show(reply, request, {
      title: row.session_key ?? row.tenant,
      active: "connections",
      notice: noticeOf(request),
      body: html`
        <div class="grid-2">
          <div class="panel">
            <table>
              <tr><th>Status</th><td>${badge(row.status)} <span class="muted mono">${row.status_reason ?? ""}</span></td></tr>
              <tr><th>Número</th><td>${formatPhone(row.display_phone_number)} <span class="muted">${row.verified_name ?? ""}</span></td></tr>
              <tr><th>Cliente</th><td><a href="/admin/clients/${row.client_id}">${row.client_slug}</a></td></tr>
              <tr><th>Organização</th><td class="mono">${row.tenant}</td></tr>
              <tr><th>Sessão</th><td class="mono">${row.session_key ?? "—"}</td></tr>
              <tr><th>Conexão</th><td class="mono">${row.id}</td></tr>
              <tr><th>Desde</th><td>${formatDate(row.status_changed_at)}</td></tr>
              <tr><th>7 dias</th><td>${formatNumber(row.sent7)} enviadas · ${formatNumber(row.received7)} recebidas</td></tr>
            </table>
            <div class="toolbar" style="margin-top:14px">
              ${action("restart", "Reiniciar / gerar QR", "Reiniciar esta conexão?")}
              ${action("logout", "Desconectar número", "Desconectar o WhatsApp deste número? Será preciso ler o QR de novo.", "danger")}
            </div>
          </div>
          <div class="panel">
            <h2 style="margin-top:0">QR code</h2>
            <p class="muted">Status: <strong data-qr-status>${badge(row.status)}</strong></p>
            <div class="qr" data-qr-url="/admin/connections/${row.id}/qr.json"><div class="empty">Carregando…</div></div>
            <p class="muted">Atualiza sozinho. O QR expira em cerca de ${QR_TTL_SECONDS} s; se sumir, use "Reiniciar".</p>
          </div>
        </div>`,
    });
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
    await queries.auditConnection(adminOf(request), row.client_id, id,
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
    const id = await queries.createClient(adminOf(request), slug, name);
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
    const issued = await queries.issueKey(adminOf(request), request.params.id, label);
    if (!issued) return notFound(reply, request, "Cliente");
    return clientPage(request, reply, request.params.id, issued);
  });

  app.post<{ Params: { id: string; keyId: string } }>(
    "/admin/clients/:id/keys/:keyId/revoke",
    async (request, reply) => {
      const { id, keyId } = request.params;
      if (!UUID.test(id) || !UUID.test(keyId)) return notFound(reply, request, "Chave");
      const revoked = await queries.revokeKey(adminOf(request), id, keyId);
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
                <td>${endpoint.status === "active" ? "" : html`
                  <form class="inline" method="post" action="/admin/webhooks/endpoints/${endpoint.id}/reactivate"
                    data-confirm="Reativar este endpoint e reenviar o que estava esperando?">
                    <button type="submit">Reativar</button>
                  </form>`}</td>
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
    const done = await queries.resendDelivery(adminOf(request), request.params.id);
    return back(reply, "/admin/webhooks", done ? "Entrega colocada para reenvio." : "Essa entrega não pode ser reenviada.");
  });

  app.post<{ Params: { id: string } }>("/admin/webhooks/endpoints/:id/reactivate", async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send("Not found");
    const done = await queries.reactivateEndpoint(adminOf(request), request.params.id);
    return back(reply, "/admin/webhooks", done ? "Endpoint reativado." : "O endpoint já estava ativo.");
  });

  app.setNotFoundHandler((request, reply) => {
    void notFound(reply, request, "Página");
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "admin request failed");
    void reply.code(500).type("text/html; charset=utf-8").send(page({
      title: "Erro", active: "dashboard", user: adminOf(request).name,
      body: html`<p>Algo deu errado. Veja os logs do serviço <span class="mono">admin</span> (request ${request.id}).</p>`,
    }));
  });

  return app;
}
