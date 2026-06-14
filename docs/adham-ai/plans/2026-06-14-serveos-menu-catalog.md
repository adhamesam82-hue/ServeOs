# ServeOS Menu & Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use parallel-build (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Menu & Catalog sub-project: branches, categories, products with modifier groups, banners, a public menu API, dashboard CRUD pages, and a read-only storefront display.

**Architecture:** Three focused domain modules (`src/server/branches/`, `src/server/catalog/`, `src/server/banners/`) — all FORCE RLS + `withTenant()`. A single `getPublishedMenu(tenantId, branchId?)` function assembles the storefront read. Dashboard pages are Next.js server components + server actions; public menu served at `GET /api/menu`.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM 0.45 + `drizzle-kit`, Postgres (Supabase), vitest (integration tests against real test DB), Playwright (E2E).

---

## Foundation Patterns (read before implementing)

**`withTenant`** — wraps every per-tenant DB operation:
```typescript
// src/db/with-tenant.ts
import { sql } from "drizzle-orm";
import { db } from "./client";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T> | T): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
```

**`checkQuota`** — call BEFORE inserting a resource:
```typescript
// src/server/entitlements/service.ts
export async function checkQuota(tenantId: string, resource: keyof PlanLimits, currentCount: number): Promise<void>
// Throws QuotaExceededError if currentCount >= plan limit.
// Plan limits include: branches, products (among others).
```

**Typed errors** — extend `DomainError` from `src/shared/errors.ts`:
```typescript
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract messageFor(locale: "en" | "ar"): string;
}
```

**RBAC** — `authorize(roleKeys, permission)` throws `UnauthorizedError` if not allowed:
```typescript
// src/server/rbac/authorize.ts
export function authorize(roleKeys: RoleKey[], permission: Permission): void
```

**Session** — get current user in server components:
```typescript
import { cookies } from "next/headers";
import { SESSION_COOKIE, loadUserRoleKeys } from "@/server/auth/current-user";
import { validateSession } from "@/server/auth/session";
const token = (await cookies()).get(SESSION_COOKIE)?.value;
const session = token ? await validateSession(token) : null;
```

**Test pattern** — insert fixtures directly, call services, assert:
```typescript
// vitest, fileParallelism:false, testTimeout:30000
// globalSetup runs migrations; beforeEach truncates all tables
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
async function makeTenant(slug = "t") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}
```

**Migration pattern** — after `db:generate`, manually append to the generated SQL file:
```sql
ALTER TABLE "tablename" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tablename" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tablename_isolation ON "tablename"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

---

## File Map

```
src/server/branches/
  schema.ts          ← Drizzle table: branches
  errors.ts          ← BranchNotFoundError
  service.ts         ← listBranches, getBranch, createBranch, updateBranch, deleteBranch
  service.test.ts    ← integration tests
  index.ts           ← re-exports

src/server/catalog/
  schema.ts          ← categories, products, modifier_groups, modifier_options, branch_product_availability
  errors.ts          ← CategoryNotEmptyError, ProductNotFoundError, InvalidModifierRulesError
  service.ts         ← all catalog CRUD + getPublishedMenu
  service.test.ts    ← integration tests
  index.ts           ← re-exports

src/server/banners/
  schema.ts          ← banners
  errors.ts          ← BannerNotFoundError
  service.ts         ← listBanners, createBanner, updateBanner, deleteBanner, getActiveBanners
  service.test.ts    ← integration tests
  index.ts           ← re-exports

src/server/auth/
  dashboard-context.ts  ← requireDashboardUser() helper (NEW)

src/server/rbac/
  permissions.ts     ← ADD 'menu:manage' permission (MODIFY)

src/db/
  schema.ts          ← ADD 3 re-exports (MODIFY)

src/app/api/menu/
  route.ts           ← GET /api/menu?slug=&branch= (NEW)

src/app/api/media-upload/
  route.ts           ← POST /api/media-upload (NEW)

src/app/dashboard/branches/
  page.tsx           ← list + create form
  [id]/page.tsx      ← edit + deactivate
  actions.ts         ← createBranchAction, updateBranchAction, deleteBranchAction

src/app/dashboard/menu/
  page.tsx           ← categories + products tree
  categories/new/page.tsx
  categories/[id]/page.tsx
  categories/actions.ts
  products/new/page.tsx
  products/[id]/page.tsx    ← includes modifier groups editor
  products/actions.ts

src/app/dashboard/banners/
  page.tsx           ← list + create + edit + delete
  actions.ts

