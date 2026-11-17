# Integrator authentication and transaction isolation

Status: design baseline; no production implementation or database migration in this branch yet.

## Verified baseline

- Fastify API currently exposes health endpoints only.
- The private `onconnect` schema and RLS migration are in `main`.
- `onconnect_app` has client-scoped policies based on `onconnect.client_id`.
- `onconnect_system` is a distinct database role; never expose it to ordinary API requests.
- The current API has no PostgreSQL client, API-key authentication, or tenant authorization layer.

## Security boundary

A PostgreSQL custom setting is **not** an authenticated identity. A database session
running as `onconnect_app` can change `onconnect.client_id`; RLS therefore
prevents accidental cross-client reads but cannot contain arbitrary SQL execution
under that role. Never claim otherwise.

## Implementation requirements

1. Authenticate a caller's API key against a securely stored verifier; derive
   `client_id` from the credential record, not headers, body, query, or path.
   Use a fixed-length secret and a safe hash/verification scheme; avoid
   logging raw keys or database secrets.
2. Authenticate before resolving a tenant. Resolve tenant identity by
   `(client_id, external_id)` or an equivalent scoped lookup. Never trust
   a bare `tenant_id` as authorization.
3. Centralize all tenant-scoped database work in one transaction helper:
   `BEGIN`, set a transaction-local client context using a parameterized
   `select set_config('onconnect.client_id', $1, true)`, execute the callback
   on that **same connection**, then `COMMIT` or `ROLLBACK`. Always release
   the connection; never use session-scoped `SET`.
4. The transaction helper must not accept `client_id` from user-controlled
   request fields. A trusted authentication principal is the only source.
5. Run system jobs with separate credentials and narrowly defined access;
   never make the system role available to request handlers.
6. Database connection credentials must be limited to the minimum required
   permissions. Prevent untrusted SQL fragments, dynamic identifiers, and
   arbitrary query execution from API parameters.
7. Treat SQL injection or arbitrary SQL execution under `onconnect_app` as
   a potential cross-client breach even with RLS. Evaluate stronger isolation
   (role separation, restricted stored procedures, or per-client credentials)
   before claiming resistance to a compromised application role.

## Acceptance tests (PostgreSQL 17 disposable database)

- Valid credential A derives A; forged `client_id` request fields cannot select B.
- Revoked, expired, malformed and unknown credentials fail authentication.
- A cannot resolve B's tenant; two tenants under A remain distinct.
- A failed transaction rolls back and does not leak context to a reused pooled connection.
- Concurrent transactions on different pooled connections do not exchange context.
- A missing principal cannot start tenant-scoped work.
- `onconnect_app` cannot become `onconnect_system` by role membership or custom settings.
- Document and test the remaining threat: arbitrary SQL as `onconnect_app`
  can set the custom GUC and is outside the protection guaranteed by current RLS.

## API-key design (step 2)

- Key format `onc_<16 alnum prefix>_<43 char base64url secret>` (32 random bytes).
  Accepted only as `Authorization: Bearer <key>`; query, body and custom headers are ignored.
- Stored verifier: `hmac-sha256$<base64url>` of `prefix.secret`, keyed with
  `API_KEY_PEPPER` (server env only). A database dump alone cannot test guesses,
  and a verifier cannot be copied to another prefix. Rotating the pepper
  invalidates every key.
- Lookup before the client is known goes through
  `onconnect.lookup_api_credential(prefix)`: a `SECURITY DEFINER` function owned
  by the read-only `onconnect_auth` role, exact match only, executable only by
  `onconnect_app`. Unknown prefixes still cost one HMAC comparison.
- The secret is verified before revocation, expiry or client status, so a
  caller without the secret learns nothing about the credential. Every
  failure returns the same 401; the reason is logged server-side only.
- The only place an `AuthenticatedClientId` is minted is `createApiKeyAuthenticator`,
  from a verified credential row.
- Keys are issued with `pnpm --filter @on-connect/api issue-key -- <client-uuid> <label> [expires-at]`,
  which prints the key once and the `INSERT` to run as `onconnect_system`.
- Remaining threat: arbitrary SQL as `onconnect_app` can call the lookup for a
  known prefix and read its verifier. Without the pepper it is not usable.

## Tenant access (step 3)

- Routes under `/v1/tenants` (all behind the API key):
  `GET /` (paginated by `after`, `limit` ≤ 100), `GET /:externalId`,
  `PUT /:externalId` (create or replace; 201 on create),
  `PUT /:externalId/commercial-status`.
- Tenants are addressed only by the integrator's `external_id`. The client
  comes from the transaction context: every statement in
  `packages/core/src/tenants.ts` uses `onconnect.current_client_id()` and none
  takes a client id parameter. RLS is the second line, not the only one.
- Another client's tenant and a missing tenant both return the same 404.
- Request schemas reject unknown fields (`removeAdditional: false`), so a
  forged `clientId` in a body is a 400, never silently dropped.
- Every write adds an `audit_log` entry with `actor_type = 'client'` and the
  credential id; an unchanged commercial status writes nothing.
- Credential `scopes` are not enforced yet: any active key of a client can
  read and write that client's tenants.

