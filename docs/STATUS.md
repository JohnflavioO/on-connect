# Estado do projeto

Atualizado em 2026-11-17. Atualize este arquivo ao fim de cada etapa.

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
  `20261117032011_whatsapp_web_connections`, `20261117121152_webhook_delivery` (trigger de
  fan-out ativo; ainda sem endpoints cadastrados).
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
   Meta Cloud API como segundo provedor.

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
