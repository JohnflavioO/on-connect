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

const apiSchema = baseSchema.extend({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_API_BASE_URL: z.url(),
  /** Requests allowed per client IP per minute before a 429 is returned. */
  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** Connection string for the onconnect_app role (never postgres/service_role). */
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must start with postgres:// or postgresql://"),
  /** Server-side HMAC key for API-key verifiers. Rotating it invalidates every key. */
  API_KEY_PEPPER: z.string().min(32, "API_KEY_PEPPER must have at least 32 characters"),
});

const workerSchema = baseSchema.extend({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(10),
});

const sessionsSchema = baseSchema.extend({
  /**
   * Connection string for onconnect_system: the sessions process updates
   * connections of every client, so it cannot run under client-scoped RLS.
   */
  SYSTEM_DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "SYSTEM_DATABASE_URL must start with postgres:// or postgresql://"),
  /** 32 random bytes, base64. Encrypts WhatsApp Web session keys stored in Redis. */
  SESSION_STATE_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "SESSION_STATE_KEY must be 32 bytes in base64 (openssl rand -base64 32)",
    }),
  /** Upper bound on simultaneously open WhatsApp sockets in this process. */
  SESSIONS_MAX: z.coerce.number().int().min(1).max(2_000).default(200),
});

export type BaseEnv = z.infer<typeof baseSchema>;
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
