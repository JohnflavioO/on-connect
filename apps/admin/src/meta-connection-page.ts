import { html, icon, type Html } from "./html.js";
import type { AdminQueries } from "./queries.js";

type Clients = Awaited<ReturnType<AdminQueries["clients"]>>;

/**
 * Form to add a Meta Cloud API number. Only ids go here (they are not
 * secrets): the access token stays in the server environment.
 */
export function newMetaConnectionPage(clients: Clients): Html {
  const active = clients.filter((client) => client.status === "active");
  return html`
    <section class="overview-intro"><div><h2>Número da API oficial da Meta.</h2><p>Conecte um número já cadastrado no WhatsApp Manager. O On Connect confere o número com a Meta e passa a enviar e receber por ele.</p></div><a class="button" href="/admin/connections">Voltar</a></section>
    <div class="grid-2">
      <section class="panel">
        <h2 style="margin-top:0">Dados da conexão</h2>
        <form class="stack" method="post" action="/admin/connections/meta">
          <label>Cliente
            <select name="clientId" required>${active.map((client) => html`<option value="${client.id}">${client.name} (${client.slug})</option>`)}</select></label>
          <label>Organização (tenant)
            <input name="tenant" required maxlength="200" placeholder="external id da organização, ex.: tendi-org-1" autocomplete="off"></label>
          <label>phone_number_id
            <input name="phoneNumberId" required inputmode="numeric" pattern="[0-9]{5,30}" placeholder="ex.: 123456789012345" autocomplete="off"></label>
          <label>WABA ID (opcional)
            <input name="wabaId" inputmode="numeric" pattern="[0-9]{5,30}" placeholder="ID da conta do WhatsApp Business" autocomplete="off"></label>
          <label>Nome interno (opcional)
            <input name="label" maxlength="100" placeholder="ex.: Atendimento oficial" autocomplete="off"></label>
          <button type="submit" class="primary">Criar conexão Meta</button>
        </form>
      </section>
      <section class="panel">
        <h2 style="margin-top:0">Onde encontrar</h2>
        <ol class="steps">
          <li>Em developers.facebook.com, abra o app da Meta e vá em <strong>WhatsApp › Configuração da API</strong>.</li>
          <li>Escolha o número. O <strong>phone_number_id</strong> e o <strong>WABA ID</strong> aparecem logo abaixo dele.</li>
          <li>Na mesma área, em <strong>Webhooks</strong>, a URL deve ser <span class="mono">/webhooks/meta</span> deste domínio, com o campo <strong>messages</strong> assinado.</li>
        </ol>
        <div class="info-note">${icon("shield")}<span><strong>O token da Meta não entra aqui.</strong> Ele fica só no servidor (META_ACCESS_TOKEN). Estes IDs não são segredos.</span></div>
      </section>
    </div>`;
}
