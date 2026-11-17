import type { ConnectionStatus, DatabasePool } from "@on-connect/core";

export interface ConnectedAccount {
  /** e.g. 5511999999999:12@s.whatsapp.net */
  jid: string;
  name: string | null;
}

export interface SessionRow {
  id: string;
  provider: string;
  status: ConnectionStatus;
  deleted: boolean;
}

/** Durable connection state, written with the onconnect_system role. */
export interface SessionStore {
  load(connectionId: string): Promise<SessionRow | null>;
  /** WhatsApp Web connections that should have an open socket. */
  liveIds(): Promise<string[]>;
  /** Ignored for retired (soft-deleted) connections. */
  setStatus(connectionId: string, status: ConnectionStatus, reason: string | null): Promise<void>;
  markConnected(connectionId: string, account: ConnectedAccount): Promise<"ok" | "number_in_use">;
}

/**
 * Digits of the phone number in a WhatsApp JID ("5511...:12@s.whatsapp.net").
 * Only the s.whatsapp.net domain carries a phone number; an "@lid" id is an
 * opaque WhatsApp identifier and must not be stored as one.
 */
export function phoneFromJid(jid: string): string | null {
  const [user = "", domain] = jid.split("@");
  if (domain !== "s.whatsapp.net") return null;
  const digits = user.split(":")[0] ?? "";
  return /^[0-9]{5,20}$/.test(digits) ? digits : null;
}

export function createPostgresSessionStore(pool: DatabasePool): SessionStore {
  const run = async <Row>(sql: string, params: readonly unknown[]) => {
    const connection = await pool.connect();
    try {
      return await connection.query<Row>(sql, params);
    } finally {
      connection.release();
    }
  };

  return {
    async load(connectionId) {
      const result = await run<{ id: string; provider: string; status: ConnectionStatus; deleted: boolean }>(
        `SELECT id, provider, status, deleted_at IS NOT NULL AS deleted
           FROM onconnect.connections WHERE id = $1`,
        [connectionId],
      );
      return result.rows[0] ?? null;
    },

    async liveIds() {
      const result = await run<{ id: string }>(
        `SELECT id FROM onconnect.connections
          WHERE provider = 'whatsapp_web' AND deleted_at IS NULL
            AND status IN ('connecting', 'connected')
          ORDER BY created_at`,
        [],
      );
      return result.rows.map((row) => row.id);
    },

    async setStatus(connectionId, status, reason) {
      await run(
        `UPDATE onconnect.connections
            SET status = $2,
                status_reason = $3,
                status_changed_at = CASE WHEN status IS DISTINCT FROM $2 THEN now()
                                         ELSE status_changed_at END
          WHERE id = $1 AND deleted_at IS NULL`,
        [connectionId, status, reason],
      );
    },

    async markConnected(connectionId, account) {
      try {
        await run(
          `UPDATE onconnect.connections
              SET status = 'connected', status_reason = NULL, status_changed_at = now(),
                  wa_jid = $2, display_phone_number = $3, verified_name = $4,
                  last_health_check_at = now()
            WHERE id = $1 AND deleted_at IS NULL`,
          [connectionId, account.jid, phoneFromJid(account.jid), account.name],
        );
        return "ok";
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return "number_in_use";
        throw error;
      }
    },
  };
}
