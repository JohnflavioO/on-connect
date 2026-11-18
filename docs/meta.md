# Meta WhatsApp Cloud API (provedor oficial)

O On Connect envia e recebe pela API oficial da Meta ao lado do WhatsApp Web.
Para o integrador (Tendi) uma conexão Meta é igual às outras: mesmas rotas
`/v1`, mesmos eventos de webhook (`message.received`, `message.status`,
`connection.status`). A diferença é como o número é ligado: não há QR, o
número já está cadastrado no WhatsApp Manager da Meta.

## Fase 1 (esta)

- Um token de usuário do sistema para todos os números (no servidor, `META_ACCESS_TOKEN`).
- Conexões Meta criadas só pelo painel (**Conexões › Nova conexão Meta**), com o
  `phone_number_id` e, se quiser, o WABA ID.
- Envio de texto e mídia (imagem, vídeo, áudio, documento). Mídia vai por link: a Meta baixa a URL.
- Recebimento de texto, mídia (baixada para o cofre, com link assinado, como no WhatsApp Web),
  localização, contato, reação, botões e listas.
- Status `sent`, `delivered`, `read` e `failed`. Uma falha leva o código da Meta,
  por exemplo `meta_131047` (janela de 24 h fechada).
- O número é conferido com a Meta ao criar, em **Verificar na Meta** e a cada 6 horas
  (nome verificado, qualidade, limite de conversas).

Ainda não: modelos (templates) e a regra da janela de 24 h (fase 2), Embedded Signup e
token por número (fase 3), mensagens enviadas pelo app WhatsApp Business no mesmo número.

## Como funciona

| Caminho | Quem faz |
|---|---|
| Meta → `POST /webhooks/meta` | `api` confere a assinatura `X-Hub-Signature-256` com `META_APP_SECRET` e põe o corpo na fila `meta-webhooks` |
| fila `meta-webhooks` → banco | `sessions` (onconnect_system) grava mensagens e status, baixa mídias para o cofre |
| integrador → `POST /v1/connections/:id/messages` | outbox (`message_jobs`) → `sessions` → Graph API `/{phone_number_id}/messages` |
| painel → **Verificar na Meta** | comando `start` → `sessions` consulta `GET /{phone_number_id}` |

- O id da mensagem (wamid) é dado pela Meta ao aceitar o envio; é gravado logo depois.
  Um status que chega antes disso faz a fila tentar de novo em seguida.
- Erros permanentes da Meta (número inválido, janela fechada, permissão) marcam a
  mensagem como `failed` na hora. Limites de vazão e falhas da Meta são tentados de novo
  (até 8 vezes, como no WhatsApp Web).
- A Graph API não tem chave de idempotência: se o banco cair no instante entre a Meta
  aceitar e o On Connect gravar, a nova tentativa pode enviar a mensagem duas vezes.
- `GET /v1/connections/:id/qr` e `pairing-code` respondem `409 not_supported_for_provider`.
- **Desconectar** (ou `DELETE`) numa conexão Meta só faz o On Connect parar de usar o número;
  nada muda na Meta.

## Configurar na Meta (uma vez)

