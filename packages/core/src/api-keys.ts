import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { AuthenticatedClientId, AuthenticatedPrincipal } from "./db-transaction.js";

/**
 * API keys issued to integrators.
 *
 * Format: `onc_<prefix>_<secret>`
 *   prefix  16 alphanumeric characters. Public lookup handle, stored in clear.
 *   secret  32 random bytes, base64url (43 characters). Never stored.
 *
 * Both parts have a fixed length, so the format is unambiguous even though
 * base64url may itself contain `_`.
 *
 * The database keeps only HMAC-SHA256(pepper, prefix + secret). The secret
 * is high-entropy, so a slow password hash adds nothing; the pepper lives
 * only in the server environment, so a database dump alone cannot be used
 * to test guesses. Binding the prefix into the MAC stops a verifier from
 * being copied onto another credential row.
 */
const API_KEY_PATTERN = /^onc_([A-Za-z0-9]{16})_([A-Za-z0-9_-]{43})$/;
const PREFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PREFIX_LENGTH = 16;
const HASH_SCHEME = "hmac-sha256";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MIN_PEPPER_LENGTH = 32;

export interface ParsedApiKey {
  readonly prefix: string;
  readonly secret: string;
}

export function parseApiKey(raw: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  return { prefix: match[1], secret: match[2] };
}

function assertPepper(pepper: string): void {
  if (pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error(`API key pepper must have at least ${MIN_PEPPER_LENGTH} characters`);
  }
}

function mac(pepper: string, prefix: string, secret: string): Buffer {
  return createHmac("sha256", pepper).update(`${prefix}.${secret}`).digest();
}

export function hashApiKeySecret(pepper: string, prefix: string, secret: string): string {
  assertPepper(pepper);
  return `${HASH_SCHEME}$${mac(pepper, prefix, secret).toString("base64url")}`;
}

/** Constant-time check of a presented key against a stored verifier. */
export function verifyApiKeySecret(
  pepper: string,
  key: ParsedApiKey,
  storedHash: string,
): boolean {
  const expected = mac(pepper, key.prefix, key.secret);
  const [scheme, encoded, extra] = storedHash.split("$");
  if (scheme !== HASH_SCHEME || encoded === undefined || extra !== undefined) return false;
  const stored = Buffer.from(encoded, "base64url");
  if (stored.length !== expected.length) return false;
  return timingSafeEqual(stored, expected);
}

export interface IssuedApiKey {
  /** Shown to the integrator exactly once. */
  readonly key: string;
  readonly prefix: string;
  readonly secretHash: string;
}

export function generateApiKey(pepper: string): IssuedApiKey {
  assertPepper(pepper);
  // randomInt is uniform, so every character is unbiased.
  let prefix = "";
  for (let i = 0; i < PREFIX_LENGTH; i += 1) {
    prefix += PREFIX_ALPHABET.charAt(randomInt(PREFIX_ALPHABET.length));
  }
  const secret = randomBytes(32).toString("base64url");
  return {
    key: `onc_${prefix}_${secret}`,
    prefix,
    secretHash: hashApiKeySecret(pepper, prefix, secret),
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface CredentialRecord {
  readonly credentialId: string;
  readonly clientId: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly clientStatus: string;
}

export interface CredentialStore {
  /** Exact-match lookup by public prefix. Must not perform pattern matching. */
  findByPrefix(prefix: string): Promise<CredentialRecord | null>;
  /** Best-effort bookkeeping, run under the authenticated client's context. */
  recordUse?(principal: ApiKeyPrincipal): Promise<void>;
}

export interface ApiKeyPrincipal extends AuthenticatedPrincipal {
  readonly credentialId: string;
  readonly scopes: readonly string[];
}

/** Reasons are for server logs only. Callers always receive one generic 401. */
export type AuthFailureReason =
  | "missing"
  | "malformed"
  | "unknown"
  | "invalid_secret"
  | "revoked"
  | "expired"
  | "client_inactive";

export type AuthResult =
  | { readonly ok: true; readonly principal: ApiKeyPrincipal }
  | { readonly ok: false; readonly reason: AuthFailureReason };

export interface ApiKeyAuthenticatorOptions {
  store: CredentialStore;
  pepper: string;
  now?: () => Date;
  onRecordUseError?: (error: unknown) => void;
}

export interface ApiKeyAuthenticator {
  authenticate(rawKey: string | undefined): Promise<AuthResult>;
}

export function createApiKeyAuthenticator(options: ApiKeyAuthenticatorOptions): ApiKeyAuthenticator {
  const { store, pepper } = options;
  assertPepper(pepper);
  const now = options.now ?? (() => new Date());
  // Compared against when the prefix is unknown, so a miss costs the same
  // HMAC work as a hit and response time does not reveal valid prefixes.
  const decoyHash = hashApiKeySecret(pepper, "0".repeat(PREFIX_LENGTH), "0".repeat(43));

  return {
    async authenticate(rawKey) {
      if (rawKey === undefined || rawKey === "") return { ok: false, reason: "missing" };
      const key = parseApiKey(rawKey);
      if (!key) return { ok: false, reason: "malformed" };

      const record = await store.findByPrefix(key.prefix);
      if (!record) {
        verifyApiKeySecret(pepper, key, decoyHash);
        return { ok: false, reason: "unknown" };
      }
      // The secret is checked before any status, so a caller without it
      // learns nothing about whether a credential is revoked or expired.
      if (!verifyApiKeySecret(pepper, key, record.secretHash)) {
        return { ok: false, reason: "invalid_secret" };
      }
      if (record.revokedAt !== null) return { ok: false, reason: "revoked" };
      if (record.expiresAt !== null && record.expiresAt.getTime() <= now().getTime()) {
        return { ok: false, reason: "expired" };
      }
      if (record.clientStatus !== "active") return { ok: false, reason: "client_inactive" };
      if (!UUID_PATTERN.test(record.clientId)) {
        throw new Error("Credential store returned a malformed client id");
      }

      const principal: ApiKeyPrincipal = Object.freeze({
        // The only place an AuthenticatedClientId is minted: from a verified
        // credential record, never from request input.
        clientId: record.clientId as AuthenticatedClientId,
        credentialId: record.credentialId,
        scopes: Object.freeze([...record.scopes]),
      });

      if (store.recordUse) {
        try {
          await store.recordUse(principal);
        } catch (error) {
          options.onRecordUseError?.(error);
        }
      }
      return { ok: true, principal };
    },
  };
}
