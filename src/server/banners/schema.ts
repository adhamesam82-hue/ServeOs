import { pgTable, uuid, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

export const banners = pgTable("banners", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  titleEn: text("title_en"),
  titleAr: text("title_ar"),
  imageUrl: text("image_url").notNull(),
  linkUrl: text("link_url"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Banner = typeof banners.$inferSelect;
export type NewBanner = typeof banners.$inferInsert;
