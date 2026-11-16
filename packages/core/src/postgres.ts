import { Pool, type PoolClient, type PoolConfig, type QueryResult as PgQueryResult } from "pg";
import type { DatabaseConnection, DatabasePool, QueryResult } from "./db-transaction.js";

/** Adapter for the node-postgres driver. No queries run outside checked-out clients. */
export function createPostgresPool(config: PoolConfig): DatabasePool & { close(): Promise<void> } {
  const pool = new Pool(config);
  return {
    async connect(): Promise<DatabaseConnection> {
      const client: PoolClient = await pool.connect();
      return {
        async query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
          const result: PgQueryResult = await client.query(sql, params ? [...params] : []);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
        release(destroy = false): void {
          client.release(destroy);
        },
      };
    },
    close: () => pool.end(),
  };
}
