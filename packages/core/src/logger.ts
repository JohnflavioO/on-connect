import { pino, type Logger, type LoggerOptions } from "pino";

/**
 * Paths removed from every log line. Tokens, secrets and signatures must
 * never reach the log stream, whatever object a caller happens to log.
 */
export const REDACTED_LOG_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-on-connect-signature"]',
  'res.headers["set-cookie"]',
  ...[
    "authorization",
    "password",
    "secret",
    "token",
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "client_secret",
    "clientSecret",
    "app_secret",
    "appSecret",
    "apiKey",
    "api_key",
  ].flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

/**
 * Request paths that are credentials themselves (media capability links)
 * are logged without their token.
 */
export function redactUrl(url: string): string {
  return url.replace(/^\/media\/[^/?#]+/, "/media/[REDACTED]");
}

export interface LoggerConfig {
  level: string;
  /** Process name attached to every line, e.g. "api" or "worker". */
  service: string;
}

export function loggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level,
    base: { service: config.service },
    redact: { paths: [...REDACTED_LOG_PATHS], censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return pino(loggerOptions(config));
}

export type { Logger };
