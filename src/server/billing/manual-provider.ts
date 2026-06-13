import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { invoices, type Invoice } from "./schema";
import type { BillingProvider, CreateInvoiceInput } from "./provider";

export class ManualBillingProvider implements BillingProvider {
  readonly name = "manual";

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    const [inv] = await db
      .insert(invoices)
      .values({
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        amount: input.amount,
        currency: input.currency,
        status: "open",
      })
      .returning();
    return inv;
  }

  async settleInvoice(invoiceId: string, method: string, markedBy?: string): Promise<Invoice> {
    const [inv] = await db
      .update(invoices)
      .set({ status: "paid", method, markedBy, paidAt: new Date() })
      .where(eq(invoices.id, invoiceId))
      .returning();
    if (!inv) throw new Error("Invoice not found");
    return inv;
  }
}