src/app/page.tsx           ← MODIFY: extend storefront branch to show menu
tests/e2e/menu.spec.ts     ← E2E smoke
```

---

## Task 1: Branches Schema

**Files:**
- Create: `src/server/branches/schema.ts`
- Create: `src/server/branches/errors.ts`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Create `src/server/branches/schema.ts`**

```typescript
import { pgTable, uuid, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

export const branches = pgTable("branches", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  phone: text("phone"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
```

- [ ] **Step 2: Create `src/server/branches/errors.ts`**

```typescript
import { DomainError, type Locale } from "@/shared/errors";

export class BranchNotFoundError extends DomainError {
  readonly code = "branch_not_found";
  constructor() {
    super("Branch not found");
    this.name = "BranchNotFoundError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "الفرع غير موجود" : "Branch not found";
  }
}
```

- [ ] **Step 3: Add branch schema export to `src/db/schema.ts`**

Open `src/db/schema.ts` and add this line at the end:
```typescript
export * from "../server/branches/schema";
```

The file should now look like:
```typescript
// Re-exports every domain's Drizzle schema. Domains append their export here.
export * from "../server/tenancy/schema";
export * from "../server/auth/schema";
export * from "../server/subscription/schema";
export * from "../server/billing/schema";
export * from "../server/onboarding/schema";
export * from "../server/platform/audit.schema";
export * from "../server/branches/schema";
```

- [ ] **Step 4: Commit (schema only, no migration yet)**

```bash
git add src/server/branches/schema.ts src/server/branches/errors.ts src/db/schema.ts
git commit -m "feat(branches): add schema and errors"
```

---

## Task 2: Catalog Schema

**Files:**
- Create: `src/server/catalog/schema.ts`
- Create: `src/server/catalog/errors.ts`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Create `src/server/catalog/schema.ts`**

```typescript
import { pgTable, uuid, text, timestamp, boolean, integer, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  descriptionEn: text("description_en"),
  descriptionAr: text("description_ar"),
  imageUrl: text("image_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "restrict" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  descriptionEn: text("description_en"),
  descriptionAr: text("description_ar"),
  basePrice: numeric("base_price").notNull(),
  imageUrl: text("image_url"),
  isPublished: boolean("is_published").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const modifierGroups = pgTable("modifier_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  required: boolean("required").notNull().default(false),
  minSelections: integer("min_selections").notNull().default(0),
  maxSelections: integer("max_selections").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const modifierOptions = pgTable("modifier_options", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  modifierGroupId: uuid("modifier_group_id").notNull().references(() => modifierGroups.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  priceDelta: numeric("price_delta").notNull().default("0"),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const branchProductAvailability = pgTable(
  "branch_product_availability",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    isAvailable: boolean("is_available").notNull().default(true),
    priceOverride: numeric("price_override"),
  },
  (t) => [uniqueIndex("bpa_branch_product_unique").on(t.branchId, t.productId)],
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ModifierGroup = typeof modifierGroups.$inferSelect;
export type ModifierOption = typeof modifierOptions.$inferSelect;
export type BranchProductAvailability = typeof branchProductAvailability.$inferSelect;

export type ModifierGroupWithOptions = ModifierGroup & { options: ModifierOption[] };
export type ProductWithModifiers = Product & { modifierGroups: ModifierGroupWithOptions[] };

export interface PublishedMenu {
  categories: Array<{
    id: string;
    nameEn: string;
    nameAr: string;
    imageUrl: string | null;
    products: Array<{
      id: string;
      nameEn: string;
      nameAr: string;
      descriptionEn: string | null;
      descriptionAr: string | null;
      effectivePrice: number;
      imageUrl: string | null;
      modifierGroups: ModifierGroupWithOptions[];
    }>;
  }>;
}
```

- [ ] **Step 2: Create `src/server/catalog/errors.ts`**

```typescript
import { DomainError, type Locale } from "@/shared/errors";

export class CategoryNotEmptyError extends DomainError {
  readonly code = "category_not_empty";
  constructor() {
    super("Category still has products");
    this.name = "CategoryNotEmptyError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "أزل جميع المنتجات أولاً" : "Remove all products first";
  }
}

export class ProductNotFoundError extends DomainError {
  readonly code = "product_not_found";
  constructor() {
    super("Product not found");
    this.name = "ProductNotFoundError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "المنتج غير موجود" : "Product not found";
  }
}

export class InvalidModifierRulesError extends DomainError {
  readonly code = "invalid_modifier_rules";
  constructor() {
    super("Invalid modifier selection rules");
    this.name = "InvalidModifierRulesError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "قواعد الاختيار غير صالحة" : "Invalid selection rules";
  }
}
```

- [ ] **Step 3: Append catalog export to `src/db/schema.ts`**

```typescript
export * from "../server/catalog/schema";
```

- [ ] **Step 4: Commit**

```bash
git add src/server/catalog/schema.ts src/server/catalog/errors.ts src/db/schema.ts
git commit -m "feat(catalog): add schema and errors"
```

---

## Task 3: Banners Schema

**Files:**
- Create: `src/server/banners/schema.ts`
- Create: `src/server/banners/errors.ts`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Create `src/server/banners/schema.ts`**

```typescript
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
```

- [ ] **Step 2: Create `src/server/banners/errors.ts`**

```typescript
import { DomainError, type Locale } from "@/shared/errors";

export class BannerNotFoundError extends DomainError {
  readonly code = "banner_not_found";
  constructor() {
    super("Banner not found");
    this.name = "BannerNotFoundError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "اللافتة غير موجودة" : "Banner not found";
  }
}
```

- [ ] **Step 3: Append banner export to `src/db/schema.ts`**

```typescript
export * from "../server/banners/schema";
```

Final `src/db/schema.ts`:
```typescript
export * from "../server/tenancy/schema";
export * from "../server/auth/schema";
export * from "../server/subscription/schema";
export * from "../server/billing/schema";
export * from "../server/onboarding/schema";
export * from "../server/platform/audit.schema";
export * from "../server/branches/schema";
export * from "../server/catalog/schema";
export * from "../server/banners/schema";
```

- [ ] **Step 4: Commit**

```bash
git add src/server/banners/schema.ts src/server/banners/errors.ts src/db/schema.ts
git commit -m "feat(banners): add schema and errors"
```

---

## Task 4: Generate Migration, Add RLS, Apply to Both DBs

**Files:**
- Modify: `drizzle/` (newly generated SQL file)

- [ ] **Step 1: Generate the migration**

```bash
npm run db:generate
```

Expected: A new file appears in `drizzle/` — something like `drizzle/0007_*.sql`. Find it:
```bash
ls drizzle/*.sql | sort | tail -1
```

- [ ] **Step 2: Open the generated file and append RLS for all new tables**

At the end of the generated SQL file, append:

```sql
--> statement-breakpoint
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY branches_isolation ON "branches"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY categories_isolation ON "categories"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY products_isolation ON "products"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "modifier_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "modifier_groups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY modifier_groups_isolation ON "modifier_groups"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "modifier_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "modifier_options" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY modifier_options_isolation ON "modifier_options"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "branch_product_availability" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "branch_product_availability" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bpa_isolation ON "branch_product_availability"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "banners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "banners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY banners_isolation ON "banners"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

- [ ] **Step 3: Apply to test DB**

```bash
npm run db:migrate:test
```

Expected: `Migrations applied successfully` (or "No migrations to run" if already up to date — which shouldn't happen here).

- [ ] **Step 4: Apply to main DB**

```bash
npm run db:migrate
```

Expected: Same success message.

- [ ] **Step 5: Commit**

```bash
git add drizzle/
git commit -m "feat: add menu catalog migration with RLS for all new tables"
```

---

## Task 5: Branches Service

**Files:**
- Create: `src/server/branches/service.ts`
- Create: `src/server/branches/service.test.ts`

- [ ] **Step 1: Write failing tests in `src/server/branches/service.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import {
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  deleteBranch,
} from "./service";
import { BranchNotFoundError } from "./errors";

async function makeTenant(slug = "t1") {
  const [t] = await db.insert(tenants).values({ slug, name: "Test", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("branches service", () => {
  it("creates and lists branches within tenant context", async () => {
    const t = await makeTenant();
    const b = await createBranch(t.id, { name: "Main Branch" });
    expect(b.name).toBe("Main Branch");
    expect(b.tenantId).toBe(t.id);
    const list = await listBranches(t.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.id);
  });

  it("getBranch throws BranchNotFoundError for unknown id", async () => {
    const t = await makeTenant("t2");
    await expect(getBranch(t.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(BranchNotFoundError);
  });

  it("updateBranch changes name", async () => {
    const t = await makeTenant("t3");
    const b = await createBranch(t.id, { name: "Old" });
    const updated = await updateBranch(t.id, b.id, { name: "New" });
    expect(updated.name).toBe("New");
  });

  it("deleteBranch soft-deletes (sets is_active=false)", async () => {
    const t = await makeTenant("t4");
    const b = await createBranch(t.id, { name: "Branch" });
    await deleteBranch(t.id, b.id);
    const all = await listBranches(t.id);
    expect(all).toHaveLength(0); // listBranches only returns active
    const found = await getBranch(t.id, b.id);
    expect(found.isActive).toBe(false);
  });

  it("createBranch throws QuotaExceededError when plan limit reached", async () => {
    // basic plan limit: branches = 1 (see src/server/subscription/plans.seed.ts)
    const t = await makeTenant("t5");
    const { QuotaExceededError } = await import("@/server/entitlements/errors");
    await createBranch(t.id, { name: "B1" }); // uses the 1 allowed branch
    await expect(createBranch(t.id, { name: "B2" })).rejects.toThrow(QuotaExceededError);
  });

  it("RLS: tenant A cannot see tenant B branches", async () => {
    const a = await makeTenant("rls-a");
    const b = await makeTenant("rls-b");
    await createBranch(a.id, { name: "A-Branch" });
    const bList = await listBranches(b.id);
    expect(bList).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/server/branches/service.test.ts
```

Expected: FAIL — `listBranches` not found.

- [ ] **Step 3: Create `src/server/branches/service.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { db } from "@/db/client";
import { checkQuota } from "@/server/entitlements/service";
import { branches, type Branch, type NewBranch } from "./schema";
import { BranchNotFoundError } from "./errors";

export type CreateBranchInput = Pick<NewBranch, "name" | "address" | "phone" | "sortOrder">;
export type UpdateBranchInput = Partial<CreateBranchInput>;

export async function listBranches(tenantId: string): Promise<Branch[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.isActive, true)).orderBy(branches.sortOrder),
  );
}

export async function getBranch(tenantId: string, branchId: string): Promise<Branch> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.id, branchId)).limit(1),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export async function createBranch(tenantId: string, input: CreateBranchInput): Promise<Branch> {
  const current = await withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.isActive, true)),
  );
  await checkQuota(tenantId, "branches", current.length);
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(branches).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateBranch(tenantId: string, branchId: string, input: UpdateBranchInput): Promise<Branch> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(branches).set(input).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export async function deleteBranch(tenantId: string, branchId: string): Promise<void> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(branches).set({ isActive: false }).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning({ id: branches.id }),
  );
  if (!row) throw new BranchNotFoundError();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/server/branches/service.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/branches/service.ts src/server/branches/service.test.ts
git commit -m "feat(branches): add service with TDD integration tests"
```

---

## Task 6: Catalog Categories Service

**Files:**
- Create: `src/server/catalog/service.ts` (initial — categories only)
- Create: `src/server/catalog/service.test.ts` (initial)

- [ ] **Step 1: Write failing tests**

```typescript
// src/server/catalog/service.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "./service";
import { CategoryNotEmptyError } from "./errors";

async function makeTenant(slug = "c1") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("catalog: categories", () => {
  it("creates and lists categories", async () => {
    const t = await makeTenant();
    const cat = await createCategory(t.id, { nameEn: "Burgers", nameAr: "برجر" });
    expect(cat.nameEn).toBe("Burgers");
    const list = await listCategories(t.id);
    expect(list).toHaveLength(1);
  });

  it("updateCategory changes name", async () => {
    const t = await makeTenant("c2");
    const cat = await createCategory(t.id, { nameEn: "A", nameAr: "أ" });
    const updated = await updateCategory(t.id, cat.id, { nameEn: "B" });
    expect(updated.nameEn).toBe("B");
    expect(updated.nameAr).toBe("أ");
  });

  it("deleteCategory throws CategoryNotEmptyError when products exist", async () => {
    const t = await makeTenant("c3");
    const cat = await createCategory(t.id, { nameEn: "X", nameAr: "س" });
    // insert a product directly to simulate non-empty
    const { products } = await import("./schema");
    await db.insert(products).values({
      tenantId: t.id,
      categoryId: cat.id,
      nameEn: "P",
      nameAr: "ب",
      basePrice: "10",
    });
    await expect(deleteCategory(t.id, cat.id)).rejects.toThrow(CategoryNotEmptyError);
  });

  it("deleteCategory succeeds for empty category", async () => {
    const t = await makeTenant("c4");
    const cat = await createCategory(t.id, { nameEn: "Empty", nameAr: "فارغ" });
    await deleteCategory(t.id, cat.id);
    const list = await listCategories(t.id);
    expect(list).toHaveLength(0);
  });

  it("RLS: tenant A cannot see tenant B categories", async () => {
    const a = await makeTenant("rls-cat-a");
    const b = await makeTenant("rls-cat-b");
    await createCategory(a.id, { nameEn: "A-Cat", nameAr: "أ" });
    expect(await listCategories(b.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test -- src/server/catalog/service.test.ts
```

Expected: FAIL — `listCategories` not found.

- [ ] **Step 3: Create `src/server/catalog/service.ts` with category functions**

```typescript
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { checkQuota } from "@/server/entitlements/service";
import {
  categories,
  products,
  modifierGroups,
  modifierOptions,
  branchProductAvailability,
  type Category,
  type NewCategory,
  type Product,
  type NewProduct,
  type ModifierGroup,
  type ModifierOption,
  type ModifierGroupWithOptions,
  type ProductWithModifiers,
  type PublishedMenu,
} from "./schema";
import {
  CategoryNotEmptyError,
  ProductNotFoundError,
  InvalidModifierRulesError,
} from "./errors";

// ── helpers ──────────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (result[k] ??= []).push(item);
  }
  return result;
}

// ── categories ───────────────────────────────────────────────────────────────

export type CreateCategoryInput = Pick<NewCategory, "nameEn" | "nameAr" | "descriptionEn" | "descriptionAr" | "imageUrl" | "sortOrder">;
export type UpdateCategoryInput = Partial<CreateCategoryInput & { isActive: boolean }>;

export async function listCategories(tenantId: string): Promise<Category[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(categories).orderBy(categories.sortOrder),
  );
}

export async function createCategory(tenantId: string, input: CreateCategoryInput): Promise<Category> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(categories).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateCategory(tenantId: string, categoryId: string, input: UpdateCategoryInput): Promise<Category> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(categories)
      .set(input)
      .where(and(eq(categories.id, categoryId), eq(categories.tenantId, tenantId)))
      .returning(),
  );
  if (!row) throw new Error("Category not found");
  return row;
}

export async function deleteCategory(tenantId: string, categoryId: string): Promise<void> {
  const [{ value }] = await withTenant(tenantId, (tx) =>
    tx.select({ value: count() }).from(products).where(eq(products.categoryId, categoryId)),
  );
  if (Number(value) > 0) throw new CategoryNotEmptyError();
  await withTenant(tenantId, (tx) =>
    tx.delete(categories).where(and(eq(categories.id, categoryId), eq(categories.tenantId, tenantId))),
  );
}

// ── products ─────────────────────────────────────────────────────────────────

export type CreateProductInput = Pick<NewProduct, "nameEn" | "nameAr" | "descriptionEn" | "descriptionAr" | "basePrice" | "imageUrl" | "sortOrder" | "categoryId">;
export type UpdateProductInput = Partial<CreateProductInput & { isPublished: boolean }>;

export async function listProducts(tenantId: string, categoryId?: string): Promise<Product[]> {
  return withTenant(tenantId, (tx) => {
    const q = tx.select().from(products);
    return categoryId
      ? q.where(and(eq(products.tenantId, tenantId), eq(products.categoryId, categoryId))).orderBy(products.sortOrder)
      : q.orderBy(products.sortOrder);
  });
}

export async function getProduct(tenantId: string, productId: string): Promise<ProductWithModifiers> {
  const [prod] = await withTenant(tenantId, (tx) =>
    tx.select().from(products).where(eq(products.id, productId)).limit(1),
  );
  if (!prod) throw new ProductNotFoundError();

  const groups = await withTenant(tenantId, (tx) =>
    tx.select().from(modifierGroups).where(eq(modifierGroups.productId, productId)).orderBy(modifierGroups.sortOrder),
  );

  const groupIds = groups.map((g) => g.id);
  const opts = groupIds.length > 0
    ? await withTenant(tenantId, (tx) =>
        tx.select().from(modifierOptions).where(inArray(modifierOptions.modifierGroupId, groupIds)).orderBy(modifierOptions.sortOrder),
      )
    : [];

  const optsByGroup = groupBy(opts, (o) => o.modifierGroupId);
  return {
    ...prod,
    modifierGroups: groups.map((g) => ({ ...g, options: optsByGroup[g.id] ?? [] })),
  };
}

export async function createProduct(tenantId: string, input: CreateProductInput): Promise<Product> {
  const current = await withTenant(tenantId, (tx) =>
    tx.select({ id: products.id }).from(products),
  );
  await checkQuota(tenantId, "products", current.length);
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(products).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateProduct(tenantId: string, productId: string, input: UpdateProductInput): Promise<Product> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(products)
      .set(input)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .returning(),
  );
  if (!row) throw new ProductNotFoundError();
  return row;
}

export async function deleteProduct(tenantId: string, productId: string): Promise<void> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.delete(products).where(and(eq(products.id, productId), eq(products.tenantId, tenantId))).returning({ id: products.id }),
  );
  if (!row) throw new ProductNotFoundError();
}

// ── modifier groups ───────────────────────────────────────────────────────────

export type ModifierGroupInput = {
  id?: string;
  nameEn: string;
  nameAr: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder?: number;
};

export async function upsertModifierGroup(tenantId: string, productId: string, input: ModifierGroupInput): Promise<ModifierGroup> {
  if (input.minSelections > input.maxSelections) throw new InvalidModifierRulesError();
  if (input.required && input.minSelections < 1) throw new InvalidModifierRulesError();

  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(modifierGroups)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, required: input.required, minSelections: input.minSelections, maxSelections: input.maxSelections, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(modifierGroups.id, input.id!), eq(modifierGroups.tenantId, tenantId)))
        .returning(),
    );
    if (!row) throw new Error("Modifier group not found");
    return row;
  }

  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(modifierGroups).values({ tenantId, productId, nameEn: input.nameEn, nameAr: input.nameAr, required: input.required, minSelections: input.minSelections, maxSelections: input.maxSelections, sortOrder: input.sortOrder ?? 0 }).returning(),
  );
  return row;
}

export async function deleteModifierGroup(tenantId: string, groupId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(modifierGroups).where(and(eq(modifierGroups.id, groupId), eq(modifierGroups.tenantId, tenantId))),
  );
}

// ── modifier options ──────────────────────────────────────────────────────────

export type ModifierOptionInput = {
  id?: string;
  nameEn: string;
  nameAr: string;
  priceDelta?: string;
  isDefault?: boolean;
  sortOrder?: number;
};

export async function upsertModifierOption(tenantId: string, groupId: string, input: ModifierOptionInput): Promise<ModifierOption> {
  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(modifierOptions)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, priceDelta: input.priceDelta ?? "0", isDefault: input.isDefault ?? false, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(modifierOptions.id, input.id!), eq(modifierOptions.tenantId, tenantId)))
        .returning(),
    );
    if (!row) throw new Error("Modifier option not found");
    return row;
  }

  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(modifierOptions).values({ tenantId, modifierGroupId: groupId, nameEn: input.nameEn, nameAr: input.nameAr, priceDelta: input.priceDelta ?? "0", isDefault: input.isDefault ?? false, sortOrder: input.sortOrder ?? 0 }).returning(),
  );
  return row;
}

export async function deleteModifierOption(tenantId: string, optionId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(modifierOptions).where(and(eq(modifierOptions.id, optionId), eq(modifierOptions.tenantId, tenantId))),
  );
}

// ── branch availability ───────────────────────────────────────────────────────

export async function setBranchAvailability(
  tenantId: string,
  branchId: string,
  productId: string,
  available: boolean,
  priceOverride?: number,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    if (available && priceOverride === undefined) {
      await tx.delete(branchProductAvailability).where(
        and(
          eq(branchProductAvailability.branchId, branchId),
          eq(branchProductAvailability.productId, productId),
        ),
      );
    } else {
      await tx.insert(branchProductAvailability)
        .values({ tenantId, branchId, productId, isAvailable: available, priceOverride: priceOverride !== undefined ? String(priceOverride) : null })
        .onConflictDoUpdate({
          target: [branchProductAvailability.branchId, branchProductAvailability.productId],
          set: { isAvailable: available, priceOverride: priceOverride !== undefined ? String(priceOverride) : null },
        });
    }
  });
}

// ── published menu ────────────────────────────────────────────────────────────

export async function getPublishedMenu(tenantId: string, branchId?: string): Promise<PublishedMenu> {
  return withTenant(tenantId, async (tx) => {
    const cats = await tx.select().from(categories).where(eq(categories.isActive, true)).orderBy(categories.sortOrder);

    let prodRows: Product[];
    if (branchId) {
      const rows = await tx
        .select({
          id: products.id,
          tenantId: products.tenantId,
          categoryId: products.categoryId,
          nameEn: products.nameEn,
          nameAr: products.nameAr,
          descriptionEn: products.descriptionEn,
          descriptionAr: products.descriptionAr,
          basePrice: products.basePrice,
          imageUrl: products.imageUrl,
          isPublished: products.isPublished,
          sortOrder: products.sortOrder,
          createdAt: products.createdAt,
          bpaAvailable: branchProductAvailability.isAvailable,
          bpaPriceOverride: branchProductAvailability.priceOverride,
        })
        .from(products)
        .leftJoin(
          branchProductAvailability,
          and(
            eq(branchProductAvailability.productId, products.id),
            eq(branchProductAvailability.branchId, branchId),
          ),
        )
        .where(
          and(
            eq(products.isPublished, true),
            or(isNull(branchProductAvailability.id), eq(branchProductAvailability.isAvailable, true)),
          ),
        )
        .orderBy(products.sortOrder);

      prodRows = rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        categoryId: r.categoryId,
        nameEn: r.nameEn,
        nameAr: r.nameAr,
        descriptionEn: r.descriptionEn,
        descriptionAr: r.descriptionAr,
        basePrice: r.bpaPriceOverride ?? r.basePrice,
        imageUrl: r.imageUrl,
        isPublished: r.isPublished,
        sortOrder: r.sortOrder,
        createdAt: r.createdAt,
      }));
    } else {
      prodRows = await tx.select().from(products).where(eq(products.isPublished, true)).orderBy(products.sortOrder);
    }

    const productIds = prodRows.map((p) => p.id);
    if (productIds.length === 0) {
      return {
        categories: cats.map((c) => ({ id: c.id, nameEn: c.nameEn, nameAr: c.nameAr, imageUrl: c.imageUrl, products: [] })),
      };
    }

    const groups = await tx.select().from(modifierGroups).where(inArray(modifierGroups.productId, productIds)).orderBy(modifierGroups.sortOrder);
    const groupIds = groups.map((g) => g.id);
    const opts = groupIds.length > 0
      ? await tx.select().from(modifierOptions).where(inArray(modifierOptions.modifierGroupId, groupIds)).orderBy(modifierOptions.sortOrder)
      : [];

    const optsByGroup = groupBy(opts, (o) => o.modifierGroupId);
    const groupsWithOpts: ModifierGroupWithOptions[] = groups.map((g) => ({ ...g, options: optsByGroup[g.id] ?? [] }));
    const groupsByProduct = groupBy(groupsWithOpts, (g) => g.productId);

    const prodsByCat = groupBy(
      prodRows.map((p) => ({
        id: p.id,
        nameEn: p.nameEn,
        nameAr: p.nameAr,
        descriptionEn: p.descriptionEn,
        descriptionAr: p.descriptionAr,
        effectivePrice: Number(p.basePrice),
        imageUrl: p.imageUrl,
        modifierGroups: groupsByProduct[p.id] ?? [],
        categoryId: p.categoryId,
      })),
      (p) => p.categoryId,
    );

    return {
      categories: cats
        .map((c) => ({
          id: c.id,
          nameEn: c.nameEn,
          nameAr: c.nameAr,
          imageUrl: c.imageUrl,
          products: prodsByCat[c.id] ?? [],
        }))
        .filter((c) => c.products.length > 0),
    };
  });
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/server/catalog/service.test.ts
```

Expected: Category tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/catalog/service.ts src/server/catalog/service.test.ts
git commit -m "feat(catalog): add categories service with TDD tests"
```

---

## Task 7: Catalog Products + Modifiers + Branch Availability Tests

**Files:**
- Modify: `src/server/catalog/service.test.ts` (add product, modifier, availability, getPublishedMenu tests)

- [ ] **Step 1: Append to `src/server/catalog/service.test.ts`**

Add these describe blocks after the categories block:

```typescript
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  upsertModifierGroup,
  upsertModifierOption,
  deleteModifierGroup,
  setBranchAvailability,
  getPublishedMenu,
} from "./service";
import { ProductNotFoundError, InvalidModifierRulesError } from "./errors";
import { createBranch } from "@/server/branches/service";

// Add these to the imports at the top of the file (alongside existing imports):
// listProducts, getProduct, createProduct, updateProduct, deleteProduct,
// upsertModifierGroup, upsertModifierOption, deleteModifierGroup,
// setBranchAvailability, getPublishedMenu
// ProductNotFoundError, InvalidModifierRulesError
// createBranch from @/server/branches/service

describe("catalog: products", () => {
  it("creates and lists products", async () => {
    const t = await makeTenant("p1");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "Burger", nameAr: "برجر", basePrice: "25.00", categoryId: cat.id });
    expect(prod.nameEn).toBe("Burger");
    const list = await listProducts(t.id);
    expect(list).toHaveLength(1);
    const byCat = await listProducts(t.id, cat.id);
    expect(byCat).toHaveLength(1);
  });

  it("getProduct throws ProductNotFoundError for unknown id", async () => {
    const t = await makeTenant("p2");
    await expect(getProduct(t.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(ProductNotFoundError);
  });

  it("deleteProduct removes a product", async () => {
    const t = await makeTenant("p3");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "10", categoryId: cat.id });
    await deleteProduct(t.id, prod.id);
    expect(await listProducts(t.id)).toHaveLength(0);
  });
});

describe("catalog: modifier groups and options", () => {
  it("inserts group with options and retrieves via getProduct", async () => {
    const t = await makeTenant("mod1");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "Pizza", nameAr: "بيتزا", basePrice: "50", categoryId: cat.id });
    const group = await upsertModifierGroup(t.id, prod.id, { nameEn: "Size", nameAr: "الحجم", required: true, minSelections: 1, maxSelections: 1 });
    await upsertModifierOption(t.id, group.id, { nameEn: "Small", nameAr: "صغير", priceDelta: "0" });
    await upsertModifierOption(t.id, group.id, { nameEn: "Large", nameAr: "كبير", priceDelta: "10" });
    const full = await getProduct(t.id, prod.id);
    expect(full.modifierGroups).toHaveLength(1);
    expect(full.modifierGroups[0].options).toHaveLength(2);
  });

  it("upsertModifierGroup throws InvalidModifierRulesError when min > max", async () => {
    const t = await makeTenant("mod2");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "5", categoryId: cat.id });
    await expect(upsertModifierGroup(t.id, prod.id, { nameEn: "G", nameAr: "ج", required: false, minSelections: 3, maxSelections: 1 })).rejects.toThrow(InvalidModifierRulesError);
  });

  it("upsertModifierGroup throws when required=true and min=0", async () => {
    const t = await makeTenant("mod3");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "5", categoryId: cat.id });
    await expect(upsertModifierGroup(t.id, prod.id, { nameEn: "G", nameAr: "ج", required: true, minSelections: 0, maxSelections: 1 })).rejects.toThrow(InvalidModifierRulesError);
  });

  it("deleteModifierGroup cascades options", async () => {
    const t = await makeTenant("mod4");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "5", categoryId: cat.id });
    const group = await upsertModifierGroup(t.id, prod.id, { nameEn: "G", nameAr: "ج", required: false, minSelections: 0, maxSelections: 1 });
    await upsertModifierOption(t.id, group.id, { nameEn: "Opt", nameAr: "خيار" });
    await deleteModifierGroup(t.id, group.id);
    const full = await getProduct(t.id, prod.id);
    expect(full.modifierGroups).toHaveLength(0);
  });
});

describe("catalog: branch availability and getPublishedMenu", () => {
  it("getPublishedMenu returns only published products in active categories", async () => {
    const t = await makeTenant("menu1");
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const pub = await createProduct(t.id, { nameEn: "Pub", nameAr: "منشور", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, pub.id, { isPublished: true });
    await createProduct(t.id, { nameEn: "Draft", nameAr: "مسودة", basePrice: "5", categoryId: cat.id });
    const menu = await getPublishedMenu(t.id);
    expect(menu.categories).toHaveLength(1);
    expect(menu.categories[0].products).toHaveLength(1);
    expect(menu.categories[0].products[0].nameEn).toBe("Pub");
  });

  it("getPublishedMenu excludes products unavailable at a branch", async () => {
    const t = await makeTenant("menu2");
    const branch = await createBranch(t.id, { name: "Branch A" });
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const p1 = await createProduct(t.id, { nameEn: "P1", nameAr: "ب1", basePrice: "10", categoryId: cat.id });
    const p2 = await createProduct(t.id, { nameEn: "P2", nameAr: "ب2", basePrice: "20", categoryId: cat.id });
    await updateProduct(t.id, p1.id, { isPublished: true });
    await updateProduct(t.id, p2.id, { isPublished: true });
    await setBranchAvailability(t.id, branch.id, p2.id, false);
    const menu = await getPublishedMenu(t.id, branch.id);
    expect(menu.categories[0].products.map((p) => p.nameEn)).toEqual(["P1"]);
  });

  it("getPublishedMenu without branchId ignores branch availability", async () => {
    const t = await makeTenant("menu3");
    const branch = await createBranch(t.id, { name: "B" });
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const p = await createProduct(t.id, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, p.id, { isPublished: true });
    await setBranchAvailability(t.id, branch.id, p.id, false);
    const menu = await getPublishedMenu(t.id); // no branch
    expect(menu.categories[0].products).toHaveLength(1);
  });

  it("getPublishedMenu applies price_override as effectivePrice", async () => {
    const t = await makeTenant("menu4");
    const branch = await createBranch(t.id, { name: "B" });
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const p = await createProduct(t.id, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, p.id, { isPublished: true });
    await setBranchAvailability(t.id, branch.id, p.id, true, 15);
    const menu = await getPublishedMenu(t.id, branch.id);
    expect(menu.categories[0].products[0].effectivePrice).toBe(15);
  });

  it("setBranchAvailability deletes row when restoring default", async () => {
    const t = await makeTenant("menu5");
    const branch = await createBranch(t.id, { name: "B" });
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const p = await createProduct(t.id, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, p.id, { isPublished: true });
    await setBranchAvailability(t.id, branch.id, p.id, false);
    await setBranchAvailability(t.id, branch.id, p.id, true); // restore
    const menu = await getPublishedMenu(t.id, branch.id);
    expect(menu.categories[0].products).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run all catalog tests**

```bash
npm test -- src/server/catalog/service.test.ts
```

Expected: All tests PASS (service.ts was already written in Task 6).

- [ ] **Step 3: Commit**

```bash
git add src/server/catalog/service.test.ts
git commit -m "test(catalog): add product, modifier, availability, and menu tests"
```

---

## Task 8: Banners Service

**Files:**
- Create: `src/server/banners/service.ts`
- Create: `src/server/banners/service.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/server/banners/service.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { listBanners, createBanner, updateBanner, deleteBanner, getActiveBanners } from "./service";

async function makeTenant(slug = "bn1") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}

describe("banners service", () => {
  it("creates and lists banners", async () => {
    const t = await makeTenant();
    const b = await createBanner(t.id, { imageUrl: "https://example.com/img.jpg" });
    expect(b.imageUrl).toBe("https://example.com/img.jpg");
    expect(await listBanners(t.id)).toHaveLength(1);
  });

  it("getActiveBanners returns only active banners within date range", async () => {
    const t = await makeTenant("bn2");
    const now = new Date();
    const past = new Date(now.getTime() - 1000 * 60 * 60);
    const future = new Date(now.getTime() + 1000 * 60 * 60);
    // active, no dates
    await createBanner(t.id, { imageUrl: "a.jpg", isActive: true });
    // active, within range
    await createBanner(t.id, { imageUrl: "b.jpg", isActive: true, startsAt: past, endsAt: future });
    // expired
    await createBanner(t.id, { imageUrl: "c.jpg", isActive: true, endsAt: past });
    // not yet started
    await createBanner(t.id, { imageUrl: "d.jpg", isActive: true, startsAt: future });
    // inactive
    await createBanner(t.id, { imageUrl: "e.jpg", isActive: false });
    const active = await getActiveBanners(t.id);
    expect(active.map((b) => b.imageUrl).sort()).toEqual(["a.jpg", "b.jpg"]);
  });

  it("updateBanner changes fields", async () => {
    const t = await makeTenant("bn3");
    const b = await createBanner(t.id, { imageUrl: "old.jpg" });
    const updated = await updateBanner(t.id, b.id, { imageUrl: "new.jpg" });
    expect(updated.imageUrl).toBe("new.jpg");
  });

  it("deleteBanner removes it", async () => {
    const t = await makeTenant("bn4");
    const b = await createBanner(t.id, { imageUrl: "x.jpg" });
    await deleteBanner(t.id, b.id);
    expect(await listBanners(t.id)).toHaveLength(0);
  });

  it("RLS: tenant A cannot see tenant B banners", async () => {
    const a = await makeTenant("rls-ban-a");
    const b = await makeTenant("rls-ban-b");
    await createBanner(a.id, { imageUrl: "a.jpg" });
    expect(await listBanners(b.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test -- src/server/banners/service.test.ts
```

Expected: FAIL — `listBanners` not found.

- [ ] **Step 3: Create `src/server/banners/service.ts`**

```typescript
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { banners, type Banner, type NewBanner } from "./schema";
import { BannerNotFoundError } from "./errors";

export type CreateBannerInput = Partial<Omit<NewBanner, "id" | "tenantId" | "createdAt">> & { imageUrl: string };
export type UpdateBannerInput = Partial<Omit<NewBanner, "id" | "tenantId" | "createdAt">>;

export async function listBanners(tenantId: string): Promise<Banner[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(banners).orderBy(banners.sortOrder),
  );
}

export async function createBanner(tenantId: string, input: CreateBannerInput): Promise<Banner> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(banners).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateBanner(tenantId: string, bannerId: string, input: UpdateBannerInput): Promise<Banner> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(banners).set(input).where(and(eq(banners.id, bannerId), eq(banners.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BannerNotFoundError();
  return row;
}

export async function deleteBanner(tenantId: string, bannerId: string): Promise<void> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.delete(banners).where(and(eq(banners.id, bannerId), eq(banners.tenantId, tenantId))).returning({ id: banners.id }),
  );
  if (!row) throw new BannerNotFoundError();
}

export async function getActiveBanners(tenantId: string): Promise<Banner[]> {
  const now = new Date();
  return withTenant(tenantId, (tx) =>
    tx.select().from(banners).where(
      and(
        eq(banners.isActive, true),
        or(isNull(banners.startsAt), lt(banners.startsAt, now)),
        or(isNull(banners.endsAt), gt(banners.endsAt, now)),
      ),
    ).orderBy(banners.sortOrder),
  );
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/server/banners/service.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/banners/service.ts src/server/banners/service.test.ts
git commit -m "feat(banners): add service with TDD integration tests"
```

---

## Task 9: RBAC Permission + Dashboard Auth Helper

**Files:**
- Modify: `src/server/rbac/permissions.ts`
- Create: `src/server/auth/dashboard-context.ts`

- [ ] **Step 1: Add `menu:manage` to `src/server/rbac/permissions.ts`**

```typescript
export const PERMISSIONS = [
  "tenant:manage",
  "staff:invite",
  "plan:view",
  "plan:change",
  "billing:manage",
  "platform:approve_tenant",
  "platform:suspend_tenant",
  "platform:view_revenue",
  "menu:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RoleKey = "owner" | "manager" | "staff" | "super_admin";

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: ["tenant:manage", "staff:invite", "plan:view", "plan:change", "billing:manage", "menu:manage"],
  manager: ["staff:invite", "plan:view", "menu:manage"],
  staff: ["plan:view"],
  super_admin: ["platform:approve_tenant", "platform:suspend_tenant", "platform:view_revenue"],
};
```

- [ ] **Step 2: Create `src/server/auth/dashboard-context.ts`**

```typescript
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "./session";
import { loadUserRoleKeys, SESSION_COOKIE } from "./current-user";
import { authorize } from "@/server/rbac/authorize";
import type { Permission } from "@/server/rbac/permissions";
import type { User } from "./schema";
import type { RoleKey } from "@/server/rbac/permissions";

export type DashboardContext = {
  user: User;
  tenantId: string;
  roleKeys: RoleKey[];
};

/**
 * Validates the session cookie and returns the current dashboard user + tenantId.
 * Redirects to /login if no valid session or user has no tenantId (super-admins).
 * Call authorize(ctx.roleKeys, permission) after this to check specific permissions.
 */
export async function requireDashboardUser(): Promise<DashboardContext> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;
  if (!session || !session.user.tenantId) redirect("/login");
  const roleKeys = await loadUserRoleKeys(session.user.id);
  return { user: session.user, tenantId: session.user.tenantId, roleKeys };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/rbac/permissions.ts src/server/auth/dashboard-context.ts
git commit -m "feat(rbac): add menu:manage permission and dashboard auth helper"
```

---

## Task 10: Public Menu API

**Files:**
- Create: `src/app/api/menu/route.ts`

- [ ] **Step 1: Create `src/app/api/menu/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  const branchId = searchParams.get("branch") ?? undefined;

  if (!slug) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !["active", "trial"].includes(tenant.status)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const menu = await getPublishedMenu(tenant.id, branchId);
  return NextResponse.json(menu);
}
```

- [ ] **Step 2: Start dev server and test manually**

```bash
npm run dev &
curl "http://localhost:3000/api/menu?slug=nonexistent" 
```

Expected: `{"error":"Not found"}` with status 404.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/menu/route.ts
git commit -m "feat: add public GET /api/menu route"
```

---

## Task 11: Image Upload Server Action

**Files:**
- Create: `src/app/api/media-upload/route.ts`

Requires two new env vars. Add to `.env.local` and `.env.test`:
```
SUPABASE_URL=https://bntbuyvuhakyaqlhrsco.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key-from-supabase-dashboard>
```

The service role key is in the Supabase dashboard under Settings → API → `service_role` (not the `anon` key).

- [ ] **Step 1: Create `src/app/api/media-upload/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireDashboardUser } from "@/server/auth/dashboard-context";

const ALLOWED_TYPES = ["category", "product", "banner"] as const;
type MediaType = (typeof ALLOWED_TYPES)[number];

export async function POST(req: NextRequest) {
  let ctx: Awaited<ReturnType<typeof requireDashboardUser>>;
  try {
    ctx = await requireDashboardUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json() as { type?: string; filename?: string; contentType?: string };
  const { type, filename, contentType } = body;

  if (!type || !ALLOWED_TYPES.includes(type as MediaType) || !filename || !contentType) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ext = filename.split(".").pop() ?? "bin";
  const path = `${ctx.tenantId}/${type}/${randomUUID()}.${ext}`;
  const bucket = "media";

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
  }

  const signRes = await fetch(`${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ upsert: false }),
  });

  if (!signRes.ok) {
    const err = await signRes.text();
    return NextResponse.json({ error: `Storage error: ${err}` }, { status: 502 });
  }

  const { signedURL } = (await signRes.json()) as { signedURL: string };
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;

  return NextResponse.json({ uploadUrl: signedURL, publicUrl });
}
```

- [ ] **Step 2: Create the `media` bucket in Supabase**

In the Supabase dashboard → Storage → New bucket:
- Name: `media`
- Public bucket: ✓ (so public URLs work without auth)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/media-upload/route.ts
git commit -m "feat: add media upload presigned URL endpoint"
```

---

## Task 12: Dashboard Branches UI

**Files:**
- Create: `src/app/dashboard/branches/page.tsx`
- Create: `src/app/dashboard/branches/actions.ts`
- Create: `src/app/dashboard/branches/[id]/page.tsx`

- [ ] **Step 1: Create `src/app/dashboard/branches/actions.ts`**

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { validateSession } from "@/server/auth/session";
import { loadUserRoleKeys, SESSION_COOKIE } from "@/server/auth/current-user";
import { authorize } from "@/server/rbac/authorize";
import { createBranch, updateBranch, deleteBranch } from "@/server/branches/service";

async function getTenantId() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;
  if (!session?.user.tenantId) redirect("/login");
  const roleKeys = await loadUserRoleKeys(session.user.id);
  authorize(roleKeys, "menu:manage");
  return session.user.tenantId;
}

export async function createBranchAction(formData: FormData) {
  const tenantId = await getTenantId();
  await createBranch(tenantId, {
    name: String(formData.get("name")),
    address: formData.get("address") ? String(formData.get("address")) : undefined,
    phone: formData.get("phone") ? String(formData.get("phone")) : undefined,
  });
  revalidatePath("/dashboard/branches");
  redirect("/dashboard/branches");
}

export async function updateBranchAction(branchId: string, formData: FormData) {
  const tenantId = await getTenantId();
  await updateBranch(tenantId, branchId, {
    name: String(formData.get("name")),
    address: formData.get("address") ? String(formData.get("address")) : undefined,
    phone: formData.get("phone") ? String(formData.get("phone")) : undefined,
  });
  revalidatePath("/dashboard/branches");
  redirect("/dashboard/branches");
}

export async function deleteBranchAction(branchId: string) {
  const tenantId = await getTenantId();
  await deleteBranch(tenantId, branchId);
  revalidatePath("/dashboard/branches");
}
```

- [ ] **Step 2: Create `src/app/dashboard/branches/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listBranches } from "@/server/branches/service";
import { createBranchAction } from "./actions";

export default async function BranchesPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const branches = await listBranches(ctx.tenantId);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Branches</h1>
      <ul>
        {branches.map((b) => (
          <li key={b.id}>
            <a href={`/dashboard/branches/${b.id}`}>{b.name}</a>
            {b.address && <span> — {b.address}</span>}
          </li>
        ))}
      </ul>
      <h2>Add Branch</h2>
      <form action={createBranchAction}>
        <input name="name" placeholder="Branch name" required />
        <input name="address" placeholder="Address (optional)" />
        <input name="phone" placeholder="Phone (optional)" />
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Create `src/app/dashboard/branches/[id]/page.tsx`**

```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getBranch } from "@/server/branches/service";
import { updateBranchAction, deleteBranchAction } from "../actions";

export default async function EditBranchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const branch = await getBranch(ctx.tenantId, id);

  const updateAction = updateBranchAction.bind(null, id);
  const deleteAction = deleteBranchAction.bind(null, id);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Edit Branch</h1>
      <form action={updateAction}>
        <input name="name" defaultValue={branch.name} required />
        <input name="address" defaultValue={branch.address ?? ""} />
        <input name="phone" defaultValue={branch.phone ?? ""} />
        <button type="submit">Save</button>
      </form>
      <form action={deleteAction} style={{ marginTop: 16 }}>
        <button type="submit" style={{ color: "red" }}>Deactivate Branch</button>
      </form>
      <p><a href="/dashboard/branches">← Back</a></p>
    </main>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/branches/
git commit -m "feat: add dashboard branches pages and actions"
```

---

## Task 13: Dashboard Categories UI

**Files:**
- Create: `src/app/dashboard/menu/page.tsx`
- Create: `src/app/dashboard/menu/categories/actions.ts`
- Create: `src/app/dashboard/menu/categories/new/page.tsx`
- Create: `src/app/dashboard/menu/categories/[id]/page.tsx`

- [ ] **Step 1: Create `src/app/dashboard/menu/categories/actions.ts`**

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createCategory, updateCategory, deleteCategory } from "@/server/catalog/service";

