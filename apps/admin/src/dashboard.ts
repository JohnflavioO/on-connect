import { badge, formatDate, formatNumber, formatPhone, html, icon, type Html, type IconName } from "./html.js";
import type { AdminQueries } from "./queries.js";

type Dashboard = Awaited<ReturnType<AdminQueries["dashboard"]>>;
export type ConnectionRow = Awaited<ReturnType<AdminQueries["connections"]>>[number];
const REASONS: Record<string, string> = {
  waiting_for_scan: "Aguardando leitura do QR", qr_expired: "QR Code expirado",
  logged_out: "Número desconectado", deleted_by_client: "Removida pelo cliente",
  restart_required: "Reconexão necessária", replaced: "Sessão substituída",
};
const count = (value: string | number | undefined) => Math.max(0, Number(value) || 0);

/**
 * Change against the previous period of the same length ("+12,5% vs. período
 * anterior"). Nothing before and something now reads "novo"; nothing in both
 * reads "sem movimento".
 */
export function trend(current: number, previous: number): { text: string; tone: "up" | "down" | "flat" } {
  if (previous === 0) return current === 0 ? { text: "sem movimento", tone: "flat" } : { text: "novo no período", tone: "up" };
  const change = Math.round(((current - previous) / previous) * 1000) / 10;
  if (change === 0) return { text: "0%", tone: "flat" };
  const formatted = Math.abs(change).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  return change > 0 ? { text: `+${formatted}%`, tone: "up" } : { text: `−${formatted}%`, tone: "down" };
}

export function connectionTable(rows: ConnectionRow[], empty = "Nenhuma conexão encontrada."): Html {
  return html`<div class="table-wrap"><table class="connections-table">
    <thead><tr><th>Sessão / número</th><th>Cliente</th><th>Status</th><th>Última alteração</th><th><span class="sr-only">Ações</span></th></tr></thead>
    <tbody>${rows.length === 0 ? html`<tr><td colspan="5"><div class="empty-state">${icon("connection")}<strong>${empty}</strong><span>As conexões dos seus clientes aparecem aqui.</span></div></td></tr>` : rows.map((row) => html`<tr>
      <td><a class="session-link" href="/admin/connections/${row.id}"><span class="session-avatar">${icon("connection")}</span><span class="session-info"><strong title="${row.session_key ?? row.tenant}">${row.session_key ?? row.tenant}</strong><small>${formatPhone(row.display_phone_number)}${row.verified_name ? html` · ${row.verified_name}` : ""}</small></span></a></td>
      <td><a class="client-label" href="/admin/clients/${row.client_id}">${row.client_slug}</a></td>
      <td>${badge(row.status)}${row.status_reason ? html`<div class="status-reason">${REASONS[row.status_reason] ?? row.status_reason}</div>` : ""}</td>
      <td class="table-date">${formatDate(row.status_changed_at)}</td>
      <td><a class="icon-button" href="/admin/connections/${row.id}" aria-label="Abrir conexão ${row.session_key ?? row.tenant}">${icon("arrow")}</a></td>
    </tr>`)}</tbody>
  </table></div>`;
}