## Delivery sequence

1. Introduce a database adapter and a transaction helper with integration tests.
2. Implement API-key authentication and authenticated principal.
3. Add tenant-scoped repository access and negative authorization tests.
4. Review privilege boundaries and run CI before PR review.

Do not apply migrations to Supabase, merge, or deploy as part of this plan.

## WhatsApp Web connections (provider `whatsapp_web`)

- Routes (API key required): `POST/GET /v1/tenants/:externalId/connections`,
  `GET /v1/connections/:id`, `GET /v1/connections/:id/qr`,
  `POST /v1/connections/:id/pairing-code`, `POST /v1/connections/:id/restart`,
  `DELETE /v1/connections/:id`. Each route first loads the connection in a
  client-scoped transaction; another client's connection is a 404, and no QR,
  pairing code or logout is ever produced for it.
- Creation enforces the tenant's commercial/operational status and
  `max_connections` (default 0) under a row lock on the tenant.
- The `sessions` process owns the sockets and runs as `onconnect_system`
  (`SYSTEM_DATABASE_URL`), never reachable from requests. API → sessions
  commands go through the `sessions` BullMQ queue; QR and pairing codes come
  back through Redis keys with short TTLs.
- Session keys live in local Redis, one hash per connection, each value
  AES-256-GCM sealed with `SESSION_STATE_KEY` and bound to its field name.
- A phone number can be live in one WhatsApp Web connection only (partial
  unique index); a second link is logged out with `number_already_connected`.
- Risk accepted by the product owner: the provider is unofficial and violates
  WhatsApp's terms; numbers can be banned. No ban-evasion features are built.

## Messages (WhatsApp Web)

- `POST /v1/connections/:id/messages` (`to` digits with country code, `text` ≤ 4096,
  optional `clientReference`) stores the message and its `message_jobs` row in one
  client-scoped transaction and returns 202. The sessions process sends it.
- Sends are idempotent: the WhatsApp message id is stored before the send and
  reused on retry; messages past `sending` are never sent again. Outbound jobs
  retry for about 10 minutes, then the message is marked `failed`.
- Outbox replay: every minute the sessions process re-enqueues jobs stuck in
  `pending`/`enqueued` for over 2 minutes; the queue job id (= message id) dedupes.
- Inbound text/media descriptions from 1:1 chats are stored once per WhatsApp id
  (groups, broadcasts and own-device echoes are ignored). Media is described,
  not downloaded. With LID addressing the phone comes from `remoteJidAlt`; when
  WhatsApp withholds it, the opaque id is stored and flagged.
- Status only moves forward (sent → delivered → read). Every inbound message and
  status change writes a `webhook_events` row in the same statement.
- Message content is never written to logs.

## Webhooks

- `/v1/webhook-endpoints` (create, list, read, patch, delete, `rotate-secret`) is
  client-scoped like every other route; another client's endpoint answers 404.
  At most 10 endpoints per client.
- The signing secret (`whsec_...`) is returned only on creation and rotation. It is
  stored AES-256-GCM sealed with `WEBHOOK_SECRET_KEY`, bound to the endpoint id,
  in the existing `secret_*` columns. The audit log records the URL host only,
  since a path or query may carry the integrator's own token.
- Fan-out is a trigger on `webhook_events`: the deliveries are inserted in the
  same transaction as the event, under the inserting role's RLS, so an event
  only reaches endpoints of its own client (optionally filtered by tenant and
  event type). Paused endpoints accumulate deliveries; disabled ones get none.
- The worker (as `onconnect_system`) claims due deliveries with
  `FOR UPDATE SKIP LOCKED` and a 60 s lease (the attempt counter), signs
  `"<t>.<body>"` with HMAC-SHA256 (`OnConnect-Signature: t=..,v1=..`) and POSTs it.
  Only 2xx counts; redirects are failures. 12 attempts over about 28 hours, then
  `dead`. An endpoint failing for 24 h on at least 10 attempts is `disabled`;
  `PATCH status=active` re-enables it and retries waiting deliveries at once.
- SSRF: URLs must be `https`, without credentials, and not name a private or
  single-label host. The worker resolves the host itself at connect time and
  refuses the request if any address is private (loopback, RFC 1918, link-local,
  CGNAT, ULA, mapped), so DNS rebinding cannot reach Redis or other containers.
  One connection per delivery, no redirects, 10 s deadline, response body unread.
- Delivery logs carry ids, attempt, status code and error code only — never the
  body or the URL.
- `connection.status` events come from a trigger on `connections` (status
  changes only), so no code path can change a status without the event.

## D-API compatible layer

- `/compat/dapi/api/v1` reuses the same API keys and the same client-scoped
  repositories; the key is read only from `Authorization` (bare or Bearer).
  Another client's session id answers "Session not found" (404).
- `session_key` is unique per client among live connections; two clients may
  use the same session id. Each session gets its own tenant (external id = the
  session id, one connection).
- The D-API webhook URL may carry the integrator's secret in its path (that is
  how D-API webhooks are authenticated). It is stored like any endpoint URL,
  only its host is audited, and it is never logged.
