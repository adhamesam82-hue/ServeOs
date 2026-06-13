import { ROLE_PERMISSIONS, type Permission, type RoleKey } from "./permissions";

export function can(roleKeys: RoleKey[], permission: Permission): boolean {
  return roleKeys.some((rk) => ROLE_PERMISSIONS[rk]?.includes(permission));
}

export class UnauthorizedError extends Error {
  constructor(public permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "UnauthorizedError";
  }
}

export function authorize(roleKeys: RoleKey[], permission: Permission): void {
  if (!can(roleKeys, permission)) throw new UnauthorizedError(permission);
}
