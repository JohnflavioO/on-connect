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

## Delivery sequence

1. Introduce a database adapter and a transaction helper with integration tests.
2. Implement API-key authentication and authenticated principal.
3. Add tenant-scoped repository access and negative authorization tests.
4. Review privilege boundaries and run CI before PR review.

Do not apply migrations to Supabase, merge, or deploy as part of this plan.
