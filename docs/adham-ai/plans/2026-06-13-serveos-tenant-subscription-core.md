# ServeOS Tenant & Subscription Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use parallel-build (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multi-tenant foundation for ServeOS — restaurants self-register, get a trial dashboard, are approved by a platform admin, and have a branded installable-PWA storefront resolve on their subdomain, with RLS-guaranteed tenant isolation and plan entitlements.

**Architecture:** A single Next.js (App Router) app serves three host-based surfaces (storefront `{slug}.serveos.com`, dashboard `app.`, admin `admin.`). All business logic lives in framework-agnostic server modules under `src/server/<domain>/`, each exposing a service interface and owning its Drizzle schema. Tenant data is isolated in one Postgres database via a `tenant_id` column plus FORCE Row-Level Security, enforced by a `withTenant()` transaction wrapper that sets `app.tenant_id`.

**Tech Stack:** Next.js 15 (App Router) · TypeScript · PostgreSQL · Drizzle ORM · `pg` · Vitest (unit/integration) · Playwright (E2E) · Node `crypto.scrypt` (password hashing) · custom cookie sessions.

**Spec:** `docs/adham-ai/specs/2026-06-13-serveos-tenant-subscription-core-design.md`

---

## Conventions used throughout this plan

- **TDD:** failing test → run (red) → minimal code → run (green) → commit.
- **Test DB:** integration tests run against a real Postgres named `serveos_test` (RLS cannot be tested with mocks). A global setup truncates tables between tests.
- **Module boundary:** code in `src/app/` (routes/actions) only imports from a domain's `index.ts` service export, never from another domain's internals.
- **Commit style:** Conventional Commits. Commit after every green step group.
- **Path alias:** `@/` → `src/`.

---

## File Structure (created across the plan)

```
serveos/
├─ docker-compose.yml                      # local Postgres
├─ drizzle.config.ts                       # Drizzle Kit config
├─ vitest.config.ts                        # unit + integration runner
├─ playwright.config.ts                    # E2E runner
├─ .env.local / .env.test                  # DATABASE_URL etc.
├─ src/
│  ├─ env.ts                               # validated env access
│  ├─ middleware.ts                        # host → surface/tenant routing
│  ├─ db/
│  │  ├─ client.ts                         # pg pool + drizzle instance
│  │  ├─ schema.ts                         # re-exports every domain schema
│  │  ├─ with-tenant.ts                    # RLS transaction wrapper
│  │  └─ test-harness.ts                   # truncate/seed helpers for tests
│  ├─ server/
│  │  ├─ tenancy/{schema.ts,service.ts,index.ts}
│  │  ├─ auth/{schema.ts,password.ts,session.ts,service.ts,otp.ts,index.ts}
│  │  ├─ rbac/{permissions.ts,authorize.ts,index.ts}
│  │  ├─ subscription/{schema.ts,plans.seed.ts,service.ts,index.ts}
│  │  ├─ entitlements/{errors.ts,service.ts,index.ts}
│  │  ├─ billing/{provider.ts,manual-provider.ts,service.ts,index.ts}
│  │  ├─ onboarding/{schema.ts,service.ts,index.ts}
│  │  └─ platform/{service.ts,index.ts}
│  ├─ shared/errors.ts                     # base DomainError + localized messages
│  └─ app/
│     ├─ (storefront)/manifest.webmanifest/route.ts
│     ├─ (storefront)/page.tsx             # branded "coming soon" PWA shell
│     ├─ (dashboard)/...                   # register/login/dashboard
│     └─ (admin)/...                       # login + approval queue
├─ public/sw.js                            # storefront service worker
├─ scripts/seed.ts                         # demo tenants + super-admin
└─ tests/e2e/onboarding.spec.ts
```

---

# Phase 0 — Project Scaffolding

### Task 1: Initialize Next.js project + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `.gitignore`, `vitest.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`

- [ ] **Step 1: Scaffold Next.js**

Run in the project root:
```bash
npx create-next-app@latest . --typescript --app --src-dir --no-tailwind --eslint --import-alias "@/*" --use-npm --no-turbopack
```
Accept overwrite if prompted (the repo only has `docs/`). Expected: a Next.js app with `src/app/layout.tsx` and `src/app/page.tsx`.

- [ ] **Step 2: Add dev/test dependencies**

```bash
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg vitest @vitest/coverage-v8 dotenv tsx
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/db/test-global-setup.ts"],
    setupFiles: ["./src/db/test-setup.ts"],
    fileParallelism: false, // shared test DB — run serially
    env: { NODE_ENV: "test" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

- [ ] **Step 4: Add test scripts to `package.json`**

Add under `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest",
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx scripts/migrate.ts",
"db:seed": "tsx scripts/seed.ts"
```

- [ ] **Step 5: Verify the app builds**

Run: `npm run build`
Expected: `✓ Compiled successfully`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Drizzle and Vitest tooling"
```

---

### Task 2: Local Postgres + env validation

**Files:**
- Create: `docker-compose.yml`, `.env.local`, `.env.test`, `src/env.ts`, `src/env.test.ts`

- [ ] **Step 1: Write the failing test for env validation**

Create `src/env.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { loadEnv } from "@/env";

describe("loadEnv", () => {
  it("returns DATABASE_URL when present", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x" });
    expect(env.DATABASE_URL).toBe("postgres://x");
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx vitest run src/env.test.ts`
Expected: FAIL — cannot find module `@/env`.

- [ ] **Step 3: Implement `src/env.ts`**

```typescript
export type Env = {
  DATABASE_URL: string;
  ROOT_DOMAIN: string;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const DATABASE_URL = source.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("Missing required env: DATABASE_URL");
  return {
    DATABASE_URL,
    ROOT_DOMAIN: source.ROOT_DOMAIN ?? "serveos.localhost",
  };
}

export const env = (): Env => loadEnv();
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npx vitest run src/env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Create `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: serveos
      POSTGRES_PASSWORD: serveos
      POSTGRES_DB: serveos
    ports: ["5432:5432"]
    volumes: ["serveos_pgdata:/var/lib/postgresql/data"]
volumes:
  serveos_pgdata:
```

- [ ] **Step 6: Create env files**

`.env.local`:
```
DATABASE_URL=postgres://serveos:serveos@localhost:5432/serveos
ROOT_DOMAIN=serveos.localhost
```
`.env.test`:
```
DATABASE_URL=postgres://serveos:serveos@localhost:5432/serveos_test
ROOT_DOMAIN=serveos.localhost
```
Confirm `.env*` is in `.gitignore` (create-next-app adds it).

- [ ] **Step 7: Start Postgres and create the test DB**

```bash
docker compose up -d
sleep 3
docker compose exec -T db psql -U serveos -d serveos -c "CREATE DATABASE serveos_test;" || true
```
Expected: `CREATE DATABASE` (or "already exists").

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: add local Postgres and validated env loader"
```

---

### Task 3: Drizzle client, migrator, and test harness

**Files:**
- Create: `drizzle.config.ts`, `src/db/client.ts`, `scripts/migrate.ts`, `src/db/schema.ts`, `src/db/test-global-setup.ts`, `src/db/test-setup.ts`, `src/db/test-harness.ts`

- [ ] **Step 1: Create `drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 2: Create the Drizzle client `src/db/client.ts`**

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const url =
  process.env.NODE_ENV === "test"
    ? process.env.DATABASE_URL?.replace(/\/serveos$/, "/serveos_test") ??
      process.env.DATABASE_URL!
    : process.env.DATABASE_URL!;

export const pool = new Pool({ connectionString: url });
export const db = drizzle(pool, { schema });
export type DB = typeof db;
```

- [ ] **Step 3: Create the empty aggregate schema `src/db/schema.ts`**

```typescript
// Re-exports every domain's Drizzle schema. Domains append their export here.
export {};
```

- [ ] **Step 4: Create the migrator `scripts/migrate.ts`**

```typescript
import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/db/client";

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("migrations applied");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 5: Create the test global setup `src/db/test-global-setup.ts`**

This applies migrations once to the test DB before the suite runs.
```typescript
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.test", override: true });
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";

export default async function () {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
}
```

- [ ] **Step 6: Create per-test truncation `src/db/test-setup.ts` and harness `src/db/test-harness.ts`**

`src/db/test-harness.ts`:
```typescript
import { sql } from "drizzle-orm";
import { db } from "./client";

/** Truncate all app tables (RLS is bypassed because this runs as table owner with TRUNCATE). */
export async function truncateAll() {
  const { rows } = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
}
```
`src/db/test-setup.ts`:
```typescript
import { config } from "dotenv";
config({ path: ".env.test", override: true });
import { beforeEach } from "vitest";
import { truncateAll } from "./test-harness";

beforeEach(async () => {
  await truncateAll();
});
```

- [ ] **Step 7: Sanity-check the harness compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (No migrations yet, so don't run the suite.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): add Drizzle client, migrator, and test harness"
```

---

# Phase 1 — Tenancy & Row-Level Security

