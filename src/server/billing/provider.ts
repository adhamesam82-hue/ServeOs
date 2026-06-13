import type { Invoice } from "./schema";

export type CreateInvoiceInput = {
  tenantId: string;
  subscriptionId: string;
  amount: string;
  currency: string;
};

export interface BillingProvider {
  readonly name: string;
  createInvoice(input: CreateInvoiceInput): Promise<Invoice>;
  settleInvoice(invoiceId: string, method: string, markedBy?: string): Promise<Invoice>;
}