async function getCtx() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}

export async function createCategoryAction(formData: FormData) {
  const { tenantId } = await getCtx();
  await createCategory(tenantId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateCategoryAction(categoryId: string, formData: FormData) {
  const { tenantId } = await getCtx();
  await updateCategory(tenantId, categoryId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function deleteCategoryAction(categoryId: string) {
  const { tenantId } = await getCtx();
  await deleteCategory(tenantId, categoryId);
  revalidatePath("/dashboard/menu");
}
```

- [ ] **Step 2: Create `src/app/dashboard/menu/page.tsx`**

```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories, listProducts } from "@/server/catalog/service";
import { deleteCategoryAction } from "./categories/actions";

export default async function MenuPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);
  const prods = await listProducts(ctx.tenantId);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Menu</h1>
      <p><a href="/dashboard/menu/categories/new">+ New Category</a></p>
      {cats.map((cat) => {
        const catProds = prods.filter((p) => p.categoryId === cat.id);
        const delCat = deleteCategoryAction.bind(null, cat.id);
        return (
          <section key={cat.id} style={{ marginBottom: 24 }}>
            <h2>
              {cat.nameEn} / {cat.nameAr}
              {" "}<a href={`/dashboard/menu/categories/${cat.id}`}>[edit]</a>
              {catProds.length === 0 && (
                <form action={delCat} style={{ display: "inline" }}>
                  <button type="submit" style={{ color: "red", marginLeft: 8 }}>[delete]</button>
                </form>
              )}
            </h2>
            <ul>
              {catProds.map((p) => (
                <li key={p.id}>
                  <a href={`/dashboard/menu/products/${p.id}`}>{p.nameEn}</a>
                  {" "}{p.isPublished ? "✓" : "(draft)"}
                  {" "}${p.basePrice}
                </li>
              ))}
            </ul>
            <a href={`/dashboard/menu/products/new?categoryId=${cat.id}`}>+ Add Product</a>
          </section>
        );
      })}
    </main>
  );
}
```

- [ ] **Step 3: Create `src/app/dashboard/menu/categories/new/page.tsx`**

```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createCategoryAction } from "../actions";

