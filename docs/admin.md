# Painel super admin

`https://onconnect.tendidesk.com.br/admin` — só para o dono da plataforma.

## Telas

O console tem navegação responsiva, atalhos para conexões, clientes e webhooks,
e apresenta o instante em que a página foi consultada. Atualize a página ou use
**Atualizar** para consultar os dados novamente.

### Visão geral e conexões

- **Dashboard:** mensagens em períodos de 7, 14 ou 30 dias, com calendário no
  horário de São Paulo. Os cartões e o gráfico usam o mesmo intervalo.
- **Gráfico:** clique nas legendas para mostrar/ocultar cada série; a tabela
  em **Ver dados por dia** mantém os números disponíveis sem depender do gráfico.
- **Conectividade:** mostra quantas conexões estão ativas no momento da consulta;
  o percentual não é uma métrica histórica de disponibilidade.
- **Webhooks:** fila aguardando entrega, desistidas nas últimas 24 horas e
  endpoints desativados, com acesso à central de entregas.
- **Conexões:** busca literal por sessão, número ou nome, combinada com filtros
  de status e slug do cliente. A consulta mantém o limite de 500 registros.
  Cada linha abre a página existente com QR, reinício e desconexão auditados.

### Página da conexão (abas)

Inspirada nas configurações de instância da D-API, `/admin/connections/:id`:

- **Conexão**: status com motivo, número, cliente, organização, QR que atualiza
  sozinho e as ações **Reiniciar** e **Desconectar**. Na *Zona de perigo*,
  **Excluir conexão**: exige digitar `EXCLUIR`, desconecta o número e remove a
  conexão das listas (exclusão lógica: mensagens e auditoria ficam). Gera o
  evento `connection.status` e a auditoria `connection.deleted`.
- **Histórico**: mudanças de status (de → para, motivo, quando) vindas dos eventos
  `connection.status`, e as últimas 20 entregas de webhook daquela sessão.
- **Desenvolvedor**: Session ID (camada D-API), id da conexão, organização e
  cliente, com botão Copiar. A API key **não** aparece: o On Connect guarda só um
  resumo cifrado; ela é mostrada uma vez, ao ser criada.
- **Configurações**: grupos e status são sempre ignorados. Em conexões WhatsApp Web,
  **Rejeitar chamadas** recusa ofertas de voz e vídeo recebidas ao vivo. **Marcar como lido
  ao responder** confirma a leitura das mensagens anteriores do mesmo contato registradas
  pelo On Connect, após um envio de texto ou mídia pela API. O Baileys respeita a
  configuração de privacidade dos recibos do WhatsApp.
- As duas opções começam desligadas e mudanças valem sem reiniciar a conexão. O painel
  registra as alterações como `connection.settings_updated`.

### Endpoint de webhook

Em **Webhooks**, o botão **Gerenciar** abre `/admin/webhooks/endpoints/:id`:
destino (sem o caminho), formato, fila, falhas e as ações **Pausar** (as entregas
ficam guardadas) ou **Reativar** (zera as falhas e reenvia o que esperava).
Endpoints **On Connect** escolhem os eventos (todos ou alguns). Nos de
**Compatibilidade (D-API)** os eventos são fixos: a camada compatível os redefine
quando o integrador conecta uma sessão (e também volta a ativá-los).

### Monitoramento

`/admin/monitoring` responde "a plataforma está saudável agora?", no estilo do
Monitoramento da D-API. Períodos: **Ao vivo (1 h)** (padrão, recarrega a cada
30 s enquanto a aba está visível), 24 horas, 7 dias e 30 dias.

- **Avisos no topo**, críticos primeiro: nenhuma conexão conectada, conexões
  fora do ar, endpoint de webhook desativado, entregas de webhook abaixo de 90%
  de sucesso ou abandonadas, envios com falha e mensagens presas na fila há mais
  de 5 minutos. Sem problemas, aparece "Tudo funcionando".
- **Cartões** com selo Saudável / Atenção / Crítico / Sem dados:
  - *Conexões*: conectadas/total agora e quedas no período.
  - *Envios*: % de sucesso, falhas e mensagens presas (5% ou mais de falha, ou
    10 presas, é crítico).
  - *Webhooks*: % de entregas com sucesso no período, novas tentativas,
    desistências e tempo médio entre o evento e a entrega (abaixo de 90% ou
    endpoint desativado é crítico; abaixo de 99% ou alguma desistência, atenção).
  - *Recebimento*: mensagens recebidas no período e quando chegou a última.
