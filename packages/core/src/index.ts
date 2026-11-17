export {
  EnvValidationError,
  loadApiEnv,
  loadSessionsEnv,
  loadWorkerEnv,
  type ApiEnv,
  type BaseEnv,
  type SessionsEnv,
  type WorkerEnv,
} from "./env.js";
export {
  REDACTED_LOG_PATHS,
  createLogger,
  loggerOptions,
  type Logger,
  type LoggerConfig,
} from "./logger.js";
export { createRedis, pingRedis, type RedisClient, type RedisConfig } from "./redis.js";
export {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  type QueueName,
  type SystemPingJob,
} from "./queues.js";

export {
  ClientTransaction,
  withClientTransaction,
  type AuthenticatedClientId,
  type AuthenticatedPrincipal,
  type DatabaseConnection,
  type DatabasePool,
  type QueryResult,
} from "./db-transaction.js";

export { createPostgresPool } from "./postgres.js";

export {
  MIN_PEPPER_LENGTH,
  createApiKeyAuthenticator,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  verifyApiKeySecret,
  type ApiKeyAuthenticator,
  type ApiKeyAuthenticatorOptions,
  type ApiKeyPrincipal,
  type AuthFailureReason,
  type AuthResult,
  type CredentialRecord,
  type CredentialStore,
  type IssuedApiKey,
  type ParsedApiKey,
} from "./api-keys.js";
export { createPostgresCredentialStore } from "./credential-store.js";

export {
  COMMERCIAL_STATUSES,
  findTenant,
  listTenants,
  setCommercialStatus,
  upsertTenant,
  type AuditActor,
  type CommercialStatus,
  type Tenant,
  type TenantInput,
  type TenantPage,
} from "./tenants.js";

export {
  ConnectionLimitError,
  createConnection,
  findConnection,
  listConnections,
  retireConnection,
  type Connection,
  type ConnectionStatus,
} from "./connections.js";
export { createSecretBox, type SecretBox } from "./secret-box.js";
export {
  PAIRING_CODE_TTL_SECONDS,
  QR_TTL_SECONDS,
  createSessionGateway,
  sessionKeys,
  type SessionCommand,
  type SessionGateway,
  type SessionGatewayOptions,
} from "./sessions.js";
