"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createCategory, updateCategory, deleteCategory } from "@/server/catalog/service";

async function getCtx() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}

export async function createCategoryAction(formData: FormData) {
  const { tenantId } = await getCtx();
  await createCategory(tenantId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateCategoryAction(categoryId: string, formData: FormData) {
  const { tenantId } = await getCtx();
  await updateCategory(tenantId, categoryId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function deleteCategoryAction(categoryId: string) {
  const { tenantId } = await getCtx();
  await deleteCategory(tenantId, categoryId);
  revalidatePath("/dashboard/menu");
}
