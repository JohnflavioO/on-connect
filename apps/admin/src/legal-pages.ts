import { brand, html, icon, type Html } from "./html.js";
import { publicDocument } from "./public-pages.js";

/**
 * Páginas públicas exigidas pela Meta para a análise do app (Login do Facebook /
 * cadastro incorporado do WhatsApp): Política de Privacidade, Termos de Uso e
 * instruções de exclusão de dados. Os dados da empresa são os do portfólio
 * empresarial verificado na Meta.
 */
export const COMPANY = {
  legalName: "FRANCISCO JOHNNOTTON FLAVIO DE OLIVEIRA",
  cnpj: "59.251.387/0001-00",
  city: "Pacatuba – CE, Brasil",
  email: "contato@studioondesign.com.br",
  updatedAt: "19 de novembro de 2026",
} as const;

export const LEGAL_LINKS = [
  ["/privacidade", "Política de Privacidade"],
  ["/termos", "Termos de Uso"],
  ["/exclusao-de-dados", "Exclusão de dados"],
] as const;

const mail = html`<a href="mailto:${COMPANY.email}">${COMPANY.email}</a>`;
const company = html`<strong>On Connect</strong>, serviço operado por ${COMPANY.legalName}, inscrito no CNPJ ${COMPANY.cnpj}, com sede em ${COMPANY.city}`;

function legalDocument(title: string, lead: string, sections: Array<[id: string, heading: string, body: Html]>): string {
  return publicDocument(`${title} · On Connect`, html`
<header class="public-header"><div class="public-container public-bar">
  ${brand("/")}
  <a class="public-secondary" href="/">Voltar ao início ${icon("arrow")}</a>
</div></header>
<main id="main-content" class="public-main">
  <div class="public-container docs-layout">
    <nav class="docs-nav" aria-label="Nesta página">
      ${sections.map(([id, heading]) => html`<a href="#${id}">${heading}</a>`)}
    </nav>
    <article class="docs-article">
      <h1>${title}</h1>
      <p class="docs-lead">${lead}</p>
      <p>Última atualização: ${COMPANY.updatedAt}.</p>
      ${sections.map(([id, heading, body]) => html`<section id="${id}" aria-labelledby="${id}-title">
        <h2 id="${id}-title">${heading}</h2>
        ${body}
      </section>`)}
    </article>
  </div>
</main>
${legalFooter()}`);
}

export function legalFooter(): Html {
  return html`<footer class="public-footer">
  <div class="public-container footer-content">
    <div class="footer-brand">
      ${brand("/")}
      <p>${COMPANY.legalName} · CNPJ ${COMPANY.cnpj}</p>
    </div>
    <nav class="public-nav footer-nav" aria-label="Documentos legais">
      ${LEGAL_LINKS.map(([href, label]) => html`<a href="${href}">${label}</a>`)}
      <a href="/docs">Documentação</a>
    </nav>
  </div>
  <div class="public-container footer-meta">© ${new Date().getUTCFullYear()} On Connect · ${mail}</div>
</footer>`;
}

