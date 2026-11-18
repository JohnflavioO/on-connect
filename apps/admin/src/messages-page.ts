import { badge, formatDate, formatNumber, html, icon, maskUrl, type Html } from "./html.js";
import { MESSAGE_PAGE_SIZE, type AdminQueries, type MessageFilters } from "./queries.js";

/**
 * "Mensagens": the message log as metadata only (when, session, direction,
 * kind, status). The text and media are never loaded, and the other party's
 * number is shown with its middle hidden; typing the full number in the
 * search still finds it.
 */

export type MessageRow = Awaited<ReturnType<AdminQueries["messages"]>>[number];

export const MESSAGE_STATUSES = ["queued", "sending", "sent", "delivered", "read", "failed", "received"] as const;

const STATUS_LABELS: Record<string, [string, string]> = {
  queued: ["Na fila", "muted"], sending: ["Enviando", "warn"], sent: ["Enviada", "ok"],
  delivered: ["Entregue", "ok"], read: ["Lida", "ok"], failed: ["Falhou", "bad"], received: ["Recebida", "ok"],
};

const TYPE_LABELS: Record<string, string> = {
  text: "Texto", image: "Imagem", video: "Vídeo", audio: "Áudio", ptt: "Áudio", voice: "Áudio",
  document: "Documento", sticker: "Figurinha", location: "Localização", contact: "Contato",
  contacts: "Contato", reaction: "Reação", template: "Modelo", interactive: "Interativa", button: "Botão",
};

/** "+55 (85) •••••-2494": enough to recognize a number, not to copy it. */
export function maskPhone(digits: string): string {
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  if (br) return `+55 (${br[1]}) ${"•".repeat(br[2]?.length ?? 4)}-${br[3]}`;
  if (digits.length <= 6) return `+${"•".repeat(digits.length)}`;
  return `+${digits.slice(0, 2)}${"•".repeat(digits.length - 6)}${digits.slice(-4)}`;
}

function statusBadge(status: string): Html {
  const [label, tone] = STATUS_LABELS[status] ?? [status, "muted"];
  return html`<span class="badge ${tone}">${label}</span>`;
}

export function messagesView(rows: MessageRow[], filters: MessageFilters, page: number, hasNext: boolean,
  href: (changes: Partial<MessageFilters>) => string): Html {
  const directions = [["", "Todas"], ["inbound", "Recebidas"], ["outbound", "Enviadas"]] as const;
  return html`
    <section class="overview-intro"><div><h2>O que passou pelas suas conexões.</h2><p>Quem, quando e em que estado: o conteúdo das mensagens não aparece aqui.</p></div><a class="button" href="${href({})}">${icon("refresh")} Atualizar</a></section>
    <div class="connection-tabs" role="navigation" aria-label="Filtrar por direção">${directions.map(([value, label]) => html`<a class="${(filters.direction ?? "") === value ? "selected" : ""}" href="${href({ direction: value || undefined, page: 1 })}" ${(filters.direction ?? "") === value ? html`aria-current="page"` : ""}>${label}</a>`)}</div>
    <section class="panel connections-panel">
      <form class="connection-search" method="get" action="/admin/messages">
        ${filters.direction ? html`<input type="hidden" name="direction" value="${filters.direction}">` : ""}
        ${filters.connection ? html`<input type="hidden" name="connection" value="${filters.connection}">` : ""}
        <label class="search-input">${icon("search")}<span class="sr-only">Buscar sessão, cliente ou número completo</span><input name="q" placeholder="Sessão, cliente ou número completo…" value="${filters.search ?? ""}" maxlength="100"></label>
        <label><span class="sr-only">Status</span><select name="status"><option value="">Todos os status</option>${MESSAGE_STATUSES.map((value) => html`<option value="${value}" ${filters.status === value ? html`selected` : ""}>${STATUS_LABELS[value]?.[0] ?? value}</option>`)}</select></label>
        <button type="submit" class="button primary">Filtrar</button>${filters.search || filters.status || filters.direction || filters.connection ? html`<a class="button compact" href="/admin/messages">Limpar</a>` : ""}
      </form>
      ${filters.connection ? html`<p class="muted filter-note">Mostrando só uma conexão. <a href="${href({ connection: undefined, page: 1 })}">Ver todas</a></p>` : ""}
      <div class="list-summary"><span>Página ${formatNumber(page)} · ${formatNumber(rows.length)} ${rows.length === 1 ? "mensagem" : "mensagens"}</span><span>${MESSAGE_PAGE_SIZE} por página · mais recentes primeiro</span></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Mensagens da página atual"><table class="messages-table">
        <thead><tr><th>Quando</th><th>Direção</th><th>Sessão / cliente</th><th>Contato</th><th>Tipo</th><th>Status</th></tr></thead>
        <tbody>
          ${rows.length === 0 ? html`<tr><td colspan="6"><div class="empty-state">${icon("inbox")}<strong>Nenhuma mensagem encontrada.</strong><span>Altere os filtros ou volte para a primeira página.</span></div></td></tr>` : ""}
          ${rows.map((row) => html`<tr>
            <td class="table-date">${formatDate(row.created_at)}</td>
            <td><span class="direction ${row.direction}">${icon(row.direction === "inbound" ? "inbox" : "send")}${row.direction === "inbound" ? "Recebida" : "Enviada"}</span></td>
            <td><a href="/admin/connections/${row.connection_id}" class="mono">${row.session}</a><div class="muted">${row.client_slug}</div></td>
            <td class="mono">${maskPhone(row.counterpart)}</td>
            <td>${TYPE_LABELS[row.message_type] ?? row.message_type}</td>
            <td>${statusBadge(row.status)}${row.error_code ? html`<div class="muted mono">${row.error_code}</div>` : ""}</td>
          </tr>`)}
        </tbody>
      </table></div>
      <nav class="pagination" aria-label="Páginas de mensagens">
        ${page > 1 ? html`<a class="button compact" rel="prev" href="${href({ page: page - 1 })}">Anterior</a>` : html`<span class="button compact disabled" aria-disabled="true">Anterior</span>`}
        <span>Página ${formatNumber(page)}</span>
        ${hasNext && page < 9999 ? html`<a class="button compact" rel="next" href="${href({ page: page + 1 })}">Próxima ${icon("arrow")}</a>` : html`<span class="button compact disabled" aria-disabled="true">Próxima</span>`}
      </nav>
    </section>`;
}

