import { brand, html, icon } from "./html.js";
import { publicDocument } from "./public-pages.js";

const sections = [
  ["autenticacao", "Autenticação"],
  ["conexao", "Conectar um número"],
  ["mensagens", "Enviar mensagens"],
  ["webhooks", "Receber webhooks"],
  ["compatibilidade", "Compatibilidade D-API"],
] as const;

const code = (sample: string) => html`<pre tabindex="0"><code>${sample}</code></pre>`;

export function documentationPage(origin: string): string {
  return publicDocument("Documentação da API · On Connect", html`
<header class="public-header"><div class="public-container public-bar">
  ${brand("/")}
  <a class="public-secondary" href="/admin/login">Acessar conta ${icon("arrow")}</a>
</div></header>
<main id="main-content" class="public-main">
  <div class="public-container docs-layout">
    <nav class="docs-nav" aria-label="Nesta documentação">
      ${sections.map(([id, title]) => html`<a href="#${id}">${title}</a>`)}
    </nav>
    <article class="docs-article">
      <h1>Documentação da API</h1>
      <p class="docs-lead">Conecte um número via WhatsApp Web, envie uma mensagem e receba eventos do On Connect no seu sistema.</p>
      <p>URL base <code>${origin}/v1</code></p>

      <section id="autenticacao" aria-labelledby="docs-auth">
        <h2 id="docs-auth">Autenticação</h2>
        <p>Um administrador gera a chave em <strong>Clientes → seu cliente → API keys → Gerar nova chave</strong>. A chave aparece uma vez. Guarde-a no servidor da sua aplicação e envie-a no cabeçalho <code>Authorization: Bearer</code>.</p>
        <p>Os exemplos usam Bash e cURL. Para os exemplos com variáveis no JSON, instale também o <code>jq</code>. Comece validando a chave com <code>GET /v1/me</code>.</p>
        ${code(`ONCONNECT_URL='${origin}'
read -rsp 'Chave de API do On Connect: ' ONCONNECT_API_KEY; printf '\\n'

oc() {
  curl --fail-with-body --silent --show-error \\
    -H "Authorization: Bearer $ONCONNECT_API_KEY" "$@"
}

oc "$ONCONNECT_URL/v1/me"`)}
        <p>A resposta retorna <code>clientId</code>, <code>credentialId</code> e <code>scopes</code>. Uma chave ausente ou inválida retorna <code>401</code>.</p>
      </section>

      <section id="conexao" aria-labelledby="docs-connection">
        <h2 id="docs-connection">Conectar um número</h2>
        <p>Use um identificador externo próprio para a organização do seu cliente. O exemplo cria ou atualiza o tenant <code>loja-1</code> e cria uma conexão nele.</p>
        ${code(`oc -X PUT "$ONCONNECT_URL/v1/tenants/loja-1" \\
  -H 'Content-Type: application/json' \\
  --data '{"name":"Loja 1","maxConnections":1}'

oc -X POST "$ONCONNECT_URL/v1/tenants/loja-1/connections" \\
  -H 'Content-Type: application/json' \\
  --data '{"label":"Atendimento"}'`)}
        <p>Copie o campo <code>id</code> da resposta da conexão. Busque o QR e exiba <code>qrImage</code>, uma imagem PNG em data URL, no seu sistema para escanear pelo WhatsApp.</p>
        ${code(`read -rp 'ID da conexão: ' CONNECTION_ID
oc "$ONCONNECT_URL/v1/connections/$CONNECTION_ID/qr"
oc "$ONCONNECT_URL/v1/connections/$CONNECTION_ID"`)}
        <p>Consulte a conexão até o campo <code>status</code> indicar <code>connected</code>. Se receber <code>qr_not_available</code>, aguarde alguns segundos e consulte novamente. Se o QR expirar, use <code>POST /v1/connections/:id/restart</code> para uma conexão ainda não vinculada.</p>
      </section>

      <section id="mensagens" aria-labelledby="docs-messages">
        <h2 id="docs-messages">Enviar uma mensagem de texto</h2>
        <p>Com a conexão ativa, informe o número do destinatário com DDI, usando apenas dígitos. O texto aceita até 4.096 caracteres.</p>
        ${code(`read -rp 'Número de destino com DDI: ' DESTINATION

oc -X POST "$ONCONNECT_URL/v1/connections/$CONNECTION_ID/messages" \\
  -H 'Content-Type: application/json' \\
  --data "$(jq -n --arg to "$DESTINATION" \\
    '{to: $to, text: "Olá! Esta é uma mensagem de teste."}')"`)}
        <p><code>202 Accepted</code> indica que o envio entrou no fluxo de processamento. Use o <code>id</code> retornado em <code>GET /v1/messages/:messageId</code> ou acompanhe o evento <code>message.status</code> para verificar o resultado da entrega.</p>
      </section>

      <section id="webhooks" aria-labelledby="docs-webhooks">
        <h2 id="docs-webhooks">Receber webhooks assinados</h2>
        <p>Cadastre uma URL HTTPS pública do seu sistema. O exemplo recebe três tipos de evento do tenant <code>loja-1</code>.</p>
        ${code(`read -rp 'URL HTTPS do seu webhook: ' WEBHOOK_URL

oc -X POST "$ONCONNECT_URL/v1/webhook-endpoints" \\
  -H 'Content-Type: application/json' \\
  --data "$(jq -n --arg url "$WEBHOOK_URL" \\
    '{url: $url, tenantExternalId: "loja-1",
      eventTypes: ["message.received", "message.status", "connection.status"]}')"`)}
        <p>A resposta <code>201</code> contém o campo <code>secret</code>. Guarde o valor completo, com o prefixo <code>whsec_</code>. Nas entregas, o cabeçalho <code>OnConnect-Signature</code> tem o formato <code>t=&lt;segundos Unix&gt;,v1=&lt;hex&gt;</code>. Calcule o HMAC-SHA256 de <code>&lt;t&gt;.&lt;corpo bruto&gt;</code> com esse segredo antes de interpretar o JSON. Compare o resultado com <code>v1</code> em tempo constante e aplique uma tolerância de cinco minutos ao timestamp <code>t</code>.</p>
        <p>Responda com <code>2xx</code> após aceitar o evento. Como entregas podem se repetir e chegar fora de ordem, deduplique por <code>OnConnect-Event-Id</code> e considere a progressão dos status <code>sent → delivered → read</code>.</p>
      </section>

      <section id="compatibilidade" aria-labelledby="docs-compat">
        <h2 id="docs-compat">Compatibilidade D-API</h2>
        <p>Integrações já escritas para a D-API usam a base <code>${origin}/compat/dapi/api/v1</code>. Utilize a chave do On Connect no cabeçalho <code>Authorization</code>. O formato aceita a chave direta e também <code>Bearer</code>.</p>
        <ul>
          <li><code>POST /sessions</code> cria ou reaproveita uma sessão identificada por <code>sessionId</code>.</li>
          <li><code>POST /messages/send/text</code> recebe <code>sessionId</code>, <code>to</code> e <code>text</code>.</li>
          <li>O envio de mídia usa <code>POST /messages/send/image</code>, <code>/messages/send/video</code>, <code>/messages/send/audio</code> ou <code>/messages/send/document</code>, com uma URL HTTPS pública no campo do arquivo.</li>
        </ul>
        <p>Na API nativa, o exemplo de envio acima usa o UUID da conexão. Na camada compatível, use o <code>sessionId</code> definido na criação da sessão.</p>
      </section>
    </article>
  </div>
</main>
<footer class="public-footer"><div class="public-container public-bar">
  ${brand("/")} <a class="public-secondary" href="/">Voltar ao início</a>
</div></footer>`);
}
