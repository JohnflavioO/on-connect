import { createHash, randomBytes } from "node:crypto";
import { compare, truncates } from "bcryptjs";

export interface AdminAuthStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

const COOKIE = "__Host-onconnect_admin";
const SESSION_SECONDS = 8 * 60 * 60;
const ATTEMPT_SECONDS = 60;
const MAX_ATTEMPTS = 10;
const TOKEN = /^[a-zA-Z0-9_-]{43}$/;

const HASH = (value: string) => createHash("sha256").update(value).digest("hex");

const countAttempt = `
  local attempts = redis.call('INCR', KEYS[1])
  if attempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return attempts
`;

export function createAdminAuth(options: { username: string; passwordHash: string; store: AdminAuthStore }) {
  const { username, passwordHash, store } = options;
  // Changing the configured credentials invalidates existing sessions.
  const namespace = HASH(JSON.stringify([username, passwordHash]));
  const sessionKey = (token: string) => `admin:session:${namespace}:${HASH(token)}`;
  const attributes = "Path=/; HttpOnly; Secure; SameSite=Lax";

  function cookieToken(header: string | undefined): string | null {
    const prefix = `${COOKIE}=`;
    const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
    return value && TOKEN.test(value) ? value : null;
  }

  return {
    username,
    async authenticated(header: string | undefined) {
      const token = cookieToken(header);
      return token !== null && await store.get(sessionKey(token)) === "active";
    },
    async signIn(ip: string, user: string, password: string) {
      const limitKey = `admin:login:${HASH(ip)}`;
      const attempts = Number(await store.eval(countAttempt, 1, limitKey, String(ATTEMPT_SECONDS)));
      if (attempts > MAX_ATTEMPTS) return { status: "limited", retryAfter: ATTEMPT_SECONDS } as const;
      if (truncates(password)) return { status: "invalid" } as const;
      const matches = await compare(password, passwordHash);
      if (!matches || user !== username) return { status: "invalid" } as const;

      const token = randomBytes(32).toString("base64url");
      await store.set(sessionKey(token), "active", "EX", SESSION_SECONDS);
      return { status: "ok", cookie: `${COOKIE}=${token}; ${attributes}; Max-Age=${SESSION_SECONDS}` } as const;
    },
    async signOut(header: string | undefined) {
      const token = cookieToken(header);
      if (token) await store.del(sessionKey(token));
      return `${COOKIE}=; ${attributes}; Max-Age=0`;
    },
  };
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;