export function privacyPage(): string {
  return legalDocument("Política de Privacidade", "Como o On Connect trata os dados de quem usa o serviço e das pessoas que conversam pelo WhatsApp, de acordo com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018).", [
    ["quem-somos", "Quem somos", html`
      <p>O ${company}, é uma plataforma de conectividade que liga números de WhatsApp a sistemas de empresas (os <strong>integradores</strong>, como o TendiDesk) por meio de API e webhooks.</p>
      <p>Para os dados das conversas, o On Connect atua como <strong>operador</strong>: trata os dados em nome do integrador e da empresa dona do número, que são os <strong>controladores</strong> e decidem a finalidade do atendimento. Para os dados de cadastro e acesso ao próprio On Connect, atuamos como controlador.</p>`],
    ["dados", "Quais dados tratamos", html`
      <ul>
        <li><strong>Dados da conta do WhatsApp Business conectada:</strong> número de telefone, identificador do número e da conta na Meta, nome verificado, qualidade e limites de mensagens.</li>
        <li><strong>Mensagens:</strong> conteúdo de texto e mídia (imagens, áudios, vídeos e documentos), remetente, destinatário, data e status de entrega e leitura das mensagens trocadas pelos números conectados.</li>
        <li><strong>Contatos:</strong> número de telefone e nome de perfil das pessoas que conversam com os números conectados.</li>
        <li><strong>Credenciais de acesso:</strong> quando a empresa conecta o número pelo cadastro incorporado da Meta (Login do Facebook), recebemos um token de acesso à conta do WhatsApp Business dela. Não recebemos a senha do Facebook.</li>
        <li><strong>Dados técnicos:</strong> endereços IP, registros de acesso ao console e registros de entrega de webhooks, sem o conteúdo das mensagens.</li>
      </ul>`],
    ["finalidade", "Para que usamos os dados", html`
      <ul>
        <li>Enviar e receber mensagens pelo WhatsApp em nome da empresa dona do número e entregá-las ao sistema do integrador.</li>
        <li>Mostrar o status das conexões e das entregas, e identificar falhas.</li>
        <li>Proteger o serviço contra acesso indevido e cumprir obrigações legais.</li>
      </ul>
      <p>Não vendemos dados, não os usamos para publicidade e não os usamos para treinar modelos de inteligência artificial.</p>`],
    ["compartilhamento", "Com quem compartilhamos", html`
      <ul>
        <li><strong>Integrador:</strong> o sistema que a empresa contratou (por exemplo, o TendiDesk) recebe as mensagens e eventos dos números dele.</li>
        <li><strong>Meta Platforms (WhatsApp):</strong> as mensagens enviadas passam pela API oficial do WhatsApp ou pelo WhatsApp Web, conforme a forma de conexão escolhida.</li>
        <li><strong>Infraestrutura:</strong> banco de dados (Supabase) e servidores (Hostinger), contratados para hospedar o serviço, com acesso restrito.</li>
        <li><strong>Autoridades:</strong> quando houver obrigação legal ou ordem judicial.</li>
      </ul>`],
    ["seguranca", "Como protegemos", html`
      <ul>
        <li>Comunicação sempre criptografada (HTTPS/TLS).</li>
        <li>Tokens de acesso e chaves de sessão guardados cifrados; chaves de API guardadas só como resumo criptográfico.</li>
        <li>Isolamento por cliente no banco de dados: cada integrador só acessa os próprios dados.</li>
        <li>O conteúdo das mensagens não é gravado em registros de log, e mídias são acessadas por links assinados e temporários.</li>
      </ul>`],
    ["retencao", "Por quanto tempo guardamos", html`
      <p>Mantemos os dados enquanto a conexão do número estiver ativa e o integrador usar o serviço. Quando a conexão é encerrada ou a exclusão é solicitada, apagamos o token de acesso imediatamente e as mensagens, contatos e mídias em até 30 dias, salvo quando a lei exigir guardar por mais tempo.</p>`],
    ["direitos", "Seus direitos", html`
      <p>Pela LGPD, você pode pedir confirmação de tratamento, acesso, correção, anonimização, portabilidade, exclusão e informações sobre compartilhamento dos seus dados, além de revogar consentimentos.</p>
      <p>Se você conversa com uma empresa pelo WhatsApp, o pedido pode ser feito a ela ou diretamente a nós pelo e-mail ${mail}. Veja também a página <a href="/exclusao-de-dados">Exclusão de dados</a>.</p>`],
    ["contato", "Contato e encarregado", html`
      <p>Encarregado pelo tratamento de dados: ${COMPANY.legalName}. E-mail: ${mail}.</p>
      <p>Podemos atualizar esta política; a data da última atualização fica no topo da página.</p>`],
  ]);
}

