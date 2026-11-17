import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets at rest (WhatsApp Web session keys today, provider
 * tokens later). Output format: `v1.<nonce>.<tag>.<ciphertext>`, base64url.
 * `context` is bound as additional authenticated data, so a value encrypted
 * for one record cannot be replayed into another.
 */
const VERSION = "v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/** The same encryption as separate binary parts, for bytea columns. */
export interface SealedParts {
  nonce: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export interface SecretBox {
  seal(plaintext: string, context: string): string;
  open(sealed: string, context: string): string;
  sealParts(plaintext: string, context: string): SealedParts;
  openParts(parts: SealedParts, context: string): string;
}

/** `encodedKey` is 32 random bytes in base64 (openssl rand -base64 32). */
export function createSecretBox(encodedKey: string): SecretBox {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must decode to ${KEY_BYTES} bytes`);
  }

  const sealParts = (plaintext: string, context: string): SealedParts => {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { nonce, tag: cipher.getAuthTag(), ciphertext };
  };

  const openParts = ({ nonce, tag, ciphertext }: SealedParts, context: string): string => {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  };

  return {
    sealParts,
    openParts,

    seal(plaintext, context) {
      const { nonce, tag, ciphertext } = sealParts(plaintext, context);
      return [VERSION, nonce, tag, ciphertext].map((part) =>
        typeof part === "string" ? part : part.toString("base64url")).join(".");
    },

    open(sealed, context) {
      const [version, nonce, tag, ciphertext, extra] = sealed.split(".");
      if (version !== VERSION || !nonce || !tag || ciphertext === undefined || extra !== undefined) {
        throw new Error("Malformed sealed value");
      }
      return openParts({
        nonce: Buffer.from(nonce, "base64url"),
        tag: Buffer.from(tag, "base64url"),
        ciphertext: Buffer.from(ciphertext, "base64url"),
      }, context);
    },
  };
}
