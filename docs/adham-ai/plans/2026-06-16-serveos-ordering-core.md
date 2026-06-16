# ServeOS Online Ordering Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use parallel-build (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the online ordering core — a customer can add menu items to a cart on a tenant storefront, check out as a guest for pickup or delivery (named delivery areas, server-computed totals with VAT), and track the order on a tokenized status page; staff process the order through a validated lifecycle in a unified dashboard list.

**Architecture:** Follows the established patterns exactly — framework-agnostic services under `src/server/<domain>/`, per-tenant operational tables behind FORCE Row-Level Security accessed only through `withTenant`, a single `entitlements` gate, dashboard pages via `requireDashboardUser`/`authorize` + server actions, storefront on `{slug}.serveos.com` resolved by the `x-tenant-slug` header set in `src/proxy.ts`. A new `ordering` domain owns the transactional tables and state machine; branch-level fulfillment config (opening hours, accepting-orders toggle, delivery areas) extends the existing `branches` domain; VAT lives in `tenant_settings`. The cart is client-side (localStorage); checkout is server-authoritative.

**Tech Stack:** Next.js 16 (App Router, server actions), Drizzle ORM + Postgres (RLS), TypeScript, Vitest (unit/integration, real test DB), Playwright (e2e).

**Conventions used throughout this plan:**
- Money columns are Postgres `numeric` → Drizzle returns/accepts **strings**. Compute in JS `number`, then format with the `money()` helper (Task 10) before persisting.
- New per-tenant tables get FORCE RLS via a hand-appended block in the generated migration (pattern from `drizzle/0007_bitter_mandarin.sql`).
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (omitted from the commands below for brevity — add it).
- Run unit/integration tests with `npm run test`. The test DB must have the latest migrations: after any schema change run `npm run db:migrate` **and** `npm run db:migrate:test` before running tests.

---

## File Structure

**New domain — `src/server/ordering/`**
- `schema.ts` — `orders`, `order_items`, `order_status_events` tables + enums + row/snapshot types
- `state-machine.ts` — pure transition table (`nextStatuses`, `canTransition`); no DB/framework deps
- `errors.ts` — typed domain errors
- `service.ts` — `placeOrder`, `getOrderByToken`, `getOrder`, `listOrders`, `transitionStatus`, `markPaid`, `pendingOrderCount`
- `index.ts` — barrel
- `state-machine.test.ts`, `service.test.ts`

**Extended — `src/server/branches/`**
- `schema.ts` — add `acceptingOrders`, `openingHours` columns to `branches`; add `deliveryAreas` table + `OpeningHours`/`DayHours` types
- `orderability.ts` — pure `isBranchOrderable(branch, now)`; `orderability.test.ts`
- `service.ts` — add `updateBranchOrdering`, delivery-area CRUD; extend `index.ts`

**Extended — `src/server/entitlements/service.ts`** — add `incrementUsage`
**Extended — `src/server/subscription/schema.ts` + `plans.seed.ts`** — add `online_ordering` feature
**Extended — `src/server/rbac/permissions.ts`** — add `orders:manage`, `fulfillment:manage`
**New — `src/server/tenancy/settings.ts`** — `getTenantSettings`, `setVatRate`, `getVatRate`; `settings.test.ts`
**Extended — `src/db/schema.ts`** — export the new `ordering` schema

**Storefront (customer) — `src/app/`**
- `_components/cart.ts` — localStorage cart types + pure helpers
- `_components/StorefrontMenu.tsx` — client: product cards w/ modifier selection + add-to-cart + cart drawer
- `checkout/page.tsx` + `checkout/CheckoutForm.tsx` — client checkout
- `order/[token]/page.tsx` + `order/[token]/StatusPoller.tsx` — tokenized status page
- `api/orders/route.ts` — `POST` place order
- `api/orders/[token]/status/route.ts` — `GET` status (polling)
- `api/delivery-areas/route.ts` — `GET` areas for a branch (checkout preview)

**Dashboard (staff) — `src/app/dashboard/`**
- `orders/page.tsx` + `orders/OrdersTable.tsx` (client poller) — unified list
- `orders/[id]/page.tsx` + `orders/[id]/actions.ts` — detail + transitions
- `fulfillment/page.tsx` + `fulfillment/actions.ts` — hours/toggle + delivery areas + VAT
- `orders-permission.ts`, `fulfillment-permission.ts` — permission guards

**Seed/e2e** — extend `scripts/seed.ts`; add `tests/e2e/ordering.spec.ts`

---

## Task 1: Add `online_ordering` plan feature + `incrementUsage`

**Files:**
- Modify: `src/server/subscription/schema.ts` (PlanFeatures type)
- Modify: `src/server/subscription/plans.seed.ts` (three seeds)
- Modify: `src/server/entitlements/service.ts` (new function)
- Test: `src/server/entitlements/usage.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/server/entitlements/usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { usageCounters } from "@/server/subscription/schema";
import { and, eq } from "drizzle-orm";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { hasFeature } from "@/server/entitlements/service";
import { incrementUsage } from "@/server/entitlements/service";

async function makeTenant(slug = "u1") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("entitlements usage + online_ordering", () => {
  it("basic plan has online_ordering feature", async () => {
    const t = await makeTenant("u1");
    expect(await hasFeature(t.id, "online_ordering")).toBe(true);
  });

  it("incrementUsage creates then increments the period counter", async () => {
    const t = await makeTenant("u2");
    await incrementUsage(t.id, "orders");
    await incrementUsage(t.id, "orders");
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [row] = await db
      .select()
      .from(usageCounters)
      .where(and(eq(usageCounters.tenantId, t.id), eq(usageCounters.metric, "orders"), eq(usageCounters.periodStart, periodStart)))
      .limit(1);
    expect(row.count).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/entitlements/usage.test.ts`
Expected: FAIL — `incrementUsage` is not exported / `online_ordering` not a valid feature key.

- [ ] **Step 3: Add the feature to the type and seeds**

In `src/server/subscription/schema.ts`, add `online_ordering` to `PlanFeatures`:

```ts
export type PlanFeatures = {
  whatsapp: boolean;
  custom_domain: boolean;
  custom_theme: boolean;
  reservations: boolean;
  advanced_analytics: boolean;
  online_ordering: boolean;
};
```

In `src/server/subscription/plans.seed.ts`, add `online_ordering: true` to all three `features` objects (basic, pro, enterprise). Example for basic:

```ts
features: { whatsapp: false, custom_domain: false, custom_theme: false, reservations: false, advanced_analytics: false, online_ordering: true },
```

(Set `online_ordering: true` for pro and enterprise too.)

- [ ] **Step 4: Add `incrementUsage`**

In `src/server/entitlements/service.ts`, add the import for `sql` is not needed (read-then-write). Add at the end of the file:

```ts
/**
 * Increments the usage counter for the current billing period (first day of the
 * month, matching checkUsage). usage_counters is a control table (not RLS-backed),
 * so this uses the plain db client. Read-then-write avoids needing a unique
 * constraint; a rare double-increment race is acceptable for non-critical metering.
 */
export async function incrementUsage(tenantId: string, metric: "orders" | "messages", by = 1): Promise<void> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.tenantId, tenantId),
        eq(usageCounters.metric, metric),
        eq(usageCounters.periodStart, periodStart),
      ),
    )
    .limit(1);
  if (row) {
    await db.update(usageCounters).set({ count: row.count + by }).where(eq(usageCounters.id, row.id));
  } else {
    await db.insert(usageCounters).values({ tenantId, metric, periodStart, count: by });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- src/server/entitlements/usage.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/subscription/schema.ts src/server/subscription/plans.seed.ts src/server/entitlements/service.ts src/server/entitlements/usage.test.ts
git commit -m "feat(entitlements): add online_ordering feature + incrementUsage writer"
```

---

## Task 2: Add RBAC permissions for ordering

**Files:**
- Modify: `src/server/rbac/permissions.ts`
- Test: `src/server/rbac/ordering-permissions.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/server/rbac/ordering-permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { can } from "./authorize";

describe("ordering permissions", () => {
  it("staff can manage orders but not fulfillment config", () => {
    expect(can(["staff"], "orders:manage")).toBe(true);
    expect(can(["staff"], "fulfillment:manage")).toBe(false);
  });
  it("manager and owner can manage both", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(can([role], "orders:manage")).toBe(true);
      expect(can([role], "fulfillment:manage")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/rbac/ordering-permissions.test.ts`
Expected: FAIL — `"orders:manage"` is not assignable to `Permission`.

- [ ] **Step 3: Add the permissions**

In `src/server/rbac/permissions.ts`, add the two permissions to the `PERMISSIONS` array (before the closing `]`):

```ts
  "menu:manage",
  "orders:manage",
  "fulfillment:manage",
] as const;
```

Update `ROLE_PERMISSIONS` so owner/manager/staff gain the new permissions:

```ts
export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: ["tenant:manage", "staff:invite", "plan:view", "plan:change", "billing:manage", "menu:manage", "orders:manage", "fulfillment:manage"],
  manager: ["staff:invite", "plan:view", "menu:manage", "orders:manage", "fulfillment:manage"],
  staff: ["plan:view", "orders:manage"],
  super_admin: ["platform:approve_tenant", "platform:suspend_tenant", "platform:view_revenue"],
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/server/rbac/ordering-permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/ordering-permissions.test.ts
git commit -m "feat(rbac): add orders:manage and fulfillment:manage permissions"
```

---

## Task 3: Branches schema — opening hours, accepting-orders, delivery areas

**Files:**
- Modify: `src/server/branches/schema.ts`
- Modify: `src/db/schema.ts` (already exports `branches/schema` — no change needed, verify)
- Generate + edit: `drizzle/00XX_*.sql` (new migration)

- [ ] **Step 1: Extend the schema**

Replace the contents of `src/server/branches/schema.ts` with:

```ts
import { pgTable, uuid, text, timestamp, boolean, integer, numeric, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

/** One entry per weekday. day: 0=Sunday … 6=Saturday. Times are "HH:MM" 24h,
 * interpreted in the branch's local wall-clock. When close < open the window
 * crosses midnight. An empty openingHours array means "no schedule configured"
 * → always within hours (the acceptingOrders toggle still applies). */
export type DayHours = { day: number; open: string; close: string; closed: boolean };
export type OpeningHours = DayHours[];

export const branches = pgTable("branches", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  phone: text("phone"),
  isActive: boolean("is_active").notNull().default(true),
  acceptingOrders: boolean("accepting_orders").notNull().default(true),
  openingHours: jsonb("opening_hours").$type<OpeningHours>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliveryAreas = pgTable("delivery_areas", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  deliveryFee: numeric("delivery_fee").notNull().default("0"),
  minOrderAmount: numeric("min_order_amount").notNull().default("0"),
  etaMinutes: integer("eta_minutes"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
export type DeliveryArea = typeof deliveryAreas.$inferSelect;
export type NewDeliveryArea = typeof deliveryAreas.$inferInsert;
```

- [ ] **Step 2: Export the new table from the db barrel**

In `src/server/branches/index.ts`, extend the first export line to include the new symbols:

```ts
export { branches, deliveryAreas, type Branch, type NewBranch, type DeliveryArea, type NewDeliveryArea, type OpeningHours, type DayHours } from "./schema";
```

(`src/db/schema.ts` already does `export * from "../server/branches/schema"`, so `deliveryAreas` is picked up automatically.)

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `drizzle/00XX_*.sql` adding the `accepting_orders` + `opening_hours` columns to `branches` and creating `delivery_areas`. Note its number (call it `00XX`).

- [ ] **Step 4: Append RLS to the new `delivery_areas` table**

