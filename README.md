# On Connect

Plataforma independente de conectividade WhatsApp (Meta Cloud API oficial),
multi-tenant, consumida por API. O Tendi é o primeiro cliente integrador.

> **Estado atual:** fundação do monorepo. API com health checks e autenticação
> por API key (`GET /v1/me`), worker com
> fila de verificação, CI e stack de deploy. Schema multi-tenant com RLS no
> banco. Tenants, conexões, mensagens e webhooks ainda **não** estão implementados.

## Estrutura

```
apps/
  api/       Fastify. Recebe chamadas dos integradores e webhooks da Meta.
  worker/    BullMQ. Processa filas (envio, eventos, entregas de webhook).
packages/
  core/      Contrato de ambiente, logger com redação, Redis, nomes de filas.
deploy/      Stack de produção: Caddy + api + worker + Redis.
```

## Desenvolvimento

Requisitos: Node 24, pnpm 10 (via `corepack enable`) e Docker.

```bash
cp .env.example .env
docker compose up -d        # Redis local
pnpm install
pnpm dev:api                # http://localhost:8080/health/ready
pnpm dev:worker
```

Antes de abrir um PR:

```bash
pnpm check                  # build + typecheck + lint + test
```

## Produção (VPS)

```bash
cd deploy
cp .env.example .env        # preencher API_DOMAIN e ACME_EMAIL; chmod 600
docker compose --env-file .env up -d --build
```

Somente o Caddy publica portas (80/443). Redis fica em rede interna sem rota
para a internet. O registro DNS do domínio precisa apontar para a VPS antes
da primeira subida, para o Caddy emitir o certificado.

## Regras do projeto

- Nenhum segredo no Git. Variáveis novas entram no contrato em
  `packages/core/src/env.ts` no mesmo PR que passa a usá-las.
- Logs nunca carregam tokens: ver `REDACTED_LOG_PATHS` em
  `packages/core/src/logger.ts`.
- Mudanças chegam à `main` apenas por PR com CI verde.
