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
  redactUrl,
  type Logger,
  type LoggerConfig,
} from "./logger.js";
export { createRedis, pingRedis, type RedisClient, type RedisConfig } from "./redis.js";
export {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  type OutboundJob,
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
export { createSecretBox, type SealedParts, type SecretBox } from "./secret-box.js";
export {
  MAX_WEBHOOK_ENDPOINTS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SECRET_KEY_VERSION,
  WEBHOOK_SIGNATURE_HEADER,
  WebhookEndpointError,
  checkWebhookUrl,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  findWebhookEndpoint,
  generateWebhookSecret,
  isPublicAddress,
  listWebhookEndpoints,
  rotateWebhookSecret,
  signWebhook,
  updateWebhookEndpoint,
  verifyWebhookSignature,
  webhookSecretContext,
  type WebhookEndpoint,
  type WebhookEndpointInput,
  type WebhookEndpointPatch,
  type WebhookEndpointStatus,
  type WebhookPayloadFormat,
  type WebhookEventType,
  type WebhookUrlProblem,
} from "./webhooks.js";
export {
  PAIRING_CODE_TTL_SECONDS,
  QR_TTL_SECONDS,
  createSessionGateway,
  sessionKeys,
  type SessionCommand,
  type SessionGateway,
  type SessionGatewayOptions,
} from "./sessions.js";

export {
  MessageRejectedError,
  createOutboundMessage,
  createOutboundText,
  findMessage,
  generateWhatsappMessageId,
  type OutboundContent,
  listMessages,
  toMessage,
  type Message,
  type MessageContent,
  type MessagePage,
  type MessageStatus,
} from "./messages.js";
export { OUTBOUND_ATTEMPTS, createOutboundQueue, enqueueOutbound } from "./sessions.js";
export {
  MEDIA_CONTENT_TYPES,
  createMediaVault,
  type MediaVault,
  type MediaVaultOptions,
  type StoredMedia,
} from "./media.js";
export { fetchPublicBytes, publicOnlyLookup, type FetchedBytes } from "./safe-http.js";
export {
  CompatSessionError,
  DAPI_COMPAT_EVENTS,
  DAPI_SESSION_ID,
  deleteCompatSession,
  findCompatSession,
  setCompatWebhook,
  upsertCompatSession,
  type CompatSession,
} from "./dapi-compat.js";
