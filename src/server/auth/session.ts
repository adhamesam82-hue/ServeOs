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