/** Results of the global search, grouped by kind. */
export function searchView(term: string, found: Awaited<ReturnType<AdminQueries["search"]>>): Html {
  const total = found.connections.length + found.clients.length + found.endpoints.length;
  const group = (title: string, count: number, items: Html[]) => count === 0 ? "" : html`
    <section class="panel search-group"><div class="section-heading"><div><h2>${title}</h2></div><span class="muted">${formatNumber(count)}</span></div>
      <ul class="search-results">${items}</ul></section>`;
  return html`
    <form class="connection-search search-page-form" method="get" action="/admin/search">
      <label class="search-input">${icon("search")}<span class="sr-only">Buscar</span><input name="q" value="${term}" maxlength="100" placeholder="Sessão, número, cliente ou endpoint…"></label>
      <button type="submit" class="button primary">Buscar</button>
    </form>
    ${!term ? html`<div class="panel"><div class="empty-state">${icon("search")}<strong>Digite o que procura.</strong><span>Sessões, números, nomes do WhatsApp, clientes e destinos de webhook. Atalho: Ctrl+K em qualquer tela.</span></div></div>`
      : total === 0 ? html`<div class="panel"><div class="empty-state">${icon("search")}<strong>Nada encontrado para "${term}".</strong><span>Para mensagens de um número, use a busca da página <a href="/admin/messages?q=${encodeURIComponent(term)}">Mensagens</a>.</span></div></div>`
      : html`
        ${group("Conexões", found.connections.length, found.connections.map((row) => html`<li><a href="/admin/connections/${row.id}">${icon("connection")}<span><strong>${row.session_key ?? row.tenant}</strong><small>${row.client_slug}${row.verified_name ? html` · ${row.verified_name}` : ""}</small></span>${badge(row.status)}</a></li>`))}
        ${group("Clientes", found.clients.length, found.clients.map((row) => html`<li><a href="/admin/clients/${row.id}">${icon("users")}<span><strong>${row.name}</strong><small class="mono">${row.slug}</small></span>${badge(row.status)}</a></li>`))}
        ${group("Endpoints de webhook", found.endpoints.length, found.endpoints.map((row) => html`<li><a href="/admin/webhooks/endpoints/${row.id}">${icon("webhook")}<span><strong>${row.client_slug}${row.tenant ? html` · ${row.tenant}` : ""}</strong><small class="mono">${maskUrl(row.url)}</small></span>${badge(row.status)}</a></li>`))}
        <p class="muted">Até 20 resultados por grupo.</p>`}`;
}

