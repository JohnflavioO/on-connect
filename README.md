# On Connect

Plataforma independente de conectividade WhatsApp, multi-tenant, consumida por
API. O Tendi é o primeiro cliente integrador. O primeiro provedor é o WhatsApp
Web (não oficial, vinculado por QR code ou código de pareamento); a Meta Cloud
API oficial entra depois, atrás da mesma API.

> **Estado atual:** autenticação por API key (`GET /v1/me`), tenants
> (`/v1/tenants`) e conexões WhatsApp Web (`/v1/tenants/:id/connections`,
> `/v1/connections/:id/qr`, `/pairing-code`, `/restart`). Envio e recebimento
> de mensagens e webhooks para o integrador ainda **não** estão implementados.
>
> **Risco do provedor não oficial:** viola os termos de uso do WhatsApp; o
> número pode ser banido e o protocolo pode mudar sem aviso.

## Estrutura

```
apps/
  api/       Fastify. Recebe chamadas dos integradores.
  sessions/  Baileys. Mantém os sockets do WhatsApp Web (uma réplica só).
  worker/    BullMQ. Processa filas (envio, eventos, entregas de webhook).
packages/
  core/      Ambiente, logger com redação, Redis, filas, banco, auth, repositórios.
deploy/      Stack de produção: Caddy + api + sessions + worker + Redis.
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
