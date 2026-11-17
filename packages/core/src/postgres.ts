import { Pool, type PoolClient, type PoolConfig, type QueryResult as PgQueryResult } from "pg";
import type { DatabaseConnection, DatabasePool, QueryResult } from "./db-transaction.js";

/** Adapter for the node-postgres driver. No queries run outside checked-out clients. */
export function createPostgresPool(
  config: PoolConfig,
  onIdleError?: (error: Error) => void,
): DatabasePool & { close(): Promise<void> } {
  const pool = new Pool(config);
  // An idle client can fail (server restart, network drop). Without a
  // listener node-postgres re-emits it as an uncaught error and kills the process.
  pool.on("error", (error) => {
    onIdleError?.(error);
  });
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
