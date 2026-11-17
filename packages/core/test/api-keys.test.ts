import { describe, expect, it, vi } from "vitest";
import {
  createApiKeyAuthenticator,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  verifyApiKeySecret,
  type CredentialRecord,
  type CredentialStore,
} from "../src/api-keys.js";

const PEPPER = "test-pepper-test-pepper-test-pepper-1234";
const OTHER_PEPPER = "another-pepper-another-pepper-another-99";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-17T12:00:00Z");

function storeWith(records: Record<string, Partial<CredentialRecord> & { secretHash: string }>) {
  const findByPrefix = vi.fn(async (prefix: string) => {
    const record = records[prefix];
    if (!record) return null;
    return {
      credentialId: "cred-1",
      clientId: A,
      scopes: ["messages:send"],
      expiresAt: null,
      revokedAt: null,
      clientStatus: "active",
      ...record,
    } satisfies CredentialRecord;
  });
  const recordUse = vi.fn(async () => undefined);
  const store: CredentialStore = { findByPrefix, recordUse };
  return { store, findByPrefix, recordUse };
}

function issued(overrides: Partial<CredentialRecord> = {}) {
  const key = generateApiKey(PEPPER);
  const fixture = storeWith({ [key.prefix]: { secretHash: key.secretHash, ...overrides } });
  const auth = createApiKeyAuthenticator({ store: fixture.store, pepper: PEPPER, now: () => NOW });
  return { key, auth, ...fixture };
}

describe("API key format", () => {
  it("generates keys that parse back to their prefix", () => {
    const key = generateApiKey(PEPPER);
    expect(key.key).toMatch(/^onc_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiKey(key.key)?.prefix).toBe(key.prefix);
    expect(key.secretHash).not.toContain(key.key.slice(-43));
  });

  it("never generates the same key twice", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey(PEPPER).key));
    expect(keys.size).toBe(200);
  });

  it.each([
    "",
    "onc_short_secret",
    `onc_${"a".repeat(16)}_${"b".repeat(42)}`,
    `onc_${"a".repeat(16)}_${"b".repeat(44)}`,
    `xyz_${"a".repeat(16)}_${"b".repeat(43)}`,
    `onc_${"a".repeat(15)}%_${"b".repeat(43)}`,
    ` onc_${"a".repeat(16)}_${"b".repeat(43)}`,
  ])("rejects malformed key %#", (raw) => {
    expect(parseApiKey(raw)).toBeNull();
  });

  it("refuses a short pepper", () => {
    expect(() => generateApiKey("short")).toThrow(/pepper/);
  });
});

describe("verifier", () => {
  it("binds the verifier to the pepper and the prefix", () => {
    const key = generateApiKey(PEPPER);
    const parsed = parseApiKey(key.key);
    if (!parsed) throw new Error("unparseable");
    expect(verifyApiKeySecret(PEPPER, parsed, key.secretHash)).toBe(true);
    expect(verifyApiKeySecret(OTHER_PEPPER, parsed, key.secretHash)).toBe(false);
    const moved = { prefix: "B".repeat(16), secret: parsed.secret };
    expect(verifyApiKeySecret(PEPPER, moved, key.secretHash)).toBe(false);
  });

  it("rejects unknown schemes and malformed stored hashes", () => {
    const key = generateApiKey(PEPPER);
    const parsed = parseApiKey(key.key);
    if (!parsed) throw new Error("unparseable");
    const digest = key.secretHash.split("$")[1] ?? "";
    expect(verifyApiKeySecret(PEPPER, parsed, `sha256$${digest}`)).toBe(false);
    expect(verifyApiKeySecret(PEPPER, parsed, `${key.secretHash}$extra`)).toBe(false);
    expect(verifyApiKeySecret(PEPPER, parsed, "hmac-sha256$AAAA")).toBe(false);
    expect(verifyApiKeySecret(PEPPER, parsed, "")).toBe(false);
  });

  it("is deterministic for the same input", () => {
    expect(hashApiKeySecret(PEPPER, "p".repeat(16), "s".repeat(43)))
      .toBe(hashApiKeySecret(PEPPER, "p".repeat(16), "s".repeat(43)));
  });
});

