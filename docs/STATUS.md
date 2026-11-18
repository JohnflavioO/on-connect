# Estado do projeto

Atualizado em 2026-11-18. Atualize este arquivo ao fim de cada etapa.

## Meta Cloud API, fase 1 (2026-11-18)

- Segundo provedor ao lado do WhatsApp Web; detalhes em `docs/meta.md`. Decisões: um token
  no servidor (`META_ACCESS_TOKEN`), conexões Meta criadas só pelo painel, texto fora da
  janela de 24 h é enviado e a falha volta com o código da Meta (`meta_131047`).
- `api` recebe `/webhooks/meta` (assinatura com `META_APP_SECRET`) e enfileira; `sessions`
  grava mensagens, status e mídia, e envia pela Graph API pelo mesmo outbox.
- Sem migration: a tabela `connections` já tinha `phone_number_id`, `waba_id`, qualidade e limite.
- `pnpm check` passou; os testes com PostgreSQL novos rodam no CI.
- Falta: criar o app na Meta, pôr as 3 variáveis no `deploy/.env`, deploy de `api`, `sessions`
  e `admin`, e testar com o número de teste da Meta. Fase 2: templates e janela de 24 h.

## Landing e entrada do console (2026-11-18)

- Landing pública em `/` e formulário em `/admin/login`, com a marca do
  dashboard. O serviço `admin` usa o usuário e o hash bcrypt existentes,
  emite um cookie de sessão HTTPS e permite sair pelo próprio painel.
- Revisão de segurança (2026-11-18): o segredo da Caddy passou para o cabeçalho
  `X-OnConnect-Console-Secret`. Assim, se a Caddy nova subir antes do painel novo,
  o painel antigo responde 404 em vez de ficar aberto sem senha. Entrada limitada a
  10 tentativas por endereço em 15 min e 20 por minuto no total; cada tentativa vai
  para o log do `admin`.
- **Ordem do deploy** (junto com as configurações por conexão abaixo):
  1. ~~aplicar a migration `connection_behavior` no Supabase~~ — **feito em 2026-11-18**,
     registrada como `20261118142124_connection_behavior` (arquivo renomeado para a mesma versão);
  2. `up -d --build admin sessions`;
  3. `up -d caddy` (a Caddy sem `basic_auth` só depois do painel com login).

## Comportamento do WhatsApp por conexão (2026-11-18)

