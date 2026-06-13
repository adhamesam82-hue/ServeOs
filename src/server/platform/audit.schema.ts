import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  target: text("target"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
