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

  it("returns null for an unknown token", async () => {
    expect(await validateSession("does-not-exist")).toBeNull();
  });
});
