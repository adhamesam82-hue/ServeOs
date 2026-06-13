import type { RoleKey } from "@/server/rbac";

export function assertSuperAdmin(roleKeys: RoleKey[]): void {
  if (!roleKeys.includes("super_admin")) throw new Error("Forbidden: super admin only");
}