export default async function NewCategoryPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>New Category</h1>
      <form action={createCategoryAction}>
        <div><label>Name (EN): <input name="nameEn" required /></label></div>
        <div><label>Name (AR): <input name="nameAr" required dir="rtl" /></label></div>
        <div><label>Description (EN): <input name="descriptionEn" /></label></div>
        <div><label>Description (AR): <input name="descriptionAr" dir="rtl" /></label></div>
        <button type="submit">Create</button>
      </form>
      <p><a href="/dashboard/menu">← Back</a></p>
    </main>
  );
}
```

- [ ] **Step 4: Create `src/app/dashboard/menu/categories/[id]/page.tsx`**

```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories } from "@/server/catalog/service";
import { updateCategoryAction } from "../actions";

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);
  const cat = cats.find((c) => c.id === id);
  if (!cat) return <main style={{ padding: 32 }}><p>Category not found.</p></main>;

  const updateAction = updateCategoryAction.bind(null, id);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Edit Category</h1>
      <form action={updateAction}>
        <div><label>Name (EN): <input name="nameEn" defaultValue={cat.nameEn} required /></label></div>
        <div><label>Name (AR): <input name="nameAr" defaultValue={cat.nameAr} required dir="rtl" /></label></div>
        <button type="submit">Save</button>
      </form>
      <p><a href="/dashboard/menu">← Back</a></p>
    </main>
  );
}
```

- [ ] **Step 5: Compile check**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/menu/
git commit -m "feat: add dashboard categories pages and actions"
```

