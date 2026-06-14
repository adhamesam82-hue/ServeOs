import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "./service";
import { CategoryNotEmptyError } from "./errors";

async function makeTenant(slug = "c1") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("catalog: categories", () => {
  it("creates and lists categories", async () => {
    const t = await makeTenant();
    const cat = await createCategory(t.id, { nameEn: "Burgers", nameAr: "برجر" });
    expect(cat.nameEn).toBe("Burgers");
    const list = await listCategories(t.id);
    expect(list).toHaveLength(1);
  });

  it("updateCategory changes name", async () => {
    const t = await makeTenant("c2");
    const cat = await createCategory(t.id, { nameEn: "A", nameAr: "أ" });
    const updated = await updateCategory(t.id, cat.id, { nameEn: "B" });
    expect(updated.nameEn).toBe("B");
    expect(updated.nameAr).toBe("أ");
  });

  it("deleteCategory throws CategoryNotEmptyError when products exist", async () => {
    const t = await makeTenant("c3");
    const cat = await createCategory(t.id, { nameEn: "X", nameAr: "س" });
    // insert a product directly to simulate non-empty (must use withTenant — RLS enforced on app role)
    const { products } = await import("./schema");
    await withTenant(t.id, (tx) =>
      tx.insert(products).values({
        tenantId: t.id,
        categoryId: cat.id,
        nameEn: "P",
        nameAr: "ب",
        basePrice: "10",
      }),
    );
    await expect(deleteCategory(t.id, cat.id)).rejects.toThrow(CategoryNotEmptyError);
  });

  it("deleteCategory succeeds for empty category", async () => {
    const t = await makeTenant("c4");
    const cat = await createCategory(t.id, { nameEn: "Empty", nameAr: "فارغ" });
    await deleteCategory(t.id, cat.id);
    const list = await listCategories(t.id);
    expect(list).toHaveLength(0);
  });

  it("RLS: tenant A cannot see tenant B categories", async () => {
    const a = await makeTenant("rls-cat-a");
    const b = await makeTenant("rls-cat-b");
    await createCategory(a.id, { nameEn: "A-Cat", nameAr: "أ" });
    expect(await listCategories(b.id)).toHaveLength(0);
  });
});
