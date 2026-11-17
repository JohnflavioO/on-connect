import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMediaVault } from "../src/media.js";

const key = randomBytes(32).toString("base64");
let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onconnect-media-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const vaultAt = (base = "https://api.example.com/") =>
  createMediaVault({ key, dir, publicBaseUrl: base });
const tokenOf = (url: string) => url.split("/media/")[1] ?? "";

describe("media vault", () => {
  it("stores encrypted and reads back through a short signed link", async () => {
    const vault = vaultAt();
    const bytes = Buffer.from("conteúdo da foto");
    const url = await vault.save(bytes, { mimetype: "image/jpeg; charset=binary" });
    expect(url).toMatch(/^https:\/\/api\.example\.com\/media\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(tokenOf(url).length).toBeLessThan(256);

    const [year] = await readdir(dir);
    const [month] = await readdir(join(dir, year ?? ""));
    const [file] = await readdir(join(dir, year ?? "", month ?? ""));
    const onDisk = await readFile(join(dir, year ?? "", month ?? "", file ?? ""));
    expect(onDisk.includes(bytes)).toBe(false);

    expect(await vault.read(tokenOf(url))).toEqual({ bytes, mimetype: "image/jpeg" });
  });

  it("rejects altered, forged and malformed tokens, and another key", async () => {
    const vault = vaultAt();
    const token = tokenOf(await vault.save(Buffer.from("x"), { mimetype: "image/png" }));
    const [payload = "", signature = ""] = token.split(".");

    const forged = Buffer.from(JSON.stringify({ p: "2026/01/00000000-0000-0000-0000-000000000000", m: "text/html" }))
      .toString("base64url");
    expect(await vault.read(`${forged}.${signature}`)).toBeNull();
    expect(await vault.read(`${payload}.${signature.slice(0, -2)}AA`)).toBeNull();
    expect(await vault.read(payload)).toBeNull();
    expect(await vault.read("a.b.c")).toBeNull();
    const other = createMediaVault({ key: randomBytes(32).toString("base64"), dir, publicBaseUrl: "https://x.example.com" });
    expect(await other.read(token)).toBeNull();
  });

  it("does not trust an odd media type", async () => {
    const vault = vaultAt();
    const url = await vault.save(Buffer.from("x"), { mimetype: "<script>" });
    expect((await vault.read(tokenOf(url)))?.mimetype).toBe("application/octet-stream");
  });

  it("deletes months past retention and answers null for their links", async () => {
    const vault = vaultAt();
    const url = await vault.save(Buffer.from("x"), { mimetype: "image/png" });
    await mkdir(join(dir, "2020", "01"), { recursive: true });
    await writeFile(join(dir, "2020", "01", "old"), "x");

    const now = new Date();
    expect(await vault.pruneOlderThan(90, now)).toBe(1);
    expect(await readdir(join(dir, "2020"))).toEqual([]);
    expect(await vault.read(tokenOf(url))).not.toBeNull();

    // Far in the future, the current month is past retention too.
    const later = new Date(now.getTime() + 400 * 86_400_000);
    expect(await vault.pruneOlderThan(90, later)).toBeGreaterThanOrEqual(1);
    expect(await vault.read(tokenOf(url))).toBeNull();
  });

  it("requires a 32-byte key", () => {
    expect(() => createMediaVault({ key: "c2hvcnQ=", dir, publicBaseUrl: "https://x" })).toThrow(/32 bytes/);
  });
});
