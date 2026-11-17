import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createApiKeyAuthenticator, generateApiKey } from "../src/api-keys.js";
import { createPostgresCredentialStore } from "../src/credential-store.js";
import { withClientTransaction } from "../src/db-transaction.js";
import { createPostgresPool } from "../src/postgres.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1";
const PEPPER = "integration-pepper-integration-pepper-01";
const A = "aaaaaaaa-0000-4000-8000-000000000021";
const B = "bbbbbbbb-0000-4000-8000-000000000021";
const SUSPENDED = "cccccccc-0000-4000-8000-000000000021";

describe.skipIf(!enabled)("API key authentication against PostgreSQL 17", () => {
  const admin = new Pool({ host: "localhost", user: "postgres", password: "postgres", database: "postgres" });
  const pool = createPostgresPool({
    host: "localhost", user: "onconnect_app", password: "integration-only",
    database: "postgres", max: 2,
  });
  const store = createPostgresCredentialStore(pool);
  const auth = createApiKeyAuthenticator({ store, pepper: PEPPER });

  const keyA = generateApiKey(PEPPER);
  const keyB = generateApiKey(PEPPER);
  const revoked = generateApiKey(PEPPER);
  const expired = generateApiKey(PEPPER);
  const suspended = generateApiKey(PEPPER);

  beforeAll(async () => {
    await admin.query("ALTER ROLE onconnect_app LOGIN PASSWORD 'integration-only'");
    await admin.query(
      `INSERT INTO onconnect.clients (id, slug, name, status) VALUES
         ($1, 'auth-a', 'A', 'active'), ($2, 'auth-b', 'B', 'active'),
         ($3, 'auth-suspended', 'S', 'suspended')`,
      [A, B, SUSPENDED],
    );
    const insert = (client: string, key: typeof keyA, extra = "") =>
      admin.query(
        `INSERT INTO onconnect.client_api_credentials
           (client_id, label, key_prefix, secret_hash, revoked_at, expires_at)
         VALUES ($1, 'integration', $2, $3, ${extra || "NULL, NULL"})`,
        [client, key.prefix, key.secretHash],
      );
    await insert(A, keyA);
    await insert(B, keyB);
    await insert(A, revoked, "now(), NULL");
    await insert(A, expired, "NULL, now() - interval '1 minute'");
    await insert(SUSPENDED, suspended);
  });

  afterAll(async () => {
    await pool.close();
    await admin.end();
  });

  it("derives each client from its own key", async () => {
    const a = await auth.authenticate(keyA.key);
    const b = await auth.authenticate(keyB.key);
    expect(a.ok && a.principal.clientId).toBe(A);
    expect(b.ok && b.principal.clientId).toBe(B);
  });

  it.each([
    ["revoked", () => revoked.key],
    ["expired", () => expired.key],
    ["client_inactive", () => suspended.key],
    ["unknown", () => generateApiKey(PEPPER).key],
    ["invalid_secret", () => `onc_${keyA.prefix}_${"A".repeat(43)}`],
  ] as const)("rejects a %s credential", async (reason, key) => {
    expect(await auth.authenticate(key())).toEqual({ ok: false, reason });
  });

  it("scopes the authenticated principal's transaction to its own client", async () => {
    const result = await auth.authenticate(keyA.key);
    if (!result.ok) throw new Error(`authentication failed: ${result.reason}`);
    const visible = await withClientTransaction(pool, result.principal, async (tx) =>
      (await tx.query<{ client_id: string }>(
        "SELECT DISTINCT client_id FROM onconnect.client_api_credentials",
      )).rows.map((row) => row.client_id));
    expect(visible).toEqual([A]);
  });

  it("records usage under the client's own context", async () => {
    const lastUsed = await admin.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM onconnect.client_api_credentials WHERE key_prefix = $1",
      [keyA.prefix],
    );
    expect(lastUsed.rows[0]?.last_used_at).toBeInstanceOf(Date);
  });

  it("does not let the application role read credentials without a context", async () => {
    const connection = await pool.connect();
    try {
      const rows = await connection.query("SELECT 1 FROM onconnect.client_api_credentials");
      expect(rows.rows).toEqual([]);
    } finally {
      connection.release();
    }
  });
});