- Implementado na branch local `feat/connection-behavior` a partir de `5c343cb` (PR #32).
  A aba Configurações salva **Rejeitar chamadas** e **Marcar como lido ao responder**.
  As opções começam desligadas e o serviço `sessions` consulta a configuração em uso,
  sem reiniciar o socket.
- `pnpm check`, as migrations, o teste de isolamento e os 82 testes de integração
  passaram em PostgreSQL 17 descartável.
- **Marcar como lido** roda depois do envio (a API não espera por ele), uma vez
  por contato de cada vez, só para mensagens dos últimos 7 dias e no máximo
  500 por resposta. Ligar a opção não percorre o histórico antigo.
- Antes do deploy, aplicar a migration `connection_behavior` e atualizar `admin`
  e `sessions` (ordem acima). Falta validar os dois controles com um número real de teste.

## Conexão em abas e gestão de webhooks no painel (2026-11-17)

- A partir das configurações de instância da D-API, decidido trazer: abas da conexão
  (Conexão com Excluir, Histórico, Desenvolvedor, Configurações) e pausa/eventos do webhook.
  Não trazer: exibir API key (só guardamos o resumo), eventos que o On Connect não gera,
  RabbitMQ, chamadas/voz, DDI +55.
- Branch `feat/admin-connection-tabs` (ver `docs/admin.md`). Sem migration e sem variável;
  depois do merge, atualizar só o `admin`.
- `pnpm check` passou; 12 testes PostgreSQL do painel passaram em banco descartável
  (histórico via trigger, pausa/eventos só em endpoint nativo, exclusão lógica com auditoria);
  visual conferido em Chromium (desktop e 375 px, sem overflow).

## Monitoramento no painel (2026-11-17)

- Estado conferido: `main` em `b3cb9c3` (PRs #25 a #29 integrados); painel em produção e Tendi
  usando o On Connect pela camada compatível com o número da própria Tendi.
- Comparação com a D-API: faltavam Monitoramento, Relatório de mensagens, histórico por
  conexão e a tela de conversas. Decisão do usuário: fazer **Monitoramento** agora; o painel
  continua **sem mostrar texto de mensagens** (só contagens).
- Branch `feat/admin-monitoring`: nova tela `/admin/monitoring` (ver `docs/admin.md`), com
  avisos, cartões de saúde, gráficos de tráfego e falhas por período e conexões fora do ar.
  Sem migration e sem variável nova; depois do merge, atualizar só o `admin`.
- `pnpm check` passou; 9 testes PostgreSQL do painel passaram em banco descartável (inclui
  janelas 1 h/24 h/7 d/30 d); visual validado em Chromium (desktop e 375 px, sem overflow).
- Migration `dapi_compat_sessions`: tinha sido aplicada pelo SQL Editor sem entrar no histórico
  do Supabase. Com ok do usuário, conferido que função, grants, trigger e checks no banco
  batem com o arquivo, e registrada em `supabase_migrations.schema_migrations` com a mesma
  versão do arquivo (`20261117150000`), sem reexecutar nada. Histórico e `supabase/migrations`
  agora têm as mesmas 5 versões.
- D-API: o Monitoramento dela mostra 100% de falha nos webhooks da sessão antiga (o segredo do
  callback do Tendi mudou). Esperado; desligar a sessão antiga quando o usuário decidir.
- Próximas melhorias possíveis do painel: relatório de mensagens (sem conteúdo) e histórico
  por conexão.

## Histórico de webhooks em revisão (2026-11-17)

- PR #28 (`941aea5`) integrado; a captura do usuário confirma a nova navegação
  no painel da VPS. O usuário apontou que a lista de webhooks estava extensa.
- Branch `fix/admin-webhook-pagination`: páginas de 25 entregas, tabela rolável
  com altura limitada, Anterior/Próxima e filtros de status, evento e cliente/
  sessão. Histórico preservado e nenhuma mudança no worker ou no receptor.
  Coluna Erro renomeada para Resultado para não apresentar HTTP 200 como falha.
- Build, tipos, lint e 254 testes padrão passaram; os 8 testes PostgreSQL do
  painel passaram em banco descartável, incluindo 31 entregas com mesmo horário,
  filtros combinados e páginas sem sobreposição nos dados estáticos. As demais
  suítes PostgreSQL não foram executadas nesta etapa. Chromium validou avanço
  de página, filtros, altura da tabela e layout móvel sem overflow global.
- Commit/PR e deploy desse ajuste pendentes. Sem migration ou novas variáveis;
  depois do merge, atualizar somente admin. Sessão antiga da D-API preservada.

## Dashboard e identidade visual em revisão (2026-11-17)

- O usuário confirmou que imagem e áudio passaram a abrir após o deploy do
  PR #27 (`0c4e9af`) e que o envio de mídia pelo Inbox também funcionou. A sessão
  antiga da D-API ainda deve ser preservada até decisão explícita do usuário.
- Branch `feat/admin-operations-dashboard`: novo visual responsivo, gráfico
  de 7/14/30 dias, visão das conexões, fila de webhooks, conexões recentes,
  legendas interativas, dados diários acessíveis e busca literal de conexões.
  Calendário e totais alinhados ao horário de São Paulo; sem migration.
- Build, typecheck, lint e 252 testes padrão passaram. Os 7 testes PostgreSQL
  do painel passaram em banco descartável, incluindo limites de dia e períodos;
  as demais suítes PostgreSQL não foram executadas nesta etapa. Chromium
  validou filtros/legendas e layout em 1440 px e 390 px sem overflow da página.
- No repositório Tendi, branch `fix/whatsapp-provider-labels`: textos de cliente
  neutros e console administrativo com nome do provedor e presença da chave
  consultados no servidor, sem expor credenciais. Lint, tipos e 551 testes
  passaram; build local permanece bloqueado pelo Google Fonts na rede do Codex.
- Capturas locais usam dados demonstrativos. Commit/PR e deploy das duas
  branches ainda pendentes; registros abaixo descrevem etapas anteriores.

## Integração Tendi e mídia no navegador (2026-11-17)

- PR #26 (`d9ac857`) implantado em sessions; o usuário confirmou que o envio
  com o número original de 13 dígitos passou a chegar após a resolução do JID.
- Tendi PR #101 (`ada1ac9`) integrado e em Production na Vercel. O usuário
  configurou base/chave do On Connect, domínio do callback e novo segredo.
  O número da própria Tendi foi pareado pelo QR da interface do Tendi, criando
  a sessão `tendi-<organizationId>`; a conexão nativa `teste` foi preservada.
- Recebimento confirmado no Inbox correto e webhook D-API ativo, zero falhas,
  entregas HTTP 200 na primeira tentativa. A resposta pelo Inbox aparece na
  conversa. Somente a própria Tendi usa um número nessa integração atualmente.
- Imagem e áudio recebidos aparecem indisponíveis: diagnóstico na VPS confirmou
  link presente e HTTP 200 (`image/jpeg` e `audio/ogg`), mas a API responde
  `Cross-Origin-Resource-Policy: same-origin`, bloqueando o uso pelo Tendi.
- Correção na branch `fix/media-cross-origin`: permitir `cross-origin` somente
  em respostas de mídia com token válido; JSON/erros mantêm `same-origin`,
  validação de assinatura e `nosniff` preservados. Build, typecheck, lint e
  249 testes passaram; 74 testes de integração não executados. Os dois testes
  novos de imagem/áudio reproduziram a falha antes da correção. Chromium carregou
  imagem e áudio da API real em uma página local de outra origem após o ajuste.
- Commit/PR e deploy desta correção pendentes. Após CI verde e merge, atualizar
  somente a API e recarregar o Inbox para validar os arquivos já recebidos.
  Depois confirmar envio de mídia pelo Inbox e revisar os rótulos D-API legados.

## Validação de envio e correção do destinatário (2026-11-17)

- A correção do formulário foi integrada no PR #25 (`dc861a3`) e implantada
  pelo usuário; a geração da chave `teste-pos-deploy` pelo painel funcionou.
- API key validada com HTTP 200. Um envio para um número brasileiro de 13
  dígitos ficou em `sent` sem chegar. Mensagens recebidas desse celular
  identificavam o número com 12 dígitos; um novo envio para esse identificador
  chegou, conforme confirmação do usuário. Não presumir que todos os números
  brasileiros precisam perder o nono dígito.
- Correção em preparação na branch `fix/whatsapp-recipient-jid`: consultar
  `onWhatsApp` antes de enviar texto ou mídia e usar o JID retornado; não enviar
  para um JID adivinhado quando a consulta falhar ou o destinatário não existir.
  Mantém o id da mensagem para novas tentativas. Não reenvia mensagens que já
  estão em `sent`. Build, typecheck, lint e 247 testes passaram (11 testes novos
  do adaptador; 74 testes de integração não executados). Commit/PR e deploy
  dessa correção ainda pendentes; a consulta automática precisa ser validada
  com WhatsApp real após o deploy.
- Próximos passos: validar novamente o número original após essa correção,
  testar mídia e cadastrar/validar webhooks antes de integrar o Tendi.

## Atualização após o deploy do painel (2026-11-17)

- O usuário confirmou o deploy de `3f89aee` (PR #24) na VPS: api/admin/Redis
  saudáveis; sessions/worker/Caddy em execução; `/admin` sem login retorna 401
  e o dashboard abre com login. Recebimento real confirmado (contador 60 → 61).
- A migration `dapi_compat_sessions` foi executada pelo SQL Editor; presença de
  `session_key`, `payload_format` e do trigger conferida. Nenhum endpoint de
  webhook cadastrado. Envio após o deploy ainda não validado (API key recusada).
- Criação de chave pelo painel retorna 403: logs mostram `Origin: null` com
  `ADMIN_ORIGIN` correto. Correção local na branch `fix/admin-form-origin`:
  trocar `Referrer-Policy: no-referrer` por `same-origin`, mantendo a recusa de
  origens externas, ausentes ou `null`. `pnpm check` passou (236 testes;
  74 testes de integração não executados). Reprodução local em Chromium com
  formulário HTML: `no-referrer` enviou `Origin: null`; `same-origin` enviou a
  origem correta. Commit/PR e deploy pendentes.
- O registro abaixo descreve o estado anterior a esse deploy. Depois da
  correção, retomar criação da chave de teste, envio, mídia, webhooks e Tendi.

## Em produção
- API: `https://onconnect.tendidesk.com.br/v1` (VPS Hostinger, Ubuntu 26.04, `/opt/on-connect`).
- Banco: Supabase, projeto `yebiezsnsifsvylspsli` (região us-west-2), via session pooler
  `aws-0-us-west-2.pooler.supabase.com:5432` com TLS verificado (`deploy/supabase-ca.crt`).
- Migrations aplicadas: `20261117020658_initial_schema`, `20261117020713_api_credential_lookup`,
  `20261117032011_whatsapp_web_connections`, `20261117121152_webhook_delivery`,
  `20261117150000_dapi_compat_sessions`.
- Versão no ar: `main` em `b5c85c4` (PR #17, webhooks). `api` e `worker` reimplantados em
  2026-11-17 12:14 UTC; `sessions` segue com a imagem de `a3ff83f` (o PR #17 não o mudou).
- `WEBHOOK_SECRET_KEY` gerada na VPS, no `deploy/.env`.
- Logs do container antigo do `sessions` (com chaves da libsignal) foram descartados na
  recriação; verificado por `grep` nos logs do Docker que nenhum arquivo contém chaves.

### Funcionando e testado com WhatsApp real
- Autenticação por API key, tenants (`/v1/tenants`).
- Conexão WhatsApp Web por QR/código de pareamento; sessão sobrevive a reinício.
- Recebimento de mensagens (1:1) e envio de texto com status `sent`/`delivered`.
  `read` depende do destinatário ter confirmação de leitura ligada.
- Webhooks (2026-11-17): endpoint de teste no webhook.site recebeu `message.received` em 1,3 s,
  HTTP 200 na 1ª tentativa, payload no formato de `docs/webhooks.md`. Criação e exclusão pela
  API conferidas no banco e na auditoria; o endpoint de teste foi apagado. Nenhum endpoint
  cadastrado agora. `message.status` só coberto por testes automatizados.

### Dados existentes (sem segredos)
- Cliente `tendi`, id `1387b40c-a1d1-45b1-8b11-aa90bb52d2be`.
- Credencial ativa do Tendi: prefixo `V6vi0ShZDLKfpGzB` (rótulo `tendi-production-2`, emitida
  em 2026-11-17 12:49 UTC). A chave existe só com o usuário (bloco de notas; mover para um
  gerenciador de senhas); não há cópia na VPS.
- Revogadas: `7yTHTS6GpzxtpTXz` e `P48ozUmwTgdPZ6mW` (esta em 2026-11-17 12:51 UTC, porque a chave
  inteira foi colada no chat; revogação na auditoria). A chave com prefixo `ErdTdMe1...` vazou num
  print e **nunca** deve ser inserida.
- Testar a chave sem expô-la: `read -rs -p "Cole a chave: " K; echo; curl -sS
  https://onconnect.tendidesk.com.br/v1/me -H "Authorization: Bearer $K"; unset K` (colar só
  depois do prompt, nunca dentro do comando).
- Tenant de teste `teste` (maxConnections 1) com a conexão
  `23762486-ee44-4017-8c4d-53e1d39e6265` ligada a um número de teste.

## Próximos passos, em ordem
0. **Substituir a D-API no Tendi** (plano em `docs/dapi-compat.md`): camada compatível com a
   D-API em `/compat/dapi/api/v1`. Fase 1 (sessões, QR e `connection.status`) no PR #21, com
   a migration `dapi_compat_sessions` ainda não aplicada. Fase 2 (mensagens de texto, enviadas
   pelo celular, entregue/lida, envio com id imediato) no PR #22, sem migration nova. Fase 3
   (mídia recebida com `media_url`, envio de mídia, avatar) na branch `feat/dapi-compat-media`,
   que exige `MEDIA_KEY` nova no `deploy/.env` (`openssl rand -base64 32`) e cria o volume
   `media_data`. Depois das fases 1 a 3 o Tendi pode trocar de provedor (ver
   `docs/dapi-compat.md`). Fase 4: painel super admin em `/admin` (ver `docs/admin.md`) na
   branch `feat/admin-panel`; exige `ADMIN_USER`, `ADMIN_PASSWORD_HASH` e `ADMIN_PROXY_SECRET`
   no `deploy/.env` e sobe o serviço `admin`.
1. **Limpeza de acesso** (usuário `deploy` já criado e testado em 2026-11-17). Falta:
   - No PC de casa: listar as chaves (`ssh-keygen -lf ~/.ssh/*.pub`) e ver qual das duas chaves
     extras do root é dele: `onconnect-deploy` (`SHA256:n2MOjbgW...`) ou
     `onconnect-deploy-nopass` (`SHA256:DvCF/MXf...`). Remover a(s) que não for(em) de ninguém,
     com backup do `authorized_keys`, e pôr a chave do PC de casa também no `deploy`.
   - Só depois, com o `deploy` acessível dos dois PCs: `PermitRootLogin no` no sshd (o terminal
     web da Hostinger continua como acesso de emergência).
2. **Configurar o Tendi**: URL base, API key, `maxConnections` dos tenants, endpoint de webhook.
3. Depois: `scopes` das API keys, idempotência por `Idempotency-Key`, mídia (envio/download),
   Meta Cloud API como segundo provedor (fase 1 feita; ver `docs/meta.md`).

## Acesso à VPS a partir de outro computador
- IP: `179.66.149.16`. Fingerprint do servidor (ED25519):
  `SHA256:BxlkHGqRxxczi80EF6iKT7hKrUJBOa/WZ+gmF+nXqPo`.
- O SSH só aceita chave (senha desligada). Usuário do dia a dia: `deploy` (grupos `docker` e
  `sudo`; a senha serve só para o `sudo` e fica no gerenciador de senhas). Ele é dono de
  `/opt/on-connect`, então `git pull` e `docker compose` rodam sem root. O grupo `docker`
  equivale a root na prática: a chave do `deploy` deve ser tratada como chave de root.
- Chaves autorizadas no `deploy`: só a deste PC do trabalho (`on_connect_vps`,
  `SHA256:n5KW4c4j...`). Root ainda aceita essa e as duas `onconnect-deploy*`.
- Em um PC novo: gerar a chave e colar a parte pública em `/home/deploy/.ssh/authorized_keys`
  pelo terminal web da Hostinger. Entrar com `ssh -i <chave> deploy@179.66.149.16`.
- `/root/show-qr.sh <connection-id>` mostra o QR de uma conexão no terminal web (só como root;
  o `deploy` não lê `/root`).