Open the generated `drizzle/00XX_*.sql` and append at the end (matches the pattern in `0007_bitter_mandarin.sql`):

```sql
--> statement-breakpoint
ALTER TABLE "delivery_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_areas" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY delivery_areas_isolation ON "delivery_areas"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

(The `branches` table already has its RLS policy from `0007`; the `ALTER TABLE … ADD COLUMN` statements need no new policy.)

- [ ] **Step 5: Apply migrations to dev + test DBs**

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: `migrations applied` twice, no errors.

- [ ] **Step 6: Verify existing tests still pass (no regression in branches)**

Run: `npm run test -- src/server/branches/service.test.ts`
Expected: PASS (existing branch tests unaffected by the additive columns).

- [ ] **Step 7: Commit**

```bash
git add src/server/branches/schema.ts src/server/branches/index.ts drizzle/
git commit -m "feat(branches): add opening hours, accepting-orders toggle, delivery_areas table"
```

---

## Task 4: Branch orderability logic (pure)

**Files:**
- Create: `src/server/branches/orderability.ts`
- Test: `src/server/branches/orderability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/branches/orderability.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isBranchOrderable } from "./orderability";
import type { Branch } from "./schema";

function branch(overrides: Partial<Branch>): Branch {
  return {
    id: "b", tenantId: "t", name: "B", address: null, phone: null,
    isActive: true, acceptingOrders: true, openingHours: [],
    sortOrder: 0, createdAt: new Date(),
    ...overrides,
  } as Branch;
}

// 2026-06-16 is a Tuesday (getDay() === 2).
const tue14 = new Date(2026, 5, 16, 14, 30);
const tue02 = new Date(2026, 5, 16, 2, 0);

