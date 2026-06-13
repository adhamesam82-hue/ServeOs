import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";

export const applicationStatus = pgEnum("application_status", ["pending", "approved", "rejected"]);

export const onboardingApplications = pgTable("onboarding_applications", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  status: applicationStatus("status").notNull().default("pending"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  reviewNotes: text("review_notes"),
});

export type OnboardingApplication = typeof onboardingApplications.$inferSelect;