1. Em [developers.facebook.com](https://developers.facebook.com), crie um app do tipo
   **Business** e adicione o produto **WhatsApp**. A Meta dá um número de teste.
2. **Token permanente**: no Business Manager, em *Usuários do sistema*, crie um usuário do
   sistema (Admin), atribua o app e a conta do WhatsApp, e gere um token com
   `whatsapp_business_messaging` e `whatsapp_business_management`, sem expiração.
3. **App Secret**: no app, *Configurações do app › Básico › Chave secreta do app*.
4. **Webhook** (em *WhatsApp › Configuração*):
   - URL de retorno: `https://<API_DOMAIN>/webhooks/meta`
   - Token de verificação: o mesmo valor de `META_VERIFY_TOKEN` (abaixo)
   - Depois de verificar, assine o campo **messages**.
5. Anote o **phone_number_id** e o **WABA ID** do número (em *Configuração da API*). Não são
   segredos.

## Configurar na VPS

No `deploy/.env` (o usuário digita os valores; não vão para o Git nem para conversas):

```
META_APP_SECRET=<chave secreta do app>
META_VERIFY_TOKEN=<texto aleatório, ex.: openssl rand -hex 24>
META_ACCESS_TOKEN=<token permanente do usuário do sistema>
# META_GRAPH_VERSION=v23.0
```

Depois: `docker compose --env-file .env up -d --build api sessions admin`. Sem essas variáveis
a rota `/webhooks/meta` responde 404 e as conexões Meta ficam em erro `meta_not_configured`;
o WhatsApp Web continua igual.

Observação: na verificação do webhook a Meta manda o token de verificação na URL. O log da
`api` o esconde; o log de acesso da Caddy ainda mostra a URL. Esse token só serve para a Meta
confirmar a URL: não permite falsificar webhooks (isso exige o App Secret).

## Códigos de status no painel

| Motivo | Significado |
|---|---|
| `checking_meta` | Criada, aguardando a primeira conferência |
| `meta_not_configured` | `META_ACCESS_TOKEN` não está no servidor |
| `meta_unreachable` | A Meta não respondeu (tenta de novo em 6 h ou em **Verificar na Meta**) |
| `meta_190` | Token inválido ou expirado |
| `meta_100`, `meta_10`, `meta_200` | `phone_number_id` não existe ou o token não tem acesso a ele |

## Número oficial num workspace do Tendi (camada D-API)

O Tendi fala com o On Connect pela camada compatível com a D-API, em que cada
workspace é uma sessão `tendi-<id do workspace>`. Um número oficial entra nessa
mesma sessão:

1. No **Console do Tendi**, na ficha da empresa, em **Conexões › Número oficial**:
   **Reservar sessão** (se ainda não houver WhatsApp) e **Copiar código**.
2. No **painel do On Connect**, **Conexões › Nova conexão Meta**: escolha o cliente,
   **Workspace do Tendi**, cole o código, informe `phone_number_id` e WABA. Se o
   workspace já usa QR Code, marque **Substituir a conexão atual**: a conexão por QR é
   encerrada (o número sai do WhatsApp Web) e o oficial entra no lugar, numa transação.
3. O Tendi passa a ver a sessão como oficial: `GET /sessions/:id` e `GET .../qr`
   respondem `connectionType: "official"` e `provider: "meta_cloud"` (campos a mais, que
   clientes D-API ignoram); o QR vem `null`. O envio responde com o id da Meta (wamid),
   o mesmo que chega depois nos status.

Os avisos (`message.received`, `message.status`, `connection.status`) saem no formato
D-API com o `sessionId` da sessão, como para as sessões por QR.

## Cadastro incorporado (Embedded Signup): o cliente conecta o próprio número

O cliente do Tendi clica em **Conectar WhatsApp oficial**, entra com o Facebook dele,
escolhe a empresa e o número, e confirma o código que a Meta manda. Cada cliente fica com a
própria conta do WhatsApp na Meta (a Meta cobra dele).

| Passo | Quem |
|---|---|
| Janela da Meta (`FB.login` com o `config_id`) | navegador, no Tendi |
| `POST /compat/dapi/api/v1/sessions/:id/meta-signup` `{code, wabaId, phoneNumberId, replace}` | Tendi → `api` |
| Cria a conexão Meta na sessão (substitui a anterior se `replace`) | `api` (`attachMetaToSession`) |
| Troca o código pelo token do cliente, guarda cifrado (`provider_credentials`, com o PIN), liga a conta ao app (`subscribed_apps`), registra o número (`/register`), confere | `sessions` (comando `meta-signup`) |

- O código vale 5 minutos e é de uso único: vai pela fila só para o `sessions`, o job some do
  Redis ao terminar, e nunca é registrado em log.
- O token do cliente é cifrado com a `SESSION_STATE_KEY` (a mesma do estado do WhatsApp Web),
  ligado à conexão (não serve para outra). Envio, mídia e conferência desse número usam esse
  token; números da conta do On Connect continuam com `META_ACCESS_TOKEN`.
- A `api` espera até 45 s pela conclusão; depois disso responde 504 e o status da sessão mostra
  o resultado.
- Variáveis no `sessions`: `META_APP_ID` e `META_APP_SECRET` (juntas). Sem elas, a rota responde
  502 `meta_signup_not_configured`.
- Na Meta: Login do Facebook para Empresas › Configurações › configuração com a variação
  **WhatsApp Embedded Signup** (o `config_id` vai para o Tendi); domínio do Tendi em
  **Allowed domains**; webhook com os campos `messages` e `account_update`.
- Exige que a empresa seja Provedor de Tecnologia para clientes de fora. Antes disso, em modo de
  desenvolvimento, só administradores e testadores do app conseguem concluir o cadastro.
