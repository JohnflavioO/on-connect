import { sessionKeys, type SecretBox } from "@on-connect/core";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";

/** The Redis commands this store uses, so tests can pass an in-memory fake. */
export interface AuthStateRedis {
  hget(key: string, field: string): Promise<string | null>;
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
  hset(key: string, values: Record<string, string>): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  del(key: string): Promise<number>;
}

export interface StoredAuthState {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** Removes every key of this connection (after logout). */
  clear(): Promise<void>;
}

const CREDS_FIELD = "creds";
const keyField = (type: string, id: string) => `${type}:${id}`;

/**
 * WhatsApp Web auth state in one Redis hash per connection, each value
 * sealed with AES-256-GCM. The field name is bound as authenticated data,
 * so a value cannot be moved to another field or connection undetected.
 *
 * Baileys rewrites signal keys many times per minute; local Redis (AOF,
 * noeviction) keeps that off the network, unlike the remote Postgres.
 */
export async function createRedisAuthState(
  redis: AuthStateRedis,
  box: SecretBox,
  connectionId: string,
): Promise<StoredAuthState> {
  const hash = sessionKeys.authState(connectionId);
  const context = (field: string) => `${connectionId}/${field}`;
  const seal = (field: string, value: unknown) =>
    box.seal(JSON.stringify(value, BufferJSON.replacer), context(field));
  const open = (field: string, sealed: string): unknown =>
    JSON.parse(box.open(sealed, context(field)), BufferJSON.reviver);

  const storedCreds = await redis.hget(hash, CREDS_FIELD);
  const creds = storedCreds
    ? (open(CREDS_FIELD, storedCreds) as AuthenticationCreds)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const result: Record<string, SignalDataTypeMap[T]> = {};
          if (ids.length === 0) return result;
          const fields = ids.map((id) => keyField(type, id));
          const values = await redis.hmget(hash, ...fields);
          ids.forEach((id, index) => {
            const sealed = values[index];
            const field = fields[index];
            if (!sealed || !field) return;
            let value = open(field, sealed);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            result[id] = value as SignalDataTypeMap[T];
          });
          return result;
        },

        async set(data: SignalDataSet) {
          const toWrite: Record<string, string> = {};
          const toDelete: string[] = [];
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              const field = keyField(type, id);
              if (value) toWrite[field] = seal(field, value);
              else toDelete.push(field);
            }
          }
          if (Object.keys(toWrite).length > 0) await redis.hset(hash, toWrite);
          if (toDelete.length > 0) await redis.hdel(hash, ...toDelete);
        },
      },
    },

    async saveCreds() {
      await redis.hset(hash, { [CREDS_FIELD]: seal(CREDS_FIELD, creds) });
    },

    async clear() {
      await redis.del(hash);
    },
  };
}
