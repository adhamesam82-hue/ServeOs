import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { onboardingApplications } from "./schema";
import { seedDefaultPlans, getActiveSubscription } from "@/server/subscription";
import { registerRestaurant } from "./service";

describe("registerRestaurant", () => {
  it("creates tenant, owner, owner role, trial subscription, and a pending application", async () => {
    await seedDefaultPlans();
    const result = await registerRestaurant({
      restaurantName: "Pizza Roma",
      slug: "roma",
      country: "EG",
      ownerName: "Sam",
      email: "sam@roma.com",
      password: "s3cret!",
    });

    const [t] = await db.select().from(tenants).where(eq(tenants.id, result.tenantId));
    expect(t.status).toBe("onboarding");

    const owner = await db.select().from(users).where(eq(users.tenantId, t.id));
    expect(owner).toHaveLength(1);
    expect(owner[0].passwordHash).toBeTruthy();
    expect(owner[0].passwordHash).not.toBe("s3cret!"); // hashed, not plaintext

    const ownerRoles = await db
      .select({ key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, owner[0].id));
    expect(ownerRoles.map((r) => r.key)).toContain("owner");

    expect((await getActiveSubscription(t.id))?.status).toBe("trialing");

    const apps = await db.select().from(onboardingApplications).where(eq(onboardingApplications.tenantId, t.id));
    expect(apps[0].status).toBe("pending");
  });

  it("rejects a duplicate slug", async () => {
    await seedDefaultPlans();
    await registerRestaurant({ restaurantName: "A", slug: "dup", country: "EG", ownerName: "A", email: "a@a.com", password: "x" });
    await expect(
      registerRestaurant({ restaurantName: "B", slug: "dup", country: "EG", ownerName: "B", email: "b@b.com", password: "x" }),
    ).rejects.toThrow();
  });

  it("rejects an invalid slug", async () => {
    await seedDefaultPlans();
    await expect(
      registerRestaurant({ restaurantName: "X", slug: "A_B!", country: "EG", ownerName: "X", email: "x@x.com", password: "x" }),
    ).rejects.toThrow(/slug/i);
  });

  it("rolls back fully when registration fails partway (no orphan tenant)", async () => {
    await seedDefaultPlans();
    await registerRestaurant({ restaurantName: "First", slug: "taken", country: "EG", ownerName: "F", email: "f@f.com", password: "x" });
    const before = await db.select().from(tenants);
    await expect(
      registerRestaurant({ restaurantName: "Second", slug: "taken", country: "EG", ownerName: "S", email: "s@s.com", password: "x" }),
    ).rejects.toThrow();
    const after = await db.select().from(tenants);
    expect(after.length).toBe(before.length); // failed attempt left no partial tenant
  });
});
