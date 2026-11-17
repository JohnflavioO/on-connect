# Camada compatível com a D-API

O Tendi foi integrado à D-API. Para trocar de provedor sem reescrever essa
integração, o On Connect responde às mesmas rotas e envia os webhooks no mesmo
formato, em:

```
https://onconnect.tendidesk.com.br/compat/dapi/api/v1
```

A autenticação é a API key do On Connect, como na D-API: `Authorization: <key>`
(sem `Bearer`; com `Bearer` também funciona). Tudo por baixo passa pelos mesmos
repositórios da API nativa: o cliente vem só da chave, e a sessão de outro
cliente responde "Session not found".

## Fases

| Fase | O que entra | Estado |
| --- | --- | --- |
| 1. Conexão | rotas de sessão e QR; evento `connection.status` | **pronta** |
| 2. Mensagens | `messages.received` (inclusive enviadas pelo celular), `message.delivered`, `message.read`, `POST /messages/send/text` | **pronta** |
| 3. Mídia | baixar mídia recebida (`media_url`), enviar imagem, vídeo, áudio, documento; avatar do contato | a fazer |
| 4. Painel super admin | clientes, tenants, conexões, QR, logs de webhook | a fazer |

**Recomendado trocar o Tendi só depois da fase 3.** Com a fase 2, texto vai e
volta, mas: mídia recebida chega sem `media_url` (o Inbox mostra o tipo, sem o
arquivo), envio de mídia e avatar respondem 404, e edições de mensagem não são
repassadas.

## Rotas (fase 1)

| Rota | Comportamento |
| --- | --- |
| `POST /sessions` | Cria a sessão (ou reaproveita, se já existe) e inicia o QR. `sessionId` é escolhido pelo integrador (`^[A-Za-z0-9._-]{1,100}$`). Cria, se preciso, um tenant com `external_id = sessionId` e 1 conexão. `webhookUrl` vira o webhook D-API do cliente. `connectionMode: "pair"` ainda não é aceito. |
| `GET /sessions/:id` | `{ success, data: { sessionId, status, phone, phoneNumber, displayName } }`. `status`: `connecting`, `connected`, `disconnected`, `error`. |
| `GET /sessions/:id/connect` | Inicia a sessão se não estiver conectada. |
| `GET /sessions/:id/qr` | `{ success, data: { status, qrCode, qrCodeImage } }` (imagem PNG em data URL). Conectada: `status: "connected"` e QR nulo. Sem QR ainda: 404 `QR code not available`. |
| `POST /sessions/:id/disconnect` | Desloga o número; a sessão continua e `/connect` gera um QR novo. |
| `DELETE /sessions/:id` | Remove a sessão (o mesmo id pode ser criado de novo). |
| `POST /sessions/:id/webhook` | Troca a URL do webhook D-API do cliente. |
| `POST /sessions/:id/webhook-config` | Aceito por compatibilidade; os eventos enviados são os suportados pela fase atual. |

Erros seguem o envelope da D-API: `{ "success": false, "error": "...", "statusCode": 404 }`.

## Envio (fase 2)

`POST /messages/send/text` com `{ sessionId, to, text }` (`to` com DDI, só
dígitos, ou um JID `...@s.whatsapp.net`). A API gera na hora o id do WhatsApp
(`3EB0...`), grava a mensagem com ele e o devolve como `messageId`,
`data.messageId` e `data.key.id`: é por esse id que chegam depois
`message.delivered` e `message.read`. A chamada espera até 10 s pelo envio:

- enviada: 200 com `status: "sent"`;
- falhou nesse tempo: 502 com o envelope de erro;
- ainda na fila (sessão reconectando): 200 com `status: "queued"`; o envio
  segue em segundo plano por até ~10 min, como na API nativa.

Sessão inexistente: 404 `Session not found`; não conectada: 400
`Session is not connected`.

## Webhook no formato D-API

O cliente tem **um** webhook D-API (o último `webhookUrl` informado vale para
todas as sessões, como o Tendi usa). O corpo é:

```json
{
  "event": "connection.status",
  "sessionId": "tendi-<organização>",
  "traceId": "<id da entrega>",
  "data": { "status": "connected", "phone": "5585999990000", "reason": null }
}
```

`status` é `connected`, `connecting` ou `disconnected` (erros viram
`disconnected`, com o motivo em `reason`).

`messages.received` (fase 2), para mensagem recebida ou enviada pelo próprio
celular (`fromMe: true`, com a outra ponta em `to`):

```json
{
  "event": "messages.received",
  "sessionId": "tendi-<organização>",
  "data": {
    "id": "<id do WhatsApp>", "type": "text", "message": "olá", "fromMe": false,
    "from": { "jid": "5585999990000@s.whatsapp.net", "name": "Ana" }, "to": {},
    "from_name": "Ana", "timestamp": 1794916800, "is_group": false
  }
}
```

`type` segue a D-API (`text`, `image`, `video`, `audio`, `ptt`, `document`,
`sticker`, `location`, `contact`, `reaction`); mídia vem com `media_data`
(`mimetype`, `filename`, `caption`) e `media_url: null` até a fase 3. Sem o
número (só o id opaco `@lid`), o `jid` vai opaco e o cliente da D-API ignora.
`message.delivered` / `message.read` levam `{ "message_id": "<id do WhatsApp>" }`.
Mensagens enviadas pela API não voltam como `messages.received` (a resposta do
envio já trouxe o id).

O Tendi autentica pelo segredo no
caminho da URL; o cabeçalho `OnConnect-Signature` também vai, para quem quiser
verificar. Novas tentativas e desativação seguem `docs/webhooks.md`.

## Para trocar o Tendi de provedor (de preferência depois da fase 3)

No Tendi, `DAPI_BASE_URL` é uma constante em `apps/web/lib/dapi.ts`; ela precisa
virar variável de ambiente. Então, por ambiente: `DAPI_BASE_URL` com a URL acima
e `DAPI_API_KEY` com a chave do On Connect. Cada cliente lê o QR de novo (as
sessões da D-API não migram). Voltar é trocar as duas variáveis de volta.
