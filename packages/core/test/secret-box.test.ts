import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox } from "../src/secret-box.js";

const key = randomBytes(32).toString("base64");

describe("createSecretBox", () => {
  it("round-trips and never repeats a ciphertext", () => {
    const box = createSecretBox(key);
    const a = box.seal("signal key material", "conn-1/creds");
    const b = box.seal("signal key material", "conn-1/creds");
    expect(a).not.toBe(b);
    expect(a).not.toContain("signal");
    expect(box.open(a, "conn-1/creds")).toBe("signal key material");
  });

  it("rejects a value moved to another context", () => {
    const box = createSecretBox(key);
    const sealed = box.seal("x", "conn-1/creds");
    expect(() => box.open(sealed, "conn-2/creds")).toThrow();
  });

  it("rejects tampering and the wrong key", () => {
    const box = createSecretBox(key);
    const sealed = box.seal("payload", "ctx");
    const parts = sealed.split(".");
    const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    parts[3] = ciphertext.toString("base64url");
    expect(() => box.open(parts.join("."), "ctx")).toThrow();
    expect(() => createSecretBox(randomBytes(32).toString("base64")).open(sealed, "ctx")).toThrow();
    expect(() => box.open("v1.only.three", "ctx")).toThrow(/Malformed/);
  });

  it("seals into binary parts bound to their context", () => {
    const box = createSecretBox(key);
    const parts = box.sealParts("whsec_abc", "webhook-endpoint:1");
    expect(parts.nonce).toHaveLength(12);
    expect(parts.tag).toHaveLength(16);
    expect(parts.ciphertext.toString("utf8")).not.toContain("whsec");
    expect(box.openParts(parts, "webhook-endpoint:1")).toBe("whsec_abc");
    expect(() => box.openParts(parts, "webhook-endpoint:2")).toThrow();
  });

  it("requires a 32-byte key", () => {
    expect(() => createSecretBox(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