---

## Task 14: Dashboard Products UI

**Files:**
- Create: `src/app/dashboard/menu/products/actions.ts`
- Create: `src/app/dashboard/menu/products/new/page.tsx`
- Create: `src/app/dashboard/menu/products/[id]/page.tsx`

- [ ] **Step 1: Create `src/app/dashboard/menu/products/actions.ts`**

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  upsertModifierGroup,
  deleteModifierGroup,
  upsertModifierOption,
  deleteModifierOption,
  setBranchAvailability,
} from "@/server/catalog/service";

async function getCtx() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}

export async function createProductAction(formData: FormData) {
  const { tenantId } = await getCtx();
  await createProduct(tenantId, {
    categoryId: String(formData.get("categoryId")),
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    basePrice: String(formData.get("basePrice")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateProductAction(productId: string, formData: FormData) {
  const { tenantId } = await getCtx();
  const isPublished = formData.get("isPublished") === "true";
  await updateProduct(tenantId, productId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    basePrice: String(formData.get("basePrice")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
    isPublished,
  });
  revalidatePath("/dashboard/menu");
  redirect(`/dashboard/menu/products/${productId}`);
}

export async function deleteProductAction(productId: string) {
  const { tenantId } = await getCtx();
  await deleteProduct(tenantId, productId);
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function upsertModifierGroupAction(productId: string, formData: FormData) {
  const { tenantId } = await getCtx();
  await upsertModifierGroup(tenantId, productId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    required: formData.get("required") === "true",
    minSelections: Number(formData.get("minSelections") ?? 0),
    maxSelections: Number(formData.get("maxSelections") ?? 1),
  });
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function deleteModifierGroupAction(productId: string, groupId: string) {
  const { tenantId } = await getCtx();
  await deleteModifierGroup(tenantId, groupId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function upsertModifierOptionAction(productId: string, groupId: string, formData: FormData) {
  const { tenantId } = await getCtx();
  await upsertModifierOption(tenantId, groupId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    priceDelta: String(formData.get("priceDelta") ?? "0"),
  });
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function deleteModifierOptionAction(productId: string, optionId: string) {
  const { tenantId } = await getCtx();
  await deleteModifierOption(tenantId, optionId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function setBranchAvailabilityAction(
  productId: string,
  branchId: string,
  available: boolean,
  priceOverride?: number,
) {
  const { tenantId } = await getCtx();
  await setBranchAvailability(tenantId, branchId, productId, available, priceOverride);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}
```

- [ ] **Step 2: Create `src/app/dashboard/menu/products/new/page.tsx`**

```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories } from "@/server/catalog/service";
import { createProductAction } from "../actions";

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ categoryId?: string }> }) {
  const { categoryId } = await searchParams;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>New Product</h1>
      <form action={createProductAction}>
        <div>
          <label>Category:
            <select name="categoryId" defaultValue={categoryId ?? ""} required>
              <option value="">Select…</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
            </select>
          </label>
        </div>
        <div><label>Name (EN): <input name="nameEn" required /></label></div>
        <div><label>Name (AR): <input name="nameAr" required dir="rtl" /></label></div>
        <div><label>Description (EN): <input name="descriptionEn" /></label></div>
        <div><label>Description (AR): <input name="descriptionAr" dir="rtl" /></label></div>
        <div><label>Base Price: <input name="basePrice" type="number" step="0.01" required /></label></div>
        <button type="submit">Create</button>
      </form>
      <p><a href="/dashboard/menu">← Back</a></p>
    </main>
  );
}
```

- [ ] **Step 3: Create `src/app/dashboard/menu/products/[id]/page.tsx`**

```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getProduct } from "@/server/catalog/service";
import {
  updateProductAction,
  deleteProductAction,
  upsertModifierGroupAction,
  deleteModifierGroupAction,
  upsertModifierOptionAction,
  deleteModifierOptionAction,
} from "../actions";

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const product = await getProduct(ctx.tenantId, id);

  const updateAction = updateProductAction.bind(null, id);
  const deleteAction = deleteProductAction.bind(null, id);
  const addGroupAction = upsertModifierGroupAction.bind(null, id);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Edit Product: {product.nameEn}</h1>

      <form action={updateAction}>
        <div><label>Name (EN): <input name="nameEn" defaultValue={product.nameEn} required /></label></div>
        <div><label>Name (AR): <input name="nameAr" defaultValue={product.nameAr} required dir="rtl" /></label></div>
        <div><label>Description (EN): <input name="descriptionEn" defaultValue={product.descriptionEn ?? ""} /></label></div>
        <div><label>Description (AR): <input name="descriptionAr" defaultValue={product.descriptionAr ?? ""} dir="rtl" /></label></div>
        <div><label>Base Price: <input name="basePrice" type="number" step="0.01" defaultValue={String(product.basePrice)} required /></label></div>
        <div>
          <label>
            <input type="checkbox" name="isPublished" value="true" defaultChecked={product.isPublished} />
            {" "}Published
          </label>
        </div>
        <button type="submit">Save</button>
      </form>

      <h2>Modifier Groups</h2>
      {product.modifierGroups.map((group) => {
        const delGroup = deleteModifierGroupAction.bind(null, id, group.id);
        const addOpt = upsertModifierOptionAction.bind(null, id, group.id);
        return (
          <section key={group.id} style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>
            <strong>{group.nameEn} / {group.nameAr}</strong>
            {" "}(min: {group.minSelections}, max: {group.maxSelections}, required: {String(group.required)})
            <form action={delGroup} style={{ display: "inline" }}>
              <button type="submit" style={{ color: "red", marginLeft: 8 }}>[delete group]</button>
            </form>
            <ul>
              {group.options.map((opt) => {
                const delOpt = deleteModifierOptionAction.bind(null, id, opt.id);
                return (
                  <li key={opt.id}>
                    {opt.nameEn} / {opt.nameAr} (+{opt.priceDelta})
                    <form action={delOpt} style={{ display: "inline" }}>
                      <button type="submit" style={{ color: "red", marginLeft: 4 }}>[x]</button>
                    </form>
                  </li>
                );
              })}
            </ul>
            <form action={addOpt}>
              <input name="nameEn" placeholder="Option EN" required />
              <input name="nameAr" placeholder="Option AR" dir="rtl" required />
              <input name="priceDelta" type="number" step="0.01" placeholder="Price delta" defaultValue="0" />
              <button type="submit">Add Option</button>
            </form>
          </section>
        );
      })}

      <h3>Add Modifier Group</h3>
      <form action={addGroupAction}>
        <input name="nameEn" placeholder="Group name EN" required />
        <input name="nameAr" placeholder="Group name AR" dir="rtl" required />
        <label><input type="checkbox" name="required" value="true" /> Required</label>
        <input name="minSelections" type="number" defaultValue="0" min="0" placeholder="Min" />
        <input name="maxSelections" type="number" defaultValue="1" min="1" placeholder="Max" />
        <button type="submit">Add Group</button>
      </form>

      <form action={deleteAction} style={{ marginTop: 24 }}>
        <button type="submit" style={{ color: "red" }}>Delete Product</button>
      </form>
      <p><a href="/dashboard/menu">← Back</a></p>
    </main>
  );
}
```

- [ ] **Step 4: Compile check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/menu/products/
git commit -m "feat: add dashboard products pages with modifier groups editor"
```

---

## Task 15: Dashboard Banners UI

**Files:**
- Create: `src/app/dashboard/banners/page.tsx`
- Create: `src/app/dashboard/banners/actions.ts`

- [ ] **Step 1: Create `src/app/dashboard/banners/actions.ts`**

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createBanner, updateBanner, deleteBanner } from "@/server/banners/service";

