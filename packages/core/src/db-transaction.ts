/**
 * Database-agnostic transaction boundary. A real PostgreSQL pool adapter must
 * implement these interfaces; the caller cannot supply a client id as SQL.
 */
export interface QueryResult<Row = unknown> {
  rows: Row[];
  rowCount: number | null;
}

export interface DatabaseConnection {
  query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
  release(): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseConnection>;
}

declare const authenticatedClientBrand: unique symbol;

/** Only the authentication module should construct this value. */
export type AuthenticatedClientId = string & {
  readonly [authenticatedClientBrand]: true;
};

export interface AuthenticatedPrincipal {
  readonly clientId: AuthenticatedClientId;
}

export class ClientTransaction {
  constructor(private readonly connection: DatabaseConnection) {}

  query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>> {
    return this.connection.query<Row>(sql, params);
  }
}

/**
 * Never use SET (session scope). The context must be transaction-local and
 * every statement must execute on the same checked-out connection.
 *
 * SECURITY: a custom GUC is not a trust boundary against arbitrary SQL
 * execution as onconnect_app; authentication and parameterized SQL are required.
 */
export async function withClientTransaction<T>(
  pool: DatabasePool,
  principal: AuthenticatedPrincipal,
  callback: (tx: ClientTransaction) => Promise<T>,
): Promise<T> {
  if (!principal || typeof principal.clientId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal.clientId)) {
    throw new Error("Authenticated client identity required");
  }

  const connection = await pool.connect();
  let began = false;
  try {
    await connection.query("BEGIN");
    began = true;
    await connection.query(
      "SELECT set_config('onconnect.client_id', $1, true)",
      [principal.clientId],
    );
    const result = await callback(new ClientTransaction(connection));
    await connection.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        await connection.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Transaction and rollback failed");
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}
