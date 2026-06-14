"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createBanner, updateBanner, deleteBanner } from "@/server/banners/service";

async function getCtx() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}

export async function createBannerAction(formData: FormData) {
  const { tenantId } = await getCtx();
  await createBanner(tenantId, {
    imageUrl: String(formData.get("imageUrl")),
    titleEn: formData.get("titleEn") ? String(formData.get("titleEn")) : undefined,
    titleAr: formData.get("titleAr") ? String(formData.get("titleAr")) : undefined,
    linkUrl: formData.get("linkUrl") ? String(formData.get("linkUrl")) : undefined,
  });
  revalidatePath("/dashboard/banners");
}

export async function toggleBannerAction(bannerId: string, isActive: boolean) {
  const { tenantId } = await getCtx();
  await updateBanner(tenantId, bannerId, { isActive });
  revalidatePath("/dashboard/banners");
}

export async function deleteBannerAction(bannerId: string) {
  const { tenantId } = await getCtx();
  await deleteBanner(tenantId, bannerId);
  revalidatePath("/dashboard/banners");
}