### Task 4: `tenants` schema + FORCE RLS migration

**Files:**
- Create: `src/server/tenancy/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `src/server/tenancy/schema.test.ts`

- [ ] **Step 1: Write a failing test that the table exists and rejects a duplicate slug**

Create `src/server/tenancy/schema.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "./schema";

describe("tenants schema", () => {
  it("inserts a tenant and enforces unique slug", async () => {
    await db.insert(tenants).values({ slug: "pizzaroma", name: "Pizza Roma", country: "EG" });
    const rows = await db.select().from(tenants);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("onboarding");
    await expect(
      db.insert(tenants).values({ slug: "pizzaroma", name: "Dup", country: "EG" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/tenancy/schema.test.ts`
Expected: FAIL — module `./schema` not found.

- [ ] **Step 3: Implement `src/server/tenancy/schema.ts`**

```typescript
import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const tenantStatus = pgEnum("tenant_status", [
  "onboarding",
  "trial",
  "active",
  "suspended",
  "rejected",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("onboarding"),
  country: text("country").notNull(), // "EG" | "SA"
  currency: text("currency").notNull().default("EGP"),
  defaultLocale: text("default_locale").notNull().default("ar"),
  timezone: text("timezone").notNull().default("Africa/Cairo"),
  customDomain: text("custom_domain").unique(),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color").notNull().default("#0F172A"),
  theme: text("theme").notNull().default("default"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
```

- [ ] **Step 4: Wire into aggregate schema `src/db/schema.ts`**

```typescript
export * from "@/server/tenancy/schema";
```

- [ ] **Step 5: Generate and apply the migration**

```bash
npm run db:generate
DATABASE_URL=postgres://serveos:serveos@localhost:5432/serveos_test npm run db:migrate
```
Expected: a new file under `drizzle/` and `migrations applied`.

- [ ] **Step 6: Run the test — expect pass**

Run: `npx vitest run src/server/tenancy/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tenancy): add tenants table with status enum"
```

---

### Task 5: RLS policies + `withTenant` wrapper (the isolation guarantee)

**Files:**
- Create: `drizzle/0001_rls.sql` (hand-written migration), `src/db/with-tenant.ts`
- Create: `src/db/with-tenant.test.ts`

> RLS must be tested with a tenant-scoped table. We add a tiny scoped table `tenant_settings` here to prove isolation; later domains follow the same pattern.

- [ ] **Step 1: Add a scoped demo table to the tenancy schema**

Append to `src/server/tenancy/schema.ts`:
```typescript
import { jsonb } from "drizzle-orm/pg-core";

export const tenantSettings = pgTable("tenant_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  data: jsonb("data").notNull().default({}),
});
export type TenantSettings = typeof tenantSettings.$inferSelect;
```

- [ ] **Step 2: Generate the table migration, then hand-write the RLS migration**

```bash
npm run db:generate
```
Create `drizzle/0002_rls.sql` (rename to follow the generated numbering if needed) with:
```sql
ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_settings_isolation ON "tenant_settings"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```
Add a marker line so Drizzle's journal records it — append the file path to `drizzle/meta/_journal.json` is handled automatically only for generated files; therefore include this SQL **inside** the most recently generated migration file instead of a separate file. Open the newest `drizzle/0002_*.sql` and paste the three statements above at its end.

- [ ] **Step 3: Write the failing isolation test `src/db/with-tenant.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants, tenantSettings } from "@/server/tenancy/schema";
import { withTenant } from "./with-tenant";

describe("withTenant RLS isolation", () => {
  it("only sees rows belonging to the active tenant", async () => {
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A", country: "EG" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "b", name: "B", country: "EG" }).returning();

    await withTenant(a.id, async (tx) => {
      await tx.insert(tenantSettings).values({ tenantId: a.id, data: { x: 1 } });
    });
    await withTenant(b.id, async (tx) => {
      await tx.insert(tenantSettings).values({ tenantId: b.id, data: { x: 2 } });
    });

    const seenByA = await withTenant(a.id, (tx) => tx.select().from(tenantSettings));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0].tenantId).toBe(a.id);
  });

  it("blocks writing a row for a different tenant", async () => {
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A", country: "EG" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "b", name: "B", country: "EG" }).returning();
    await expect(
      withTenant(a.id, (tx) => tx.insert(tenantSettings).values({ tenantId: b.id, data: {} })),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run — expect failure**

Run: `npx vitest run src/db/with-tenant.test.ts`
Expected: FAIL — `./with-tenant` not found.

- [ ] **Step 5: Implement `src/db/with-tenant.ts`**

```typescript
import { sql } from "drizzle-orm";
import { db } from "./client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` inside a transaction with the Postgres session var `app.tenant_id`
 * set, so every query is constrained by RLS policies to that tenant.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T> | T): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
```

- [ ] **Step 6: Apply migration and run tests — expect pass**

```bash
DATABASE_URL=postgres://serveos:serveos@localhost:5432/serveos_test npm run db:migrate
npx vitest run src/db/with-tenant.test.ts
```
Expected: PASS (2 tests). If "policy already exists" appears, the SQL ran twice — `DROP POLICY IF EXISTS` before `CREATE POLICY` to make it idempotent.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): enforce tenant isolation with FORCE RLS and withTenant wrapper"
```

---

### Task 6: Tenant resolution service (slug → tenant, cached)

**Files:**
- Create: `src/server/tenancy/service.ts`, `src/server/tenancy/index.ts`
- Create: `src/server/tenancy/service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/tenancy/service.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "./schema";
import { resolveTenantByHost, createTenant } from "./service";

describe("tenancy service", () => {
  it("creates a tenant with defaults", async () => {
    const t = await createTenant({ slug: "roma", name: "Roma", country: "EG" });
    expect(t.slug).toBe("roma");
    expect(t.status).toBe("onboarding");
  });

  it("resolves a tenant from a storefront host", async () => {
    await db.insert(tenants).values({ slug: "roma", name: "Roma", country: "EG", status: "active" });
    const t = await resolveTenantByHost("roma.serveos.localhost", "serveos.localhost");
    expect(t?.slug).toBe("roma");
  });

  it("returns null for the bare root domain and app/admin hosts", async () => {
    expect(await resolveTenantByHost("serveos.localhost", "serveos.localhost")).toBeNull();
    expect(await resolveTenantByHost("app.serveos.localhost", "serveos.localhost")).toBeNull();
    expect(await resolveTenantByHost("admin.serveos.localhost", "serveos.localhost")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/tenancy/service.test.ts`
Expected: FAIL — `./service` not found.

- [ ] **Step 3: Implement `src/server/tenancy/service.ts`**

```typescript
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants, type NewTenant, type Tenant } from "./schema";

const RESERVED = new Set(["app", "admin", "www", "api"]);

export async function createTenant(input: Pick<NewTenant, "slug" | "name" | "country"> & Partial<NewTenant>): Promise<Tenant> {
  const currency = input.country === "SA" ? "SAR" : "EGP";
  const timezone = input.country === "SA" ? "Asia/Riyadh" : "Africa/Cairo";
  const [row] = await db
    .insert(tenants)
    .values({ currency, timezone, ...input })
    .returning();
  return row;
}

/** Extracts the subdomain slug from a host, or null if it's the root / reserved host. */
export function subdomainFromHost(host: string, rootDomain: string): string | null {
  const h = host.split(":")[0].toLowerCase();
  if (h === rootDomain) return null;
  if (!h.endsWith(`.${rootDomain}`)) return null;
  const sub = h.slice(0, -(`.${rootDomain}`.length));
  if (!sub || sub.includes(".") || RESERVED.has(sub)) return null;
  return sub;
}

export async function resolveTenantByHost(host: string, rootDomain: string): Promise<Tenant | null> {
  const slug = subdomainFromHost(host, rootDomain);
  if (!slug) return null;
  const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return row ?? null;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return row ?? null;
}
```

- [ ] **Step 4: Create the public barrel `src/server/tenancy/index.ts`**

```typescript
export { tenants, tenantSettings, tenantStatus, type Tenant, type NewTenant } from "./schema";
export {
  createTenant,
  resolveTenantByHost,
  subdomainFromHost,
  getTenantBySlug,
} from "./service";
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npx vitest run src/server/tenancy/service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tenancy): resolve tenants by host with reserved-subdomain handling"
```

---

### Task 7: Host-based middleware routing

**Files:**
- Create: `src/middleware.ts`
- Create: `src/middleware-routing.ts` (pure logic, unit-tested), `src/middleware-routing.test.ts`

> Next.js middleware runs on the edge and is awkward to unit-test directly. We extract the pure decision into `classifyHost()` and test that; `middleware.ts` is a thin adapter.

- [ ] **Step 1: Write the failing test `src/middleware-routing.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { classifyHost } from "./middleware-routing";

const root = "serveos.localhost";

describe("classifyHost", () => {
  it("routes app host to dashboard", () => {
    expect(classifyHost("app.serveos.localhost", root)).toEqual({ surface: "dashboard" });
  });
  it("routes admin host to admin", () => {
    expect(classifyHost("admin.serveos.localhost", root)).toEqual({ surface: "admin" });
  });
  it("routes a subdomain to storefront with the slug", () => {
    expect(classifyHost("roma.serveos.localhost", root)).toEqual({ surface: "storefront", slug: "roma" });
  });
  it("routes the bare root to marketing", () => {
    expect(classifyHost("serveos.localhost", root)).toEqual({ surface: "marketing" });
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/middleware-routing.test.ts`
Expected: FAIL — `./middleware-routing` not found.

- [ ] **Step 3: Implement `src/middleware-routing.ts`**

```typescript
export type HostClass =
  | { surface: "dashboard" }
  | { surface: "admin" }
  | { surface: "marketing" }
  | { surface: "storefront"; slug: string };

export function classifyHost(host: string, rootDomain: string): HostClass {
  const h = host.split(":")[0].toLowerCase();
  if (h === `app.${rootDomain}`) return { surface: "dashboard" };
  if (h === `admin.${rootDomain}`) return { surface: "admin" };
  if (h === rootDomain) return { surface: "marketing" };
  const sub = h.endsWith(`.${rootDomain}`) ? h.slice(0, -(`.${rootDomain}`.length)) : null;
  if (sub && !sub.includes(".")) return { surface: "storefront", slug: sub };
  return { surface: "marketing" };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/middleware-routing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement `src/middleware.ts` (thin adapter; rewrites to route groups)**

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { classifyHost } from "./middleware-routing";

export function middleware(req: NextRequest) {
  const root = process.env.ROOT_DOMAIN ?? "serveos.localhost";
  const host = req.headers.get("host") ?? root;
  const cls = classifyHost(host, root);
  const url = req.nextUrl.clone();

  if (cls.surface === "storefront") {
    const res = NextResponse.next();
    res.headers.set("x-tenant-slug", cls.slug);
    res.headers.set("x-surface", "storefront");
    return res;
  }
  const res = NextResponse.next();
  res.headers.set("x-surface", cls.surface);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js).*)"],
};
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: compiles; middleware detected.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(routing): classify hosts into surfaces via middleware"
```

---

# Phase 2 — Auth & RBAC

### Task 8: Identity schema (`users`, `sessions`, `roles`, `user_roles`)

**Files:**
- Create: `src/server/auth/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `src/server/auth/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/auth/schema.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users } from "./schema";

describe("users schema", () => {
  it("allows the same email across different tenants but not within one", async () => {
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A", country: "EG" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "b", name: "B", country: "EG" }).returning();
    await db.insert(users).values({ tenantId: a.id, name: "Owner", email: "o@x.com" });
    await db.insert(users).values({ tenantId: b.id, name: "Owner", email: "o@x.com" }); // ok
    await expect(
      db.insert(users).values({ tenantId: a.id, name: "Dup", email: "o@x.com" }),
    ).rejects.toThrow();
  });

  it("permits a platform super-admin with null tenant", async () => {
    const [u] = await db.insert(users).values({ tenantId: null, name: "Root", email: "root@serveos.com" }).returning();
    expect(u.tenantId).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/auth/schema.test.ts`
Expected: FAIL — `./schema` not found.

- [ ] **Step 3: Implement `src/server/auth/schema.ts`**

```typescript
import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }), // null = super-admin
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    passwordHash: text("password_hash"),
    locale: text("locale").notNull().default("ar"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailPerTenant: uniqueIndex("users_email_per_tenant").on(t.tenantId, t.email),
    phonePerTenant: uniqueIndex("users_phone_per_tenant").on(t.tenantId, t.phone),
  }),
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // opaque random token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }), // null = platform role
  key: text("key").notNull(), // owner | manager | staff | super_admin
  name: text("name").notNull(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: uniqueIndex("user_roles_pk").on(t.userId, t.roleId) }),
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Role = typeof roles.$inferSelect;
```

- [ ] **Step 4: Wire into `src/db/schema.ts`**

Append:
```typescript
export * from "@/server/auth/schema";
```

- [ ] **Step 5: Generate + apply migration**

```bash
npm run db:generate
DATABASE_URL=postgres://serveos:serveos@localhost:5432/serveos_test npm run db:migrate
```

- [ ] **Step 6: Run test — expect pass**

Run: `npx vitest run src/server/auth/schema.test.ts`
Expected: PASS (2 tests).

> Note: `users`, `roles`, `user_roles` are intentionally **not** RLS-scoped at the DB level — auth runs before a tenant context exists (login must look up a user by email across the request's resolved tenant). Tenant scoping for these is enforced in the service layer by always filtering on `tenantId`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): add users, sessions, roles, and user_roles schema"
```

---

### Task 9: Password hashing (scrypt)

**Files:**
- Create: `src/server/auth/password.ts`, `src/server/auth/password.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("s3cret!");
    expect(await verifyPassword("s3cret!", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    expect(await hashPassword("x")).not.toBe(await hashPassword("x"));
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/auth/password.test.ts`
Expected: FAIL — `./password` not found.

- [ ] **Step 3: Implement `src/server/auth/password.ts`**

```typescript
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  const keyBuf = Buffer.from(key, "hex");
  return keyBuf.length === derived.length && timingSafeEqual(keyBuf, derived);
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/server/auth/password.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(auth): add scrypt password hashing"
```

---

### Task 10: Session management

**Files:**
- Create: `src/server/auth/session.ts`, `src/server/auth/session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { users } from "./schema";
import { createSession, validateSession, invalidateSession } from "./session";

describe("session", () => {
  it("creates and validates a session, then invalidates it", async () => {
    const [u] = await db.insert(users).values({ tenantId: null, name: "Root", email: "r@x.com" }).returning();
    const token = await createSession(u.id, "vitest");
    const v = await validateSession(token);
    expect(v?.user.id).toBe(u.id);
    await invalidateSession(token);
    expect(await validateSession(token)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const [u] = await db.insert(users).values({ tenantId: null, name: "Root", email: "r@x.com" }).returning();
    const token = await createSession(u.id, "vitest", new Date(Date.now() - 1000));
    expect(await validateSession(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/auth/session.test.ts`
Expected: FAIL — `./session` not found.

- [ ] **Step 3: Implement `src/server/auth/session.ts`**

```typescript
import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db/client";
import { sessions, users, type User } from "./schema";

const THIRTY_DAYS = 1000 * 60 * 60 * 24 * 30;

export async function createSession(userId: string, userAgent?: string, expiresAt?: Date): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({
    id: token,
    userId,
    userAgent,
    expiresAt: expiresAt ?? new Date(Date.now() + THIRTY_DAYS),
  });
  return token;
}

export async function validateSession(token: string): Promise<{ user: User } | null> {
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ? { user: row.user } : null;
}

export async function invalidateSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, token));
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/server/auth/session.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(auth): add token sessions with expiry validation"
```

---

### Task 11: RBAC permission catalog + `authorize`

**Files:**
- Create: `src/server/rbac/permissions.ts`, `src/server/rbac/authorize.ts`, `src/server/rbac/index.ts`
- Create: `src/server/rbac/authorize.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { can } from "./authorize";

describe("RBAC can()", () => {
  it("owner has tenant management", () => {
    expect(can(["owner"], "tenant:manage")).toBe(true);
  });
  it("staff cannot manage billing", () => {
    expect(can(["staff"], "billing:manage")).toBe(false);
  });
  it("super_admin can approve tenants", () => {
    expect(can(["super_admin"], "platform:approve_tenant")).toBe(true);
  });
  it("a tenant role cannot use platform permissions", () => {
    expect(can(["owner"], "platform:approve_tenant")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/rbac/authorize.test.ts`
Expected: FAIL — `./authorize` not found.

- [ ] **Step 3: Implement `src/server/rbac/permissions.ts`**

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
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RoleKey = "owner" | "manager" | "staff" | "super_admin";

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: ["tenant:manage", "staff:invite", "plan:view", "plan:change", "billing:manage"],
  manager: ["staff:invite", "plan:view"],
  staff: ["plan:view"],
  super_admin: ["platform:approve_tenant", "platform:suspend_tenant", "platform:view_revenue"],
};
```

- [ ] **Step 4: Implement `src/server/rbac/authorize.ts`**

```typescript
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
```

- [ ] **Step 5: Implement `src/server/rbac/index.ts`**

```typescript
export { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type RoleKey } from "./permissions";
export { can, authorize, UnauthorizedError } from "./authorize";
```

- [ ] **Step 6: Run — expect pass**

Run: `npx vitest run src/server/rbac/authorize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(rbac): add permission catalog and authorize helper"
```

---

### Task 12: OTP provider seam (no-op for dev)

**Files:**
- Create: `src/server/auth/otp.ts`, `src/server/auth/otp.test.ts`, `src/server/auth/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { NoopOtpProvider } from "./otp";

describe("NoopOtpProvider", () => {
  it("records the code it 'sent' so tests/dev can read it", async () => {
    const p = new NoopOtpProvider();
    await p.send("+201000000000", "123456");
    expect(p.lastSent).toEqual({ to: "+201000000000", code: "123456" });
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/auth/otp.test.ts`
Expected: FAIL — `./otp` not found.

- [ ] **Step 3: Implement `src/server/auth/otp.ts`**

```typescript
export interface OtpProvider {
  send(to: string, code: string): Promise<void>;
}

/** Dev/test provider — does not actually deliver; later replaced by WhatsApp/SMS. */
export class NoopOtpProvider implements OtpProvider {
  lastSent: { to: string; code: string } | null = null;
  async send(to: string, code: string): Promise<void> {
    this.lastSent = { to, code };
  }
}
```

- [ ] **Step 4: Create `src/server/auth/index.ts`**

```typescript
export { users, sessions, roles, userRoles, type User, type Session, type Role } from "./schema";
export { hashPassword, verifyPassword } from "./password";
export { createSession, validateSession, invalidateSession } from "./session";
export { type OtpProvider, NoopOtpProvider } from "./otp";
```

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run src/server/auth/otp.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): add OtpProvider interface with noop dev provider"
```

---

# Phase 3 — Plans, Subscriptions & Entitlements

### Task 13: Plans, subscriptions, usage_counters, invoices schema

**Files:**
- Create: `src/server/subscription/schema.ts`, `src/server/billing/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `src/server/subscription/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/subscription/schema.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { plans } from "./schema";

describe("plans schema", () => {
  it("stores limits and features as JSON", async () => {
    const [p] = await db
      .insert(plans)
      .values({
        key: "basic",
        name: "Basic",
        priceMonthly: "0",
        currency: "EGP",
        limits: { branches: 1, staff: 2, products: 50, whatsapp_numbers: 1, orders_per_month: 200, messages_per_month: 0 },
        features: { whatsapp: false, custom_domain: false, custom_theme: false, reservations: false, advanced_analytics: false },
      })
      .returning();
    expect(p.limits.branches).toBe(1);
    expect(p.features.whatsapp).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/subscription/schema.test.ts`
Expected: FAIL — `./schema` not found.

- [ ] **Step 3: Implement `src/server/subscription/schema.ts`**

```typescript
import { pgTable, uuid, text, timestamp, numeric, integer, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

export type PlanLimits = {
  branches: number;
  staff: number;
  products: number;
  whatsapp_numbers: number;
  orders_per_month: number;
  messages_per_month: number;
};
export type PlanFeatures = {
  whatsapp: boolean;
  custom_domain: boolean;
  custom_theme: boolean;
  reservations: boolean;
  advanced_analytics: boolean;
};

export const plans = pgTable("plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  priceMonthly: numeric("price_monthly").notNull().default("0"),
  currency: text("currency").notNull().default("EGP"),
  isActive: text("is_active").notNull().default("true"),
  limits: jsonb("limits").$type<PlanLimits>().notNull(),
  features: jsonb("features").$type<PlanFeatures>().notNull(),
});

export const subscriptionStatus = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "suspended",
  "canceled",
]);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id),
  status: subscriptionStatus("status").notNull().default("trialing"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  provider: text("provider").notNull().default("manual"),
});

export const usageCounters = pgTable("usage_counters", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(), // "orders" | "messages"
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
});

export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
```

- [ ] **Step 4: Implement `src/server/billing/schema.ts`**

```typescript
import { pgTable, uuid, text, timestamp, numeric, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { subscriptions } from "@/server/subscription/schema";
import { users } from "@/server/auth/schema";

export const invoiceStatus = pgEnum("invoice_status", ["open", "paid", "void"]);

export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  amount: numeric("amount").notNull(),
  currency: text("currency").notNull(),
  status: invoiceStatus("status").notNull().default("open"),
  method: text("method"), // bank | cash | manual
  markedBy: uuid("marked_by").references(() => users.id),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Invoice = typeof invoices.$inferSelect;
```

- [ ] **Step 5: Wire into `src/db/schema.ts`**

Append:
```typescript
export * from "@/server/subscription/schema";
export * from "@/server/billing/schema";
```

- [ ] **Step 6: Generate + apply migration, run test**

```bash
npm run db:generate
DATABASE_URL=postgres://serveos:serveos@localhost:5432/serveos_test npm run db:migrate
npx vitest run src/server/subscription/schema.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(subscription): add plans, subscriptions, usage_counters, invoices"
```

---

### Task 14: Default plans seed (Basic / Pro / Enterprise)

**Files:**
- Create: `src/server/subscription/plans.seed.ts`, `src/server/subscription/plans.seed.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { plans } from "./schema";
import { seedDefaultPlans, DEFAULT_PLANS } from "./plans.seed";

describe("seedDefaultPlans", () => {
  it("is idempotent and inserts the three tiers", async () => {
    await seedDefaultPlans();
    await seedDefaultPlans(); // second run must not duplicate
    const rows = await db.select().from(plans);
    expect(rows).toHaveLength(DEFAULT_PLANS.length);
    expect(rows.map((r) => r.key).sort()).toEqual(["basic", "enterprise", "pro"]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/subscription/plans.seed.test.ts`
Expected: FAIL — `./plans.seed` not found.

- [ ] **Step 3: Implement `src/server/subscription/plans.seed.ts`**

```typescript
import { db } from "@/db/client";
import { plans, type PlanLimits, type PlanFeatures } from "./schema";
import { sql } from "drizzle-orm";

type Seed = { key: string; name: string; priceMonthly: string; limits: PlanLimits; features: PlanFeatures };

export const DEFAULT_PLANS: Seed[] = [
  {
    key: "basic",
    name: "Basic",
    priceMonthly: "0",
    limits: { branches: 1, staff: 2, products: 50, whatsapp_numbers: 0, orders_per_month: 200, messages_per_month: 0 },
    features: { whatsapp: false, custom_domain: false, custom_theme: false, reservations: false, advanced_analytics: false },
  },
  {
    key: "pro",
    name: "Pro",
    priceMonthly: "499",
    limits: { branches: 3, staff: 10, products: 500, whatsapp_numbers: 1, orders_per_month: 2000, messages_per_month: 5000 },
    features: { whatsapp: true, custom_domain: false, custom_theme: true, reservations: true, advanced_analytics: false },
  },
  {
    key: "enterprise",
    name: "Enterprise",
    priceMonthly: "1499",
    limits: { branches: 50, staff: 200, products: 100000, whatsapp_numbers: 10, orders_per_month: 100000, messages_per_month: 100000 },
    features: { whatsapp: true, custom_domain: true, custom_theme: true, reservations: true, advanced_analytics: true },
  },
];

export async function seedDefaultPlans(): Promise<void> {
  for (const p of DEFAULT_PLANS) {
    await db
      .insert(plans)
      .values({ key: p.key, name: p.name, priceMonthly: p.priceMonthly, currency: "EGP", limits: p.limits, features: p.features })
      .onConflictDoUpdate({
        target: plans.key,
        set: { name: p.name, priceMonthly: p.priceMonthly, limits: p.limits, features: p.features },
      });
  }
  void sql; // keep import used if refactored
}
```
Then remove the unused `sql` import line if `tsc` complains. (Simpler: delete the `import { sql }` line and the `void sql;` line.)

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/server/subscription/plans.seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(subscription): seed Basic/Pro/Enterprise default plans"
```

---

### Task 15: Subscription state machine + service

**Files:**
- Create: `src/server/subscription/service.ts`, `src/server/subscription/index.ts`
- Create: `src/server/subscription/service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "./plans.seed";
import { startTrial, transition, getActiveSubscription } from "./service";

async function tenant() {
  const [t] = await db.insert(tenants).values({ slug: "t", name: "T", country: "EG" }).returning();
  return t;
}

describe("subscription service", () => {
  it("starts a 14-day trial on the basic plan", async () => {
    await seedDefaultPlans();
    const t = await tenant();
    const sub = await startTrial(t.id, "basic");
    expect(sub.status).toBe("trialing");
    expect(sub.trialEndsAt).toBeInstanceOf(Date);
  });

  it("allows trialing -> active but rejects active -> trialing", async () => {
    await seedDefaultPlans();
    const t = await tenant();
    const sub = await startTrial(t.id, "basic");
    const active = await transition(sub.id, "active");
    expect(active.status).toBe("active");
    await expect(transition(sub.id, "trialing")).rejects.toThrow(/invalid transition/i);
  });

  it("returns the active subscription for a tenant", async () => {
    await seedDefaultPlans();
    const t = await tenant();
    await startTrial(t.id, "basic");
    expect((await getActiveSubscription(t.id))?.tenantId).toBe(t.id);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/subscription/service.test.ts`
Expected: FAIL — `./service` not found.

- [ ] **Step 3: Implement `src/server/subscription/service.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plans, subscriptions, type Subscription } from "./schema";

const TRIAL_DAYS = 14;

type Status = Subscription["status"];

const ALLOWED: Record<Status, Status[]> = {
  trialing: ["active", "past_due", "canceled"],
  active: ["past_due", "canceled"],
  past_due: ["active", "suspended", "canceled"],
  suspended: ["active", "canceled"],
  canceled: [],
};

export async function startTrial(tenantId: string, planKey: string): Promise<Subscription> {
  const [plan] = await db.select().from(plans).where(eq(plans.key, planKey)).limit(1);
  if (!plan) throw new Error(`Unknown plan: ${planKey}`);
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const [sub] = await db
    .insert(subscriptions)
    .values({ tenantId, planId: plan.id, status: "trialing", trialEndsAt })
    .returning();
  return sub;
}

export async function transition(subscriptionId: string, next: Status): Promise<Subscription> {
  const [current] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
  if (!current) throw new Error("Subscription not found");
  if (!ALLOWED[current.status].includes(next)) {
    throw new Error(`Invalid transition: ${current.status} -> ${next}`);
  }
  const [updated] = await db
    .update(subscriptions)
    .set({ status: next })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  return updated;
}

export async function getActiveSubscription(tenantId: string): Promise<Subscription | null> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  return sub ?? null;
}

export async function getPlanForTenant(tenantId: string) {
  const [row] = await db
    .select({ plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  return row?.plan ?? null;
}
```

- [ ] **Step 4: Create `src/server/subscription/index.ts`**

```typescript
export {
  plans,
  subscriptions,
  usageCounters,
  type Plan,
  type Subscription,
  type PlanLimits,
  type PlanFeatures,
} from "./schema";
export { startTrial, transition, getActiveSubscription, getPlanForTenant } from "./service";
export { seedDefaultPlans, DEFAULT_PLANS } from "./plans.seed";
```

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run src/server/subscription/service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(subscription): add trial start and guarded status transitions"
```

---

### Task 16: Entitlements — quotas, feature flags, usage (the single gate)

**Files:**
- Create: `src/shared/errors.ts`, `src/server/entitlements/errors.ts`, `src/server/entitlements/service.ts`, `src/server/entitlements/index.ts`
- Create: `src/server/entitlements/service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { usageCounters } from "@/server/subscription/schema";
import { seedDefaultPlans, startTrial } from "@/server/subscription";
import { checkQuota, hasFeature, checkUsage } from "./service";
import { QuotaExceededError, FeatureNotAvailableError } from "./errors";

async function basicTenant() {
  await seedDefaultPlans();
  const [t] = await db.insert(tenants).values({ slug: "t", name: "T", country: "EG" }).returning();
  await startTrial(t.id, "basic");
  return t;
}

describe("entitlements", () => {
  it("allows a quota under the limit and throws over it", async () => {
    const t = await basicTenant(); // basic: branches = 1
    await expect(checkQuota(t.id, "branches", 0)).resolves.toBeUndefined();
    await expect(checkQuota(t.id, "branches", 1)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("reports feature flags from the plan", async () => {
    const t = await basicTenant();
    expect(await hasFeature(t.id, "whatsapp")).toBe(false);
    await expect(
      (async () => {
        if (!(await hasFeature(t.id, "whatsapp"))) throw new FeatureNotAvailableError("whatsapp");
      })(),
    ).rejects.toBeInstanceOf(FeatureNotAvailableError);
  });

  it("enforces monthly usage caps", async () => {
    const t = await basicTenant(); // orders_per_month = 200
    await db.insert(usageCounters).values({
      tenantId: t.id,
      metric: "orders",
      periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      count: 200,
    });
    await expect(checkUsage(t.id, "orders")).rejects.toBeInstanceOf(QuotaExceededError);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/entitlements/service.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/shared/errors.ts`**

```typescript
export type Locale = "en" | "ar";

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract messageFor(locale: Locale): string;
}
```

- [ ] **Step 4: Implement `src/server/entitlements/errors.ts`**

```typescript
import { DomainError, type Locale } from "@/shared/errors";

export class QuotaExceededError extends DomainError {
  readonly code = "quota_exceeded";
  constructor(public resource: string, public limit: number, public current: number) {
    super(`Quota exceeded for ${resource} (${current}/${limit})`);
    this.name = "QuotaExceededError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? `لقد وصلت إلى الحد الأقصى لـ ${this.resource}. يرجى ترقية باقتك.`
      : `You've reached your ${this.resource} limit. Please upgrade your plan.`;
  }
}

export class FeatureNotAvailableError extends DomainError {
  readonly code = "feature_unavailable";
  constructor(public feature: string) {
    super(`Feature not available: ${feature}`);
    this.name = "FeatureNotAvailableError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? `هذه الميزة (${this.feature}) غير متاحة في باقتك الحالية.`
      : `The ${this.feature} feature isn't available on your current plan.`;
  }
}
```

- [ ] **Step 5: Implement `src/server/entitlements/service.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { usageCounters } from "@/server/subscription/schema";
import { getPlanForTenant } from "@/server/subscription/service";
import type { PlanLimits, PlanFeatures } from "@/server/subscription/schema";
import { QuotaExceededError, FeatureNotAvailableError } from "./errors";

async function planOrThrow(tenantId: string) {
  const plan = await getPlanForTenant(tenantId);
  if (!plan) throw new Error(`No plan for tenant ${tenantId}`);
  return plan;
}

/** Throws QuotaExceededError if adding one more would exceed the plan limit. */
export async function checkQuota(tenantId: string, resource: keyof PlanLimits, currentCount: number): Promise<void> {
  const plan = await planOrThrow(tenantId);
  const limit = plan.limits[resource];
  if (currentCount >= limit) throw new QuotaExceededError(resource, limit, currentCount);
}

export async function hasFeature(tenantId: string, feature: keyof PlanFeatures): Promise<boolean> {
  const plan = await planOrThrow(tenantId);
  return Boolean(plan.features[feature]);
}

export async function requireFeature(tenantId: string, feature: keyof PlanFeatures): Promise<void> {
  if (!(await hasFeature(tenantId, feature))) throw new FeatureNotAvailableError(feature);
}

const METRIC_LIMIT: Record<string, keyof PlanLimits> = {
  orders: "orders_per_month",
  messages: "messages_per_month",
};

export async function checkUsage(tenantId: string, metric: "orders" | "messages"): Promise<void> {
  const plan = await planOrThrow(tenantId);
  const limit = plan.limits[METRIC_LIMIT[metric]];
  const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.metric, metric)))
    .limit(1);
  const used = row?.count ?? 0;
  void periodStart;
  if (used >= limit) throw new QuotaExceededError(metric, limit, used);
}
```

- [ ] **Step 6: Implement `src/server/entitlements/index.ts`**

```typescript
export { checkQuota, hasFeature, requireFeature, checkUsage } from "./service";
export { QuotaExceededError, FeatureNotAvailableError } from "./errors";
```

- [ ] **Step 7: Run — expect pass**

Run: `npx vitest run src/server/entitlements/service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(entitlements): add quota, feature, and usage gates with localized errors"
```

---

# Phase 4 — Billing (manual provider)

### Task 17: BillingProvider interface + ManualBillingProvider

**Files:**
- Create: `src/server/billing/provider.ts`, `src/server/billing/manual-provider.ts`, `src/server/billing/index.ts`
- Create: `src/server/billing/manual-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans, startTrial, getActiveSubscription } from "@/server/subscription";
import { invoices } from "./schema";
import { ManualBillingProvider } from "./manual-provider";
import { eq } from "drizzle-orm";

async function setup() {
  await seedDefaultPlans();
  const [t] = await db.insert(tenants).values({ slug: "t", name: "T", country: "EG" }).returning();
  await startTrial(t.id, "pro");
  const sub = (await getActiveSubscription(t.id))!;
  return { t, sub };
}

describe("ManualBillingProvider", () => {
  it("creates an open invoice then settles it as paid", async () => {
    const { t, sub } = await setup();
    const provider = new ManualBillingProvider();
    const inv = await provider.createInvoice({ tenantId: t.id, subscriptionId: sub.id, amount: "499", currency: "EGP" });
    expect(inv.status).toBe("open");

    const paid = await provider.settleInvoice(inv.id, "bank", "admin-user-id");
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).toBeInstanceOf(Date);

    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.method).toBe("bank");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/billing/manual-provider.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/server/billing/provider.ts`**

```typescript
import type { Invoice } from "./schema";

export type CreateInvoiceInput = {
  tenantId: string;
  subscriptionId: string;
  amount: string;
  currency: string;
};

export interface BillingProvider {
  readonly name: string;
  createInvoice(input: CreateInvoiceInput): Promise<Invoice>;
  settleInvoice(invoiceId: string, method: string, markedBy?: string): Promise<Invoice>;
}
```

- [ ] **Step 4: Implement `src/server/billing/manual-provider.ts`**

```typescript
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { invoices, type Invoice } from "./schema";
import type { BillingProvider, CreateInvoiceInput } from "./provider";

export class ManualBillingProvider implements BillingProvider {
  readonly name = "manual";

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    const [inv] = await db
      .insert(invoices)
      .values({
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        amount: input.amount,
        currency: input.currency,
        status: "open",
      })
      .returning();
    return inv;
  }

  async settleInvoice(invoiceId: string, method: string, markedBy?: string): Promise<Invoice> {
    const [inv] = await db
      .update(invoices)
      .set({ status: "paid", method, markedBy, paidAt: new Date() })
      .where(eq(invoices.id, invoiceId))
      .returning();
    if (!inv) throw new Error("Invoice not found");
    return inv;
  }
}
```

- [ ] **Step 5: Implement `src/server/billing/index.ts`**

```typescript
export { invoices, type Invoice } from "./schema";
export { type BillingProvider, type CreateInvoiceInput } from "./provider";
export { ManualBillingProvider } from "./manual-provider";
```

- [ ] **Step 6: Run — expect pass**

Run: `npx vitest run src/server/billing/manual-provider.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(billing): add BillingProvider interface and ManualBillingProvider"
```

---

# Phase 5 — Onboarding & Admin Approval

### Task 18: Onboarding + audit schema

**Files:**
- Create: `src/server/onboarding/schema.ts`
- Create: `src/server/platform/audit.schema.ts`
- Modify: `src/db/schema.ts`
- Create: `src/server/onboarding/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/onboarding/schema.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/onboarding/schema.test.ts`
Expected: FAIL — `./schema` not found.

- [ ] **Step 3: Implement `src/server/onboarding/schema.ts`**

```typescript
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
```

- [ ] **Step 4: Implement `src/server/platform/audit.schema.ts`**

```typescript
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
```

- [ ] **Step 5: Wire into `src/db/schema.ts`**

Append:
```typescript
export * from "@/server/onboarding/schema";
export * from "@/server/platform/audit.schema";
```

- [ ] **Step 6: Generate + apply migration, run test**

```bash
npm run db:generate
DATABASE_URL=postgres://serveos:serveos@localhost:5432/serveos_test npm run db:migrate
npx vitest run src/server/onboarding/schema.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(onboarding): add onboarding_applications and audit_logs tables"
```

---

### Task 19: Registration flow (tenant + owner + trial + application)

**Files:**
- Create: `src/server/onboarding/service.ts`, `src/server/onboarding/index.ts`
- Create: `src/server/onboarding/service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { onboardingApplications } from "./schema";
import { seedDefaultPlans } from "@/server/subscription";
import { getActiveSubscription } from "@/server/subscription";
import { registerRestaurant } from "./service";
import { eq } from "drizzle-orm";

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
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/onboarding/service.test.ts`
Expected: FAIL — `./service` not found.

- [ ] **Step 3: Implement `src/server/onboarding/service.ts`**

```typescript
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { plans, subscriptions } from "@/server/subscription/schema";
import { onboardingApplications } from "./schema";
import { eq } from "drizzle-orm";

export type RegisterInput = {
  restaurantName: string;
  slug: string;
  country: "EG" | "SA";
  ownerName: string;
  email: string;
  password: string;
};

export type RegisterResult = { tenantId: string; ownerUserId: string };

const TRIAL_DAYS = 14;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export async function registerRestaurant(input: RegisterInput): Promise<RegisterResult> {
  if (!SLUG_RE.test(input.slug)) throw new Error("Invalid slug");

  return db.transaction(async (tx) => {
    const currency = input.country === "SA" ? "SAR" : "EGP";
    const timezone = input.country === "SA" ? "Asia/Riyadh" : "Africa/Cairo";

    const [tenant] = await tx
      .insert(tenants)
      .values({ slug: input.slug, name: input.restaurantName, country: input.country, currency, timezone, status: "onboarding" })
      .returning();

    const passwordHash = await hashPassword(input.password);
    const [owner] = await tx
      .insert(users)
      .values({ tenantId: tenant.id, name: input.ownerName, email: input.email, passwordHash })
      .returning();

    const [ownerRole] = await tx
      .insert(roles)
      .values({ tenantId: tenant.id, key: "owner", name: "Owner" })
      .returning();
    await tx.insert(userRoles).values({ userId: owner.id, roleId: ownerRole.id });

    const [basic] = await tx.select().from(plans).where(eq(plans.key, "basic")).limit(1);
    if (!basic) throw new Error("Default plans not seeded");
    await tx.insert(subscriptions).values({
      tenantId: tenant.id,
      planId: basic.id,
      status: "trialing",
      trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
    });

    await tx.insert(onboardingApplications).values({ tenantId: tenant.id });

    return { tenantId: tenant.id, ownerUserId: owner.id };
  });
}
```

- [ ] **Step 4: Create `src/server/onboarding/index.ts`**

```typescript
export { onboardingApplications, applicationStatus, type OnboardingApplication } from "./schema";
export { registerRestaurant, type RegisterInput, type RegisterResult } from "./service";
```

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run src/server/onboarding/service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(onboarding): transactional restaurant registration with trial"
```

---

### Task 20: Admin approval/rejection with audit logging

**Files:**
- Create: `src/server/platform/service.ts`, `src/server/platform/index.ts`
- Create: `src/server/platform/service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "@/server/onboarding/schema";
import { auditLogs } from "./audit.schema";
import { seedDefaultPlans, registerRestaurant } from "@/server/onboarding";
import { listPendingApplications, approveTenant, rejectTenant } from "./service";
import { eq } from "drizzle-orm";

async function admin() {
  const [a] = await db.insert(users).values({ tenantId: null, name: "Root", email: "root@serveos.com" }).returning();
  return a;
}

describe("platform approval", () => {
  it("approves a tenant, activates it, and writes an audit log", async () => {
    await seedDefaultPlans();
    const a = await admin();
    const { tenantId } = await registerRestaurant({ restaurantName: "R", slug: "r", country: "EG", ownerName: "O", email: "o@r.com", password: "x" });

    const pending = await listPendingApplications();
    expect(pending).toHaveLength(1);

    await approveTenant(tenantId, a.id);

    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t.status).toBe("active");
    const [app] = await db.select().from(onboardingApplications).where(eq(onboardingApplications.tenantId, tenantId));
    expect(app.status).toBe("approved");
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    expect(logs.map((l) => l.action)).toContain("tenant.approved");
  });

  it("rejects a tenant with notes", async () => {
    await seedDefaultPlans();
    const a = await admin();
    const { tenantId } = await registerRestaurant({ restaurantName: "R", slug: "r2", country: "EG", ownerName: "O", email: "o2@r.com", password: "x" });
    await rejectTenant(tenantId, a.id, "Incomplete details");
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t.status).toBe("rejected");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/platform/service.test.ts`
Expected: FAIL — `./service` not found.

- [ ] **Step 3: Implement `src/server/platform/service.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "@/server/onboarding/schema";
import { auditLogs } from "./audit.schema";

export async function listPendingApplications() {
  return db
    .select({
      applicationId: onboardingApplications.id,
      tenantId: tenants.id,
      tenantName: tenants.name,
      slug: tenants.slug,
      submittedAt: onboardingApplications.submittedAt,
    })
    .from(onboardingApplications)
    .innerJoin(tenants, eq(tenants.id, onboardingApplications.tenantId))
    .where(eq(onboardingApplications.status, "pending"));
}

export async function approveTenant(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId));
    await tx
      .update(onboardingApplications)
      .set({ status: "approved", reviewedBy: adminUserId })
      .where(eq(onboardingApplications.tenantId, tenantId));
    await tx.insert(auditLogs).values({
      tenantId,
      actorUserId: adminUserId,
      action: "tenant.approved",
      target: tenantId,
    });
  });
}

export async function rejectTenant(tenantId: string, adminUserId: string, notes: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(tenants).set({ status: "rejected" }).where(eq(tenants.id, tenantId));
    await tx
      .update(onboardingApplications)
      .set({ status: "rejected", reviewedBy: adminUserId, reviewNotes: notes })
      .where(eq(onboardingApplications.tenantId, tenantId));
    await tx.insert(auditLogs).values({
      tenantId,
      actorUserId: adminUserId,
      action: "tenant.rejected",
      target: tenantId,
      metadata: { notes },
    });
  });
}

export async function suspendTenant(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantId));
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action: "tenant.suspended", target: tenantId });
  });
  void and;
}
```
If `tsc` flags the unused `and` import, delete the `import`'s `and,` and the `void and;` line.

- [ ] **Step 4: Create `src/server/platform/index.ts`**

```typescript
export { auditLogs, type AuditLog } from "./audit.schema";
export { listPendingApplications, approveTenant, rejectTenant, suspendTenant } from "./service";
```

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run src/server/platform/service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(platform): add tenant approval/rejection with audit logging"
```

---

# Phase 6 — Surfaces, PWA & End-to-End

### Task 21: Dynamic per-tenant PWA manifest

**Files:**
- Create: `src/app/manifest.webmanifest/route.ts`
- Create: `src/server/tenancy/manifest.ts`, `src/server/tenancy/manifest.test.ts`

> The route reads the tenant from the `x-tenant-slug` header set by middleware and emits a branded manifest. We unit-test the pure builder.

- [ ] **Step 1: Write the failing test `src/server/tenancy/manifest.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { buildManifest } from "./manifest";

describe("buildManifest", () => {
  it("uses the tenant's name and brand color", () => {
    const m = buildManifest({ name: "Pizza Roma", primaryColor: "#E11D48", slug: "roma" });
    expect(m.name).toBe("Pizza Roma");
    expect(m.theme_color).toBe("#E11D48");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.icons.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/tenancy/manifest.test.ts`
Expected: FAIL — `./manifest` not found.

- [ ] **Step 3: Implement `src/server/tenancy/manifest.ts`**

```typescript
export type ManifestInput = { name: string; primaryColor: string; slug: string };

export type WebManifest = {
  name: string;
  short_name: string;
  start_url: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string }[];
};

export function buildManifest(input: ManifestInput): WebManifest {
  return {
    name: input.name,
    short_name: input.name.slice(0, 12),
    start_url: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: input.primaryColor,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
```

- [ ] **Step 4: Implement the route `src/app/manifest.webmanifest/route.ts`**

```typescript
import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";
import { buildManifest } from "@/server/tenancy/manifest";

export async function GET() {
  const slug = (await headers()).get("x-tenant-slug");
  const tenant = slug ? await getTenantBySlug(slug) : null;
  const manifest = tenant
    ? buildManifest({ name: tenant.name, primaryColor: tenant.primaryColor, slug: tenant.slug })
    : buildManifest({ name: "ServeOS", primaryColor: "#0F172A", slug: "serveos" });

  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
```

- [ ] **Step 5: Run unit test — expect pass; build to confirm route**

```bash
npx vitest run src/server/tenancy/manifest.test.ts
npm run build
```
Expected: test PASS; build compiles the route.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(pwa): serve a dynamic per-tenant web manifest"
```

---

### Task 22: Storefront shell + service worker + branding

**Files:**
- Create: `public/sw.js`, `src/app/(storefront)/page.tsx`, `src/app/(storefront)/layout.tsx`, `src/app/sw-register.tsx`
- Modify: `src/app/layout.tsx` (link manifest)

- [ ] **Step 1: Create the service worker `public/sw.js`**

```javascript
// Minimal install/activate SW so the storefront is installable as a PWA.
// Full offline caching strategy is added in the Ordering sub-project.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Pass-through for now; no caching yet.
});
```

- [ ] **Step 2: Create the SW registration client component `src/app/sw-register.tsx`**

```tsx
"use client";
import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
```

- [ ] **Step 3: Create the storefront layout `src/app/(storefront)/layout.tsx`**

```tsx
import type { ReactNode } from "react";
import { ServiceWorkerRegister } from "@/app/sw-register";

export default function StorefrontLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="manifest" href="/manifest.webmanifest" />
      <ServiceWorkerRegister />
      {children}
    </>
  );
}
```

- [ ] **Step 4: Create the branded storefront page `src/app/(storefront)/page.tsx`**

```tsx
import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";

export default async function StorefrontHome() {
  const slug = (await headers()).get("x-tenant-slug");
  const tenant = slug ? await getTenantBySlug(slug) : null;

  if (!tenant) {
    return <main style={{ padding: 48 }}><h1>ServeOS</h1></main>;
  }

  const published = tenant.status === "active";
  return (
    <main style={{ padding: 48, fontFamily: "system-ui", color: tenant.primaryColor }}>
      <h1>{tenant.name}</h1>
      <p>{published ? "Welcome — our menu is coming online soon." : "This restaurant is getting ready. Check back soon!"}</p>
    </main>
  );
}
```

- [ ] **Step 5: Build to confirm**

Run: `npm run build`
Expected: compiles; `(storefront)` route group present.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(storefront): branded PWA shell with service worker registration"
```

---

### Task 23: Registration & login server actions (dashboard) + auth context

**Files:**
- Create: `src/app/(dashboard)/register/page.tsx`, `src/app/(dashboard)/register/actions.ts`
- Create: `src/app/(dashboard)/login/page.tsx`, `src/app/(dashboard)/login/actions.ts`
- Create: `src/server/auth/current-user.ts`, `src/server/auth/current-user.test.ts`

- [ ] **Step 1: Write the failing test for the cookie-name constant + role loader**

```typescript
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { users, roles, userRoles } from "./schema";
import { loadUserRoleKeys, SESSION_COOKIE } from "./current-user";

describe("current-user helpers", () => {
  it("exposes a stable session cookie name", () => {
    expect(SESSION_COOKIE).toBe("serveos_session");
  });

  it("loads a user's role keys", async () => {
    const [u] = await db.insert(users).values({ tenantId: null, name: "X", email: "x@x.com" }).returning();
    const [r] = await db.insert(roles).values({ tenantId: null, key: "super_admin", name: "Super Admin" }).returning();
    await db.insert(userRoles).values({ userId: u.id, roleId: r.id });
    expect(await loadUserRoleKeys(u.id)).toEqual(["super_admin"]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/auth/current-user.test.ts`
Expected: FAIL — `./current-user` not found.

- [ ] **Step 3: Implement `src/server/auth/current-user.ts`**

```typescript
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { roles, userRoles } from "./schema";
import type { RoleKey } from "@/server/rbac";

export const SESSION_COOKIE = "serveos_session";

export async function loadUserRoleKeys(userId: string): Promise<RoleKey[]> {
  const rows = await db
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.key as RoleKey);
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/server/auth/current-user.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement the register action `src/app/(dashboard)/register/actions.ts`**

```typescript
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { registerRestaurant } from "@/server/onboarding";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function registerAction(formData: FormData) {
  const result = await registerRestaurant({
    restaurantName: String(formData.get("restaurantName")),
    slug: String(formData.get("slug")),
    country: String(formData.get("country")) === "SA" ? "SA" : "EG",
    ownerName: String(formData.get("ownerName")),
    email: String(formData.get("email")),
    password: String(formData.get("password")),
  });
  const token = await createSession(result.ownerUserId, "dashboard");
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}
```

- [ ] **Step 6: Implement the register page `src/app/(dashboard)/register/page.tsx`**

```tsx
import { registerAction } from "./actions";

export default function RegisterPage() {
  return (
    <main style={{ padding: 48, maxWidth: 420 }}>
      <h1>Create your restaurant</h1>
      <form action={registerAction} style={{ display: "grid", gap: 12 }}>
        <input name="restaurantName" placeholder="Restaurant name" required />
        <input name="slug" placeholder="subdomain (e.g. roma)" required />
        <select name="country" defaultValue="EG"><option value="EG">Egypt</option><option value="SA">Saudi Arabia</option></select>
        <input name="ownerName" placeholder="Your name" required />
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Start free trial</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 7: Implement the login action `src/app/(dashboard)/login/actions.ts`**

```typescript
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email"));
  const password = String(formData.get("password"));
  const [user] = await db.select().from(users).where(and(eq(users.email, email))).limit(1);
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    redirect("/login?error=1");
  }
  const token = await createSession(user.id, "dashboard");
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}
```

- [ ] **Step 8: Implement the login page `src/app/(dashboard)/login/page.tsx`**

```tsx
import { loginAction } from "./actions";

export default function LoginPage() {
  return (
    <main style={{ padding: 48, maxWidth: 420 }}>
      <h1>Sign in</h1>
      <form action={loginAction} style={{ display: "grid", gap: 12 }}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 9: Build to confirm everything compiles**

Run: `npm run build`
Expected: compiles. (Route groups share `/` path; ensure only one root `page.tsx` per surface — the marketing root lives in `src/app/page.tsx` from scaffolding; if Next reports a duplicate `/` route between `(dashboard)` and `(storefront)`, move the dashboard landing to `src/app/(dashboard)/dashboard/page.tsx` and keep register/login under their own paths. The middleware rewrites are header-based so path collisions are the only constraint.)

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(dashboard): registration and login flows with cookie sessions"
```

---

### Task 24: Admin approval queue UI + guard

**Files:**
- Create: `src/app/(admin)/admin/page.tsx`, `src/app/(admin)/admin/actions.ts`
- Create: `src/server/auth/require-role.ts`, `src/server/auth/require-role.test.ts`

- [ ] **Step 1: Write the failing test for the guard helper**

```typescript
import { describe, it, expect } from "vitest";
import { assertSuperAdmin } from "./require-role";

describe("assertSuperAdmin", () => {
  it("passes for super_admin", () => {
    expect(() => assertSuperAdmin(["super_admin"])).not.toThrow();
  });
  it("throws for tenant roles", () => {
    expect(() => assertSuperAdmin(["owner"])).toThrow(/forbidden/i);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/server/auth/require-role.test.ts`
Expected: FAIL — `./require-role` not found.

- [ ] **Step 3: Implement `src/server/auth/require-role.ts`**

```typescript
import type { RoleKey } from "@/server/rbac";

export function assertSuperAdmin(roleKeys: RoleKey[]): void {
  if (!roleKeys.includes("super_admin")) throw new Error("Forbidden: super admin only");
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/server/auth/require-role.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement the admin actions `src/app/(admin)/admin/actions.ts`**

```typescript
"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { validateSession } from "@/server/auth/session";
import { loadUserRoleKeys, SESSION_COOKIE } from "@/server/auth/current-user";
import { assertSuperAdmin } from "@/server/auth/require-role";
import { approveTenant, rejectTenant } from "@/server/platform";

async function currentAdmin() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;
  if (!session) throw new Error("Not signed in");
  const roleKeys = await loadUserRoleKeys(session.user.id);
  assertSuperAdmin(roleKeys);
  return session.user;
}

export async function approveAction(formData: FormData) {
  const admin = await currentAdmin();
  await approveTenant(String(formData.get("tenantId")), admin.id);
  revalidatePath("/admin");
}

export async function rejectAction(formData: FormData) {
  const admin = await currentAdmin();
  await rejectTenant(String(formData.get("tenantId")), admin.id, String(formData.get("notes") ?? ""));
  revalidatePath("/admin");
}
```

- [ ] **Step 6: Implement the admin queue page `src/app/(admin)/admin/page.tsx`**

```tsx
import { listPendingApplications } from "@/server/platform";
import { approveAction, rejectAction } from "./actions";

export default async function AdminQueue() {
  const pending = await listPendingApplications();
  return (
    <main style={{ padding: 48 }}>
      <h1>Pending restaurants</h1>
      {pending.length === 0 && <p>No pending applications.</p>}
      <ul style={{ display: "grid", gap: 16 }}>
        {pending.map((p) => (
          <li key={p.applicationId} style={{ border: "1px solid #ddd", padding: 16 }}>
            <strong>{p.tenantName}</strong> — {p.slug}.serveos.com
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <form action={approveAction}>
                <input type="hidden" name="tenantId" value={p.tenantId} />
                <button type="submit">Approve</button>
              </form>
              <form action={rejectAction}>
                <input type="hidden" name="tenantId" value={p.tenantId} />
                <input name="notes" placeholder="Reason" />
                <button type="submit">Reject</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 7: Build to confirm**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(admin): approval queue with super-admin guard"
```

---

### Task 25: Seed script (demo tenants + super-admin)

**Files:**
- Create: `scripts/seed.ts`

- [ ] **Step 1: Implement `scripts/seed.ts`**

```typescript
import "dotenv/config";
import { db, pool } from "../src/db/client";
import { users, roles, userRoles } from "../src/server/auth/schema";
import { hashPassword } from "../src/server/auth/password";
import { seedDefaultPlans, registerRestaurant } from "../src/server/onboarding";
import { approveTenant } from "../src/server/platform";

async function main() {
  await seedDefaultPlans();

  // Platform super-admin
  const [admin] = await db
    .insert(users)
    .values({ tenantId: null, name: "Platform Admin", email: "admin@serveos.com", passwordHash: await hashPassword("admin1234") })
    .onConflictDoNothing()
    .returning();
  if (admin) {
    const [role] = await db.insert(roles).values({ tenantId: null, key: "super_admin", name: "Super Admin" }).returning();
    await db.insert(userRoles).values({ userId: admin.id, roleId: role.id });
  }

  // Demo restaurant (approved + live)
  const demo = await registerRestaurant({
    restaurantName: "Pizza Roma",
    slug: "roma",
    country: "EG",
    ownerName: "Sam Adel",
    email: "owner@roma.com",
    password: "owner1234",
  });
  const adminId = admin?.id;
  if (adminId) await approveTenant(demo.tenantId, adminId);

  console.log("Seed complete: admin@serveos.com / admin1234, owner@roma.com / owner1234, storefront roma.serveos.localhost");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the seed against the dev DB**

```bash
npm run db:seed
```
Expected: `Seed complete: ...`. (Re-running may error on duplicate slug `roma` — that's expected; the seed is for a fresh DB.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: add dev seed script for super-admin and demo restaurant"
```

---

### Task 26: End-to-end smoke test (register → approve → installable PWA)

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/onboarding.spec.ts`
- Modify: `package.json` (add `test:e2e`)

> This test uses host headers to hit the three surfaces against a running dev server. Storefront PWA "installability" is asserted by verifying the manifest is served with branded values and the SW registers.

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Create `playwright.config.ts`**

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

- [ ] **Step 3: Add the script to `package.json`**

```json
"test:e2e": "playwright test"
```

- [ ] **Step 4: Write the E2E test `tests/e2e/onboarding.spec.ts`**

```typescript
import { test, expect } from "@playwright/test";

const ROOT = "serveos.localhost";

test("storefront serves a branded, installable PWA manifest", async ({ request }) => {
  // Assumes `npm run db:seed` created the approved "roma" tenant.
  const res = await request.get("http://localhost:3000/manifest.webmanifest", {
    headers: { host: `roma.${ROOT}`, "x-tenant-slug": "roma" },
  });
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.name).toBe("Pizza Roma");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test("storefront home renders the restaurant brand", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ host: `roma.${ROOT}`, "x-tenant-slug": "roma" });
  await page.goto("http://localhost:3000/");
  await expect(page.getByRole("heading", { name: "Pizza Roma" })).toBeVisible();
});
```

- [ ] **Step 5: Seed, then run the E2E suite**

```bash
npm run db:seed || true
npm run test:e2e
```
Expected: 2 passed. (If the dev server isn't already running, Playwright starts it via `webServer`.)

> Note: `x-tenant-slug` is normally set by middleware from the host. Passing it explicitly in the test keeps the smoke test independent of local wildcard-DNS setup. For full host-based resolution locally, add `127.0.0.1 roma.serveos.localhost` to `/etc/hosts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(e2e): smoke test storefront PWA manifest and branding"
```

---

### Task 27: Full suite green + README run instructions

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run the entire unit/integration suite**

Run: `npm run test`
Expected: all tests PASS across tenancy, auth, rbac, subscription, entitlements, billing, onboarding, platform, manifest.

- [ ] **Step 2: Run a production build**

Run: `npm run build`
Expected: compiles with no type errors.

- [ ] **Step 3: Write `README.md`**

```markdown
# ServeOS — Tenant & Subscription Core

Multi-tenant foundation: tenancy + RLS, auth + RBAC, plans/entitlements, manual
billing, onboarding + admin approval, and per-tenant installable PWA storefronts.

## Local setup
1. `docker compose up -d` then create the test DB:
   `docker compose exec -T db psql -U serveos -d serveos -c "CREATE DATABASE serveos_test;"`
2. `npm install`
3. `npm run db:migrate` (dev DB)
4. `npm run db:seed`
5. `npm run dev`

Hosts (add to /etc/hosts for local subdomains):
- `app.serveos.localhost` — dashboard (register/login)
- `admin.serveos.localhost` — platform admin (admin@serveos.com / admin1234)
- `roma.serveos.localhost` — demo storefront PWA

## Testing
- `npm run test` — unit + integration (needs Postgres + serveos_test DB)
- `npm run test:e2e` — Playwright smoke test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add README with setup and testing instructions"
```

---

## Self-Review

**Spec coverage check** (spec → task):
- Shared-DB multi-tenancy + `tenant_id` + RLS → Tasks 4–5 ✓
- Subdomain routing (storefront/app/admin) → Tasks 6–7, surfaces in 21–24 ✓
- Self-hosted auth, sessions, OTP seam → Tasks 8–12 ✓
- RBAC owner/manager/staff/super_admin → Task 11 ✓
- Plans (quotas + features + WhatsApp count + usage) → Tasks 13–14 ✓
- Subscription state machine (trialing/active/past_due/suspended/canceled) → Task 15 ✓
- Entitlements single gate (checkQuota/hasFeature/checkUsage) + localized errors → Task 16 ✓
- Manual billing behind `BillingProvider` + invoices → Task 17 ✓
- Onboarding: register → trial → admin approval → publish → Tasks 18–20, 23–24 ✓
- Audit logging → Tasks 18, 20 ✓
- Per-tenant installable PWA (dynamic manifest + SW) → Tasks 21–22, E2E 26 ✓
- en/ar + region fields (country/currency/locale/timezone) → Tasks 4, 16, 19 ✓
- Seed (plans, super-admin, demo tenant) → Tasks 14, 25 ✓
- RLS isolation tested → Task 5 ✓

**Out-of-scope respected:** no menu/orders/customer-account tables; `usage_counters` defined but only read here; gateway providers (Paymob/Fawry/PayTabs) intentionally absent behind the `BillingProvider` interface. ✓

**Known cleanup nudges flagged inline:** unused-import guards in Tasks 14 and 20 (delete the noted lines if `tsc` complains); route-group `/` collision guidance in Task 23 Step 9.

**Type consistency:** `withTenant`, `RoleKey`, `PlanLimits`/`PlanFeatures`, `SESSION_COOKIE`, `BillingProvider` signatures are defined once and reused consistently across tasks.
