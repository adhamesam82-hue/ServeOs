import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "./schema";

describe("onboarding_applications schema", () => {
  it("defaults to pending status", async () => {
    const [t] = await db.insert(tenants).values({ slug: "t", name: "T", country: "EG" }).returning();
    const [app] = await db.insert(onboardingApplications).values({ tenantId: t.id }).returning();
    expect(app.status).toBe("pending");
  });
});
