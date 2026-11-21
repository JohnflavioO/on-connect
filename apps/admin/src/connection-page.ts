import { QR_TTL_SECONDS } from "@on-connect/core";
import { badge, formatDate, formatNumber, formatPhone, html, icon, type Html } from "./html.js";
import { ago } from "./monitoring.js";
import type { AdminQueries } from "./queries.js";

/**
 * One connection, in tabs like D-API's instance settings: Conexão (status,
 * QR, actions, delete), Histórico (status changes and webhook deliveries of
 * this session), Desenvolvedor (ids to configure an integrator) and
 * Configurações (fixed behaviors and per-connection settings).
 */

export const CONNECTION_TABS = ["conexao", "historico", "desenvolvedor", "configuracoes"] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number];

type Connection = NonNullable<Awaited<ReturnType<AdminQueries["connection"]>>>;
type History = Awaited<ReturnType<AdminQueries["connectionHistory"]>>;
type Deliveries = Awaited<ReturnType<AdminQueries["connectionDeliveries"]>>;

const TAB_LABELS: Record<ConnectionTab, string> = {
  conexao: "Conexão", historico: "Histórico", desenvolvedor: "Desenvolvedor", configuracoes: "Configurações",
};

export const REASONS: Record<string, string> = {
  starting: "Iniciando", waiting_for_scan: "Aguardando leitura do QR", qr_expired: "QR expirou sem leitura",
  reconnecting: "Reconectando", logged_out: "Número desconectado no celular", deleted_by_client: "Removida pelo cliente",
  deleted_by_admin: "Removida pelo painel", connection_replaced: "Sessão aberta em outro lugar",
  number_already_connected: "Número já conectado em outra sessão", capacity_exceeded: "Limite de sessões do servidor",
  checking_meta: "Conferindo o número na Meta", meta_not_configured: "Token da Meta não configurado no servidor",
  meta_phone_number_missing: "Sem phone_number_id", meta_unreachable: "Meta não respondeu",
  meta_100: "phone_number_id não encontrado na Meta (ou sem acesso)", meta_190: "Token da Meta inválido ou expirado",
  meta_200: "Token sem permissão para este número", meta_10: "Token sem permissão para este número",
};

const reason = (value: string | null) => (value ? REASONS[value] ?? value : "");

function copyRow(id: string, label: string, value: string, note?: string): Html {
  return html`<div class="dev-row"><div><span class="dev-label">${label}</span><code class="dev-value" id="${id}">${value}</code>${note ? html`<small class="muted">${note}</small>` : ""}</div><button type="button" class="button compact" data-copy="${id}">Copiar</button></div>`;
}