describe("isBranchOrderable", () => {
  it("false when acceptingOrders is off", () => {
    expect(isBranchOrderable(branch({ acceptingOrders: false }), tue14)).toBe(false);
  });
  it("true when openingHours empty (no schedule) and toggle on", () => {
    expect(isBranchOrderable(branch({ openingHours: [] }), tue14)).toBe(true);
  });
  it("within a normal same-day window", () => {
    const hours = [{ day: 2, open: "10:00", close: "23:00", closed: false }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue14)).toBe(true);
  });
  it("outside a normal same-day window", () => {
    const hours = [{ day: 2, open: "10:00", close: "13:00", closed: false }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue14)).toBe(false);
  });
  it("closed flag wins", () => {
    const hours = [{ day: 2, open: "10:00", close: "23:00", closed: true }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue14)).toBe(false);
  });
  it("crosses midnight: open at 02:00 when window is 18:00-04:00", () => {
    const hours = [{ day: 2, open: "18:00", close: "04:00", closed: false }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue02)).toBe(true);
  });
  it("no entry for today's weekday → closed", () => {
    const hours = [{ day: 5, open: "10:00", close: "23:00", closed: false }];
    expect(isBranchOrderable(branch({ openingHours: hours }), tue14)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/branches/orderability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/server/branches/orderability.ts`:

```ts
import type { Branch } from "./schema";

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Whether a branch can take an order at `now`. Uses the wall-clock fields of
 * `now` (getDay/getHours/getMinutes). Tenant-timezone normalisation of `now` is
 * the caller's responsibility; v1 uses server-local time (documented limitation).
 */
export function isBranchOrderable(branch: Branch, now: Date): boolean {
  if (!branch.acceptingOrders) return false;
  const hours = branch.openingHours ?? [];
  if (hours.length === 0) return true; // no schedule configured → open

  const entry = hours.find((h) => h.day === now.getDay());
  if (!entry || entry.closed) return false;

  const cur = now.getHours() * 60 + now.getMinutes();
  const open = toMinutes(entry.open);
  const close = toMinutes(entry.close);

  if (open === close) return true; // 24h
  if (close > open) return cur >= open && cur < close; // same-day window
  return cur >= open || cur < close; // crosses midnight
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/server/branches/orderability.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/server/branches/orderability.ts src/server/branches/orderability.test.ts
git commit -m "feat(branches): pure isBranchOrderable (hours + toggle, midnight-crossing)"
```

---

## Task 5: Branch ordering config + delivery-area CRUD services

**Files:**
- Modify: `src/server/branches/service.ts`
- Modify: `src/server/branches/index.ts`
- Test: `src/server/branches/fulfillment.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/server/branches/fulfillment.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering, createDeliveryArea, listDeliveryAreas, updateDeliveryArea, deleteDeliveryArea } from "./service";

async function makeTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("branches fulfillment config", () => {
  it("updateBranchOrdering sets toggle + hours", async () => {
    const t = await makeTenant("f1");
    const b = await createBranch(t.id, { name: "Main" });
    const updated = await updateBranchOrdering(t.id, b.id, {
      acceptingOrders: false,
      openingHours: [{ day: 2, open: "10:00", close: "23:00", closed: false }],
    });
    expect(updated.acceptingOrders).toBe(false);
    expect(updated.openingHours).toHaveLength(1);
  });

  it("delivery areas CRUD within a branch", async () => {
    const t = await makeTenant("f2");
    const b = await createBranch(t.id, { name: "Main" });
    const a = await createDeliveryArea(t.id, b.id, { nameEn: "Maadi", nameAr: "المعادي", deliveryFee: "25", minOrderAmount: "100", etaMinutes: 35 });
    expect(a.nameEn).toBe("Maadi");
    let list = await listDeliveryAreas(t.id, b.id);
    expect(list).toHaveLength(1);
    await updateDeliveryArea(t.id, a.id, { deliveryFee: "30" });
    await deleteDeliveryArea(t.id, a.id);
    list = await listDeliveryAreas(t.id, b.id);
    expect(list).toHaveLength(0);
  });

  it("RLS: tenant B cannot see tenant A delivery areas", async () => {
    const a = await makeTenant("f-a");
    const b = await makeTenant("f-b");
    const br = await createBranch(a.id, { name: "A" });
    await createDeliveryArea(a.id, br.id, { nameEn: "X", nameAr: "س", deliveryFee: "10", minOrderAmount: "0" });
    expect(await listDeliveryAreas(b.id, br.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/branches/fulfillment.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the services**

Append to `src/server/branches/service.ts` (add the new imports at the top of the file alongside the existing ones):

```ts
// add to the existing import from "./schema":
import { branches, deliveryAreas, type Branch, type NewBranch, type DeliveryArea, type OpeningHours } from "./schema";
```

Then append the functions:

```ts
export type UpdateBranchOrderingInput = { acceptingOrders?: boolean; openingHours?: OpeningHours };

export async function updateBranchOrdering(tenantId: string, branchId: string, input: UpdateBranchOrderingInput): Promise<Branch> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(branches).set(input).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export type CreateDeliveryAreaInput = {
  nameEn: string; nameAr: string; deliveryFee: string; minOrderAmount: string; etaMinutes?: number | null; sortOrder?: number;
};
export type UpdateDeliveryAreaInput = Partial<CreateDeliveryAreaInput & { isActive: boolean }>;

export async function listDeliveryAreas(tenantId: string, branchId: string): Promise<DeliveryArea[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(deliveryAreas).where(eq(deliveryAreas.branchId, branchId)).orderBy(deliveryAreas.sortOrder),
  );
}

export async function createDeliveryArea(tenantId: string, branchId: string, input: CreateDeliveryAreaInput): Promise<DeliveryArea> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(deliveryAreas).values({ ...input, tenantId, branchId }).returning(),
  );
  return row;
}

export async function updateDeliveryArea(tenantId: string, areaId: string, input: UpdateDeliveryAreaInput): Promise<DeliveryArea> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(deliveryAreas).set(input).where(and(eq(deliveryAreas.id, areaId), eq(deliveryAreas.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export async function deleteDeliveryArea(tenantId: string, areaId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(deliveryAreas).where(and(eq(deliveryAreas.id, areaId), eq(deliveryAreas.tenantId, tenantId))),
  );
}
```

- [ ] **Step 4: Extend the barrel**

In `src/server/branches/index.ts`, add to the `./service` export block:

```ts
export {
  listBranches, getBranch, createBranch, updateBranch, deleteBranch,
  updateBranchOrdering, listDeliveryAreas, createDeliveryArea, updateDeliveryArea, deleteDeliveryArea,
  type CreateBranchInput, type UpdateBranchInput, type UpdateBranchOrderingInput,
  type CreateDeliveryAreaInput, type UpdateDeliveryAreaInput,
} from "./service";
export { isBranchOrderable } from "./orderability";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- src/server/branches/fulfillment.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/branches/service.ts src/server/branches/index.ts src/server/branches/fulfillment.test.ts
git commit -m "feat(branches): branch ordering config + delivery-area CRUD services"
```

---

## Task 6: Tenant VAT settings service

**Files:**
- Create: `src/server/tenancy/settings.ts`
- Modify: `src/server/tenancy/index.ts`
- Test: `src/server/tenancy/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/tenancy/settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "./schema";
import { getVatRate, setVatRate, getTenantSettings } from "./settings";

async function makeTenant(slug: string, country = "EG") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country }).returning();
  return t;
}

describe("tenant VAT settings", () => {
  it("defaults to 14 for EG and 15 for SA when unset", async () => {
    const eg = await makeTenant("vat-eg", "EG");
    const sa = await makeTenant("vat-sa", "SA");
    expect(await getVatRate(eg.id)).toBe(14);
    expect(await getVatRate(sa.id)).toBe(15);
  });
  it("setVatRate overrides the default and persists", async () => {
    const t = await makeTenant("vat-set", "EG");
    await setVatRate(t.id, 10);
    expect(await getVatRate(t.id)).toBe(10);
    expect((await getTenantSettings(t.id)).vatRate).toBe(10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/tenancy/settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/server/tenancy/settings.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants, tenantSettings } from "./schema";

export type TenantSettingsData = { vatRate?: number };

/** tenant_settings is RLS-backed → read/write through withTenant. */
export async function getTenantSettings(tenantId: string): Promise<TenantSettingsData> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1),
  );
  return (row?.data as TenantSettingsData | undefined) ?? {};
}

export async function setVatRate(tenantId: string, vatRate: number): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1);
    const data = { ...((row?.data as TenantSettingsData | undefined) ?? {}), vatRate };
    if (row) {
      await tx.update(tenantSettings).set({ data }).where(eq(tenantSettings.id, row.id));
    } else {
      await tx.insert(tenantSettings).values({ tenantId, data });
    }
  });
}

export function defaultVatRate(country: string): number {
  return country === "SA" ? 15 : 14;
}

/** Configured VAT rate, or the country default. tenants is a control table → plain db. */
export async function getVatRate(tenantId: string): Promise<number> {
  const settings = await getTenantSettings(tenantId);
  if (typeof settings.vatRate === "number") return settings.vatRate;
  const [t] = await db.select({ country: tenants.country }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return defaultVatRate(t?.country ?? "EG");
}
```

- [ ] **Step 4: Export from the barrel**

In `src/server/tenancy/index.ts`, add:

```ts
export { getTenantSettings, setVatRate, getVatRate, defaultVatRate, type TenantSettingsData } from "./settings";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- src/server/tenancy/settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/tenancy/settings.ts src/server/tenancy/index.ts src/server/tenancy/settings.test.ts
git commit -m "feat(tenancy): per-tenant VAT settings with EG/SA defaults"
```

---

## Task 7: Ordering schema + migration

**Files:**
- Create: `src/server/ordering/schema.ts`
- Modify: `src/db/schema.ts`
- Generate + edit: `drizzle/00YY_*.sql`

- [ ] **Step 1: Create the schema**

Create `src/server/ordering/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, integer, numeric, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";

export const orderStatusEnum = pgEnum("order_status", [
  "pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed", "rejected", "cancelled",
]);
export const fulfillmentTypeEnum = pgEnum("fulfillment_type", ["pickup", "delivery"]);
export const orderChannelEnum = pgEnum("order_channel", ["web"]);
export const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "paid"]);
export const paymentMethodEnum = pgEnum("payment_method", ["cash"]);

export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type FulfillmentType = (typeof fulfillmentTypeEnum.enumValues)[number];

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  orderNumber: integer("order_number").notNull(),
  status: orderStatusEnum("status").notNull().default("pending"),
  fulfillmentType: fulfillmentTypeEnum("fulfillment_type").notNull(),
  channel: orderChannelEnum("channel").notNull().default("web"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
  paymentMethod: paymentMethodEnum("payment_method").notNull().default("cash"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone").notNull(),
  notes: text("notes"),
  deliveryAreaId: uuid("delivery_area_id"),
  deliveryAreaNameSnapshot: text("delivery_area_name_snapshot"),
  deliveryAddressText: text("delivery_address_text"),
  subtotal: numeric("subtotal").notNull(),
  vatRateSnapshot: numeric("vat_rate_snapshot").notNull(),
  vatAmount: numeric("vat_amount").notNull(),
  deliveryFee: numeric("delivery_fee").notNull().default("0"),
  total: numeric("total").notNull(),
  statusToken: text("status_token").notNull().unique(),
  cancelReason: text("cancel_reason"),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SelectedModifier = {
  groupNameEn: string; groupNameAr: string; optionNameEn: string; optionNameAr: string; priceDelta: string;
};

export const orderItems = pgTable("order_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  unitBasePrice: numeric("unit_base_price").notNull(),
  quantity: integer("quantity").notNull(),
  lineTotal: numeric("line_total").notNull(),
  selectedModifiers: jsonb("selected_modifiers").$type<SelectedModifier[]>().notNull().default([]),
});

export const orderStatusEvents = pgTable("order_status_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  fromStatus: orderStatusEnum("from_status"),
  toStatus: orderStatusEnum("to_status").notNull(),
  changedByUserId: uuid("changed_by_user_id"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type OrderStatusEvent = typeof orderStatusEvents.$inferSelect;
export type OrderWithItems = Order & { items: OrderItem[] };
export type OrderDetail = Order & { items: OrderItem[]; events: OrderStatusEvent[] };
```

- [ ] **Step 2: Export from the db barrel**

In `src/db/schema.ts`, add at the end:

```ts
export * from "../server/ordering/schema";
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/00YY_*.sql` creating the five enums and three tables. Note its number.

- [ ] **Step 4: Append RLS for the three new tables**

Append to the generated `drizzle/00YY_*.sql`:

```sql
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY orders_isolation ON "orders"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY order_items_isolation ON "order_items"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "order_status_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_status_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY order_status_events_isolation ON "order_status_events"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

- [ ] **Step 5: Apply migrations**

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: `migrations applied` twice.

- [ ] **Step 6: Commit**

```bash
git add src/server/ordering/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(ordering): orders / order_items / order_status_events schema + RLS"
```

---

## Task 8: Order state machine (pure)

**Files:**
- Create: `src/server/ordering/state-machine.ts`
- Test: `src/server/ordering/state-machine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/ordering/state-machine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextStatuses, canTransition } from "./state-machine";

describe("order state machine", () => {
  it("pending can go to confirmed/rejected/cancelled", () => {
    expect(nextStatuses("pending", "delivery").sort()).toEqual(["cancelled", "confirmed", "rejected"]);
  });
  it("ready → out_for_delivery for delivery, → completed for pickup", () => {
    expect(canTransition("ready", "out_for_delivery", "delivery")).toBe(true);
    expect(canTransition("ready", "out_for_delivery", "pickup")).toBe(false);
    expect(canTransition("ready", "completed", "pickup")).toBe(true);
    expect(canTransition("ready", "completed", "delivery")).toBe(false);
  });
  it("pickup never enters out_for_delivery", () => {
    expect(nextStatuses("ready", "pickup")).not.toContain("out_for_delivery");
  });
  it("terminal states have no transitions", () => {
    for (const s of ["completed", "rejected", "cancelled"] as const) {
      expect(nextStatuses(s, "delivery")).toEqual([]);
    }
  });
  it("rejects illegal jumps", () => {
    expect(canTransition("pending", "completed", "pickup")).toBe(false);
    expect(canTransition("confirmed", "rejected", "delivery")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/ordering/state-machine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/server/ordering/state-machine.ts`:

```ts
import type { OrderStatus, FulfillmentType } from "./schema";

/** Allowed next statuses from a given status, given the fulfillment type. */
export function nextStatuses(from: OrderStatus, fulfillment: FulfillmentType): OrderStatus[] {
  switch (from) {
    case "pending": return ["confirmed", "rejected", "cancelled"];
    case "confirmed": return ["preparing", "cancelled"];
    case "preparing": return ["ready", "cancelled"];
    case "ready": return fulfillment === "delivery" ? ["out_for_delivery", "cancelled"] : ["completed", "cancelled"];
    case "out_for_delivery": return ["completed", "cancelled"];
    default: return []; // completed, rejected, cancelled are terminal
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus, fulfillment: FulfillmentType): boolean {
  return nextStatuses(from, fulfillment).includes(to);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/server/ordering/state-machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/ordering/state-machine.ts src/server/ordering/state-machine.test.ts
git commit -m "feat(ordering): pure order state machine"
```

---

## Task 9: Ordering domain errors

**Files:**
- Create: `src/server/ordering/errors.ts`
- Test: `src/server/ordering/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/ordering/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { OrderValidationError, BranchNotAcceptingOrdersError, AreaNotDeliverableError, MinimumOrderNotMetError, InvalidTransitionError, OrderNotFoundError } from "./errors";

describe("ordering errors", () => {
  it("carry codes and localized messages", () => {
    expect(new OrderValidationError("x").code).toBe("order_validation");
    expect(new BranchNotAcceptingOrdersError().messageFor("ar")).toContain("الطلب");
    const min = new MinimumOrderNotMetError("100");
    expect(min.minimum).toBe("100");
    expect(min.messageFor("en")).toContain("100");
    expect(new InvalidTransitionError("pending", "completed").messageFor("en")).toContain("pending");
    expect(new AreaNotDeliverableError().code).toBe("area_not_deliverable");
    expect(new OrderNotFoundError().code).toBe("order_not_found");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/ordering/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/server/ordering/errors.ts`:

```ts
import { DomainError, type Locale } from "@/shared/errors";

export class OrderValidationError extends DomainError {
  readonly code = "order_validation";
  constructor(public readonly detail: string) {
    super(`Order validation failed: ${detail}`);
    this.name = "OrderValidationError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "تعذّر إتمام الطلب، يرجى مراجعة عناصر السلة" : "We couldn't place the order — please review your cart";
  }
}

export class BranchNotAcceptingOrdersError extends DomainError {
  readonly code = "branch_not_accepting_orders";
  constructor() { super("Branch is not accepting orders"); this.name = "BranchNotAcceptingOrdersError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "هذا الفرع لا يستقبل الطلب حالياً" : "This branch isn't accepting orders right now";
  }
}

export class AreaNotDeliverableError extends DomainError {
  readonly code = "area_not_deliverable";
  constructor() { super("Delivery area not available"); this.name = "AreaNotDeliverableError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "منطقة التوصيل غير متاحة" : "This delivery area isn't available";
  }
}

export class MinimumOrderNotMetError extends DomainError {
  readonly code = "minimum_order_not_met";
  constructor(public readonly minimum: string) { super(`Minimum order is ${minimum}`); this.name = "MinimumOrderNotMetError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? `الحد الأدنى للطلب هو ${this.minimum}` : `The minimum order for this area is ${this.minimum}`;
  }
}

export class InvalidTransitionError extends DomainError {
  readonly code = "invalid_transition";
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid transition ${from} → ${to}`); this.name = "InvalidTransitionError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? `لا يمكن تغيير الحالة من ${this.from} إلى ${this.to}` : `Can't change status from ${this.from} to ${this.to}`;
  }
}

export class OrderNotFoundError extends DomainError {
  readonly code = "order_not_found";
  constructor() { super("Order not found"); this.name = "OrderNotFoundError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "الطلب غير موجود" : "Order not found";
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/server/ordering/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/ordering/errors.ts src/server/ordering/errors.test.ts
git commit -m "feat(ordering): typed domain errors"
```

---

## Task 10: `placeOrder` — server-authoritative checkout

**Files:**
- Create: `src/server/ordering/service.ts`
- Create: `src/server/ordering/index.ts`
- Test: `src/server/ordering/place-order.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/ordering/place-order.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { plans, subscriptions } from "@/server/subscription/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering, createDeliveryArea } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct, upsertModifierGroup, upsertModifierOption } from "@/server/catalog/service";
import { placeOrder } from "./service";

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro"); // pro: branches 3, products 500
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "Pizza", nameAr: "بيتزا" });
  const pizza = await createProduct(t.id, { nameEn: "Margherita", nameAr: "مارجريتا", basePrice: "100", categoryId: cat.id });
  await updateProduct(t.id, pizza.id, { isPublished: true });
  const group = await upsertModifierGroup(t.id, pizza.id, { nameEn: "Extras", nameAr: "إضافات", required: false, minSelections: 0, maxSelections: 2 });
  const cheese = await upsertModifierOption(t.id, group.id, { nameEn: "Cheese", nameAr: "جبنة", priceDelta: "15" });
  const area = await createDeliveryArea(t.id, branch.id, { nameEn: "Maadi", nameAr: "المعادي", deliveryFee: "25", minOrderAmount: "100" });
  return { t, branch, pizza, cheese, area };
}

describe("placeOrder", () => {
  it("creates a delivery order with server-computed totals (subtotal + VAT + fee)", async () => {
    const { t, branch, pizza, cheese, area } = await setup("po1");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "delivery",
      customerName: "Ahmed", customerPhone: "0100",
      areaId: area.id, addressText: "12 St",
      lines: [{ productId: pizza.id, quantity: 2, selectedOptionIds: [cheese.id] }],
    });
    expect(res.orderNumber).toBe(1);
    const [order] = await db.select().from(/* avoid RLS: use withTenant below */ (await import("./schema")).orders).where(eq((await import("./schema")).orders.id, res.orderId));
    // NOTE: orders is RLS-protected; assert via getOrderByToken instead (added in Task 11).
    expect(res.statusToken).toMatch(/.+/);
  });

  it("rejects when subtotal below the area minimum", async () => {
    const { t, branch, pizza, area } = await setup("po2");
    const { MinimumOrderNotMetError } = await import("./errors");
    // 1× 100 = 100 which meets min 100; make min higher to fail
    await (await import("@/server/branches/service")).updateDeliveryArea(t.id, area.id, { minOrderAmount: "500" });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "delivery", customerName: "A", customerPhone: "1",
      areaId: area.id, addressText: "x", lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(MinimumOrderNotMetError);
  });

  it("rejects an unpublished product", async () => {
    const { t, branch, pizza, area } = await setup("po3");
    const { OrderValidationError } = await import("./errors");
    await updateProduct(t.id, pizza.id, { isPublished: false });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(OrderValidationError);
  });

  it("rejects when branch not accepting orders", async () => {
    const { t, branch, pizza } = await setup("po4");
    const { BranchNotAcceptingOrdersError } = await import("./errors");
    await updateBranchOrdering(t.id, branch.id, { acceptingOrders: false });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(BranchNotAcceptingOrdersError);
  });

  it("blocks checkout when online_ordering feature is off", async () => {
    const { t, branch, pizza } = await setup("po5");
    const { FeatureNotAvailableError } = await import("@/server/entitlements/errors");
    // turn the feature off on this tenant's plan
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, t.id)).limit(1);
    const [plan] = await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
    await db.update(plans).set({ features: { ...plan.features, online_ordering: false } }).where(eq(plans.id, plan.id));
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(FeatureNotAvailableError);
  });

  it("increments per-tenant order_number", async () => {
    const { t, branch, pizza } = await setup("po6");
    const a = await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1", lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }] });
    const b = await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "B", customerPhone: "2", lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }] });
    expect(a.orderNumber).toBe(1);
    expect(b.orderNumber).toBe(2);
  });
});
```

> Note: the first test's direct `db.select(...orders)` line will return zero rows under RLS; replace that assertion with `getOrderByToken` after Task 11. To keep Task 10 green, delete the two lines referencing `order` and keep only the `orderNumber`/`statusToken` assertions for now (the deeper assertions live in Task 11's test).

Simplify the first test body to:

```ts
  it("creates a delivery order and returns number + token", async () => {
    const { t, branch, pizza, cheese, area } = await setup("po1");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "delivery",
      customerName: "Ahmed", customerPhone: "0100",
      areaId: area.id, addressText: "12 St",
      lines: [{ productId: pizza.id, quantity: 2, selectedOptionIds: [cheese.id] }],
    });
    expect(res.orderNumber).toBe(1);
    expect(res.statusToken).toMatch(/.+/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/ordering/place-order.test.ts`
Expected: FAIL — `placeOrder` not exported.

- [ ] **Step 3: Implement the service (placeOrder + helpers)**

Create `src/server/ordering/service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { requireFeature, incrementUsage } from "@/server/entitlements/service";
import { getVatRate } from "@/server/tenancy/settings";
import { isBranchOrderable } from "@/server/branches/orderability";
import { branches, deliveryAreas } from "@/server/branches/schema";
import { products, modifierGroups, modifierOptions, branchProductAvailability } from "@/server/catalog/schema";
import { orders, orderItems, orderStatusEvents, type SelectedModifier } from "./schema";
import { OrderValidationError, BranchNotAcceptingOrdersError, AreaNotDeliverableError, MinimumOrderNotMetError } from "./errors";

export type PlaceOrderLine = { productId: string; quantity: number; selectedOptionIds: string[] };
export type PlaceOrderInput = {
  branchId: string;
  fulfillmentType: "pickup" | "delivery";
  customerName: string;
  customerPhone: string;
  notes?: string;
  areaId?: string;
  addressText?: string;
  lines: PlaceOrderLine[];
  now?: Date;
};
export type PlaceOrderResult = { orderId: string; orderNumber: number; statusToken: string };

/** Round to 2 decimals and format as a numeric string for Postgres. */
export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export async function placeOrder(tenantId: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  if (!input.lines || input.lines.length === 0) throw new OrderValidationError("empty cart");
  if (!input.customerName.trim() || !input.customerPhone.trim()) throw new OrderValidationError("missing customer details");

  await requireFeature(tenantId, "online_ordering");
  const vatRate = await getVatRate(tenantId);
  const now = input.now ?? new Date();

  const result = await withTenant(tenantId, async (tx) => {
    // Serialize order-number generation per tenant.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);

    // 1. Branch + orderability
    const [branch] = await tx.select().from(branches).where(eq(branches.id, input.branchId)).limit(1);
    if (!branch) throw new OrderValidationError("unknown branch");
    if (!isBranchOrderable(branch, now)) throw new BranchNotAcceptingOrdersError();

    // 2. Validate each line against the catalog; build snapshots.
    let subtotal = 0;
    const itemsToInsert: Array<{ productId: string; nameEn: string; nameAr: string; unitBasePrice: string; quantity: number; lineTotal: string; selectedModifiers: SelectedModifier[] }> = [];

    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new OrderValidationError("bad quantity");

      const [product] = await tx.select().from(products).where(and(eq(products.id, line.productId), eq(products.isPublished, true))).limit(1);
      if (!product) throw new OrderValidationError("product unavailable");

      // branch availability + price override
      const [avail] = await tx.select().from(branchProductAvailability)
        .where(and(eq(branchProductAvailability.branchId, input.branchId), eq(branchProductAvailability.productId, product.id))).limit(1);
      if (avail && !avail.isAvailable) throw new OrderValidationError("product unavailable at branch");
      const effectiveBase = avail?.priceOverride ?? product.basePrice;

      // modifiers
      const groups = await tx.select().from(modifierGroups).where(eq(modifierGroups.productId, product.id));
      const groupIds = groups.map((g) => g.id);
      const opts = groupIds.length > 0
        ? await tx.select().from(modifierOptions).where(inArray(modifierOptions.modifierGroupId, groupIds))
        : [];
      const optById = new Map(opts.map((o) => [o.id, o]));

      // every selected option must belong to this product's groups
      const selected = line.selectedOptionIds.map((id) => {
        const o = optById.get(id);
        if (!o) throw new OrderValidationError("invalid modifier selection");
        return o;
      });
      // enforce per-group required/min/max
      for (const g of groups) {
        const count = selected.filter((o) => o.modifierGroupId === g.id).length;
        if (g.required && count < Math.max(1, g.minSelections)) throw new OrderValidationError("required modifier missing");
        if (count < g.minSelections) throw new OrderValidationError("too few modifier selections");
        if (count > g.maxSelections) throw new OrderValidationError("too many modifier selections");
      }

      const modifiersTotal = selected.reduce((s, o) => s + Number(o.priceDelta), 0);
      const unit = Number(effectiveBase) + modifiersTotal;
      const lineTotal = unit * line.quantity;
      subtotal += lineTotal;

      const snapshot: SelectedModifier[] = selected.map((o) => {
        const g = groups.find((gg) => gg.id === o.modifierGroupId)!;
        return { groupNameEn: g.nameEn, groupNameAr: g.nameAr, optionNameEn: o.nameEn, optionNameAr: o.nameAr, priceDelta: o.priceDelta };
      });

      itemsToInsert.push({
        productId: product.id, nameEn: product.nameEn, nameAr: product.nameAr,
        unitBasePrice: String(effectiveBase), quantity: line.quantity, lineTotal: money(lineTotal), selectedModifiers: snapshot,
      });
    }

    // 3. Fulfillment: delivery fee + area, or pickup.
    let deliveryFee = 0;
    let deliveryAreaId: string | null = null;
    let deliveryAreaName: string | null = null;
    let deliveryAddress: string | null = null;
    if (input.fulfillmentType === "delivery") {
      if (!input.areaId) throw new AreaNotDeliverableError();
      if (!input.addressText?.trim()) throw new OrderValidationError("missing delivery address");
      const [area] = await tx.select().from(deliveryAreas)
        .where(and(eq(deliveryAreas.id, input.areaId), eq(deliveryAreas.branchId, input.branchId), eq(deliveryAreas.isActive, true))).limit(1);
      if (!area) throw new AreaNotDeliverableError();
      if (subtotal < Number(area.minOrderAmount)) throw new MinimumOrderNotMetError(money(Number(area.minOrderAmount)));
      deliveryFee = Number(area.deliveryFee);
      deliveryAreaId = area.id;
      deliveryAreaName = area.nameEn;
      deliveryAddress = input.addressText.trim();
    }

    // 4. Totals
    const vatAmount = subtotal * (vatRate / 100);
    const total = subtotal + vatAmount + deliveryFee;

    // 5. Order number (per-tenant max+1, under the advisory lock above)
    const [{ next }] = await tx.select({ next: sql<number>`COALESCE(MAX(${orders.orderNumber}), 0) + 1` }).from(orders);
    const orderNumber = Number(next);
    const statusToken = randomUUID();

    // 6. Insert order + items + initial status event
    const [order] = await tx.insert(orders).values({
      tenantId, branchId: input.branchId, orderNumber,
      fulfillmentType: input.fulfillmentType, status: "pending",
      customerName: input.customerName.trim(), customerPhone: input.customerPhone.trim(), notes: input.notes?.trim() || null,
      deliveryAreaId, deliveryAreaNameSnapshot: deliveryAreaName, deliveryAddressText: deliveryAddress,
      subtotal: money(subtotal), vatRateSnapshot: money(vatRate), vatAmount: money(vatAmount), deliveryFee: money(deliveryFee), total: money(total),
      statusToken,
    }).returning();

    await tx.insert(orderItems).values(itemsToInsert.map((i) => ({ ...i, tenantId, orderId: order.id })));
    await tx.insert(orderStatusEvents).values({ tenantId, orderId: order.id, fromStatus: null, toStatus: "pending" });

    return { orderId: order.id, orderNumber, statusToken };
  });

  // Meter usage (control table, outside the tenant tx). No hard cap in v1.
  await incrementUsage(tenantId, "orders");
  return result;
}
```

Create `src/server/ordering/index.ts`:

```ts
export {
  orders, orderItems, orderStatusEvents,
  type Order, type OrderItem, type OrderStatusEvent, type OrderWithItems, type OrderDetail,
  type OrderStatus, type FulfillmentType, type SelectedModifier,
} from "./schema";
export { nextStatuses, canTransition } from "./state-machine";
export {
  placeOrder, money,
  type PlaceOrderInput, type PlaceOrderLine, type PlaceOrderResult,
} from "./service";
export {
  OrderValidationError, BranchNotAcceptingOrdersError, AreaNotDeliverableError,
  MinimumOrderNotMetError, InvalidTransitionError, OrderNotFoundError,
} from "./errors";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/server/ordering/place-order.test.ts`
Expected: PASS (all cases). If the first test still references `orders`/`db.select`, ensure you simplified it per Step 1.

- [ ] **Step 5: Commit**

```bash
git add src/server/ordering/service.ts src/server/ordering/index.ts src/server/ordering/place-order.test.ts
git commit -m "feat(ordering): server-authoritative placeOrder with totals + RLS"
```

---

## Task 11: Order queries + status transitions

**Files:**
- Modify: `src/server/ordering/service.ts`
- Modify: `src/server/ordering/index.ts`
- Test: `src/server/ordering/orders.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/ordering/orders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering, createDeliveryArea } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder, getOrderByToken, getOrder, listOrders, transitionStatus, markPaid, pendingOrderCount } from "./service";
import { InvalidTransitionError } from "./errors";

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  const cat = await createCategory(t.id, { nameEn: "P", nameAr: "ب" });
  const prod = await createProduct(t.id, { nameEn: "Pie", nameAr: "فطيرة", basePrice: "100", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });
  const order = await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1", lines: [{ productId: prod.id, quantity: 1, selectedOptionIds: [] }] });
  return { t, branch, order };
}

describe("orders queries + transitions", () => {
  it("getOrderByToken returns the order with items and computed total", async () => {
    const { t, order } = await setup("o1");
    const found = await getOrderByToken(t.id, order.statusToken);
    expect(found?.orderNumber).toBe(1);
    expect(found?.items).toHaveLength(1);
    expect(Number(found?.total)).toBeCloseTo(114); // 100 + 14% VAT, pickup
  });

  it("getOrderByToken returns null for unknown token", async () => {
    const { t } = await setup("o2");
    expect(await getOrderByToken(t.id, "nope")).toBeNull();
  });

  it("legal transition pending→confirmed writes a status event", async () => {
    const { t, order } = await setup("o3");
    await transitionStatus(t.id, order.orderId, "confirmed", "user-1");
    const detail = await getOrder(t.id, order.orderId);
    expect(detail.status).toBe("confirmed");
    expect(detail.events.map((e) => e.toStatus)).toContain("confirmed");
  });

  it("illegal transition throws", async () => {
    const { t, order } = await setup("o4");
    await expect(transitionStatus(t.id, order.orderId, "completed", "user-1")).rejects.toThrow(InvalidTransitionError);
  });

  it("cancel records the reason", async () => {
    const { t, order } = await setup("o5");
    const cancelled = await transitionStatus(t.id, order.orderId, "cancelled", "user-1", "out of stock");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("out of stock");
  });

  it("markPaid flips payment independently of status", async () => {
    const { t, order } = await setup("o6");
    const paid = await markPaid(t.id, order.orderId, "user-1");
    expect(paid.paymentStatus).toBe("paid");
    expect(paid.status).toBe("pending");
  });

  it("listOrders + pendingOrderCount", async () => {
    const { t } = await setup("o7");
    const list = await listOrders(t.id, {});
    expect(list).toHaveLength(1);
    expect(await pendingOrderCount(t.id)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/server/ordering/orders.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the query/transition functions**

Append to `src/server/ordering/service.ts` (add `desc` to the drizzle imports: `import { and, desc, eq, inArray, sql } from "drizzle-orm";`):

```ts
import { canTransition } from "./state-machine";
import { OrderNotFoundError, InvalidTransitionError } from "./errors";
import type { Order, OrderItem, OrderWithItems, OrderDetail, OrderStatus } from "./schema";

async function loadItems(tx: Parameters<Parameters<typeof withTenant>[1]>[0], orderId: string): Promise<OrderItem[]> {
  return tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
}

export async function getOrderByToken(tenantId: string, token: string): Promise<OrderWithItems | null> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.statusToken, token)).limit(1);
    if (!order) return null;
    const items = await loadItems(tx, order.id);
    return { ...order, items };
  });
}

export async function getOrder(tenantId: string, orderId: string): Promise<OrderDetail> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const events = await tx.select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, orderId)).orderBy(orderStatusEvents.createdAt);
    return { ...order, items, events };
  });
}

export type ListOrdersOpts = { branchId?: string; status?: OrderStatus; limit?: number };

export async function listOrders(tenantId: string, opts: ListOrdersOpts): Promise<Order[]> {
  return withTenant(tenantId, (tx) => {
    const conds = [];
    if (opts.branchId) conds.push(eq(orders.branchId, opts.branchId));
    if (opts.status) conds.push(eq(orders.status, opts.status));
    const base = tx.select().from(orders);
    const q = conds.length > 0 ? base.where(and(...conds)) : base;
    return q.orderBy(desc(orders.placedAt)).limit(opts.limit ?? 100);
  });
}

export async function pendingOrderCount(tenantId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ c: sql<number>`COUNT(*)` }).from(orders).where(eq(orders.status, "pending")),
  );
  return Number(row.c);
}

export async function transitionStatus(tenantId: string, orderId: string, to: OrderStatus, userId: string, reason?: string): Promise<Order> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (!canTransition(order.status, to, order.fulfillmentType)) throw new InvalidTransitionError(order.status, to);
    const setCancel = (to === "cancelled" || to === "rejected") && reason ? { cancelReason: reason } : {};
    const [updated] = await tx.update(orders)
      .set({ status: to, updatedAt: new Date(), ...setCancel })
      .where(eq(orders.id, orderId)).returning();
    await tx.insert(orderStatusEvents).values({ tenantId, orderId, fromStatus: order.status, toStatus: to, changedByUserId: userId, reason: reason ?? null });
    return updated;
  });
}

export async function markPaid(tenantId: string, orderId: string, _userId: string): Promise<Order> {
  return withTenant(tenantId, async (tx) => {
    const [updated] = await tx.update(orders)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(eq(orders.id, orderId)).returning();
    if (!updated) throw new OrderNotFoundError();
    return updated;
  });
}
```

> Note: the duplicate `import { OrderNotFoundError, InvalidTransitionError }` and the error imports already at the top of `service.ts` — merge them into the existing import line from `"./errors"` rather than adding a second import statement. Likewise merge the `type` imports from `"./schema"` into one import.

- [ ] **Step 4: Extend the barrel**

In `src/server/ordering/index.ts`, add to the `./service` export:

```ts
export {
  placeOrder, money, getOrderByToken, getOrder, listOrders, pendingOrderCount, transitionStatus, markPaid,
  type PlaceOrderInput, type PlaceOrderLine, type PlaceOrderResult, type ListOrdersOpts,
} from "./service";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- src/server/ordering/orders.test.ts`
Expected: PASS. Then run the whole ordering domain: `npm run test -- src/server/ordering` — all green.

- [ ] **Step 6: Commit**

```bash
git add src/server/ordering/service.ts src/server/ordering/index.ts src/server/ordering/orders.test.ts
git commit -m "feat(ordering): order queries, status transitions, mark-paid"
```

---

## Task 12: Checkout + status API routes

**Files:**
- Create: `src/app/api/orders/route.ts`
- Create: `src/app/api/orders/[token]/status/route.ts`
- Create: `src/app/api/delivery-areas/route.ts`
- Test: covered by integration tests above + e2e in Task 20 (routes are thin adapters).

- [ ] **Step 1: Implement `POST /api/orders`**

Create `src/app/api/orders/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { placeOrder, type PlaceOrderInput } from "@/server/ordering/service";
import { DomainError } from "@/shared/errors";

export async function POST(req: NextRequest) {
  let body: { slug?: string; locale?: "en" | "ar" } & Partial<PlaceOrderInput>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { slug, locale = "en", ...input } = body;
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const result = await placeOrder(tenant.id, input as PlaceOrderInput);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.messageFor(locale), code: e.code }, { status: 422 });
    }
    console.error("placeOrder failed", { tenantId: tenant.id, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Implement `GET /api/orders/[token]/status`**

Create `src/app/api/orders/[token]/status/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug } from "@/server/tenancy";
import { getOrderByToken } from "@/server/ordering/service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const slug = req.headers.get("x-tenant-slug") ?? new URL(req.url).searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const order = await getOrderByToken(tenant.id, token);
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ status: order.status, paymentStatus: order.paymentStatus, fulfillmentType: order.fulfillmentType });
}
```

- [ ] **Step 3: Implement `GET /api/delivery-areas`**

Create `src/app/api/delivery-areas/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { listDeliveryAreas } from "@/server/branches/service";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  const branchId = searchParams.get("branch");
  if (!slug || !branchId) return NextResponse.json({ error: "slug and branch are required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const areas = await listDeliveryAreas(tenant.id, branchId);
  return NextResponse.json(
    areas.filter((a) => a.isActive).map((a) => ({ id: a.id, nameEn: a.nameEn, nameAr: a.nameAr, deliveryFee: a.deliveryFee, minOrderAmount: a.minOrderAmount, etaMinutes: a.etaMinutes })),
  );
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/orders src/app/api/delivery-areas
git commit -m "feat(api): checkout, order-status, and delivery-areas endpoints"
```

---

## Task 13: Storefront cart helpers (localStorage)

**Files:**
- Create: `src/app/_components/cart.ts`
- Test: `src/app/_components/cart.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/_components/cart.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cartSubtotal, type CartLine } from "./cart";

const lines: CartLine[] = [
  { productId: "p1", nameEn: "A", nameAr: "أ", quantity: 2, unitPrice: 100, selectedOptionIds: [], modifierSummaryEn: "" },
  { productId: "p2", nameEn: "B", nameAr: "ب", quantity: 1, unitPrice: 50, selectedOptionIds: [], modifierSummaryEn: "" },
];

describe("cart helpers", () => {
  it("cartSubtotal sums quantity × unitPrice", () => {
    expect(cartSubtotal(lines)).toBe(250);
  });
  it("empty cart subtotal is 0", () => {
    expect(cartSubtotal([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/app/_components/cart.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/app/_components/cart.ts`:

```ts
export type CartLine = {
  productId: string;
  nameEn: string;
  nameAr: string;
  quantity: number;
  unitPrice: number; // base + selected modifier deltas, for display only
  selectedOptionIds: string[];
  modifierSummaryEn: string;
};

export type Cart = { branchId: string | null; lines: CartLine[] };

const KEY = "serveos.cart";

export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
}

export function loadCart(): Cart {
  if (typeof window === "undefined") return { branchId: null, lines: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Cart) : { branchId: null, lines: [] };
  } catch {
    return { branchId: null, lines: [] };
  }
}

export function saveCart(cart: Cart): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(cart));
  window.dispatchEvent(new Event("serveos-cart-changed"));
}

export function clearCart(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new Event("serveos-cart-changed"));
}

/** Adds a line. If the branch changed, the cart is reset to the new branch first. */
export function addLine(branchId: string | null, line: CartLine): Cart {
  const current = loadCart();
  const cart: Cart = current.branchId && current.branchId !== branchId
    ? { branchId, lines: [] }
    : { branchId: branchId ?? current.branchId, lines: [...current.lines] };
  cart.lines.push(line);
  saveCart(cart);
  return cart;
}

export function removeLine(index: number): Cart {
  const cart = loadCart();
  cart.lines.splice(index, 1);
  saveCart(cart);
  return cart;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/app/_components/cart.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/_components/cart.ts src/app/_components/cart.test.ts
git commit -m "feat(storefront): localStorage cart helpers"
```

---

## Task 14: Storefront menu with add-to-cart + cart drawer

**Files:**
- Create: `src/app/_components/StorefrontMenu.tsx`
- Modify: `src/app/page.tsx` (use the client component for the storefront menu render)

- [ ] **Step 1: Build the client component**

Create `src/app/_components/StorefrontMenu.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import type { PublishedMenu } from "@/server/catalog/schema";
import { addLine, loadCart, removeLine, cartSubtotal, type Cart } from "./cart";

type MenuProduct = PublishedMenu["categories"][number]["products"][number];

export function StorefrontMenu({ menu, branchId, slug }: { menu: PublishedMenu; branchId: string | null; slug: string }) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setCart(loadCart());
    const onChange = () => setCart(loadCart());
    window.addEventListener("serveos-cart-changed", onChange);
    return () => window.removeEventListener("serveos-cart-changed", onChange);
  }, []);

  function add(p: MenuProduct, optionIds: string[]) {
    const deltas = p.modifierGroups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).reduce((s, o) => s + Number(o.priceDelta), 0);
    const summary = p.modifierGroups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).map((o) => o.nameEn).join(", ");
    setCart(addLine(branchId, {
      productId: p.id, nameEn: p.nameEn, nameAr: p.nameAr, quantity: 1,
      unitPrice: p.effectivePrice + deltas, selectedOptionIds: optionIds, modifierSummaryEn: summary,
    }));
    setDrawerOpen(true);
  }

  return (
    <>
      <button onClick={() => setDrawerOpen(true)} style={{ position: "fixed", insetInlineEnd: 16, top: 16, zIndex: 20, background: "#0f172a", color: "#fff", border: 0, borderRadius: 999, padding: "10px 16px", fontWeight: 700 }}>
        🛒 {cart.lines.reduce((s, l) => s + l.quantity, 0)}
      </button>

      {menu.categories.map((cat) => (
        <div key={cat.id} style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 20, borderBottom: "2px solid currentColor", paddingBottom: 4 }}>{cat.nameEn} / {cat.nameAr}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16, marginTop: 12 }}>
            {cat.products.map((p) => <ProductCard key={p.id} product={p} onAdd={add} />)}
          </div>
        </div>
      ))}

      {drawerOpen && (
        <CartDrawer cart={cart} slug={slug} onClose={() => setDrawerOpen(false)} onRemove={(i) => setCart(removeLine(i))} />
      )}
    </>
  );
}

function ProductCard({ product, onAdd }: { product: MenuProduct; onAdd: (p: MenuProduct, ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>(() => product.modifierGroups.flatMap((g) => g.options).filter((o) => o.isDefault).map((o) => o.id));
  const toggle = (gMax: number, groupOptionIds: string[], id: string) => {
    setSelected((prev) => {
      const inGroup = prev.filter((x) => groupOptionIds.includes(x));
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (gMax === 1) return [...prev.filter((x) => !groupOptionIds.includes(x)), id];
      if (inGroup.length >= gMax) return prev;
      return [...prev, id];
    });
  };
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
      {product.imageUrl && <img src={product.imageUrl} alt={product.nameEn} style={{ width: "100%", height: 140, objectFit: "cover" }} />}
      <div style={{ padding: 12 }}>
        <div style={{ fontWeight: 600 }}>{product.nameEn}</div>
        <div dir="rtl" style={{ color: "#6b7280", fontSize: 14 }}>{product.nameAr}</div>
        {product.modifierGroups.map((g) => {
          const ids = g.options.map((o) => o.id);
          return (
            <div key={g.id} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: "#6b7280" }}>{g.nameEn}{g.required ? " *" : ""}</div>
              {g.options.map((o) => (
                <label key={o.id} style={{ display: "flex", gap: 6, fontSize: 13, alignItems: "center" }}>
                  <input type={g.maxSelections === 1 ? "radio" : "checkbox"} name={`${product.id}-${g.id}`} checked={selected.includes(o.id)} onChange={() => toggle(g.maxSelections, ids, o.id)} />
                  {o.nameEn}{Number(o.priceDelta) ? ` (+${Number(o.priceDelta)})` : ""}
                </label>
              ))}
            </div>
          );
        })}
        <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>{product.effectivePrice.toFixed(2)}</strong>
          <button onClick={() => onAdd(product, selected)} style={{ background: "#f97316", color: "#fff", border: 0, borderRadius: 6, padding: "6px 14px", fontWeight: 600 }}>Add</button>
        </div>
      </div>
    </div>
  );
}

function CartDrawer({ cart, slug, onClose, onRemove }: { cart: Cart; slug: string; onClose: () => void; onRemove: (i: number) => void }) {
  const subtotal = cartSubtotal(cart.lines);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 30 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", insetInlineEnd: 0, top: 0, bottom: 0, width: 340, maxWidth: "90vw", background: "#fff", padding: 16, overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}><h3>Your cart</h3><button onClick={onClose} style={{ border: 0, background: "none", fontSize: 20 }}>×</button></div>
        {cart.lines.length === 0 && <p style={{ color: "#6b7280" }}>Cart is empty.</p>}
        {cart.lines.map((l, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #eee", padding: "8px 0" }}>
            <div><div>{l.quantity}× {l.nameEn}</div>{l.modifierSummaryEn && <div style={{ fontSize: 11, color: "#6b7280" }}>{l.modifierSummaryEn}</div>}</div>
            <div style={{ textAlign: "end" }}>{(l.unitPrice * l.quantity).toFixed(2)}<br /><button onClick={() => onRemove(i)} style={{ border: 0, background: "none", color: "#b91c1c", fontSize: 12 }}>Remove</button></div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontWeight: 700 }}><span>Subtotal</span><span>{subtotal.toFixed(2)}</span></div>
        {cart.lines.length > 0 && (
          <a href={`/checkout?slug=${encodeURIComponent(slug)}${cart.branchId ? `&branch=${cart.branchId}` : ""}`} style={{ display: "block", textAlign: "center", marginTop: 16, background: "#0f172a", color: "#fff", padding: "12px", borderRadius: 6, textDecoration: "none", fontWeight: 600 }}>Checkout →</a>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the storefront page**

In `src/app/page.tsx`, add the import at the top:

```ts
import { StorefrontMenu } from "./_components/StorefrontMenu";
```

Replace the storefront `<section style={{ padding: "0 24px 32px" }}>…</section>` block (the one that maps `menu.categories`) with:

```tsx
        <section style={{ padding: "0 24px 32px" }}>
          <h1 style={{ fontSize: 28, marginBottom: 4 }}>{tenant.name}</h1>
          {menu.categories.length === 0 && <p>Menu coming soon.</p>}
          <StorefrontMenu menu={menu} branchId={branchId ?? null} slug={slug} />
        </section>
```

(`slug` is already available in scope from `h.get("x-tenant-slug")`.)

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/_components/StorefrontMenu.tsx src/app/page.tsx
git commit -m "feat(storefront): add-to-cart menu + cart drawer"
```

---

## Task 15: Checkout page

**Files:**
- Create: `src/app/checkout/page.tsx`
- Create: `src/app/checkout/CheckoutForm.tsx`

- [ ] **Step 1: Server page (reads slug, passes to client form)**

Create `src/app/checkout/page.tsx`:

```tsx
import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { listBranches } from "@/server/branches/service";
import { CheckoutForm } from "./CheckoutForm";

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ slug?: string; branch?: string }> }) {
  const h = await headers();
  const headerSlug = h.get("x-tenant-slug");
  const { slug: querySlug, branch } = await searchParams;
  const slug = headerSlug ?? querySlug;
  if (!slug) return <main style={{ padding: 32 }}><h1>Not found</h1></main>;

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return <main style={{ padding: 32 }}><h1>Restaurant not available</h1></main>;

  const branches = await listBranches(tenant.id);
  const branchId = branch ?? branches[0]?.id ?? null;

  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22 }}>Checkout — {tenant.name}</h1>
      <CheckoutForm slug={slug} branchId={branchId} country={tenant.country} />
    </main>
  );
}
```

- [ ] **Step 2: Client form**

Create `src/app/checkout/CheckoutForm.tsx`:

```tsx
"use client";
import { useEffect, useMemo, useState } from "react";
import { loadCart, clearCart, cartSubtotal, type Cart } from "../_components/cart";

