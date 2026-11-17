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
| 2. Mensagens | `messages.received` (inclusive enviadas pelo celular), `message.delivered`, `message.read`, `POST /messages/send/text` | a fazer |
| 3. Mídia | receber e enviar imagem, vídeo, áudio, documento; avatar do contato | a fazer |
| 4. Painel super admin | clientes, tenants, conexões, QR, logs de webhook | a fazer |

**Não apontar o Tendi para cá antes da fase 2**: sem ela, a conexão funciona,
mas as mensagens não chegam no formato da D-API.

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
`disconnected`, com o motivo em `reason`). O Tendi autentica pelo segredo no
caminho da URL; o cabeçalho `OnConnect-Signature` também vai, para quem quiser
verificar. Novas tentativas e desativação seguem `docs/webhooks.md`.

## Para trocar o Tendi de provedor (depois da fase 2)

No Tendi, `DAPI_BASE_URL` é uma constante em `apps/web/lib/dapi.ts`; ela precisa
virar variável de ambiente. Então, por ambiente: `DAPI_BASE_URL` com a URL acima
e `DAPI_API_KEY` com a chave do On Connect. Cada cliente lê o QR de novo (as
sessões da D-API não migram). Voltar é trocar as duas variáveis de volta.
