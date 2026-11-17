# Estado do projeto

Atualizado em 2026-11-17. Atualize este arquivo ao fim de cada etapa.

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