type Area = { id: string; nameEn: string; nameAr: string; deliveryFee: string; minOrderAmount: string; etaMinutes: number | null };

export function CheckoutForm({ slug, branchId, country }: { slug: string; branchId: string | null; country: string }) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [fulfillment, setFulfillment] = useState<"pickup" | "delivery">("delivery");
  const [areas, setAreas] = useState<Area[]>([]);
  const [areaId, setAreaId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const vatRate = country === "SA" ? 15 : 14;

  useEffect(() => { setCart(loadCart()); }, []);
  useEffect(() => {
    if (!branchId) return;
    fetch(`/api/delivery-areas?slug=${encodeURIComponent(slug)}&branch=${branchId}`).then((r) => r.json()).then((d) => Array.isArray(d) && setAreas(d)).catch(() => {});
  }, [slug, branchId]);

  const subtotal = cartSubtotal(cart.lines);
  const area = useMemo(() => areas.find((a) => a.id === areaId), [areas, areaId]);
  const deliveryFee = fulfillment === "delivery" && area ? Number(area.deliveryFee) : 0;
  const vat = subtotal * (vatRate / 100);
  const total = subtotal + vat + deliveryFee;

  async function submit() {
    setError(null);
    if (fulfillment === "delivery" && (!areaId || !address.trim())) { setError("Please choose an area and enter your address."); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug, branchId, fulfillmentType: fulfillment, customerName: name, customerPhone: phone, notes,
          areaId: fulfillment === "delivery" ? areaId : undefined,
          addressText: fulfillment === "delivery" ? address : undefined,
          lines: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, selectedOptionIds: l.selectedOptionIds })),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not place order."); setSubmitting(false); return; }
      clearCart();
      window.location.href = `/order/${data.statusToken}`;
    } catch {
      setError("Network error — please try again.");
      setSubmitting(false);
    }
  }

  if (cart.lines.length === 0) return <p style={{ color: "#6b7280" }}>Your cart is empty.</p>;

  const input = { display: "block", width: "100%", padding: 8, margin: "6px 0", border: "1px solid #d1d5db", borderRadius: 6 } as const;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        {(["delivery", "pickup"] as const).map((f) => (
          <button key={f} onClick={() => setFulfillment(f)} style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #d1d5db", background: fulfillment === f ? "#0f172a" : "#fff", color: fulfillment === f ? "#fff" : "#0f172a", fontWeight: 600, textTransform: "capitalize" }}>{f}</button>
        ))}
      </div>
      <input style={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input style={input} placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
      {fulfillment === "delivery" && (
        <>
          <select style={input} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">Select area…</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn} (fee {Number(a.deliveryFee)} · min {Number(a.minOrderAmount)})</option>)}
          </select>
          <input style={input} placeholder="Street / building details" value={address} onChange={(e) => setAddress(e.target.value)} />
        </>
      )}
      <input style={input} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />

      <div style={{ borderTop: "1px solid #eee", marginTop: 12, paddingTop: 8 }}>
        <Row label="Subtotal" value={subtotal} />
        <Row label={`VAT ${vatRate}%`} value={vat} />
        {fulfillment === "delivery" && <Row label="Delivery" value={deliveryFee} />}
        <Row label="Total" value={total} bold />
      </div>

      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      <button onClick={submit} disabled={submitting || !name || !phone} style={{ width: "100%", marginTop: 12, padding: 12, background: "#f97316", color: "#fff", border: 0, borderRadius: 6, fontWeight: 700 }}>
        {submitting ? "Placing…" : "Place order (Cash)"}
      </button>
      <p style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>Final price is confirmed by the restaurant.</p>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", fontWeight: bold ? 700 : 400 }}><span>{label}</span><span>{value.toFixed(2)}</span></div>;
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/checkout
git commit -m "feat(storefront): guest checkout page (pickup/delivery, live totals)"
```

---

## Task 16: Order status page (tokenized + polling)

**Files:**
- Create: `src/app/order/[token]/page.tsx`
- Create: `src/app/order/[token]/StatusPoller.tsx`

- [ ] **Step 1: Server page**

Create `src/app/order/[token]/page.tsx`:

```tsx
import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";
import { getOrderByToken } from "@/server/ordering/service";
import { StatusPoller } from "./StatusPoller";

const STEPS_DELIVERY = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed"];
const STEPS_PICKUP = ["pending", "confirmed", "preparing", "ready", "completed"];

export default async function OrderStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const slug = h.get("x-tenant-slug");
  if (!slug) return <main style={{ padding: 32 }}><h1>Not found</h1></main>;

  const tenant = await getTenantBySlug(slug);
  const order = tenant ? await getOrderByToken(tenant.id, token) : null;
  if (!order) return <main style={{ padding: 32, fontFamily: "system-ui" }}><h1>Order not found</h1></main>;

  const steps = order.fulfillmentType === "delivery" ? STEPS_DELIVERY : STEPS_PICKUP;

  return (
    <main style={{ padding: 24, maxWidth: 440, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22 }}>Order #{order.orderNumber}</h1>
      <StatusPoller token={token} slug={slug} initialStatus={order.status} steps={steps} terminal={["completed", "rejected", "cancelled"]} />
      <div style={{ borderTop: "1px solid #eee", marginTop: 16, paddingTop: 12, fontSize: 14, color: "#374151" }}>
        <div>{order.fulfillmentType === "delivery" ? `Delivery to ${order.deliveryAreaNameSnapshot ?? ""}` : "Pickup"} · Cash · {order.paymentStatus}</div>
        {order.items.map((it) => <div key={it.id}>{it.quantity}× {it.nameEn}</div>)}
        <div style={{ fontWeight: 700, marginTop: 6 }}>Total {Number(order.total).toFixed(2)}</div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Client poller**

Create `src/app/order/[token]/StatusPoller.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

export function StatusPoller({ token, slug, initialStatus, steps, terminal }: { token: string; slug: string; initialStatus: string; steps: string[]; terminal: string[] }) {
  const [status, setStatus] = useState(initialStatus);

  useEffect(() => {
    if (terminal.includes(status)) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${token}/status?slug=${encodeURIComponent(slug)}`);
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status);
          if (terminal.includes(data.status)) clearInterval(id);
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(id);
  }, [token, slug, status, terminal]);

  const label = (s: string) => s.replace(/_/g, " ");
  const currentIdx = steps.indexOf(status);
  const isCancelled = status === "cancelled" || status === "rejected";

  return (
    <div style={{ marginTop: 12 }}>
      {isCancelled ? (
        <div style={{ color: "#b91c1c", fontWeight: 700, textTransform: "capitalize" }}>{label(status)}</div>
      ) : (
        steps.map((s, i) => (
          <div key={s} style={{ opacity: i <= currentIdx ? 1 : 0.4, fontWeight: i === currentIdx ? 700 : 400, textTransform: "capitalize", padding: "2px 0" }}>
            {i < currentIdx ? "✅ " : i === currentIdx ? "🟣 " : "⚪ "}{label(s)}
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/order
git commit -m "feat(storefront): tokenized order status page with polling"
```

---

## Task 17: Dashboard — unified orders list

**Files:**
- Create: `src/app/dashboard/orders-permission.ts`
- Create: `src/app/dashboard/orders/page.tsx`
- Create: `src/app/dashboard/orders/OrdersTable.tsx`

- [ ] **Step 1: Permission guard**

Create `src/app/dashboard/orders-permission.ts`:

```ts
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireOrdersPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "orders:manage");
  return ctx;
}
```

- [ ] **Step 2: List page**

Create `src/app/dashboard/orders/page.tsx`:

```tsx
import { requireOrdersPermission } from "../orders-permission";
import { listOrders } from "@/server/ordering/service";
import { OrdersTable } from "./OrdersTable";

export default async function OrdersPage() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  const initial = orders.map((o) => ({
    id: o.id, orderNumber: o.orderNumber, customerName: o.customerName,
    fulfillmentType: o.fulfillmentType, total: o.total, status: o.status, paymentStatus: o.paymentStatus,
  }));
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Orders</h1>
      <OrdersTable initial={initial} />
    </main>
  );
}
```

- [ ] **Step 3: Client table with polling + new badge**

Create `src/app/dashboard/orders/OrdersTable.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

type Row = { id: string; orderNumber: number; customerName: string; fulfillmentType: string; total: string; status: string; paymentStatus: string };

export function OrdersTable({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initial);
  const pending = rows.filter((r) => r.status === "pending").length;

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/dashboard/orders", { cache: "no-store" });
        if (res.ok) setRows(await res.json());
      } catch { /* keep polling */ }
    }, 8000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <div style={{ margin: "8px 0" }}>
        {pending > 0 && <span style={{ background: "#b91c1c", color: "#fff", borderRadius: 10, padding: "2px 10px", fontSize: 13 }}>{pending} new</span>}
        <span style={{ color: "#6b7280", fontSize: 12, marginInlineStart: 8 }}>auto-refreshing · 🛵 delivery · 🥡 pickup</span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "start", color: "#6b7280", fontSize: 13 }}><th style={{ textAlign: "start" }}>#</th><th style={{ textAlign: "start" }}>Customer</th><th>Type</th><th>Total</th><th>Payment</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ background: r.status === "pending" ? "#fff7ed" : undefined, borderTop: "1px solid #eee" }}>
              <td><a href={`/dashboard/orders/${r.id}`}>{r.orderNumber}</a></td>
              <td>{r.customerName}</td>
              <td style={{ textAlign: "center" }}>{r.fulfillmentType === "delivery" ? "🛵" : "🥡"}</td>
              <td style={{ textAlign: "center" }}>{Number(r.total).toFixed(2)}</td>
              <td style={{ textAlign: "center", color: r.paymentStatus === "paid" ? "#15803d" : "#b91c1c" }}>{r.paymentStatus}</td>
              <td style={{ textAlign: "center", textTransform: "capitalize" }}>{r.status.replace(/_/g, " ")}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} style={{ color: "#6b7280", padding: 12 }}>No orders yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