async function getCtx() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}

export async function createBannerAction(formData: FormData) {
  const { tenantId } = await getCtx();
  await createBanner(tenantId, {
    imageUrl: String(formData.get("imageUrl")),
    titleEn: formData.get("titleEn") ? String(formData.get("titleEn")) : undefined,
    titleAr: formData.get("titleAr") ? String(formData.get("titleAr")) : undefined,
    linkUrl: formData.get("linkUrl") ? String(formData.get("linkUrl")) : undefined,
  });
  revalidatePath("/dashboard/banners");
}

export async function toggleBannerAction(bannerId: string, isActive: boolean) {
  const { tenantId } = await getCtx();
  await updateBanner(tenantId, bannerId, { isActive });
  revalidatePath("/dashboard/banners");
}

export async function deleteBannerAction(bannerId: string) {
  const { tenantId } = await getCtx();
  await deleteBanner(tenantId, bannerId);
  revalidatePath("/dashboard/banners");
}
```

- [ ] **Step 2: Create `src/app/dashboard/banners/page.tsx`**

```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listBanners } from "@/server/banners/service";
import { createBannerAction, toggleBannerAction, deleteBannerAction } from "./actions";

export default async function BannersPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const banners = await listBanners(ctx.tenantId);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Banners</h1>
      <ul>
        {banners.map((b) => {
          const toggle = toggleBannerAction.bind(null, b.id, !b.isActive);
          const del = deleteBannerAction.bind(null, b.id);
          return (
            <li key={b.id} style={{ marginBottom: 8 }}>
              <img src={b.imageUrl} alt={b.titleEn ?? ""} style={{ width: 120, height: 60, objectFit: "cover" }} />
              {" "}{b.titleEn ?? "(no title)"} — {b.isActive ? "active" : "inactive"}
              <form action={toggle} style={{ display: "inline" }}>
                <button type="submit" style={{ marginLeft: 8 }}>{b.isActive ? "Deactivate" : "Activate"}</button>
              </form>
              <form action={del} style={{ display: "inline" }}>
                <button type="submit" style={{ color: "red", marginLeft: 4 }}>Delete</button>
              </form>
            </li>
          );
        })}
      </ul>

      <h2>Add Banner</h2>
      <form action={createBannerAction}>
        <div><label>Image URL: <input name="imageUrl" required /></label></div>
        <div><label>Title (EN): <input name="titleEn" /></label></div>
        <div><label>Title (AR): <input name="titleAr" dir="rtl" /></label></div>
        <div><label>Link URL: <input name="linkUrl" /></label></div>
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Compile check + commit**

