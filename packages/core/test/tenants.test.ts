import { describe, expect, it } from "vitest";
import { ClientTransaction, type DatabaseConnection } from "../src/db-transaction.js";
import {
  findTenant,
  listTenants,
  setCommercialStatus,
  upsertTenant,
} from "../src/tenants.js";

const actor = { credentialId: "cred-1" };

function recordingTx(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const connection: DatabaseConnection = {
    query: (async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as DatabaseConnection["query"],
    release: () => undefined,
  };
  return { tx: new ClientTransaction(connection), calls };
}

const row = {
  id: "t-1", external_id: "org-1", name: "Org", plan_code: null, max_connections: 0,
  entitlements: {}, commercial_status: "active", commercial_reason: null,
  commercial_changed_at: null, operational_status: "active",
  created_at: new Date(), updated_at: new Date(), created: true, previous_status: "active",
};

describe("tenant repository", () => {
  it("scopes every statement to the transaction's client, never to a parameter", async () => {
    const { tx, calls } = recordingTx([row]);
    await findTenant(tx, "org-1");
    await listTenants(tx, { limit: 10 });
    await upsertTenant(tx, actor, "org-1", { name: "Org" });
    await setCommercialStatus(tx, actor, "org-1", "suspended", "unpaid");

    for (const call of calls) {
      expect(call.sql).toContain("onconnect.current_client_id()");
      expect(call.sql).not.toMatch(/client_id\s*=\s*\$\d/);
    }
  });

  it("writes an audit entry for each change", async () => {
    const { tx, calls } = recordingTx([row]);
    await upsertTenant(tx, actor, "org-1", { name: "Org" });
    const auditCall = calls.find((c) => c.sql.includes("audit_log"));
    expect(auditCall?.params.slice(0, 2)).toEqual(["cred-1", "tenant.created"]);
  });

  it("skips the audit entry when the commercial status does not change", async () => {
    const { tx, calls } = recordingTx([{ ...row, commercial_status: "active" }]);
    await setCommercialStatus(tx, actor, "org-1", "active", null);
    expect(calls.some((c) => c.sql.includes("audit_log"))).toBe(false);
  });

  it("clamps the page size and reports the next cursor", async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ ...row, external_id: `org-${i}` }));
    const { tx, calls } = recordingTx(many);
    const page = await listTenants(tx, { limit: 2 });
    expect(calls[0]?.params).toEqual([null, 3]);
    expect(page.tenants.map((t) => t.externalId)).toEqual(["org-0", "org-1"]);
    expect(page.nextCursor).toBe("org-1");

    const huge = recordingTx([]);
    await listTenants(huge.tx, { limit: 10_000 });
    expect(huge.calls[0]?.params).toEqual([null, 101]);
  });

  it("returns null for a tenant the client cannot see", async () => {
    const { tx } = recordingTx([]);
    expect(await findTenant(tx, "org-of-someone-else")).toBeNull();
    expect(await setCommercialStatus(tx, actor, "org-of-someone-else", "suspended", null))
      .toBeNull();
  });
});
