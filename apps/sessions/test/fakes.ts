import type { AuthStateRedis } from "../src/auth-state.js";
import type { ManagerRedis } from "../src/session-manager.js";

/** In-memory stand-in for the few Redis commands the sessions process uses. */
export class FakeRedis implements AuthStateRedis, ManagerRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly strings = new Map<string, { value: string; ttl: number }>();

  async hget(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hmget(key: string, ...fields: string[]) {
    return fields.map((field) => this.hashes.get(key)?.get(field) ?? null);
  }
  async hset(key: string, values: Record<string, string>) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
    return Object.keys(values).length;
  }
  async hdel(key: string, ...fields: string[]) {
    let removed = 0;
    for (const field of fields) if (this.hashes.get(key)?.delete(field)) removed += 1;
    return removed;
  }
  async set(key: string, value: string, _mode: "EX", seconds: number) {
    this.strings.set(key, { value, ttl: seconds });
    return "OK";
  }
  async del(key: string) {
    const existed = this.hashes.delete(key) || this.strings.delete(key);
    return existed ? 1 : 0;
  }
}
