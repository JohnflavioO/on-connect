import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresPool } from "../src/postgres.js";
import { withClientTransaction, type AuthenticatedPrincipal } from "../src/db-transaction.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1";
const A = "aaaaaaaa-0000-4000-8000-000000000011";
const B = "bbbbbbbb-0000-4000-8000-000000000011";
const principal = (id: string): AuthenticatedPrincipal =>
  ({ clientId: id }) as AuthenticatedPrincipal;

describe.skipIf(!enabled)("PostgreSQL 17 transaction isolation", () => {
  const admin = new Pool({ host: "localhost", user: "postgres", password: "postgres", database: "postgres" });
  const pool = createPostgresPool({
    host: "localhost", user: "onconnect_app", password: "integration-only",
    database: "postgres", max: 1,
  });

  beforeAll(async () => {
    await admin.query("ALTER ROLE onconnect_app LOGIN PASSWORD 'integration-only'");
    await admin.query(
      "INSERT INTO onconnect.clients (id, slug, name) VALUES ($1, 'integration-a', 'A'), ($2, 'integration-b', 'B')",
      [A, B],
    );
  });

  afterAll(async () => {
    await pool.close();
    await admin.end();
  });

  it("enforces RLS using a transaction-local principal and resets reused connections", async () => {
    const read = async (id: string) =>
      withClientTransaction(pool, principal(id), async (tx) => {
        const result = await tx.query<{ id: string }>("SELECT id FROM onconnect.clients");
        return result.rows.map((row) => row.id);
      });
    expect(await read(A)).toEqual([A]);
    expect(await read(B)).toEqual([B]);
    expect(await read(A)).toEqual([A]);
  });

  it("rolls back a failed transaction before reusing the connection", async () => {
    await expect(withClientTransaction(pool, principal(A), async (tx) => {
      await tx.query("SELECT 1");
      throw new Error("forced failure");
    })).rejects.toThrow("forced failure");
    const ids = await withClientTransaction(pool, principal(B), async (tx) =>
      (await tx.query<{ id: string }>("SELECT id FROM onconnect.clients")).rows.map((r) => r.id));
    expect(ids).toEqual([B]);
  });

  it("does not leak transaction-local context into a new checkout", async () => {
    await withClientTransaction(pool, principal(A), async (tx) => {
      expect((await tx.query("SELECT current_setting('onconnect.client_id', true) AS id")).rows)
        .toEqual([{ id: A }]);
    });
    const connection = await pool.connect();
    try {
      const result = await connection.query<{ id: string | null }>(
        "SELECT nullif(current_setting('onconnect.client_id', true), '') AS id",
      );
      expect(result.rows[0]?.id).toBeNull();
      const visible = await connection.query("SELECT id FROM onconnect.clients");
      expect(visible.rows).toEqual([]);
    } finally {
      connection.release();
    }
  });
});
