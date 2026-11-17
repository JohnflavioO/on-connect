export {
  EnvValidationError,
  loadApiEnv,
  loadWorkerEnv,
  type ApiEnv,
  type BaseEnv,
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
