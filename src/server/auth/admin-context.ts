import { cookies } from "next/headers";
import { validateSession } from "./session";
import { loadUserRoleKeys, SESSION_COOKIE } from "./current-user";
import { assertSuperAdmin } from "./require-role";
import type { User } from "./schema";

/** Returns the current platform super-admin user, or throws if not signed in / not authorized. */
export async function requireSuperAdmin(): Promise<User> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;
  if (!session) throw new Error("Not signed in");
  const roleKeys = await loadUserRoleKeys(session.user.id);
  assertSuperAdmin(roleKeys);
  return session.user;
}
