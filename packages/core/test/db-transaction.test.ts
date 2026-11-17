import { describe, expect, it, vi } from "vitest";
import {
  withClientTransaction,
  type AuthenticatedPrincipal,
  type DatabaseConnection,
  type DatabasePool,
} from "../src/db-transaction.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000001";
const principal = (id: string): AuthenticatedPrincipal =>
  ({ clientId: id }) as AuthenticatedPrincipal;

function fixture() {
  const calls: Array<{ sql: string; params?: readonly unknown[] | undefined }> = [];
  const release = vi.fn();
  const connection: DatabaseConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    release,
  };
  const connect = vi.fn(async () => connection);
  const pool: DatabasePool = { connect };
  return { calls, release, pool, connect };
}

describe("withClientTransaction", () => {
  it("sets the authenticated client locally before executing queries", async () => {
    const f = fixture();
    await withClientTransaction(f.pool, principal(A), async (tx) => {
      await tx.query("SELECT 1");
    });
    expect(f.calls.map((c) => c.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('onconnect.client_id', $1, true)",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(f.calls[1]?.params).toEqual([A]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("rolls back failed callbacks and releases the connection", async () => {
    const f = fixture();
    await expect(withClientTransaction(f.pool, principal(A), async () => {
      throw new Error("failure");
    })).rejects.toThrow("failure");
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("rejects missing or malformed identities before checking out a connection", async () => {
    const f = fixture();
    await expect(withClientTransaction(f.pool, principal("not-a-uuid"), async () => 1))
      .rejects.toThrow("Authenticated client identity required");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("resets context per transaction even when the pool reuses one connection", async () => {
    const f = fixture();
    await withClientTransaction(f.pool, principal(A), async () => 1);
    await withClientTransaction(f.pool, principal(B), async () => 2);
    expect(f.calls.filter((c) => c.sql.startsWith("SELECT set_config"))
      .map((c) => c.params?.[0])).toEqual([A, B]);
    expect(f.release).toHaveBeenCalledTimes(2);
  });
});
