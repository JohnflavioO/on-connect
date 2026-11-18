import { brand, html, icon, type Html, type IconName } from "./html.js";

export function publicDocument(title: string, body: Html, login = false): string {
  return html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${login ? html`<meta name="robots" content="noindex, nofollow">`
    : html`<meta name="description" content="Conecte o WhatsApp ao seu sistema pela API do On Connect e acompanhe mensagens, sessões e webhooks.">`}
<link rel="icon" type="image/svg+xml" href="/admin/assets/favicon.svg">
<link rel="icon" type="image/png" href="/admin/assets/icon.png">
<link rel="apple-touch-icon" href="/admin/assets/icon.png">
<link rel="stylesheet" href="/admin/assets/admin.css">
<link rel="stylesheet" href="/assets/on-connect.css">
</head>
<body class="public-site">
<a class="skip-link" href="#main-content">Ir para o conteúdo</a>
${body}
</body>
</html>`.value;
}

const features: Array<{ symbol: IconName; title: string; body: string }> = [
  { symbol: "connection", title: "Conexões", body: "Vincule seu número por QR Code ou código de pareamento. Veja no painel se a sessão está conectada e consulte o histórico de status." },
  { symbol: "send", title: "Mensagens", body: "Envie textos, imagens, vídeos, áudios e documentos por API. Acompanhe status como enviado, entregue, lido ou com falha." },
  { symbol: "webhook", title: "Webhooks", body: "Receba mensagens e mudanças de status em um endpoint do seu sistema. Consulte tentativas, erros e reenvios pelo console." },
];

export function landingPage(): string {
  return publicDocument("On Connect · Integração WhatsApp", html`
<header class="public-header"><div class="public-container public-bar">
  ${brand("/")}
  <nav class="public-nav public-header-nav" aria-label="Navegação principal">
    <a href="#solucao">Solução</a><a href="#recursos">Recursos</a><a href="#como-funciona">Como funciona</a><a href="#plano">Plano</a>
  </nav>
  <a class="public-secondary" href="/admin/login">Acessar conta ${icon("arrow")}</a>
</div></header>
<main id="main-content" class="public-main">
  <section class="hero-band" aria-labelledby="hero-title">
    <div class="public-container public-hero">
      <div class="public-copy">
        <p class="public-kicker">API de WhatsApp para SaaS</p>
        <h1 id="hero-title">Coloque o WhatsApp <em>dentro do seu produto.</em></h1>
        <p>Envie mensagens pelo seu sistema, receba eventos em tempo real por webhooks e acompanhe as conexões de cada cliente no painel.</p>
        <div class="public-actions">
          <a class="public-primary" href="#plano">Ver plano ${icon("arrow")}</a>
          <a class="public-secondary" href="/docs">Explorar a API ${icon("arrow")}</a>
        </div>
      </div>
      <div class="hero-flow">
        <ol class="hero-route" aria-label="Caminho de uma mensagem">
          <li><span>${icon("grid")}</span>Seu sistema</li>
          <li><span><img src="/admin/assets/icon.png" alt="" width="348" height="375"></span>On Connect</li>
          <li><span>${icon("connection")}</span>WhatsApp</li>
        </ol>
        <figure class="api-preview">
          <figcaption>
            <span>${icon("send")} Enviar mensagem</span>
            <code>API REST</code>
          </figcaption>
        <pre tabindex="0" aria-label="Exemplo de requisição para enviar uma mensagem"><code><span class="api-method">POST</span> /v1/connections/{id}/messages
Authorization: Bearer &lt;CHAVE_DA_API&gt;
Content-Type: application/json

{
  <span class="api-field">"to"</span>: <span class="api-string">"5511999999999"</span>,
  <span class="api-field">"text"</span>: <span class="api-string">"Seu pedido está a caminho."</span>
}</code></pre>
          <div class="api-response"><code>202 Accepted</code><span>Envio aceito para processamento</span></div>
        </figure>
        <div class="hero-conversation" aria-label="Exemplo de conversa">
          <span class="conversation-icon">${icon("inbox")}</span>
          <div><span>Prévia da mensagem</span><p>Seu pedido está a caminho.</p></div>
        </div>
      </div>
    </div>
  </section>
  <section class="solution-band" id="solucao" aria-labelledby="solution-title">
    <div class="public-container solution-layout">
      <h2 id="solution-title">O que é o On Connect?</h2>
      <div>
        <p class="solution-lead">O On Connect é uma API de WhatsApp para SaaS, CRMs e plataformas de atendimento. Seu produto envia mensagens e recebe respostas, enquanto sua equipe acompanha conexões e entregas pelo painel.</p>
        <dl class="solution-details">
          <div><dt>Integração</dt><dd>API REST</dd></div>
          <div><dt>Conexão</dt><dd>WhatsApp Web</dd></div>
          <div><dt>Eventos</dt><dd>Webhooks assinados</dd></div>
          <div><dt>Operação</dt><dd>Painel de monitoramento</dd></div>
        </dl>
      </div>
    </div>
  </section>
  <section class="public-container public-features" id="recursos" aria-labelledby="resources-title">
    <h2 id="resources-title">Gerencie a integração de ponta a ponta</h2>
    <div class="public-feature-grid">
      ${features.map(({ symbol, title, body }) => html`
        <article class="public-feature"><span class="public-symbol">${icon(symbol)}</span><h3>${title}</h3><p>${body}</p></article>`)}
    </div>
  </section>
  <section class="public-container public-setup" id="como-funciona" aria-labelledby="setup-title">
    <div class="section-intro">
      <h2 id="setup-title">Do número conectado à primeira mensagem</h2>
      <p>Integre o WhatsApp ao seu CRM, sistema de atendimento ou fluxo de notificações.</p>
    </div>
    <ol class="public-steps">
      <li><h3>Conecte o número</h3><p>Vincule sua conta do WhatsApp por QR Code ou código de pareamento.</p></li>
      <li><h3>Integre seu sistema</h3><p>Use uma chave de API para enviar mensagens e configure uma URL para receber eventos assinados.</p></li>
      <li><h3>Acompanhe a operação</h3><p>Consulte o status das conexões e investigue falhas de entrega dos webhooks no painel.</p></li>
    </ol>
  </section>
  <section class="public-container public-plan" id="plano" aria-labelledby="plan-title">
    <div class="section-intro">
      <h2 id="plan-title">Plano On Connect</h2>
      <p>Para equipes que querem enviar mensagens e receber eventos de WhatsApp diretamente no sistema que já usam.</p>
      <a class="public-secondary plan-docs" href="/docs">Ver documentação ${icon("arrow")}</a>
    </div>
    <div class="plan-card">
      <p class="plan-price"><span>R$</span> 37,49</p>
      <ul>
        <li>${icon("check")} Conexão via WhatsApp Web</li>
        <li>${icon("check")} API para envio de texto e mídia</li>
        <li>${icon("check")} Webhooks assinados de mensagens e status</li>
        <li>${icon("check")} Painel de conexões e entregas</li>
      </ul>
    </div>
  </section>
  <section class="closing-band" aria-labelledby="closing-title">
    <div class="public-container closing-content">
      <h2 id="closing-title">Conecte seu primeiro número.</h2>
      <p>Vincule o WhatsApp por QR Code ou código de pareamento e envie sua primeira mensagem pela API.</p>
      <div class="public-actions">
        <a class="public-primary" href="/admin/login">Acessar conta ${icon("arrow")}</a>
        <a class="public-secondary" href="#plano">Ver plano</a>
      </div>
    </div>
  </section>
</main>
<footer class="public-footer">
  <div class="public-container footer-content">
    <div class="footer-brand">
      ${brand("/")}
      <p>API de conectividade WhatsApp para integrar mensagens e eventos ao seu sistema.</p>
    </div>
    <nav class="public-nav footer-nav" aria-label="Links do rodapé">
      <a href="#solucao">Solução</a><a href="#recursos">Recursos</a><a href="#como-funciona">Como funciona</a>
      <a href="#plano">Plano</a><a href="/docs">Documentação</a><a href="/admin/login">Acessar conta</a>
    </nav>
  </div>
  <div class="public-container footer-meta">© ${new Date().getUTCFullYear()} On Connect</div>
</footer>`);
}

export function loginPage(error?: string): string {
  return publicDocument("Entrar · On Connect", html`
<header class="public-header"><div class="public-container public-bar">
  ${brand("/", "CONSOLE")}
  <a class="public-secondary" href="/">Voltar ao início</a>
</div></header>
<main id="main-content" class="public-main public-container login-layout">
  <section class="login-info">
    <p class="public-kicker">Console de operações</p>
    <h1>Entre no<br> On Connect.</h1>
    <p>Gerencie suas conexões, acompanhe mensagens e monitore a entrega de webhooks.</p>
    <div class="login-icons" aria-hidden="true">${features.map(({ symbol }) => html`<span class="public-symbol">${icon(symbol)}</span>`)}</div>
  </section>
  <section class="login-card" aria-labelledby="login-title">
    <span class="public-symbol">${icon("shield")}</span>
    <h2 id="login-title">Acessar console</h2>
    <p>Use suas credenciais de administrador.</p>
    ${error ? html`<p role="alert" class="login-error">${error}</p>` : ""}
    <form method="post" action="/admin/login">
      <label for="username">Usuário</label>
      <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required>
      <label for="password">Senha</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button class="public-primary" type="submit">Entrar ${icon("arrow")}</button>
    </form>
  </section>
</main>`, true);
}
