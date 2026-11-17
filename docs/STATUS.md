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
- Credencial ativa do Tendi: prefixo `P48ozUmwTgdPZ6mW` (rótulo `tendi-production`).
  Revogada: `7yTHTS6GpzxtpTXz`. A chave com prefixo `ErdTdMe1...` vazou num print e
  **nunca** deve ser inserida.
- Tenant de teste `teste` (maxConnections 1) com a conexão
  `23762486-ee44-4017-8c4d-53e1d39e6265` ligada a um número de teste.

## Próximos passos, em ordem
1. **Limpeza de acesso**: apagar `/root/tendi-api-key.txt` na VPS depois de guardar a chave no
   Tendi e num gerenciador de senhas; criar usuário de deploy sem root; remover chaves SSH não usadas.
2. **Configurar o Tendi**: URL base, API key, `maxConnections` dos tenants, endpoint de webhook.
3. Depois: `scopes` das API keys, idempotência por `Idempotency-Key`, mídia (envio/download),
   Meta Cloud API como segundo provedor.

## Acesso à VPS a partir de outro computador
- O SSH só aceita chave (senha desligada). Cada computador precisa da sua chave em
  `/root/.ssh/authorized_keys`. Em um PC novo: gerar a chave e colar a parte pública pelo
  terminal web da Hostinger.
- Fingerprint do servidor (ED25519): `SHA256:BxlkHGqRxxczi80EF6iKT7hKrUJBOa/WZ+gmF+nXqPo`.
- `/root/show-qr.sh <connection-id>` mostra o QR de uma conexão no terminal web.
