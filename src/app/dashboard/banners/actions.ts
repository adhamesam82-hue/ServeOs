"use server";
import { revalidatePath } from "next/cache";
import { requireMenuPermission } from "../menu-permission";
import { createBanner, updateBanner, deleteBanner } from "@/server/banners/service";

export async function createBannerAction(formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await createBanner(tenantId, {
    imageUrl: String(formData.get("imageUrl")),
    titleEn: formData.get("titleEn") ? String(formData.get("titleEn")) : undefined,
    titleAr: formData.get("titleAr") ? String(formData.get("titleAr")) : undefined,
    linkUrl: formData.get("linkUrl") ? String(formData.get("linkUrl")) : undefined,
  });
  revalidatePath("/dashboard/banners");
}

export async function toggleBannerAction(bannerId: string, isActive: boolean) {
  const { tenantId } = await requireMenuPermission();
  await updateBanner(tenantId, bannerId, { isActive });
  revalidatePath("/dashboard/banners");
}

export async function deleteBannerAction(bannerId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteBanner(tenantId, bannerId);
  revalidatePath("/dashboard/banners");
}
