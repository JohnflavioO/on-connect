import { z } from "zod";

/**
 * Environment contract shared by every On Connect process.
 *
 * Only variables that are actually consumed today are declared here. Each
 * module (database, Meta, service auth) adds its own variables in the pull
 * request that introduces the code using them, so a missing secret always
 * fails at boot instead of at the first request.
 */
const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, "REDIS_URL must start with redis:// or rediss://"),
});

const encryptionKey = (name: string) =>
  z.string().refine((value) => Buffer.from(value, "base64").length === 32, {
    message: `${name} must be 32 bytes in base64 (openssl rand -base64 32)`,
  });

/**
 * An optional variable that docker compose passes as "" when it is not set
 * in deploy/.env: empty means absent.
 */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const postgresUrl = (name: string) =>
  z.string().regex(/^postgres(ql)?:\/\//, `${name} must start with postgres:// or postgresql://`);

/**
 * 32 random bytes, base64. Encrypts webhook signing secrets in the database.
 * The API seals them, the worker opens them to sign deliveries. Losing it
 * forces every endpoint secret to be rotated.
 */
const webhookSecretKey = encryptionKey("WEBHOOK_SECRET_KEY");

/**
 * Received media (see media.ts). The sessions process writes files, the API
 * serves them; both need the key and the same directory (a shared volume).
 * Losing the key makes every stored file unreadable and every media link dead.
 */
const mediaSettings = {
  MEDIA_KEY: encryptionKey("MEDIA_KEY"),
  MEDIA_DIR: z.string().min(1).default("/data/media"),
};

const apiSchema = baseSchema.extend({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_API_BASE_URL: z.url(),
  /** Requests allowed per client IP per minute before a 429 is returned. */
  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** Connection string for the onconnect_app role (never postgres/service_role). */
  DATABASE_URL: postgresUrl("DATABASE_URL"),
  /** Server-side HMAC key for API-key verifiers. Rotating it invalidates every key. */
  API_KEY_PEPPER: z.string().min(32, "API_KEY_PEPPER must have at least 32 characters"),
  WEBHOOK_SECRET_KEY: webhookSecretKey,
  ...mediaSettings,
  /**
   * Meta WhatsApp Cloud API webhooks (/webhooks/meta). Both or neither: the
   * app secret checks each delivery's signature, the verify token answers
   * Meta's subscription check. Without them the route answers 404.
   */
  META_APP_SECRET: optional(z.string().min(16)),
  META_VERIFY_TOKEN: optional(z.string().min(16)),
}).refine((env) => (env.META_APP_SECRET === undefined) === (env.META_VERIFY_TOKEN === undefined), {
  message: "Set META_APP_SECRET and META_VERIFY_TOKEN together, or neither",
  path: ["META_VERIFY_TOKEN"],
});

const workerSchema = baseSchema.extend({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(10),
  /** onconnect_system: the worker delivers webhooks of every client. */
  SYSTEM_DATABASE_URL: postgresUrl("SYSTEM_DATABASE_URL"),
  WEBHOOK_SECRET_KEY: webhookSecretKey,
});

const sessionsSchema = baseSchema.extend({
  /**
   * Connection string for onconnect_system: the sessions process updates
   * connections of every client, so it cannot run under client-scoped RLS.
   */
  SYSTEM_DATABASE_URL: postgresUrl("SYSTEM_DATABASE_URL"),
  /** 32 random bytes, base64. Encrypts WhatsApp Web session keys stored in Redis. */
  SESSION_STATE_KEY: encryptionKey("SESSION_STATE_KEY"),
  /** Upper bound on simultaneously open WhatsApp sockets in this process. */
  SESSIONS_MAX: z.coerce.number().int().min(1).max(2_000).default(200),
  ...mediaSettings,
  /** Base of the media links handed to integrators (the API's public URL). */
  PUBLIC_API_BASE_URL: z.url(),
  /** Larger media is not downloaded (the message still arrives, without a link). */
  MEDIA_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(104_857_600).default(33_554_432),
  /** Stored media older than this is deleted (whole months at a time). */
  MEDIA_RETENTION_DAYS: z.coerce.number().int().min(7).max(3_650).default(90),
  /**
   * Meta WhatsApp Cloud API: permanent token of a system user with
   * whatsapp_business_messaging and whatsapp_business_management. Without it
   * Meta connections stay in error ("meta_not_configured").
   */
  META_ACCESS_TOKEN: optional(z.string().min(20)),
  /**
   * Meta Embedded Signup (customers connect their own number): the app id and
   * app secret swap the signup code for the customer's token. Both or neither.
   */
  META_APP_ID: optional(z.string().regex(/^[0-9]{5,30}$/, "Expected the numeric Meta app id")),
  META_APP_SECRET: optional(z.string().min(16)),
  /** Graph API version, e.g. v23.0. Meta retires versions about two years after release. */
  META_GRAPH_VERSION: z.preprocess((value) => (value === "" ? undefined : value),
    z.string().regex(/^v[0-9]+\.[0-9]+$/, "Expected a version like v23.0").default("v23.0")),
}).refine((env) => (env.META_APP_ID === undefined) === (env.META_APP_SECRET === undefined), {
  message: "Set META_APP_ID and META_APP_SECRET together, or neither",
  path: ["META_APP_SECRET"],
});

/**
 * Super-admin panel. Caddy adds ADMIN_PROXY_SECRET to the requests it
 * forwards. The panel verifies the administrator credentials.
 */
const adminSchema = baseSchema.extend({
  ADMIN_HOST: z.string().min(1).default("0.0.0.0"),
  ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  /** onconnect_system: the panel sees every client. */
  SYSTEM_DATABASE_URL: postgresUrl("SYSTEM_DATABASE_URL"),
  /** Needed to issue API keys from the panel. */
  API_KEY_PEPPER: z.string().min(32, "API_KEY_PEPPER must have at least 32 characters"),
  ADMIN_PROXY_SECRET: z.string().min(32, "ADMIN_PROXY_SECRET must have at least 32 characters"),
  /** e.g. https://onconnect.tendidesk.com.br: forms are accepted only from it. */
  ADMIN_ORIGIN: z.url(),
  ADMIN_USER: z.string().min(1).max(100),
  ADMIN_PASSWORD_HASH: z.string().regex(/^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/, "Expected a bcrypt hash"),
});

export type BaseEnv = z.infer<typeof baseSchema>;
export type AdminEnv = z.infer<typeof adminSchema>;

export function loadAdminEnv(source: EnvSource = process.env): AdminEnv {
  return parse(adminSchema, source);
}
export type ApiEnv = z.infer<typeof apiSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;
export type SessionsEnv = z.infer<typeof sessionsSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

type EnvSource = Record<string, string | undefined>;

function parse<T>(schema: z.ZodType<T>, source: EnvSource): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  // Report variable names and reasons only. Values are never echoed, so a
  // malformed secret cannot leak into logs through a boot failure.
  const issues = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  throw new EnvValidationError(issues);
}

export function loadApiEnv(source: EnvSource = process.env): ApiEnv {
  return parse(apiSchema, source);
}

export function loadWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return parse(workerSchema, source);
}

export function loadSessionsEnv(source: EnvSource = process.env): SessionsEnv {
  return parse(sessionsSchema, source);
}
