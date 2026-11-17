# On Connect — contexto para o Claude Code

Leia também `docs/STATUS.md` (onde o trabalho parou e o que falta) e
`docs/security/integrator-auth-and-transaction-context.md` (decisões de segurança).

## O que é
Plataforma de conectividade WhatsApp, multi-tenant, consumida só por API. O
**Tendi** é o primeiro cliente integrador. O primeiro provedor é o **WhatsApp Web
não oficial** (Baileys 7, conexão por QR ou código de pareamento); a Meta Cloud
API oficial fica para depois, atrás da mesma API. Risco aceito pelo dono do
produto: o provedor não oficial viola os termos do WhatsApp e números podem ser
banidos. Não construir recursos de evasão de banimento.

## Arquitetura
- `apps/api` (Fastify): rotas `/v1`, autenticação por API key (`Authorization: Bearer onc_...`).
- `apps/sessions`: dono dos sockets do WhatsApp. **Uma réplica só.** Roda como `onconnect_system`.
- `apps/worker` (BullMQ): filas gerais.
- `packages/core`: env, logger com redação, banco, auth, repositórios, filas.
- `deploy/`: Caddy + api + sessions + worker + Redis (docker compose).
- Banco: Supabase, schema privado `onconnect` com RLS forçado em todas as tabelas.

## Regras que não podem ser quebradas
- O `client_id` vem **só** da API key verificada; nunca de header/body/query.
- Todo acesso de cliente passa por `withClientTransaction` (contexto local à transação).
- Repositórios usam `onconnect.current_client_id()` no SQL e nunca recebem `client_id`.
- Recurso de outro cliente responde 404 (não 403), para não vazar existência.
- Nenhum segredo no Git, em logs ou em mensagens. Conteúdo de mensagens nunca vai para log.
- O processo `sessions` substitui o `console` (a libsignal imprime chaves de sessão).

## Como trabalhar
- `pnpm check` (build, typecheck, lint, testes) antes de abrir PR. Mudanças só por PR com CI verde.
- Testes de integração com PostgreSQL rodam só no CI (`RUN_POSTGRES_INTEGRATION=1`).
- Branch nova a partir de `origin/main`; commit e push só com o ok do usuário.
- Migrations: o arquivo em `supabase/migrations` deve ter a **mesma versão** registrada no
  Supabase. Aplicar em produção (MCP `apply_migration`) só com ok explícito do usuário e
  depois renomear o arquivo para a versão aplicada.
- Deploy e qualquer ação na VPS de produção só com ok explícito do usuário.

## Segredos (o usuário cria; o Claude não vê nem digita senhas)
- Senhas das roles `onconnect_app`/`onconnect_system`: geradas na VPS por um comando que grava a URL
  no `deploy/.env` e mostra o `alter role` para o usuário rodar no SQL Editor do Supabase.
- `API_KEY_PEPPER` e `SESSION_STATE_KEY`: gerados direto na VPS com `openssl rand`.
- Pedir ao usuário que **não envie prints** da saída desses comandos.
- `deploy/.env` contém `&` nas URLs: não fazer `source` no shell; ler com `grep`/`cut`.
