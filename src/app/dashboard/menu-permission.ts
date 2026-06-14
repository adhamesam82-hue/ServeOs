import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import type { DashboardContext } from "@/server/auth/dashboard-context";

export async function requireMenuPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}
