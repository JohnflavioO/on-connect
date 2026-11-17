import type { ApiKeyPrincipal, CredentialRecord, CredentialStore } from "./api-keys.js";
import { withClientTransaction, type DatabasePool } from "./db-transaction.js";

interface LookupRow {
  credential_id: string;
  client_id: string;
  secret_hash: string;
  scopes: string[] | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  client_status: string;
}

/** Skip the write when the credential was already marked recently. */
const LAST_USED_RESOLUTION = "5 minutes";

/**
 * Reads credentials through onconnect.lookup_api_credential, the only path
 * that can see a credential before its client is known. Usage bookkeeping
 * runs as an ordinary client-scoped transaction under RLS.
 */
export function createPostgresCredentialStore(pool: DatabasePool): CredentialStore {
  return {
    async findByPrefix(prefix) {
      const connection = await pool.connect();
      try {
        const result = await connection.query<LookupRow>(
          "SELECT * FROM onconnect.lookup_api_credential($1)",
          [prefix],
        );
        const row = result.rows[0];
        if (!row) return null;
        const record: CredentialRecord = {
          credentialId: row.credential_id,
          clientId: row.client_id,
          secretHash: row.secret_hash,
          scopes: row.scopes ?? [],
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
          clientStatus: row.client_status,
        };
        return record;
      } finally {
        connection.release();
      }
    },

    async recordUse(principal: ApiKeyPrincipal) {
      await withClientTransaction(pool, principal, async (tx) => {
        await tx.query(
          `UPDATE onconnect.client_api_credentials
              SET last_used_at = now()
            WHERE id = $1
              AND (last_used_at IS NULL OR last_used_at < now() - $2::interval)`,
          [principal.credentialId, LAST_USED_RESOLUTION],
        );
      });
    },
  };
}
