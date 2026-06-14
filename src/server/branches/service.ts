import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { checkQuota } from "@/server/entitlements/service";
import { branches, type Branch, type NewBranch } from "./schema";
import { BranchNotFoundError } from "./errors";

export type CreateBranchInput = Pick<NewBranch, "name" | "address" | "phone" | "sortOrder">;
export type UpdateBranchInput = Partial<CreateBranchInput>;

export async function listBranches(tenantId: string): Promise<Branch[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.isActive, true)).orderBy(branches.sortOrder),
  );
}

export async function getBranch(tenantId: string, branchId: string): Promise<Branch> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.id, branchId)).limit(1),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export async function createBranch(tenantId: string, input: CreateBranchInput): Promise<Branch> {
  const current = await withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.isActive, true)),
  );
  await checkQuota(tenantId, "branches", current.length);
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(branches).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateBranch(tenantId: string, branchId: string, input: UpdateBranchInput): Promise<Branch> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(branches).set(input).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export async function deleteBranch(tenantId: string, branchId: string): Promise<void> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(branches).set({ isActive: false }).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning({ id: branches.id }),
  );
  if (!row) throw new BranchNotFoundError();
}
