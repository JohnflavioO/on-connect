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

export interface SecretBox {
  seal(plaintext: string, context: string): string;
  open(sealed: string, context: string): string;
}

/** `encodedKey` is 32 random bytes in base64 (openssl rand -base64 32). */
export function createSecretBox(encodedKey: string): SecretBox {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must decode to ${KEY_BYTES} bytes`);
  }

  return {
    seal(plaintext, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [VERSION, nonce, cipher.getAuthTag(), ciphertext]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },

    open(sealed, context) {
      const [version, nonce, tag, ciphertext, extra] = sealed.split(".");
      if (version !== VERSION || !nonce || !tag || ciphertext === undefined || extra !== undefined) {
        throw new Error("Malformed sealed value");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