function chart(days: Dashboard["days"]): Html {
  const max = Math.max(1, ...days.flatMap((d) => [count(d.sent), count(d.received)]));
  const ceiling = Math.max(4, Math.ceil(max / 4) * 4);
  const date = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });
  const x = (i: number) => Math.round(42 + i * 712 / Math.max(1, days.length - 1));
  const y = (value: string) => Math.round(184 - count(value) / ceiling * 150);
  const series = (key: "sent" | "received", label: string) => {
    const points = days.map((d, i) => `${x(i)},${y(d[key])}`).join(" ");
    const area = days.length ? `M ${x(0)} 184 L ${points.replaceAll(",", " ")} L ${x(days.length - 1)} 184 Z` : "";
    return html`<g data-chart-line="${key}">
      <path d="${area}" fill="url(#${key}-fill)"/>
      <polyline class="chart-line ${key}" points="${points}"/>
      ${days.map((d, i) => html`<circle class="chart-point ${key}" cx="${x(i)}" cy="${y(d[key])}" r="3"><title>${d.day}: ${formatNumber(d[key])} ${label}</title></circle>`)}
    </g>`;
  };
  return html`<svg class="volume-chart" viewBox="0 0 800 225" role="img" aria-labelledby="chart-title chart-description">
    <title id="chart-title">Mensagens enviadas e recebidas por dia</title>
    <desc id="chart-description">Contagens no horário de São Paulo. A tabela abaixo contém os valores de cada dia.</desc>
    <defs><linearGradient id="sent-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#42d9c8" stop-opacity=".18"/><stop offset="100%" stop-color="#42d9c8" stop-opacity="0"/></linearGradient>
      <linearGradient id="received-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#8c86f6" stop-opacity=".12"/><stop offset="100%" stop-color="#8c86f6" stop-opacity="0"/></linearGradient></defs>
    ${[0, 1, 2, 3, 4].map((tick) => html`<g><line class="chart-grid" x1="42" x2="774" y1="${184 - tick * 37.5}" y2="${184 - tick * 37.5}"/><text class="chart-tick" x="30" y="${188 - tick * 37.5}" text-anchor="end">${formatNumber(tick * ceiling / 4)}</text></g>`)}
    ${series("received", "recebidas")}${series("sent", "enviadas")}
    ${days.map((d, i) => i === 0 || i === days.length - 1 || i % Math.max(1, Math.ceil(days.length / 7)) === 0
      ? html`<text class="chart-tick chart-day" data-mobile-visible="${i === 0 || i === days.length - 1 || i % Math.max(1, Math.ceil(days.length / 3)) === 0 ? "true" : "false"}" x="${x(i)}" y="212" text-anchor="middle">${date.format(new Date(`${d.day}T12:00:00Z`))}</text>` : "")}
  </svg>
  <details class="chart-details"><summary>Ver dados por dia</summary><div class="table-wrap"><table><caption class="sr-only">Volume diário de mensagens</caption><thead><tr><th>Dia</th><th>Enviadas</th><th>Recebidas</th></tr></thead><tbody>${days.map((d) => html`<tr><td>${date.format(new Date(`${d.day}T12:00:00Z`))}</td><td>${formatNumber(d.sent)}</td><td>${formatNumber(d.received)}</td></tr>`)}</tbody></table></div></details>`;
}

