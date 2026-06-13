import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants, tenantSettings } from "@/server/tenancy/schema";
import { withTenant } from "./with-tenant";

describe("withTenant RLS isolation", () => {
  it("only sees rows belonging to the active tenant", async () => {
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A", country: "EG" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "b", name: "B", country: "EG" }).returning();

    await withTenant(a.id, async (tx) => {
      await tx.insert(tenantSettings).values({ tenantId: a.id, data: { x: 1 } });
    });
    await withTenant(b.id, async (tx) => {
      await tx.insert(tenantSettings).values({ tenantId: b.id, data: { x: 2 } });
    });

    const seenByA = await withTenant(a.id, (tx) => tx.select().from(tenantSettings));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0].tenantId).toBe(a.id);
  });

  it("blocks writing a row for a different tenant", async () => {
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A", country: "EG" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "b", name: "B", country: "EG" }).returning();
    await expect(
      withTenant(a.id, (tx) => tx.insert(tenantSettings).values({ tenantId: b.id, data: {} })),
    ).rejects.toThrow();
  });

  it("sees no rows outside any tenant context (fails closed)", async () => {
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A", country: "EG" }).returning();
    await withTenant(a.id, async (tx) => {
      await tx.insert(tenantSettings).values({ tenantId: a.id, data: {} });
    });
    const bare = await db.select().from(tenantSettings);
    expect(bare).toHaveLength(0);
  });
});