```bash
npx tsc --noEmit
git add src/app/dashboard/banners/
git commit -m "feat: add dashboard banners pages and actions"
```

---

## Task 16: Storefront Menu Display

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Replace the storefront branch in `src/app/page.tsx`**

Replace the entire file:

```tsx
import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches } from "@/server/branches/service";

export default async function Home() {
  const h = await headers();
  const surface = h.get("x-surface");
  const slug = h.get("x-tenant-slug");

  if (surface === "storefront" && slug) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return <main style={{ padding: 48, fontFamily: "system-ui" }}><h1>Restaurant not found</h1></main>;
    }
    if (!["active", "trial"].includes(tenant.status)) {
      return (
        <main style={{ padding: 48, fontFamily: "system-ui", color: tenant.primaryColor }}>
          <h1>{tenant.name}</h1>
          <p>This restaurant is getting ready. Check back soon!</p>
        </main>
      );
    }

    const [banners, menu, branches] = await Promise.all([
      getActiveBanners(tenant.id),
      getPublishedMenu(tenant.id),
      listBranches(tenant.id),
    ]);

    return (
      <main style={{ fontFamily: "system-ui", color: tenant.primaryColor }}>
        {banners.length > 0 && (
          <section style={{ display: "flex", gap: 8, overflowX: "auto", padding: "16px 24px" }}>
            {banners.map((b) => (
              <a key={b.id} href={b.linkUrl ?? "#"}>
                <img src={b.imageUrl} alt={b.titleEn ?? ""} style={{ height: 160, borderRadius: 8 }} />
              </a>
            ))}
          </section>
        )}

        {branches.length > 1 && (
          <section style={{ padding: "8px 24px" }}>
            <label>Branch: {" "}
              <select id="branch-select" onChange="window.location.search='?branch='+this.value" defaultValue="">
                <option value="">All branches</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          </section>
        )}

        <section style={{ padding: "0 24px 32px" }}>
          <h1 style={{ fontSize: 28, marginBottom: 4 }}>{tenant.name}</h1>
          {menu.categories.length === 0 && <p>Menu coming soon.</p>}
          {menu.categories.map((cat) => (
            <div key={cat.id} style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 20, borderBottom: "2px solid currentColor", paddingBottom: 4 }}>
                {cat.nameEn} / {cat.nameAr}
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16, marginTop: 12 }}>
                {cat.products.map((p) => (
                  <div key={p.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
                    {p.imageUrl && <img src={p.imageUrl} alt={p.nameEn} style={{ width: "100%", height: 160, objectFit: "cover" }} />}
                    <div style={{ padding: 12 }}>
                      <div style={{ fontWeight: 600 }}>{p.nameEn}</div>
                      <div dir="rtl" style={{ color: "#6b7280", fontSize: 14 }}>{p.nameAr}</div>
                      {p.descriptionEn && <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{p.descriptionEn}</p>}
                      <div style={{ marginTop: 8, fontWeight: 700 }}>
                        {p.effectivePrice.toFixed(2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>
    );
  }

  return (
    <main style={{ padding: 48, fontFamily: "system-ui" }}>
      <h1>ServeOS</h1>
      <p>The operating system for restaurants. Online ordering, reservations, and WhatsApp commerce.</p>
    </main>
  );
}
```

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: extend storefront to display published menu with banners"
```

---

## Task 17: Module Index Re-exports

**Files:**
- Create: `src/server/branches/index.ts`
- Create: `src/server/catalog/index.ts`
- Create: `src/server/banners/index.ts`

- [ ] **Step 1: Create `src/server/branches/index.ts`**

```typescript
export { branches, type Branch, type NewBranch } from "./schema";
export { BranchNotFoundError } from "./errors";
export {
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  deleteBranch,
  type CreateBranchInput,
  type UpdateBranchInput,
} from "./service";
```

- [ ] **Step 2: Create `src/server/catalog/index.ts`**

```typescript
export {
  categories,
  products,
  modifierGroups,
  modifierOptions,
  branchProductAvailability,
  type Category,
  type Product,
  type ModifierGroup,
  type ModifierOption,
  type ModifierGroupWithOptions,
  type ProductWithModifiers,
  type PublishedMenu,
} from "./schema";
export { CategoryNotEmptyError, ProductNotFoundError, InvalidModifierRulesError } from "./errors";
export {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  upsertModifierGroup,
  deleteModifierGroup,
  upsertModifierOption,
  deleteModifierOption,
  setBranchAvailability,
  getPublishedMenu,
} from "./service";
```

- [ ] **Step 3: Create `src/server/banners/index.ts`**

```typescript
export { banners, type Banner, type NewBanner } from "./schema";
export { BannerNotFoundError } from "./errors";
export {
  listBanners,
  createBanner,
  updateBanner,
  deleteBanner,
  getActiveBanners,
} from "./service";
```

- [ ] **Step 4: Commit**

```bash
git add src/server/branches/index.ts src/server/catalog/index.ts src/server/banners/index.ts
git commit -m "feat: add module index re-exports for branches, catalog, banners"
```

---

## Task 18: Run Full Test Suite

- [ ] **Step 1: Run all unit/integration tests**

```bash
npm test
```

Expected: All tests pass. If any fail, read the error message — the most likely issues are:
- Migration not applied to test DB → run `npm run db:migrate:test`
- Import path errors → check `@/` aliases resolve correctly
- Schema type mismatch → verify Drizzle column names match the property names used in service queries

- [ ] **Step 2: Fix any failures**

Address errors one by one. Commit fixes.

- [ ] **Step 3: Compile check**

```bash
npx tsc --noEmit
```

---

## Task 19: E2E Smoke Tests

**Files:**
- Create: `tests/e2e/menu.spec.ts`

- [ ] **Step 1: Ensure a seeded tenant exists**

The seed script (`scripts/seed.ts`) from sub-project #1 creates a demo tenant with slug `roma`. If `roma` doesn't have menu data, add it manually via the dashboard or extend the seed script to include a category and product.

Alternatively, use the E2E test itself to seed via the API — but the simplest approach is to assume a pre-seeded tenant. Check the existing seed:

```bash
npm run db:seed
```

If the seed doesn't add a menu, manually create:
1. Start dev server: `npm run dev`
2. Register/login as the `roma` tenant owner
3. Create one category and one published product via `/dashboard/menu`

- [ ] **Step 2: Create `tests/e2e/menu.spec.ts`**

```typescript
import { test, expect } from "@playwright/test";