export function dashboardView(data: Dashboard, rows: ConnectionRow[], period: 7 | 14 | 30): Html {
  const t = data.totals;
  const connected = count(t?.connected);
  const live = count(t?.live);
  const disconnected = Math.max(0, live - connected);
  const pending = count(t?.pending);
  const dead = count(t?.dead24);
  const disabled = count(t?.disabled);
  const sent = count(t?.sent7);
  const received = count(t?.received7);
  const ratio = live ? Math.min(100, Math.round(connected / live * 100)) : 0;
  const metric = (label: string, value: number, description: string, symbol: IconName, tone: string, href: string,
    previous?: number) => {
    const change = previous === undefined ? null : trend(value, previous);
    return html`
    <a class="metric-card" href="${href}"><div class="metric-top"><span class="metric-icon ${tone}">${icon(symbol)}</span>${icon("arrow")}</div>
      <span class="metric-label">${label}</span><strong class="metric-value">${formatNumber(value)}</strong><span class="metric-description">${change
        ? html`<span class="metric-trend ${change.tone}">${change.text}</span> vs. ${period} dias anteriores` : description}</span></a>`;
  };
  const recent = [...rows].sort((a, b) => b.status_changed_at.getTime() - a.status_changed_at.getTime()).slice(0, 5);
  return html`
    <section class="overview-intro"><div><h2>Uma visão clara da sua operação.</h2><p>Acompanhe suas conexões, o tráfego de mensagens e as entregas aos seus clientes.</p></div>
      <div class="intro-actions"><a class="button" href="/admin?days=${period}">${icon("refresh")} Atualizar</a><a class="button primary" href="/admin/connections">${icon("connection")} Gerenciar conexões</a></div></section>
    <div class="metrics-grid">
      ${metric("Conexões ativas", connected, `${formatNumber(live)} conexões cadastradas`, "connection", "teal", "/admin/connections?status=connected")}
      ${metric(`Enviadas · ${period} dias`, sent, `Últimos ${period} dias`, "send", "blue", "/admin/messages?direction=outbound", count(t?.sent_prev))}
      ${metric(`Recebidas · ${period} dias`, received, `Últimos ${period} dias`, "inbox", "violet", "/admin/messages?direction=inbound", count(t?.received_prev))}
      ${metric("Clientes ativos", count(t?.clients), `${formatNumber(t?.tenants ?? 0)} organizações na plataforma`, "users", "amber", "/admin/clients")}
    </div>
    <div class="dashboard-grid">
      <section class="panel volume-panel" id="message-volume"><div class="section-heading"><div><p class="eyebrow">TRÁFEGO</p><h2>Volume de mensagens</h2><p class="section-description">${formatNumber(sent + received)} mensagens nos últimos ${period} dias</p></div>
        <form class="period-form" action="/admin" method="get"><label class="sr-only" for="dashboard-period">Período do gráfico</label><select id="dashboard-period" name="days">${([7, 14, 30] as const).map((n) => html`<option value="${n}" ${n === period ? html`selected` : ""}>Últimos ${n} dias</option>`)}</select><button type="submit" class="button compact">Aplicar</button></form></div>
        <div class="chart-legend"><button type="button" data-chart-toggle="sent" aria-pressed="true"><i class="legend-dot sent"></i>Enviadas <strong>${formatNumber(sent)}</strong></button><button type="button" data-chart-toggle="received" aria-pressed="true"><i class="legend-dot received"></i>Recebidas <strong>${formatNumber(received)}</strong></button></div>
        ${chart(data.days)}
        <div class="chart-footnote">${icon("activity")} Dados por dia · Horário de São Paulo</div>
      </section>
      <aside class="dashboard-aside"><section class="panel availability-panel"><div class="section-heading"><div><p class="eyebrow">CONECTIVIDADE</p><h2>Visão das conexões</h2></div>${icon("connection")}</div>
        <div class="availability"><svg viewBox="0 0 120 120" class="availability-ring" role="img" aria-label="${formatNumber(connected)} de ${formatNumber(live)} conexões ativas"><circle class="ring-track" cx="60" cy="60" r="47"/><circle class="ring-value" cx="60" cy="60" r="47" pathLength="100" stroke-dasharray="${ratio} 100"/><text x="60" y="58" text-anchor="middle" class="ring-number">${formatNumber(connected)}</text><text x="60" y="75" text-anchor="middle" class="ring-label">conectadas</text></svg><div class="availability-labels"><div><i class="status-dot"></i>Ativas <strong>${formatNumber(connected)}</strong></div><div><i class="status-dot inactive"></i>Outros status <strong>${formatNumber(disconnected)}</strong></div><p>${live ? `${ratio}% das conexões estão ativas` : "Nenhuma conexão cadastrada"}</p></div></div>
        <a class="text-link" href="/admin/connections">Ver todas as conexões ${icon("arrow")}</a></section>
        <section class="panel webhook-summary"><div class="section-heading"><div><p class="eyebrow">INTEGRAÇÕES</p><h2>Entregas de webhook</h2></div><span class="metric-icon violet">${icon("webhook")}</span></div>
          <div class="queue-number">${formatNumber(pending)}<span>aguardando entrega</span></div>
          <div class="delivery-status"><span>Desistidas em 24 h</span><strong class="${dead ? "warn-text" : ""}">${formatNumber(dead)}</strong></div>
          <div class="delivery-status"><span>Endpoints desativados</span><strong class="${disabled ? "warn-text" : ""}">${formatNumber(disabled)}</strong></div>
          <a class="webhook-note ${dead || disabled ? "attention" : ""}" href="/admin/webhooks">${icon(dead || disabled ? "alert" : "check")}<span>${dead || disabled ? "Há entregas ou endpoints para revisar" : pending ? "Acompanhe o processamento da fila" : "Nenhuma entrega aguardando na fila"}</span>${icon("arrow")}</a></section></aside>
    </div>
    <section class="panel recent-connections"><div class="section-heading"><div><p class="eyebrow">SESSÕES</p><h2>Conexões recentes</h2><p class="section-description">Últimas alterações de status entre as conexões listadas</p></div><a class="button compact" href="/admin/connections">Ver todas ${icon("arrow")}</a></div>
      ${connectionTable(recent, "Suas conexões começam aqui.")}</section>
    <div class="quick-links"><a href="/admin/clients">${icon("users")}<span><strong>Clientes e credenciais</strong><small>Gerencie integrações e chaves de API</small></span>${icon("arrow")}</a><a href="/admin/webhooks">${icon("webhook")}<span><strong>Central de webhooks</strong><small>Acompanhe entregas e novas tentativas</small></span>${icon("arrow")}</a></div>`;
}