function conexaoTab(row: Connection): Html {
  if (row.provider === "meta_cloud") return metaConexaoTab(row);
  const action = (path: string, label: string, description: string, confirm: string, tone = "") => html`
    <div class="action-row ${tone}"><div><strong>${label}</strong><small>${description}</small></div>
      <form class="inline" method="post" action="/admin/connections/${row.id}/${path}" data-confirm="${confirm}">
        <button type="submit" class="button compact ${tone}">${label}</button>
      </form></div>`;
  return html`
    <div class="grid-2">
      <section class="panel">
        <div class="connection-status-card"><span class="session-avatar">${icon("connection")}</span>
          <div><div>${badge(row.status)}${row.status_reason ? html` <span class="muted">${reason(row.status_reason)}</span>` : ""}</div>
            <span><strong>${formatPhone(row.display_phone_number)}</strong>${row.verified_name ? html` <span class="muted">· ${row.verified_name}</span>` : ""}</span>
            <small class="muted">Desde ${formatDate(row.status_changed_at)} · ${ago(row.status_changed_at)}</small></div></div>
        <table class="kv">
          <tr><th>Cliente</th><td><a href="/admin/clients/${row.client_id}">${row.client_slug}</a></td></tr>
          <tr><th>Organização</th><td class="mono">${row.tenant}</td></tr>
          <tr><th>Últimos 7 dias</th><td>${formatNumber(row.sent7)} enviadas · ${formatNumber(row.received7)} recebidas · <a href="/admin/messages?connection=${row.id}">ver mensagens</a></td></tr>
        </table>
        <h2>Ações</h2>
        ${action("restart", "Reiniciar", "Reabre a sessão sem desconectar o número; se não estiver conectada, gera um QR novo.", "Reiniciar esta conexão?")}
        ${action("logout", "Desconectar", "Encerra a sessão no WhatsApp. Para voltar, é preciso ler o QR de novo.", "Desconectar o WhatsApp deste número? Será preciso ler o QR de novo.", "danger")}
        <h2 class="danger-title">Zona de perigo</h2>
        <form class="action-row danger delete-form" method="post" action="/admin/connections/${row.id}/delete"
          data-confirm="Excluir esta conexão? O número é desconectado e a sessão some das listas.">
          <div><strong>Excluir conexão</strong><small>Desconecta o número e remove a conexão das listas. O histórico de mensagens e a auditoria ficam guardados. Digite <b>EXCLUIR</b> para confirmar.</small>
            <label class="sr-only" for="confirm-delete">Confirmação</label>
            <input id="confirm-delete" name="confirm" placeholder="EXCLUIR" autocomplete="off" required pattern="EXCLUIR" maxlength="7"></div>
          <button type="submit" class="button compact danger">Excluir</button>
        </form>
      </section>
      <section class="panel">
        <h2 style="margin-top:0">QR code</h2>
        <p class="muted">Status: <strong data-qr-status>${badge(row.status)}</strong></p>
        <div class="qr" data-qr-url="/admin/connections/${row.id}/qr.json"><div class="empty">Carregando…</div></div>
        <p class="muted">Atualiza sozinho. O QR expira em cerca de ${QR_TTL_SECONDS} s; se sumir, use "Reiniciar".</p>
      </section>
    </div>`;
}

const QUALITY: Record<string, [string, string]> = {
  GREEN: ["Alta", "ok"], YELLOW: ["Média", "warn"], RED: ["Baixa", "bad"], UNKNOWN: ["Sem avaliação", "muted"],
};

/** A Meta Cloud API number: no QR; Meta's data and a check instead. */
function metaConexaoTab(row: Connection): Html {
  const action = (path: string, label: string, description: string, confirm: string, tone = "") => html`
    <div class="action-row ${tone}"><div><strong>${label}</strong><small>${description}</small></div>
      <form class="inline" method="post" action="/admin/connections/${row.id}/${path}" data-confirm="${confirm}">
        <button type="submit" class="button compact ${tone}">${label}</button>
      </form></div>`;
  const [quality, tone] = QUALITY[row.quality_rating ?? "UNKNOWN"] ?? [row.quality_rating ?? "—", "muted"];
  return html`
    <div class="grid-2">
      <section class="panel">
        <div class="connection-status-card"><span class="session-avatar">${icon("connection")}</span>
          <div><div>${badge(row.status)}${row.status_reason ? html` <span class="muted">${reason(row.status_reason)}</span>` : ""}</div>
            <span><strong>${formatPhone(row.display_phone_number)}</strong>${row.verified_name ? html` <span class="muted">· ${row.verified_name}</span>` : ""}</span>
            <small class="muted">Desde ${formatDate(row.status_changed_at)} · ${ago(row.status_changed_at)}</small></div></div>
        <table class="kv">
          <tr><th>Provedor</th><td>Meta · API oficial do WhatsApp</td></tr>
          <tr><th>Cliente</th><td><a href="/admin/clients/${row.client_id}">${row.client_slug}</a></td></tr>
          <tr><th>Organização</th><td class="mono">${row.tenant}</td></tr>
          <tr><th>Últimos 7 dias</th><td>${formatNumber(row.sent7)} enviadas · ${formatNumber(row.received7)} recebidas · <a href="/admin/messages?connection=${row.id}">ver mensagens</a></td></tr>
        </table>
        <h2>Ações</h2>
        ${action("restart", "Verificar na Meta", "Confere o número com a Meta agora e atualiza nome, qualidade e limite. Também volta a usar um número parado.", "Verificar este número na Meta agora?")}
        ${action("logout", "Parar de usar", "O On Connect para de enviar por este número. Nada muda na Meta; para voltar, use Verificar na Meta.", "Parar de usar este número no On Connect?", "danger")}
        <h2 class="danger-title">Zona de perigo</h2>
        <form class="action-row danger delete-form" method="post" action="/admin/connections/${row.id}/delete"
          data-confirm="Excluir esta conexão? Ela some das listas; o número continua cadastrado na Meta.">
          <div><strong>Excluir conexão</strong><small>Remove a conexão das listas. O número continua na Meta e o histórico fica guardado. Digite <b>EXCLUIR</b> para confirmar.</small>
            <label class="sr-only" for="confirm-delete">Confirmação</label>
            <input id="confirm-delete" name="confirm" placeholder="EXCLUIR" autocomplete="off" required pattern="EXCLUIR" maxlength="7"></div>
          <button type="submit" class="button compact danger">Excluir</button>
        </form>
      </section>
      <section class="panel">
        <h2 style="margin-top:0">Dados da Meta</h2>
        <table class="kv">
          <tr><th>Qualidade</th><td><span class="badge ${tone}">${quality}</span></td></tr>
          <tr><th>Limite de conversas</th><td class="mono">${row.messaging_limit_tier ?? "—"}</td></tr>
          <tr><th>phone_number_id</th><td class="mono">${row.phone_number_id ?? "—"}</td></tr>
          <tr><th>WABA</th><td class="mono">${row.waba_id ?? "—"}</td></tr>
          <tr><th>Última verificação</th><td>${row.last_health_check_at ? html`${formatDate(row.last_health_check_at)} · ${ago(row.last_health_check_at)}` : "—"}</td></tr>
        </table>
        <p class="muted">O On Connect confere o número a cada 6 horas. Fora da janela de 24 h após a última mensagem do contato, a Meta só aceita modelos aprovados (fase 2): o envio de texto falha com o código <span class="mono">meta_131047</span>.</p>
      </section>
    </div>`;
}