```

- [ ] **Step 4: Polling endpoint for the dashboard list**

Create `src/app/api/dashboard/orders/route.ts`:

```ts
import { NextResponse } from "next/server";
import { requireOrdersPermission } from "@/app/dashboard/orders-permission";
import { listOrders } from "@/server/ordering/service";

export async function GET() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  return NextResponse.json(orders.map((o) => ({
    id: o.id, orderNumber: o.orderNumber, customerName: o.customerName,
    fulfillmentType: o.fulfillmentType, total: o.total, status: o.status, paymentStatus: o.paymentStatus,
  })));
}
```

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/orders-permission.ts src/app/dashboard/orders src/app/api/dashboard/orders
git commit -m "feat(dashboard): unified orders list with polling + new badge"
```

---

## Task 18: Dashboard — order detail + transitions

**Files:**
- Create: `src/app/dashboard/orders/[id]/page.tsx`
- Create: `src/app/dashboard/orders/[id]/actions.ts`

- [ ] **Step 1: Server actions**

Create `src/app/dashboard/orders/[id]/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireOrdersPermission } from "../../orders-permission";
import { transitionStatus, markPaid } from "@/server/ordering/service";
import type { OrderStatus } from "@/server/ordering/schema";

export async function transitionOrderAction(orderId: string, to: OrderStatus, reason?: string) {
  const { tenantId, user } = await requireOrdersPermission();
  await transitionStatus(tenantId, orderId, to, user.id, reason);
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath("/dashboard/orders");
}

export async function markPaidAction(orderId: string) {
  const { tenantId, user } = await requireOrdersPermission();
  await markPaid(tenantId, orderId, user.id);
  revalidatePath(`/dashboard/orders/${orderId}`);
}
```

