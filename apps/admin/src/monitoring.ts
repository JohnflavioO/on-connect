import { badge, formatDate, formatNumber, html, icon, type Html, type IconName } from "./html.js";
import {
  MONITORING_WINDOWS,
  type MonitoringBucket,
  type MonitoringPeriod,
  type MonitoringTotals,
} from "./queries.js";

/**
 * The "Monitoramento" page: is the platform healthy right now, and how did
 * traffic and failures move in the chosen window. Health rules live in
 * `evaluateHealth` (pure, tested); the rest only renders.
 */

export type Tone = "ok" | "warn" | "bad" | "idle";

export interface HealthCard {
  key: "connections" | "sending" | "webhooks" | "receiving";
  label: string;
  icon: IconName;
  tone: Tone;
  value: string;
  detail: string;
  href: string;
}

export interface Alert {
  tone: "warn" | "bad";
  text: string;
  href: string;
}

const n = (value: string | number | null | undefined) => Math.max(0, Number(value) || 0);
const percent = (part: number, total: number) => (total ? Math.round((part / total) * 1000) / 10 : 0);
const pct = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

/** Time since an instant, in words ("há 3 min"). */
export function ago(at: Date | null, now = new Date()): string {
  if (!at) return "nunca";
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} dias`;
}

export function evaluateHealth(t: MonitoringTotals, period: MonitoringPeriod, now = new Date()) {
  const label = MONITORING_WINDOWS[period].label.toLowerCase();
  const live = n(t.live);
  const connected = n(t.connected);
  const drops = n(t.drops);
  const sent = n(t.sent);
  const sendFailed = n(t.send_failed);
  const stuck = n(t.send_stuck);
  const delivered = n(t.delivered);
  const retrying = n(t.retrying);
  const dead = n(t.dead);
  const disabled = n(t.disabled_endpoints);
  const attempts = delivered + retrying + dead;
  const success = percent(delivered, attempts);
  const sendFailRate = percent(sendFailed, sent + sendFailed);

  const connections: HealthCard = {
    key: "connections", label: "Conexões", icon: "connection", href: "/admin/connections",
    value: `${formatNumber(connected)}/${formatNumber(live)}`,
    tone: live === 0 ? "idle" : connected === 0 ? "bad" : connected < live ? "warn" : "ok",
    detail: live === 0 ? "Nenhuma conexão cadastrada"
      : connected === live ? "Todas conectadas"
      : `${formatNumber(live - connected)} fora do ar agora`,
  };
  if (drops > 0) connections.detail += ` · ${formatNumber(drops)} ${drops === 1 ? "queda" : "quedas"} no período`;

  const sending: HealthCard = {
    key: "sending", label: "Envios", icon: "send", href: "/admin/connections",
    value: sent + sendFailed === 0 ? "—" : pct(100 - sendFailRate),
    tone: sent + sendFailed === 0 && stuck === 0 ? "idle"
      : sendFailRate >= 5 || stuck >= 10 ? "bad"
      : sendFailed > 0 || stuck > 0 ? "warn" : "ok",
    detail: sent + sendFailed === 0 && stuck === 0 ? "Sem envios no período"
      : `${formatNumber(sent)} enviadas · ${formatNumber(sendFailed)} com falha${stuck ? ` · ${formatNumber(stuck)} presas na fila` : ""}`,
  };

  const webhooks: HealthCard = {
    key: "webhooks", label: "Webhooks", icon: "webhook", href: "/admin/webhooks",
    value: attempts === 0 ? "—" : pct(success),
    tone: disabled > 0 ? "bad"
      : attempts === 0 ? "idle"
      : success < 90 ? "bad" : success < 99 || dead > 0 ? "warn" : "ok",
    detail: attempts === 0 && disabled === 0 ? "Sem entregas no período"
      : `${formatNumber(delivered)} entregues${retrying ? ` · ${formatNumber(retrying)} tentando de novo` : ""}${dead ? ` · ${formatNumber(dead)} desistidas` : ""}${
        t.delivery_ms !== null && delivered ? ` · ${formatNumber(n(t.delivery_ms))} ms em média` : ""}`,
  };

  const lastReceived = t.last_received_at;
  const receiving: HealthCard = {
    key: "receiving", label: "Recebimento", icon: "inbox", href: "/admin",
    value: formatNumber(n(t.received)),
    tone: n(t.received) > 0 ? "ok" : "idle",
    detail: `mensagens recebidas · última ${ago(lastReceived, now)}`,
  };

  const alerts: Alert[] = [];
  if (live > 0 && connected === 0) {
    alerts.push({ tone: "bad", text: "Nenhuma conexão está conectada. Nenhuma mensagem entra ou sai.", href: "/admin/connections" });
  } else if (connected < live) {
    alerts.push({ tone: "warn", text: `${formatNumber(live - connected)} de ${formatNumber(live)} conexões estão fora do ar.`, href: "/admin/connections?status=disconnected" });
  }
  if (disabled > 0) {
    alerts.push({ tone: "bad", text: `${formatNumber(disabled)} ${disabled === 1 ? "endpoint de webhook foi desativado" : "endpoints de webhook foram desativados"} por falhas: o cliente parou de receber eventos.`, href: "/admin/webhooks" });
  }
  if (attempts > 0 && success < 90) {
    alerts.push({ tone: "bad", text: `Só ${pct(success)} das entregas de webhook deram certo (${label}). Confira se o endpoint do cliente está respondendo.`, href: "/admin/webhooks" });
  } else if (dead > 0) {
    alerts.push({ tone: "warn", text: `${formatNumber(dead)} ${dead === 1 ? "entrega de webhook foi abandonada" : "entregas de webhook foram abandonadas"} (${label}).`, href: "/admin/webhooks?show=dead" });
  }
  if (sendFailRate >= 5) {
    alerts.push({ tone: "bad", text: `${pct(sendFailRate)} dos envios falharam (${label}).`, href: "/admin/connections" });
  } else if (sendFailed > 0) {
    alerts.push({ tone: "warn", text: `${formatNumber(sendFailed)} ${sendFailed === 1 ? "envio falhou" : "envios falharam"} (${label}).`, href: "/admin/connections" });
  }
  if (stuck > 0) {
    alerts.push({ tone: stuck >= 10 ? "bad" : "warn", text: `${formatNumber(stuck)} ${stuck === 1 ? "mensagem está presa" : "mensagens estão presas"} na fila há mais de 5 minutos.`, href: "/admin/connections" });
  }
  alerts.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));

  return { cards: [connections, sending, webhooks, receiving], alerts };
}

const TONE_LABELS: Record<Tone, string> = { ok: "Saudável", warn: "Atenção", bad: "Crítico", idle: "Sem dados" };

function bucketLabel(at: Date, period: MonitoringPeriod): string {
  const options: Intl.DateTimeFormatOptions = period === "1h" || period === "24h"
    ? { hour: "2-digit", minute: "2-digit" }
    : period === "7d" ? { day: "2-digit", month: "2-digit", hour: "2-digit" } : { day: "2-digit", month: "2-digit" };
  return new Intl.DateTimeFormat("pt-BR", { ...options, timeZone: "America/Sao_Paulo" }).format(at);
}

interface Series {
  key: keyof Omit<MonitoringBucket, "at">;
  label: string;
  color: string;
}

/** Line chart (traffic) or stacked-free bars (failures) over the buckets. */
function chart(buckets: MonitoringBucket[], period: MonitoringPeriod, series: Series[], kind: "line" | "bar", title: string): Html {
  const max = Math.max(1, ...buckets.flatMap((b) => series.map((s) => n(b[s.key]))));
  const ceiling = Math.max(4, Math.ceil(max / 4) * 4);
  const width = 712;
  const step = width / Math.max(1, buckets.length - (kind === "line" ? 1 : 0));
  const x = (i: number) => 42 + (kind === "line" ? i * step : i * step + step / 2);
  const y = (value: number) => 184 - (value / ceiling) * 150;
  const every = Math.max(1, Math.ceil(buckets.length / 8));
  const barWidth = Math.max(1.5, Math.min(14, (step * 0.8) / series.length));

  return html`<svg class="volume-chart monitor-chart" viewBox="0 0 800 225" role="img" aria-label="${title}">
    <title>${title}</title>
    ${[0, 1, 2, 3, 4].map((tick) => html`<g><line class="chart-grid" x1="42" x2="774" y1="${184 - tick * 37.5}" y2="${184 - tick * 37.5}"/><text class="chart-tick" x="30" y="${188 - tick * 37.5}" text-anchor="end">${formatNumber(tick * ceiling / 4)}</text></g>`)}
    ${series.map((s, si) => kind === "line"
      ? html`<g data-chart-line="${s.key}"><polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${buckets.map((b, i) => `${x(i).toFixed(1)},${y(n(b[s.key])).toFixed(1)}`).join(" ")}"/>
          ${buckets.map((b, i) => n(b[s.key]) > 0 ? html`<circle cx="${x(i).toFixed(1)}" cy="${y(n(b[s.key])).toFixed(1)}" r="2.5" fill="${s.color}"><title>${bucketLabel(b.at, period)}: ${formatNumber(n(b[s.key]))} ${s.label.toLowerCase()}</title></circle>` : "")}</g>`
      : html`<g data-chart-line="${s.key}">${buckets.map((b, i) => n(b[s.key]) > 0
          ? html`<rect x="${(x(i) - (barWidth * series.length) / 2 + si * barWidth).toFixed(1)}" y="${y(n(b[s.key])).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(184 - y(n(b[s.key]))).toFixed(1)}" rx="1.5" fill="${s.color}"><title>${bucketLabel(b.at, period)}: ${formatNumber(n(b[s.key]))} ${s.label.toLowerCase()}</title></rect>`
          : "")}</g>`)}
    ${buckets.map((b, i) => i % every === 0 || i === buckets.length - 1
      ? html`<text class="chart-tick chart-day" x="${x(i).toFixed(1)}" y="212" text-anchor="middle">${bucketLabel(b.at, period)}</text>` : "")}
  </svg>`;
}

const TRAFFIC: Series[] = [
  { key: "received", label: "Recebidas", color: "#8c86f6" },
  { key: "sent", label: "Enviadas", color: "#42d9c8" },
  { key: "delivered", label: "Webhooks entregues", color: "#81b4f4" },
];
const FAILURES: Series[] = [
  { key: "webhook_failed", label: "Webhooks com falha", color: "#f08085" },
  { key: "send_failed", label: "Envios com falha", color: "#e8b96a" },
  { key: "drops", label: "Quedas de conexão", color: "#c792ea" },
];

function hasChartData(buckets: MonitoringBucket[], series: Series[]): boolean {
  return buckets.some((bucket) => series.some(({ key }) => n(bucket[key]) > 0));
}

function legend(series: Series[], buckets: MonitoringBucket[]): Html {
  return html`<div class="chart-legend">${series.map((s) => html`<button type="button" data-chart-toggle="${s.key}" aria-pressed="true"><i class="legend-dot" style="background:${s.color}"></i>${s.label} <strong>${formatNumber(buckets.reduce((sum, b) => sum + n(b[s.key]), 0))}</strong></button>`)}</div>`;
}

const REASONS: Record<string, string> = {
  waiting_for_scan: "Aguardando leitura do QR", qr_expired: "QR expirado", logged_out: "Número desconectado",
  connection_replaced: "Sessão aberta em outro lugar", number_already_connected: "Número já conectado em outra sessão",
  reconnecting: "Reconectando", starting: "Iniciando", capacity_exceeded: "Limite de sessões do servidor",
};

export function monitoringView(
  data: { totals: MonitoringTotals | undefined; buckets: MonitoringBucket[]; problems: Array<{
    id: string; session_key: string | null; tenant: string; client_slug: string; status: string;
    status_reason: string | null; status_changed_at: Date;
  }> },
  period: MonitoringPeriod,
  now = new Date(),
): Html {
  const totals: MonitoringTotals = data.totals ?? {
    live: "0", connected: "0", drops: "0", received: "0", sent: "0", send_failed: "0", send_stuck: "0",
    last_received_at: null, delivered: "0", retrying: "0", dead: "0", queued: "0", delivery_ms: null,
    disabled_endpoints: "0",
  };
  const { cards, alerts } = evaluateHealth(totals, period, now);
  const worst = alerts[0]?.tone;

  return html`
    <section class="overview-intro"><div><h2>Como está a plataforma agora.</h2><p>Conexões, envios e entregas aos clientes. ${period === "1h" ? "A página se atualiza sozinha a cada 30 segundos." : ""}</p></div>
      <div class="intro-actions"><a class="button" href="/admin/monitoring?period=${period}">${icon("refresh")} Atualizar</a></div></section>
    <div class="connection-tabs monitor-periods" role="navigation" aria-label="Período">
      ${(Object.keys(MONITORING_WINDOWS) as MonitoringPeriod[]).map((key) => html`<a class="${key === period ? "selected" : ""}" href="/admin/monitoring?period=${key}" ${key === period ? html`aria-current="page"` : ""}>${key === "1h" ? html`<i class="live-dot"></i>Ao vivo (1 h)` : MONITORING_WINDOWS[key].label}</a>`)}
    </div>
    ${alerts.length === 0
      ? html`<div class="monitor-alert ok">${icon("check")}<span>Tudo funcionando: nenhum problema encontrado (${MONITORING_WINDOWS[period].label.toLowerCase()}).</span></div>`
      : html`<div class="monitor-alerts">${alerts.map((alert) => html`<a class="monitor-alert ${alert.tone}" href="${alert.href}">${icon("alert")}<span>${alert.text}</span><b>Ver detalhes ${icon("arrow")}</b></a>`)}</div>`}
    <section class="panel monitor-current"><div class="section-heading"><div><p class="eyebrow">AGORA</p><h2>Conexões fora do ar</h2><p class="section-description">Situação atual, independente do período.</p></div><a class="button compact" href="/admin/connections">Ver todas ${icon("arrow")}</a></div>
      ${data.problems.length === 0
        ? html`<p class="monitor-empty">${icon("check")} Nenhuma conexão fora do ar agora.</p>`
        : html`<div class="table-wrap"><table>
          <thead><tr><th>Sessão</th><th>Cliente</th><th>Status</th><th>Desde</th></tr></thead>
          <tbody>${data.problems.map((row) => html`<tr>
            <td><a href="/admin/connections/${row.id}">${row.session_key ?? row.tenant}</a></td>
            <td>${row.client_slug}</td>
            <td>${badge(row.status)}${row.status_reason ? html`<div class="status-reason">${REASONS[row.status_reason] ?? row.status_reason}</div>` : ""}</td>
            <td class="table-date">${formatDate(row.status_changed_at)} · ${ago(row.status_changed_at, now)}</td>
          </tr>`)}</tbody>
        </table></div>`}</section>
    <div class="health-grid" ${worst ? html`data-worst="${worst}"` : ""}>
      ${cards.map((card) => html`<a class="health-card ${card.tone}" href="${card.href}">
        <div class="health-top"><span class="health-name">${icon(card.icon)}${card.label}</span><span class="health-state ${card.tone}"><i></i>${TONE_LABELS[card.tone]}</span></div>
        <strong class="health-value">${card.value}</strong>
        <span class="health-detail">${card.detail}</span></a>`)}
    </div>
    <section class="panel"><div class="section-heading"><div><p class="eyebrow">ATIVIDADE</p><h2>Tráfego no período</h2><p class="section-description">Mensagens recebidas e enviadas, e webhooks entregues aos clientes.</p></div></div>
      ${hasChartData(data.buckets, TRAFFIC)
        ? html`${legend(TRAFFIC, data.buckets)}${chart(data.buckets, period, TRAFFIC, "line", "Tráfego por intervalo")}`
        : html`<p class="monitor-empty">${icon("activity")} Sem atividade registrada neste período.</p>`}</section>
    <section class="panel"><div class="section-heading"><div><p class="eyebrow">FALHAS</p><h2>Tudo o que não deu certo</h2><p class="section-description">Por origem: entregas de webhook, envios e quedas de conexão.</p></div></div>
      ${hasChartData(data.buckets, FAILURES)
        ? html`${legend(FAILURES, data.buckets)}${chart(data.buckets, period, FAILURES, "bar", "Falhas por intervalo")}`
        : html`<p class="monitor-empty">${icon("check")} Nenhuma falha registrada neste período.</p>`}</section>
    <p class="chart-footnote">${icon("activity")} Fila de webhooks agora: ${formatNumber(n(totals.queued))} aguardando · Horário de São Paulo</p>
    ${period === "1h" ? html`<span hidden data-autorefresh="30"></span>` : ""}`;
}