function historicoTab(history: History, deliveries: Deliveries): Html {
  return html`
    <section class="panel"><div class="section-heading"><div><p class="eyebrow">STATUS</p><h2>Quando conectou e caiu</h2><p class="section-description">Mudanças de status desta conexão, mais recentes primeiro (até 50).</p></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Quando</th><th>De</th><th>Para</th><th>Motivo</th></tr></thead>
        <tbody>${history.length === 0
          ? html`<tr><td colspan="4"><div class="empty-state">${icon("activity")}<strong>Nenhuma mudança registrada ainda.</strong><span>Mudanças anteriores à criação desse registro não aparecem.</span></div></td></tr>`
          : history.map((h) => html`<tr>
            <td class="table-date">${formatDate(h.at)}<div class="muted">${ago(h.at)}</div></td>
            <td>${h.previous_status ? badge(h.previous_status) : "—"}</td>
            <td>${badge(h.status)}</td>
            <td>${reason(h.reason) || "—"}</td></tr>`)}</tbody>
      </table></div></section>
    <section class="panel"><div class="section-heading"><div><p class="eyebrow">WEBHOOKS</p><h2>Últimas entregas desta sessão</h2><p class="section-description">Eventos desta conexão enviados ao cliente (até 20).</p></div><a class="button compact" href="/admin/webhooks">Central de webhooks ${icon("arrow")}</a></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Quando</th><th>Evento</th><th>Status</th><th>Tentativas</th><th>Resultado</th></tr></thead>
        <tbody>${deliveries.length === 0
          ? html`<tr><td colspan="5"><div class="empty-state">${icon("webhook")}<strong>Nenhuma entrega desta sessão.</strong></div></td></tr>`
          : deliveries.map((d) => html`<tr>
            <td class="table-date">${formatDate(d.updated_at)}</td>
            <td class="mono">${d.event_type}</td>
            <td>${badge(d.status)}</td>
            <td>${formatNumber(d.attempts)}</td>
            <td class="mono">${d.last_error ?? (d.last_status_code ? `HTTP ${d.last_status_code}` : "—")}</td></tr>`)}</tbody>
      </table></div></section>`;
}

