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

Os dados são consultados no banco; a página não exibe conteúdo de mensagens.
O formato de payload `dapi` aparece como **Compatibilidade**, sem alterar o
contrato enviado aos integradores.

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

- **Login na Caddy** (`basic_auth`), usuário `ADMIN_USER` e senha guardada só
  como hash bcrypt (`ADMIN_PASSWORD_HASH`). Para sair, feche o navegador.
- **Segredo entre Caddy e painel** (`ADMIN_PROXY_SECRET`): a Caddy o injeta em
  toda requisição para `/admin`; o painel responde 404 a qualquer coisa sem ele,
  então nenhum outro container da rede chega ao painel pulando o login. A rota
  da API remove esses cabeçalhos.
- **CSRF**: formulários só são aceitos com `Origin` igual ao do painel
  (`ADMIN_ORIGIN`); o navegador reenviaria a senha num formulário de outro site.
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
