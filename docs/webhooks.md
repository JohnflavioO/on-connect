# Webhooks para o integrador

O On Connect avisa o integrador por `POST` HTTPS quando chega uma mensagem ou
quando muda o status de uma mensagem enviada. Cada aviso é assinado com um
segredo do endpoint.

## Cadastrar um endpoint

```http
POST /v1/webhook-endpoints
Authorization: Bearer onc_...
Content-Type: application/json

{
  "url": "https://tendi.example.com/webhooks/onconnect",
  "tenantExternalId": null,
  "eventTypes": ["message.received", "message.status"]
}
```

- `url`: precisa ser `https`, sem usuário/senha, e apontar para um host público.
- `tenantExternalId`: `null` (ou ausente) recebe eventos de todos os tenants;
  um valor limita a um tenant.
- `eventTypes`: vazio (ou ausente) recebe todos os tipos.

A resposta (201) traz o endpoint e o campo `secret` (`whsec_...`). **O segredo
só aparece aqui** (e ao rotacionar); guarde-o no Tendi. Limite: 10 endpoints
por cliente.

Outras rotas:

| Método e rota | Uso |
| --- | --- |
| `GET /v1/webhook-endpoints` | lista (sem segredo) |
| `GET /v1/webhook-endpoints/:id` | lê um endpoint |
| `PATCH /v1/webhook-endpoints/:id` | muda `url`, `eventTypes` ou `status` (`active`/`paused`) |
| `POST /v1/webhook-endpoints/:id/rotate-secret` | gera um segredo novo; o antigo deixa de valer na hora |
| `DELETE /v1/webhook-endpoints/:id` | remove o endpoint e as entregas pendentes |

## O que chega

```http
POST /webhooks/onconnect
Content-Type: application/json
OnConnect-Event-Id: 3f0c...            (id do evento; use para deduplicar)
OnConnect-Event-Type: message.received
OnConnect-Delivery-Id: 9a1b...
OnConnect-Delivery-Attempt: 1
OnConnect-Signature: t=1795430400,v1=5d2c...

{
  "id": "3f0c...",
  "type": "message.received",
  "occurredAt": "2026-11-17T12:00:00.000Z",
  "tenantExternalId": "loja-1",
  "connectionId": "2376...",
  "data": { ... }
}
```

`data` de `message.received`:

```json
{
  "messageId": "uuid da mensagem no On Connect",
  "connectionId": "uuid",
  "tenantExternalId": "loja-1",
  "from": "5511999999999",
  "contactName": "Ana",
  "content": { "type": "text", "text": "olá" }
}
```

`data` de `message.status` (para mensagens enviadas pela API):

```json
{
  "messageId": "uuid",
  "connectionId": "uuid",
  "clientReference": "id do Tendi enviado no POST, ou null",
  "status": "sent | delivered | read | failed",
  "error": "só quando status = failed"
}
```

## Verificar a assinatura

`OnConnect-Signature` é `t=<segundos unix>,v1=<hex>`, onde `v1` é o
HMAC-SHA256, com o segredo inteiro (`whsec_...`) como chave, de
`"<t>.<corpo bruto>"`. Use o corpo **exatamente como recebido**, antes de
qualquer parse de JSON.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Rejeite (401) quando a assinatura não bate ou o `t` está a mais de 5 minutos
do relógio.

## Respostas, novas tentativas e desativação

- Responda **2xx** rápido (até 10 s) e processe depois. Qualquer outro status,
  redirecionamento, timeout ou erro de rede conta como falha.
- Falhas são tentadas de novo com espera crescente: 10 s, 30 s, 1 min, 5 min,
  15 min, 30 min, 1 h, 2 h, 4 h, 8 h, 12 h (12 tentativas, cerca de 28 h). Depois
  disso a entrega é descartada.
- A entrega é **pelo menos uma vez**: o mesmo evento pode chegar mais de uma
  vez. Deduplique por `OnConnect-Event-Id`.
- A **ordem não é garantida**. Para status, considere a progressão
  `sent → delivered → read` e ignore um status anterior ao que já tem.
- Um endpoint que falha sem nenhum sucesso por 24 h (com pelo menos 10
  tentativas) passa para `disabled` e para de receber eventos novos. Depois de
  corrigir, `PATCH {"status": "active"}` reativa e reenvia na hora as entregas
  que ainda estavam aguardando nova tentativa.
- `PATCH {"status": "paused"}` segura as entregas; ao voltar para `active`,
  elas são enviadas.