const ROOT = "http://localhost:3000";

test("GET /api/menu returns published products for an active tenant", async ({ request }) => {
  // Requires: tenant with slug "roma" exists with status active/trial
  // and has at least one published product
  const res = await request.get(`${ROOT}/api/menu?slug=roma`);
  expect(res.status()).toBe(200);
  const menu = await res.json();
  expect(menu).toHaveProperty("categories");
  expect(Array.isArray(menu.categories)).toBe(true);
});

test("GET /api/menu returns 404 for unknown slug", async ({ request }) => {
  const res = await request.get(`${ROOT}/api/menu?slug=doesnotexist`);
  expect(res.status()).toBe(404);
});

test("GET /api/menu returns 400 when slug is missing", async ({ request }) => {
  const res = await request.get(`${ROOT}/api/menu`);
  expect(res.status()).toBe(400);
});

test("storefront page renders menu for active tenant", async ({ request }) => {
  // Uses Host header injection (same pattern as onboarding E2E tests)
  const res = await request.get(ROOT, {
    headers: { host: "roma.serveos.localhost" },
  });
  expect(res.status()).toBe(200);
  const html = await res.text();
  // Should contain the tenant name (or "Menu coming soon" if no products yet)
  expect(html.toLowerCase()).toMatch(/pizza roma|coming soon|menu/i);
});
```

- [ ] **Step 3: Run E2E tests (requires dev server)**

Start the server in one terminal:
```bash
npm run dev
```

In another terminal:
```bash
npm run test:e2e -- tests/e2e/menu.spec.ts
```

Expected: All 3 tests pass. If the storefront test fails with HTML missing the expected text, verify the `roma` tenant exists and has `status = 'active'` or `'trial'`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/menu.spec.ts
git commit -m "test(e2e): add menu API and storefront smoke tests"
```

---

## Done

All 19 tasks complete. The Menu & Catalog sub-project is built:
- `branches`, `catalog`, `banners` domain modules with FORCE RLS + `withTenant`
- Plan quota enforcement on `branches` and `products`
- `getPublishedMenu` with branch-level filtering and price overrides
- Public `GET /api/menu` API
- Dashboard CRUD for branches, categories, products (with modifier groups), and banners
- Read-only storefront menu display page (banners + categories + products)
- Presigned image upload endpoint
- Full integration test suite proving RLS isolation between tenants
