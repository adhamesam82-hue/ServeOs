"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { validateSession } from "@/server/auth/session";
import { loadUserRoleKeys, SESSION_COOKIE } from "@/server/auth/current-user";
import { assertSuperAdmin } from "@/server/auth/require-role";
import { approveTenant, rejectTenant } from "@/server/platform";

async function currentAdmin() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;
  if (!session) throw new Error("Not signed in");
  const roleKeys = await loadUserRoleKeys(session.user.id);
  assertSuperAdmin(roleKeys);
  return session.user;
}

export async function approveAction(formData: FormData) {
  const admin = await currentAdmin();
  await approveTenant(String(formData.get("tenantId")), admin.id);
  revalidatePath("/admin");
}

export async function rejectAction(formData: FormData) {
  const admin = await currentAdmin();
  await rejectTenant(String(formData.get("tenantId")), admin.id, String(formData.get("notes") ?? ""));
  revalidatePath("/admin");
}
