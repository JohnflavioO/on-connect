import { WEBHOOK_EVENT_TYPES } from "@on-connect/core";
import { badge, formatDate, formatNumber, html, icon, maskUrl, type Html } from "./html.js";
import type { AdminQueries } from "./queries.js";

/**
 * One webhook endpoint: pause / reactivate, and which events it receives.
 * D-API (compatibility) endpoints show their events as fixed: the
 * compatible session routes reset them whenever the integrator connects.
 */

type Endpoint = NonNullable<Awaited<ReturnType<AdminQueries["webhookEndpoint"]>>>;

export const EVENT_LABELS: Record<(typeof WEBHOOK_EVENT_TYPES)[number], [string, string]> = {
  "message.received": ["Mensagem recebida", "Mensagens que chegam, e as enviadas pelo próprio celular."],
  "message.status": ["Status de mensagem", "Enviada, entregue, lida ou falhou, para mensagens enviadas pela API."],
  "connection.status": ["Status de conexão", "Conectou, caiu, pediu QR ou foi desconectada."],
};

export function endpointPage(endpoint: Endpoint): Html {
  const compat = endpoint.payload_format === "dapi";
  const all = endpoint.event_types.length === 0;
  const action = (path: string, label: string, description: string, confirm: string, tone = "") => html`
    <div class="action-row ${tone}"><div><strong>${label}</strong><small>${description}</small></div>
      <form class="inline" method="post" action="/admin/webhooks/endpoints/${endpoint.id}/${path}" data-confirm="${confirm}">
        <button type="submit" class="button compact ${tone}">${label}</button>
      </form></div>`;

  return html`
    <p><a class="text-link" href="/admin/webhooks">${icon("arrow")} Voltar para webhooks</a></p>
    <div class="grid-2">
      <section class="panel"><div class="section-heading"><div><p class="eyebrow">ENDPOINT</p><h2>${endpoint.client_slug}</h2></div>${badge(endpoint.status)}</div>
        <table class="kv">
          <tr><th>Destino</th><td class="mono">${maskUrl(endpoint.url)}</td></tr>
          <tr><th>Formato</th><td>${compat ? "Compatibilidade (D-API)" : "On Connect"}</td></tr>
          <tr><th>Organização</th><td class="mono">${endpoint.tenant ?? "todas"}</td></tr>
          <tr><th>Aguardando entrega</th><td>${formatNumber(endpoint.queued)}</td></tr>
          <tr><th>Falhas seguidas</th><td>${formatNumber(endpoint.consecutive_failures)}${endpoint.failing_since ? html` <span class="muted">desde ${formatDate(endpoint.failing_since)}</span>` : ""}</td></tr>
          ${endpoint.disabled_at ? html`<tr><th>Desativado em</th><td>${formatDate(endpoint.disabled_at)}</td></tr>` : ""}
          <tr><th>Criado</th><td>${formatDate(endpoint.created_at)}</td></tr>
        </table>
        <p class="muted">O caminho da URL fica oculto: ele pode conter o segredo do cliente.</p>
        <h2>Entrega</h2>
        ${endpoint.status === "active"
          ? action("pause", "Pausar", "Para de enviar. Os eventos continuam sendo guardados e saem quando reativar.", "Pausar este endpoint? O cliente para de receber eventos até reativar.")
          : action("reactivate", "Reativar", endpoint.status === "disabled"
            ? "Foi desativado por falhas seguidas. Reativar zera as falhas e reenvia o que estava esperando."
            : "Volta a enviar, começando pelo que ficou guardado na pausa.", "Reativar este endpoint e reenviar o que estava esperando?")}
        ${compat && endpoint.status === "paused" ? html`<p class="muted">Endpoints de compatibilidade voltam a ficar ativos quando o integrador reconecta uma sessão.</p>` : ""}
      </section>
      <section class="panel"><div class="section-heading"><div><p class="eyebrow">EVENTOS</p><h2>O que este endpoint recebe</h2></div></div>
        ${compat
          ? html`<div class="info-note">${icon("shield")}<span>Na compatibilidade com a D-API, os eventos são definidos pela integração: o Tendi recebe exatamente os que entende. Para parar tudo, use <strong>Pausar</strong>.</span></div>
            <ul class="event-list">${WEBHOOK_EVENT_TYPES.map((type) => html`<li>${icon(all || endpoint.event_types.includes(type) ? "check" : "alert")}<span><strong>${EVENT_LABELS[type][0]}</strong><small class="mono">${type}</small></span></li>`)}</ul>`
          : html`<form class="events-form" method="post" action="/admin/webhooks/endpoints/${endpoint.id}/events">
              <label class="setting-row"><div><strong>Todos os eventos</strong><small>Inclui eventos que forem criados no futuro.</small></div><input type="radio" name="mode" value="all" ${all ? html`checked` : ""}></label>
              <label class="setting-row"><div><strong>Só os escolhidos</strong><small>Marque abaixo.</small></div><input type="radio" name="mode" value="some" ${all ? "" : html`checked`}></label>
              ${WEBHOOK_EVENT_TYPES.map((type) => html`<label class="setting-row sub"><div><strong>${EVENT_LABELS[type][0]}</strong><small>${EVENT_LABELS[type][1]} <span class="mono">${type}</span></small></div><input type="checkbox" name="event_${type}" ${all || endpoint.event_types.includes(type) ? html`checked` : ""}></label>`)}
              <button type="submit" class="button primary">Salvar eventos</button>
            </form>`}
      </section>
    </div>`;
}
