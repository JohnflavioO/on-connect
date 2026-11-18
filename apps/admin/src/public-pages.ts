import { brand, html, icon, type Html, type IconName } from "./html.js";

function document(title: string, body: Html, login = false): string {
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
  { symbol: "connection", title: "Conexões", body: "Vincule números por QR Code e acompanhe o estado de cada sessão no painel." },
  { symbol: "send", title: "Mensagens", body: "Envie textos e mídias do seu sistema e receba atualizações de entrega e leitura." },
  { symbol: "webhook", title: "Webhooks", body: "Receba eventos no seu sistema e acompanhe as tentativas de entrega no console." },
];

export function landingPage(): string {
  return document("On Connect · Integração WhatsApp", html`
<header class="public-header"><div class="public-container public-bar">
  ${brand("/")}
  <a class="public-secondary" href="/admin/login">Acessar console ${icon("arrow")}</a>
</div></header>
<main id="main-content" class="public-main">
  <section class="public-container public-hero">
    <div class="public-copy">
      <p class="public-kicker">API de conectividade</p>
      <h1>Conecte o WhatsApp <em>ao seu sistema.</em></h1>
      <p>Integre mensagens e eventos de WhatsApp ao seu produto. Gerencie números, sessões e webhooks em um só console.</p>
      <div class="public-actions">
        <a class="public-primary" href="/admin/login">Acessar console ${icon("arrow")}</a>
        <a class="public-feature-link" href="#recursos">Conhecer recursos</a>
      </div>
    </div>
    <div class="public-diagram" role="img" aria-label="O On Connect liga seu sistema ao WhatsApp por API e entrega eventos por webhooks.">
      <div class="diagram-row" aria-hidden="true">
        <div class="diagram-node">${icon("grid")}<span>Seu sistema</span></div>
        <span class="diagram-line"></span>
        <div class="diagram-node diagram-core"><img class="diagram-mark" src="/admin/assets/icon.png" alt="" width="348" height="375"><span>On Connect</span></div>
        <span class="diagram-line"></span>
        <div class="diagram-node">${icon("connection")}<span>WhatsApp</span></div>
      </div>
      <div class="diagram-event" aria-hidden="true">${icon("webhook")} Eventos por webhook</div>
    </div>
  </section>
  <section class="public-container public-features" id="recursos" aria-labelledby="resources-title">
    <h2 id="resources-title">Gerencie a integração de ponta a ponta</h2>
    <div class="public-feature-grid">
      ${features.map(({ symbol, title, body }) => html`
        <article class="public-feature"><span class="public-symbol">${icon(symbol)}</span><h3>${title}</h3><p>${body}</p></article>`)}
    </div>
  </section>
</main>
<footer class="public-footer"><div class="public-container public-bar">
  ${brand("/")} <a class="public-feature-link" href="/admin/login">Entrar no console</a>
</div></footer>`);
}

export function loginPage(error?: string): string {
  return document("Entrar · On Connect", html`
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