describe("createApiKeyAuthenticator", () => {
  it("derives the principal from the credential record", async () => {
    const f = issued();
    const result = await f.auth.authenticate(f.key.key);
    expect(result).toEqual({
      ok: true,
      principal: { clientId: A, credentialId: "cred-1", scopes: ["messages:send"] },
    });
    expect(f.recordUse).toHaveBeenCalledOnce();
  });

  it("returns a frozen principal", async () => {
    const f = issued();
    const result = await f.auth.authenticate(f.key.key);
    if (!result.ok) throw new Error("expected success");
    expect(Object.isFrozen(result.principal)).toBe(true);
    expect(Object.isFrozen(result.principal.scopes)).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["missing", ""],
    ["malformed", "Bearer something"],
    ["malformed", "onc_tooshort"],
  ] as const)("fails as %s without touching the store", async (reason, raw) => {
    const f = issued();
    expect(await f.auth.authenticate(raw)).toEqual({ ok: false, reason });
    expect(f.findByPrefix).not.toHaveBeenCalled();
  });

  it("rejects an unknown prefix", async () => {
    const f = issued();
    const stranger = generateApiKey(PEPPER);
    expect(await f.auth.authenticate(stranger.key)).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a known prefix with the wrong secret", async () => {
    const f = issued();
    const forged = `onc_${f.key.prefix}_${"A".repeat(43)}`;
    expect(await f.auth.authenticate(forged)).toEqual({ ok: false, reason: "invalid_secret" });
    expect(f.recordUse).not.toHaveBeenCalled();
  });

  it("checks the secret before revealing revocation", async () => {
    const f = issued({ revokedAt: new Date("2026-01-01T00:00:00Z") });
    const forged = `onc_${f.key.prefix}_${"A".repeat(43)}`;
    expect(await f.auth.authenticate(forged)).toEqual({ ok: false, reason: "invalid_secret" });
    expect(await f.auth.authenticate(f.key.key)).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects an expired credential, including one expiring exactly now", async () => {
    const past = issued({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(await past.auth.authenticate(past.key.key)).toEqual({ ok: false, reason: "expired" });
    const exact = issued({ expiresAt: NOW });
    expect(await exact.auth.authenticate(exact.key.key)).toEqual({ ok: false, reason: "expired" });
    const future = issued({ expiresAt: new Date(NOW.getTime() + 60_000) });
    expect((await future.auth.authenticate(future.key.key)).ok).toBe(true);
  });

  it("rejects credentials of a suspended client", async () => {
    const f = issued({ clientStatus: "suspended" });
    expect(await f.auth.authenticate(f.key.key)).toEqual({ ok: false, reason: "client_inactive" });
  });

  it("refuses a store row with a malformed client id", async () => {
    const f = issued({ clientId: "not-a-uuid" });
    await expect(f.auth.authenticate(f.key.key)).rejects.toThrow(/malformed client id/);
  });

  it("still authenticates when usage bookkeeping fails", async () => {
    const key = generateApiKey(PEPPER);
    const onRecordUseError = vi.fn();
    const auth = createApiKeyAuthenticator({
      pepper: PEPPER,
      onRecordUseError,
      store: {
        findByPrefix: async () => ({
          credentialId: "cred-1", clientId: A, secretHash: key.secretHash, scopes: [],
          expiresAt: null, revokedAt: null, clientStatus: "active",
        }),
        recordUse: async () => {
          throw new Error("db down");
        },
      },
    });
    expect((await auth.authenticate(key.key)).ok).toBe(true);
    expect(onRecordUseError).toHaveBeenCalledOnce();
  });
});
