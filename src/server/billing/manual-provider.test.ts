import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans, startTrial, getActiveSubscription } from "@/server/subscription";
import { invoices } from "./schema";
import { ManualBillingProvider } from "./manual-provider";

async function setup() {
  await seedDefaultPlans();
  const [t] = await db.insert(tenants).values({ slug: "t", name: "T", country: "EG" }).returning();
  await startTrial(t.id, "pro");
  const sub = (await getActiveSubscription(t.id))!;
  return { t, sub };
}

describe("ManualBillingProvider", () => {
  it("creates an open invoice then settles it as paid", async () => {
    const { t, sub } = await setup();
    const provider = new ManualBillingProvider();
    const inv = await provider.createInvoice({ tenantId: t.id, subscriptionId: sub.id, amount: "499", currency: "EGP" });
    expect(inv.status).toBe("open");

    const paid = await provider.settleInvoice(inv.id, "bank");
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).toBeInstanceOf(Date);

    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.method).toBe("bank");
  });

  it("settleInvoice throws for an unknown invoice id", async () => {
    const provider = new ManualBillingProvider();
    await expect(provider.settleInvoice("00000000-0000-0000-0000-000000000000", "cash")).rejects.toThrow();
  });
});