- [ ] **Step 2: Detail page with state-machine-driven buttons**

Create `src/app/dashboard/orders/[id]/page.tsx`:

```tsx
import { requireOrdersPermission } from "../../orders-permission";
import { getOrder } from "@/server/ordering/service";
import { nextStatuses } from "@/server/ordering/state-machine";
import { transitionOrderAction, markPaidAction } from "./actions";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tenantId } = await requireOrdersPermission();
  const order = await getOrder(tenantId, id);
  const actions = nextStatuses(order.status, order.fulfillmentType);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 560 }}>
      <a href="/dashboard/orders">← Orders</a>
      <h1>Order #{order.orderNumber} <span style={{ fontSize: 14, textTransform: "capitalize" }}>· {order.status.replace(/_/g, " ")}</span></h1>
      <p style={{ color: "#374151" }}>
        {order.customerName} · {order.customerPhone}<br />
        {order.fulfillmentType === "delivery" ? `🛵 Delivery → ${order.deliveryAreaNameSnapshot ?? ""}, ${order.deliveryAddressText ?? ""}` : "🥡 Pickup"}<br />
        💵 Cash · <span style={{ color: order.paymentStatus === "paid" ? "#15803d" : "#b91c1c" }}>{order.paymentStatus}</span>
        {order.notes && <><br />📝 {order.notes}</>}
      </p>

      <div style={{ border: "1px solid #eee", borderRadius: 6, padding: 10 }}>
        {order.items.map((it) => (
          <div key={it.id}>{it.quantity}× {it.nameEn}{it.selectedModifiers.length > 0 && <span style={{ color: "#6b7280" }}> ({it.selectedModifiers.map((m) => m.optionNameEn).join(", ")})</span>} … {Number(it.lineTotal).toFixed(2)}</div>
        ))}
        <div style={{ borderTop: "1px solid #eee", marginTop: 6, paddingTop: 6 }}>
          Subtotal {Number(order.subtotal).toFixed(2)} · VAT {Number(order.vatAmount).toFixed(2)} · Delivery {Number(order.deliveryFee).toFixed(2)}<br />
          <strong>Total {Number(order.total).toFixed(2)}</strong>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {actions.map((to) => {
          const danger = to === "cancelled" || to === "rejected";
          return (
            <form key={to} action={async () => { "use server"; await transitionOrderAction(id, to, danger ? "Cancelled by staff" : undefined); }}>
              <button style={{ background: danger ? "#b91c1c" : "#0f172a", color: "#fff", border: 0, borderRadius: 6, padding: "8px 14px", textTransform: "capitalize" }}>{to.replace(/_/g, " ")}</button>
            </form>
          );
        })}
        {order.paymentStatus === "unpaid" && (
          <form action={async () => { "use server"; await markPaidAction(id); }}>
            <button style={{ background: "#374151", color: "#fff", border: 0, borderRadius: 6, padding: "8px 14px" }}>Mark paid</button>
          </form>
        )}
      </div>

      <h3 style={{ marginTop: 24 }}>History</h3>
      <ul style={{ fontSize: 13, color: "#6b7280" }}>
        {order.events.map((e) => <li key={e.id}>{e.fromStatus ? `${e.fromStatus} → ` : ""}{e.toStatus}{e.reason ? ` (${e.reason})` : ""} · {new Date(e.createdAt).toLocaleString()}</li>)}
      </ul>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/orders/[id]
git commit -m "feat(dashboard): order detail with state-machine transitions + mark-paid"
```

