import { randomBytes } from "node:crypto";
import { createSecretBox, sessionKeys } from "@on-connect/core";
import { describe, expect, it } from "vitest";
import { createRedisAuthState } from "../src/auth-state.js";
import { FakeRedis } from "./fakes.js";

const box = createSecretBox(randomBytes(32).toString("base64"));

describe("Redis auth state", () => {
  it("creates fresh credentials and persists them encrypted", async () => {
    const redis = new FakeRedis();
    const first = await createRedisAuthState(redis, box, "conn-1");
    expect(first.state.creds.registered).toBe(false);
    await first.saveCreds();

    const stored = redis.hashes.get(sessionKeys.authState("conn-1"))?.get("creds") ?? "";
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain("noiseKey");

    const reloaded = await createRedisAuthState(redis, box, "conn-1");
    expect(reloaded.state.creds.noiseKey.public).toEqual(first.state.creds.noiseKey.public);
  });

  it("stores, reads and deletes signal keys, keeping Buffers intact", async () => {
    const redis = new FakeRedis();
    const auth = await createRedisAuthState(redis, box, "conn-1");
    const session = Buffer.from([1, 2, 3, 250]);
    await auth.state.keys.set({ session: { "5511999999999.0": session } });

    const read = await auth.state.keys.get("session", ["5511999999999.0", "missing"]);
    expect(Buffer.from(read["5511999999999.0"] as Uint8Array)).toEqual(session);
    expect(read.missing).toBeUndefined();

    await auth.state.keys.set({ session: { "5511999999999.0": null } });
    expect(await auth.state.keys.get("session", ["5511999999999.0"])).toEqual({});
  });

  it("cannot read another connection's keys even if copied over", async () => {
    const redis = new FakeRedis();
    const a = await createRedisAuthState(redis, box, "conn-a");
    await a.saveCreds();
    const sealed = redis.hashes.get(sessionKeys.authState("conn-a"))?.get("creds") ?? "";
    await redis.hset(sessionKeys.authState("conn-b"), { creds: sealed });
    await expect(createRedisAuthState(redis, box, "conn-b")).rejects.toThrow();
  });

  it("clear removes every key of the connection", async () => {
    const redis = new FakeRedis();
    const auth = await createRedisAuthState(redis, box, "conn-1");
    await auth.saveCreds();
    await auth.clear();
    expect(redis.hashes.has(sessionKeys.authState("conn-1"))).toBe(false);
  });
});