- **Gráficos**: tráfego (recebidas, enviadas, webhooks entregues) e falhas por
  origem (webhooks, envios, quedas de conexão), em intervalos de 1 min (1 h),
  1 h (24 h), 6 h (7 dias) ou 1 dia (30 dias). As legendas ligam/desligam séries.
- **Conexões fora do ar agora**, com o motivo e há quanto tempo.

As regras de saúde estão em `apps/admin/src/monitoring.ts` (`evaluateHealth`).
Erros HTTP da API ainda não entram: a API não guarda essas contagens.

Os dados são consultados no banco; a página não exibe conteúdo de mensagens.
O formato de payload `dapi` aparece como **Compatibilidade**, sem alterar o
contrato enviado aos integradores.

### Histórico de webhooks

Cada evento recebido ou atualização de status pode gerar uma entrega: crescer
o histórico é esperado. O histórico tem páginas de 25 registros, botões
Anterior/Próxima e uma tabela de altura limitada com cabeçalho fixo. Nenhum
registro é excluído pela paginação.

O filtro inicial mostra pendentes e problemas. É possível selecionar todas as
entregas ou um status específico, combinar com tipo de evento e buscar pelo
cliente/sessão. Ao filtrar, a navegação volta à primeira página; ao paginar,
os filtros são preservados. A coluna **Resultado** mostra o código HTTP ou a
falha registrada. HTTP 200 com uma tentativa indica entrega concluída pelo
receptor, não uma repetição por erro.

As páginas seguem a última atualização, com desempate pelo id. Como o histórico
é vivo, novas entregas ou mudanças de status podem deslocar registros entre
páginas durante a navegação.

| Tela | O que tem |
| --- | --- |
| Dashboard | conexões ativas, mensagens enviadas e recebidas (7 dias, com gráfico), clientes e tenants, entregas de webhook aguardando e desistidas, endpoints desativados |
| Conexões | todas as conexões de todos os clientes, filtro por status e cliente; na conexão: dados, QR que atualiza sozinho, **Reiniciar** (gera QR) e **Desconectar** |
| Clientes | integradores (Tendi etc.), criar cliente; no cliente: API keys (gerar, revogar) e tenants |
| Webhooks | endpoints (destino mostrado sem o caminho, que pode ter segredo), reativar desativado; entregas com problema, erro e **Reenviar** |

O painel nunca mostra conteúdo de mensagem, só contagens. Toda ação (reiniciar,
desconectar, criar cliente, gerar/revogar chave, reenviar, reativar) vai para
`audit_log` com `actor_type = 'admin'` e o usuário do login.

## Segurança

- A landing pública abre em `/` e o formulário de entrada em `/admin/login`.
  Use o mesmo usuário `ADMIN_USER` e a senha correspondente ao hash bcrypt
  `ADMIN_PASSWORD_HASH`. A sessão expira em 8 horas e o botão **Sair** a revoga.
- **Segredo entre Caddy e painel** (`ADMIN_PROXY_SECRET`): a Caddy o injeta nas
  rotas do site e do painel. O serviço exige esse cabeçalho e verifica a sessão
  nas rotas privadas. A rota da API remove os cabeçalhos internos do painel.
- **CSRF**: formulários exigem `Origin` igual a `ADMIN_ORIGIN`. O cookie de
  sessão é HTTPS, HttpOnly e SameSite=Lax. O Redis armazena o hash do token e
  limita as tentativas de entrada por endereço de origem.
- Processo próprio (`admin`), com `onconnect_system` (vê todos os clientes): a
  API pública continua sem esse acesso.
- HTML escapado por padrão; CSP sem scripts inline; `no-store`; `DENY` em frames.
- Nova API key aparece uma vez, no corpo da página (nunca numa URL).

## Configurar na VPS (uma vez, como root)

1. Hash da senha — você digita a senha duas vezes; ela não aparece nem fica no histórico:
   ```bash
   docker run --rm -it caddy:2-alpine caddy hash-password
   ```
2. No `deploy/.env` (o hash **entre aspas simples**, porque tem `$`):
   ```
   ADMIN_USER=seu-usuario
   ADMIN_PASSWORD_HASH='<hash do passo 1>'
   ADMIN_PROXY_SECRET=<openssl rand -hex 32>
   ```
3. Deploy: `docker compose --env-file .env up -d --build admin caddy`.
   Em instalações existentes, os três valores atuais podem ser reutilizados.