---

## Task 19: Dashboard — fulfillment settings (hours, toggle, areas, VAT)

**Files:**
- Create: `src/app/dashboard/fulfillment-permission.ts`
- Create: `src/app/dashboard/fulfillment/page.tsx`
- Create: `src/app/dashboard/fulfillment/actions.ts`

- [ ] **Step 1: Permission guard**

Create `src/app/dashboard/fulfillment-permission.ts`:

```ts
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireFulfillmentPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "fulfillment:manage");
  return ctx;
}
```

- [ ] **Step 2: Server actions**

Create `src/app/dashboard/fulfillment/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { updateBranchOrdering, createDeliveryArea, deleteDeliveryArea } from "@/server/branches/service";
import { setVatRate } from "@/server/tenancy/settings";
import type { OpeningHours } from "@/server/branches/schema";

export async function setAcceptingOrdersAction(branchId: string, accepting: boolean) {
  const { tenantId } = await requireFulfillmentPermission();
  await updateBranchOrdering(tenantId, branchId, { acceptingOrders: accepting });
  revalidatePath("/dashboard/fulfillment");
}

export async function setOpeningHoursAction(branchId: string, formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  const hours: OpeningHours = [];
  for (let day = 0; day < 7; day++) {
    const closed = formData.get(`closed-${day}`) === "on";
    hours.push({ day, closed, open: String(formData.get(`open-${day}`) || "10:00"), close: String(formData.get(`close-${day}`) || "23:00") });
  }
  await updateBranchOrdering(tenantId, branchId, { openingHours: hours });
  revalidatePath("/dashboard/fulfillment");
}

export async function addAreaAction(branchId: string, formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  await createDeliveryArea(tenantId, branchId, {
    nameEn: String(formData.get("nameEn")), nameAr: String(formData.get("nameAr")),
    deliveryFee: String(formData.get("deliveryFee") || "0"), minOrderAmount: String(formData.get("minOrderAmount") || "0"),
    etaMinutes: formData.get("etaMinutes") ? Number(formData.get("etaMinutes")) : null,
  });
  revalidatePath("/dashboard/fulfillment");
}

export async function deleteAreaAction(areaId: string) {
  const { tenantId } = await requireFulfillmentPermission();
  await deleteDeliveryArea(tenantId, areaId);
  revalidatePath("/dashboard/fulfillment");
}

export async function setVatAction(formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  await setVatRate(tenantId, Number(formData.get("vatRate")));
  revalidatePath("/dashboard/fulfillment");
}
```