export function termsPage(): string {
  return legalDocument("Termos de Uso", "Regras para usar o On Connect, a plataforma de conectividade WhatsApp por API.", [
    ["servico", "O serviço", html`
      <p>O ${company}, oferece a empresas e desenvolvedores (os <strong>integradores</strong>) uma API para conectar números de WhatsApp, enviar e receber mensagens e receber eventos por webhooks, além de um console para acompanhar conexões e entregas.</p>`],
    ["conta", "Conta e chaves de API", html`
      <ul>
        <li>O acesso é feito por chaves de API e pelo console. O integrador é responsável por guardar suas chaves em segurança e por todo uso feito com elas.</li>
        <li>Chaves expostas devem ser revogadas imediatamente pelo console ou pelo e-mail ${mail}.</li>
      </ul>`],
    ["uso", "Uso permitido", html`
      <ul>
        <li>Cumprir a <a href="https://business.whatsapp.com/policy" rel="noopener">Política Comercial do WhatsApp</a>, os Termos da Meta e a legislação brasileira, incluindo a LGPD e o Código de Defesa do Consumidor.</li>
        <li>Enviar mensagens apenas a pessoas que deram consentimento e oferecer forma de deixar de recebê-las.</li>
        <li>É proibido enviar spam, conteúdo ilegal, enganoso ou que viole direitos de terceiros.</li>
      </ul>`],
    ["conexoes", "Formas de conexão", html`
      <p>Números podem ser conectados pela <strong>API oficial do WhatsApp (Meta Cloud API)</strong> ou pelo <strong>WhatsApp Web</strong>. A conexão pelo WhatsApp Web não é um serviço oficial da Meta e o número pode ser restrito pelo WhatsApp; o integrador assume esse risco ao escolher essa forma de conexão.</p>`],
    ["responsabilidades", "Responsabilidades", html`
      <ul>
        <li>O integrador e a empresa dona do número são responsáveis pelo conteúdo das mensagens e pelo relacionamento com os próprios clientes.</li>
        <li>Fazemos o possível para manter o serviço disponível, mas ele pode ter interrupções, inclusive por mudanças da Meta ou do WhatsApp.</li>
        <li>Podemos suspender o acesso em caso de uso que viole estes termos ou coloque o serviço em risco.</li>
      </ul>`],
    ["dados", "Dados pessoais", html`
      <p>O tratamento de dados segue a nossa <a href="/privacidade">Política de Privacidade</a>.</p>`],
    ["foro", "Alterações e foro", html`
      <p>Estes termos podem ser atualizados; a data da última atualização fica no topo da página. Fica eleito o foro da comarca de Pacatuba – CE para resolver questões relacionadas a estes termos. Contato: ${mail}.</p>`],
  ]);
}

export function dataDeletionPage(): string {
  return legalDocument("Exclusão de dados", "Como pedir a exclusão dos seus dados no On Connect, inclusive os recebidos pelo Login do Facebook e pelo cadastro do WhatsApp Business.", [
    ["empresas", "Empresas que conectaram um número", html`
      <ol>
        <li>Desconecte o número no sistema que você usa (por exemplo, no TendiDesk) ou peça ao seu integrador.</li>
        <li>Opcionalmente, remova o acesso do app em <strong>Facebook › Configurações › Integrações comerciais</strong> ou no Gerenciador de Negócios da Meta.</li>
        <li>Envie um e-mail para ${mail} com o assunto <strong>“Exclusão de dados”</strong>, informando o número de telefone conectado e o nome da empresa.</li>
      </ol>
      <p>O token de acesso é apagado assim que a conexão é encerrada. Mensagens, contatos e mídias desse número são apagados em até 30 dias, e confirmamos a exclusão por e-mail.</p>`],
    ["pessoas", "Pessoas que conversaram com uma empresa", html`
      <p>Se você trocou mensagens com uma empresa que usa o On Connect, peça a exclusão à empresa ou escreva para ${mail} informando o seu número de telefone e o nome da empresa. Respondemos em até 15 dias.</p>`],
    ["prazo", "O que é mantido", html`
      <p>Podemos guardar por mais tempo apenas o que a lei exigir (por exemplo, registros de acesso, pelo prazo do Marco Civil da Internet). Mais detalhes na <a href="/privacidade">Política de Privacidade</a>.</p>`],
  ]);
}