function desenvolvedorTab(row: Connection): Html {
  return html`
    <section class="panel"><div class="section-heading"><div><p class="eyebrow">INTEGRAÇÃO</p><h2>Dados de desenvolvimento</h2><p class="section-description">Identificadores para configurar o integrador.</p></div></div>
      <div class="dev-list">
        ${row.session_key ? copyRow("dev-session", "Session ID (camada D-API)", row.session_key) : ""}
        ${copyRow("dev-connection", "ID da conexão (API On Connect)", row.id)}
        ${copyRow("dev-tenant", "Organização (tenant)", row.tenant)}
        ${copyRow("dev-client", "Cliente", row.client_slug)}
      </div>
      ${row.provider === "meta_cloud" ? html`
        <section class="panel" style="margin-top:1.5rem">
          <h2>Vincular número oficial a uma sessão do TendiDesk</h2>
          <p class="muted">Corrige o identificador da sessão sem recriar o número na Meta.
            Confirme o código no Console do TendiDesk. O histórico da conexão oficial é preservado.</p>
          <form class="stack" method="post" action="/admin/connections/${row.id}/relink-meta"
            data-confirm="Confirmar o vínculo deste número oficial com a sessão informada? A sessão QR existente será encerrada somente se a substituição estiver marcada.">
            <label>Código da sessão do workspace
              <input name="sessionKey" required maxlength="100" pattern="[A-Za-z0-9._-]{1,100}"
                placeholder="tendi-637a9d9f-…" autocomplete="off"></label>
            <label class="checkbox"><input type="checkbox" name="replace" value="on">
              <span>Substituir a conexão QR Code desta sessão, se existir.</span></label>
            <button type="submit" class="button">Vincular sessão existente</button>
          </form>
          <p class="muted">A organização original da conexão permanece inalterada para preservar
            as referências de mensagens e eventos históricos.</p>
        </section>` : ""}
      <div class="info-note">${icon("shield")}<span><strong>API key não aparece aqui.</strong> O On Connect guarda só um resumo cifrado da chave, por segurança: ela é mostrada uma única vez, quando é criada. Para uma chave nova, vá em <a href="/admin/clients/${row.client_id}">Clientes</a>.</span></div>
    </section>`;
}

function configuracoesTab(row: Connection): Html {
  const item = (title: string, description: string, state: Html) =>
    html`<div class="setting-row"><div><strong>${title}</strong><small>${description}</small></div>${state}</div>`;
  const always = html`<span class="badge ok">Sempre ligado</span>`;
  const checkbox = (name: string, title: string, description: string, enabled: boolean) =>
    html`<label class="setting-row"><div><strong>${title}</strong><small>${description}</small></div>
      <input name="${name}" type="checkbox" ${enabled ? html`checked` : ""}>
    </label>`;
  return html`
    <section class="panel"><div class="section-heading"><div><p class="eyebrow">COMPORTAMENTO</p><h2>Configurações da conexão</h2><p class="section-description">Como esta conexão trata o que chega do WhatsApp.</p></div></div>
      ${item("Ignorar grupos", "Mensagens de grupos não são processadas nem enviadas ao cliente.", always)}
      ${item("Ignorar status", "Atualizações de status (stories) e listas de transmissão são ignoradas.", always)}
      ${row.provider === "whatsapp_web" ? html`
        <form method="post" action="/admin/connections/${row.id}/settings">
          ${checkbox("rejectCalls", "Rejeitar chamadas", "Recusar automaticamente ligações de voz e vídeo para este número.", row.reject_calls)}
          ${checkbox("readOnReply", "Marcar como lido ao responder", "Ao enviar uma mensagem pela API, marcar como lidas as mensagens anteriores do contato.", row.read_on_reply)}
          <button class="button primary" type="submit">Salvar configurações</button>
        </form>` : ""}
    </section>`;
}

export function connectionPage(
  row: Connection,
  tab: ConnectionTab,
  extra: { history?: History; deliveries?: Deliveries },
): Html {
  const content = tab === "historico" ? historicoTab(extra.history ?? [], extra.deliveries ?? [])
    : tab === "desenvolvedor" ? desenvolvedorTab(row)
    : tab === "configuracoes" ? configuracoesTab(row)
    : conexaoTab(row);
  return html`
    <div class="connection-tabs" role="navigation" aria-label="Seções da conexão">
      ${CONNECTION_TABS.map((key) => html`<a class="${key === tab ? "selected" : ""}" href="/admin/connections/${row.id}${key === "conexao" ? "" : `?tab=${key}`}" ${key === tab ? html`aria-current="page"` : ""}>${TAB_LABELS[key]}</a>`)}
    </div>
    ${content}`;
}