- [ ] **Step 3: Settings page**

Create `src/app/dashboard/fulfillment/page.tsx`:

```tsx
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { listBranches, listDeliveryAreas } from "@/server/branches/service";
import { getVatRate } from "@/server/tenancy/settings";
import { setAcceptingOrdersAction, setOpeningHoursAction, addAreaAction, deleteAreaAction, setVatAction } from "./actions";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function FulfillmentPage() {
  const { tenantId } = await requireFulfillmentPermission();
  const branches = await listBranches(tenantId);
  const vatRate = await getVatRate(tenantId);
  const areasByBranch = Object.fromEntries(await Promise.all(branches.map(async (b) => [b.id, await listDeliveryAreas(tenantId, b.id)] as const)));

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 720 }}>
      <h1>Ordering settings</h1>

      <section style={{ margin: "16px 0" }}>
        <h2 style={{ fontSize: 16 }}>VAT</h2>
        <form action={setVatAction} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input name="vatRate" type="number" step="0.1" defaultValue={vatRate} style={{ width: 100, padding: 6 }} /> %
          <button>Save</button>
        </form>
      </section>

      {branches.map((b) => {
        const hours = b.openingHours ?? [];
        const byDay = (d: number) => hours.find((h) => h.day === d);
        return (
          <section key={b.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <h2 style={{ fontSize: 16 }}>{b.name}</h2>

            <form action={setAcceptingOrdersAction.bind(null, b.id, !b.acceptingOrders)}>
              <button>{b.acceptingOrders ? "● Accepting orders (click to pause)" : "○ Paused (click to resume)"}</button>
            </form>

            <form action={setOpeningHoursAction.bind(null, b.id)} style={{ marginTop: 12 }}>
              <table style={{ fontSize: 13 }}>
                <tbody>
                  {DAYS.map((name, d) => {
                    const e = byDay(d);
                    return (
                      <tr key={d}>
                        <td>{name}</td>
                        <td><label><input type="checkbox" name={`closed-${d}`} defaultChecked={e?.closed ?? false} /> closed</label></td>
                        <td><input type="time" name={`open-${d}`} defaultValue={e?.open ?? "10:00"} /></td>
                        <td><input type="time" name={`close-${d}`} defaultValue={e?.close ?? "23:00"} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button style={{ marginTop: 6 }}>Save hours</button>
            </form>

            <h3 style={{ fontSize: 14, marginTop: 12 }}>Delivery areas</h3>
            <ul>
              {(areasByBranch[b.id] ?? []).map((a) => (
                <li key={a.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {a.nameEn} — fee {Number(a.deliveryFee)} · min {Number(a.minOrderAmount)} {a.etaMinutes ? `· ${a.etaMinutes}m` : ""}
                  <form action={deleteAreaAction.bind(null, a.id)}><button style={{ color: "#b91c1c", border: 0, background: "none" }}>delete</button></form>
                </li>
              ))}
            </ul>
            <form action={addAreaAction.bind(null, b.id)} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              <input name="nameEn" placeholder="Area (EN)" required />
              <input name="nameAr" placeholder="Area (AR)" dir="rtl" required />
              <input name="deliveryFee" type="number" step="0.01" placeholder="Fee" style={{ width: 80 }} />
              <input name="minOrderAmount" type="number" step="0.01" placeholder="Min" style={{ width: 80 }} />
              <input name="etaMinutes" type="number" placeholder="ETA min" style={{ width: 80 }} />
              <button>+ Add area</button>
            </form>
          </section>
        );
      })}
    </main>
  );
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/fulfillment-permission.ts src/app/dashboard/fulfillment
git commit -m "feat(dashboard): fulfillment settings — hours, toggle, areas, VAT"
```

---

## Task 20: Seed data + e2e smoke test

**Files:**
- Modify: `scripts/seed.ts`
- Create: `tests/e2e/ordering.spec.ts`

- [ ] **Step 1: Extend the seed with ordering data**

In `scripts/seed.ts`, after the existing Roma menu/branch seeding (locate where the demo branch is created; if none exists, the menu sub-project seed created branches — find the first branch for `romaTenant`). Add near the end of `main()` (before `await pool.end()`), using dynamic imports consistent with the file:

```ts
  // ── Ordering demo data ──────────────────────────────────────────────────────
  {
    const { listBranches, updateBranchOrdering, listDeliveryAreas, createDeliveryArea } = await import("../src/server/branches/service");
    const { setVatRate } = await import("../src/server/tenancy/settings");
    const branches = await listBranches(romaTenant.id);
    if (branches[0]) {
      const b = branches[0];
      await updateBranchOrdering(romaTenant.id, b.id, {
        acceptingOrders: true,
        openingHours: Array.from({ length: 7 }, (_, day) => ({ day, open: "10:00", close: "23:00", closed: false })),
      });
      if ((await listDeliveryAreas(romaTenant.id, b.id)).length === 0) {
        await createDeliveryArea(romaTenant.id, b.id, { nameEn: "Maadi", nameAr: "المعادي", deliveryFee: "25", minOrderAmount: "100", etaMinutes: 35 });
        await createDeliveryArea(romaTenant.id, b.id, { nameEn: "Nasr City", nameAr: "مدينة نصر", deliveryFee: "40", minOrderAmount: "150", etaMinutes: 50 });
      }
    }
    await setVatRate(romaTenant.id, 14);
  }
```

> If the existing seed does not already create a branch + published product for Roma, also add a category + one published product here (use `createCategory`/`createProduct`/`updateProduct` from `@/server/catalog/service`) so the storefront has something orderable. Check the file first; only add what's missing.

- [ ] **Step 2: Run the seed against the dev DB**

Run: `npm run db:seed`
Expected: completes without error; Roma now has hours, two delivery areas, and VAT 14%.

- [ ] **Step 3: Write the e2e smoke test**

Review `tests/e2e/menu.spec.ts` first for the existing host-header pattern (the storefront is reached via the `Host` header `roma.serveos.localhost`). Create `tests/e2e/ordering.spec.ts` mirroring that setup:

```ts
import { test, expect } from "@playwright/test";

// Storefront is host-routed; menu.spec.ts shows the pattern for setting the tenant host.
test("customer can browse, add to cart, and reach checkout", async ({ page }) => {
  await page.goto("http://roma.serveos.localhost:3000/");
  await expect(page.getByRole("heading", { name: /Pizza Roma|Roma/ })).toBeVisible();

  // Add the first available product to the cart.
  const addButton = page.getByRole("button", { name: "Add" }).first();
  await addButton.click();

  // Cart drawer opens with a Checkout link.
  const checkout = page.getByRole("link", { name: /Checkout/ });
  await expect(checkout).toBeVisible();
  await checkout.click();

  await expect(page.getByRole("heading", { name: /Checkout/ })).toBeVisible();
  await expect(page.getByPlaceholder("Name")).toBeVisible();
});
```

> Note: e2e requires the dev server running and the seed applied. If the project's Playwright config starts the server, rely on it; otherwise run `npm run dev` in another terminal. If `roma.serveos.localhost` is not in `/etc/hosts`, follow the README note to add `127.0.0.1 roma.serveos.localhost`.

- [ ] **Step 4: Run the e2e smoke test**

Run: `npm run test:e2e -- ordering.spec.ts`
Expected: PASS. If host resolution fails locally, document it and verify manually per the README, then continue.

- [ ] **Step 5: Run the full unit/integration suite**

Run: `npm run test`
Expected: all suites green (entitlements, rbac, branches, tenancy, ordering, plus existing).

- [ ] **Step 6: Commit**

```bash
git add scripts/seed.ts tests/e2e/ordering.spec.ts
git commit -m "feat(ordering): seed demo ordering data + e2e smoke test"
```

---

## Final verification

- [ ] Run `npm run test` — all green.
- [ ] Run `npx tsc --noEmit && npm run lint` — clean.
- [ ] Manually (or via `/run`): on `roma.serveos.localhost:3000`, add an item → checkout (delivery, pick Maadi) → land on `/order/<token>`; in the dashboard at `/dashboard/orders`, the order shows as pending → Confirm → Mark paid; the status page reflects the change within ~5s.

---

## Self-Review

**Spec coverage (each spec section → task):**
- §1 web cart → Tasks 13–14; checkout pickup/delivery → Task 15; guest fields → Task 15.
- §2 fulfillment named areas → Tasks 3,5,19; phone unverified → Task 15 (plain fields); lifecycle → Task 8; payment unpaid/paid + cash + PaymentProvider seam → `payment_method` enum (Task 7) + `markPaid` (Task 11) [the enum-only `cash` value *is* the seam — gateways add enum values + a webhook later]; branch orderable → Tasks 4,19; tokenized tracking + dashboard polling → Tasks 16,17; entitlements feature + metering, no cap → Tasks 1,10; VAT → Tasks 6,19; client cart → Task 13; architecture (ordering domain, branches config, tenant_settings) → Tasks 3–11.
- §3 architecture & PaymentProvider seam → represented by the `payment_method`/`paymentStatus` split; **no separate `PaymentProvider` interface file is created in v1** since the only method is `cash` set by staff — the seam is the enum + the isolated `markPaid` call. (Documented intentional simplification; a real interface lands with the gateway slice.)
- §4 data model → Tasks 3 (branches/areas) + 7 (orders/items/events), incl. `channel` discriminator default `web`.
- §5 data flow placeOrder steps 1–10 → Task 10; transitions → Task 11.
- §6 typed errors + localized + fail-closed + tokenized read → Tasks 9,10,12,16.
- §7 testing unit/integration/e2e/seed → Tasks 4,8 (unit), 5,6,10,11 (integration), 20 (seed+e2e).
- §8 RTL/en-ar → applied via `dir="rtl"` on Arabic fields and logical CSS props (`insetInlineEnd`, `marginInlineStart`, `textAlign:"start"`) in the UI tasks; unified list `channel` reserved (Task 7). **Note:** the storefront/dashboard use ad-hoc inline styles matching the existing codebase (which is not yet fully RTL-themed); full Arabic locale switching is consistent with the current app state and the foundation's `dir` usage in `page.tsx`.

**Placeholder scan:** no TBD/TODO; all code blocks complete. The one cross-task caution (Task 10 first test referencing `orders` directly) is called out with the exact simplified replacement.

**Type consistency:** `placeOrder`/`PlaceOrderInput`/`PlaceOrderResult`, `transitionStatus(tenantId, orderId, to, userId, reason?)`, `markPaid(tenantId, orderId, userId)`, `nextStatuses(from, fulfillment)`/`canTransition`, `getOrderByToken`→`OrderWithItems`, `getOrder`→`OrderDetail` (with `events`), `OrderStatus`/`FulfillmentType` from schema, `money()` shared — all consistent across Tasks 7–18. `incrementUsage`/`requireFeature` (Task 1) used in Task 10. `online_ordering` feature key (Task 1) used in Task 10. `orders:manage`/`fulfillment:manage` (Task 2) used in Tasks 17–19.

**Gaps fixed inline:** added the `/api/dashboard/orders` polling endpoint (Task 17 Step 4) needed by `OrdersTable`; clarified the PaymentProvider seam is enum-based in v1 (no separate interface file) to avoid an unused abstraction (YAGNI).
