import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Media received on WhatsApp, kept so integrators can fetch it later.
 *
 * Files live on a local volume, each AES-256-GCM encrypted and bound to its
 * own path. A file is reached through a capability URL: the token carries
 * the path and type, signed with HMAC, so the API serves it without a
 * database lookup and nobody can forge or alter a token. Anyone holding the
 * URL can fetch the file (as with D-API media links), so it is only ever
 * handed to the integrator in its own webhooks. Retention deletes whole
 * months of files.
 *
 * One key (MEDIA_KEY) is split into an encryption key and a signing key.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PATH_PATTERN = /^[0-9]{4}\/[0-9]{2}\/[0-9a-f-]{36}$/;
const SIGNATURE_BYTES = 24;

export interface StoredMedia {
  bytes: Buffer;
  mimetype: string;
}

export interface MediaVault {
  /**
   * Encrypts and writes the file; returns its public capability URL. The
   * token stays short (path and type only): the file name travels with the
   * message, not in the link.
   */
  save(bytes: Buffer, meta: { mimetype: string | null }): Promise<string>;
  /** Null for a forged, altered or malformed token, or a file already deleted. */
  read(token: string): Promise<StoredMedia | null>;
  /** Deletes the months that ended more than `days` ago. Returns how many. */
  pruneOlderThan(days: number, now?: Date): Promise<number>;
}

export interface MediaVaultOptions {
  /** 32 random bytes, base64 (openssl rand -base64 32). */
  key: string;
  dir: string;
  /** e.g. https://onconnect.tendidesk.com.br; the URL is `${base}/media/${token}`. */
  publicBaseUrl: string;
}

interface TokenPayload {
  p: string;
  m: string;
}

const b64url = (buffer: Buffer): string => buffer.toString("base64url");

export function createMediaVault(options: MediaVaultOptions): MediaVault {
  const master = Buffer.from(options.key, "base64");
  if (master.length !== 32) throw new Error("MEDIA_KEY must decode to 32 bytes");
  const encryptionKey = createHmac("sha256", master).update("onconnect-media-encryption").digest();
  const signingKey = createHmac("sha256", master).update("onconnect-media-signature").digest();
  const base = options.publicBaseUrl.replace(/\/$/, "");

  const sign = (payload: string): Buffer =>
    createHmac("sha256", signingKey).update(payload).digest().subarray(0, SIGNATURE_BYTES);

  return {
    async save(bytes, meta) {
      const now = new Date();
      const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const path = `${month}/${randomUUID()}`;
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(Buffer.from(path, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      await mkdir(join(options.dir, month), { recursive: true });
      await writeFile(join(options.dir, path), Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]), {
        mode: 0o600,
      });

      const mimetype = meta.mimetype && /^[a-z]+\/[A-Za-z0-9.+-]{1,100}$/.test(meta.mimetype.split(";")[0]?.trim() ?? "")
        ? meta.mimetype.split(";")[0]?.trim() ?? "application/octet-stream"
        : "application/octet-stream";
      const payload: TokenPayload = { p: path, m: mimetype };
      const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
      return `${base}/media/${encoded}.${b64url(sign(encoded))}`;
    },

    async read(token) {
      const [encoded, signature, extra] = token.split(".");
      if (!encoded || !signature || extra !== undefined) return null;
      const expected = sign(encoded);
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

      let payload: TokenPayload;
      try {
        payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TokenPayload;
      } catch {
        return null;
      }
      if (typeof payload.p !== "string" || !PATH_PATTERN.test(payload.p)) return null;

      let file: Buffer;
      try {
        file = await readFile(join(options.dir, payload.p));
      } catch {
        return null; // Deleted by retention.
      }
      if (file.length < NONCE_BYTES + TAG_BYTES) return null;
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, file.subarray(0, NONCE_BYTES));
      decipher.setAAD(Buffer.from(payload.p, "utf8"));
      decipher.setAuthTag(file.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
      const bytes = Buffer.concat([decipher.update(file.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]);
      return { bytes, mimetype: payload.m || "application/octet-stream" };
    },

    async pruneOlderThan(days, now = new Date()) {
      const cutoff = now.getTime() - days * 86_400_000;
      let removed = 0;
      const years = await readdir(options.dir).catch(() => [] as string[]);
      for (const year of years.filter((name) => /^[0-9]{4}$/.test(name))) {
        const months = await readdir(join(options.dir, year)).catch(() => [] as string[]);
        for (const month of months.filter((name) => /^[0-9]{2}$/.test(name))) {
          // The month's last instant: everything in it is older than this.
          const end = Date.UTC(Number(year), Number(month), 1);
          if (end <= cutoff) {
            await rm(join(options.dir, year, month), { recursive: true, force: true });
            removed += 1;
          }
        }
      }
      return removed;
    },
  };
}

/** The media types WhatsApp messages carry as downloadable files. */
export const MEDIA_CONTENT_TYPES = ["image", "video", "audio", "document", "sticker"] as const;
