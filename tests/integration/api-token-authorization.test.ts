import { afterEach, describe, expect, it, vi } from "vitest";
import { openAppDatabase, type AppDatabase } from "../helpers/app-database";

let database: AppDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
  vi.resetModules();
});

describe("API token deletion authorization", () => {
  it("makes another user's token indistinguishable from a nonexistent ID", async () => {
    database = await openAppDatabase("ingressi-api-token-auth-");
    vi.resetModules();
    const [{ default: db, nowIso }, { apiTokens, users }, { deleteApiToken }] = await Promise.all([
      import("@/src/lib/db"),
      import("@/src/lib/db/schema"),
      import("@/src/lib/models/api-tokens"),
    ]);
    const now = nowIso();
    const [owner, otherUser, admin] = await db.insert(users).values([
      {
        email: "owner@example.com", name: "Owner", role: "user", provider: "credentials",
        subject: "owner", status: "active", createdAt: now, updatedAt: now,
      },
      {
        email: "other@example.com", name: "Other", role: "user", provider: "credentials",
        subject: "other", status: "active", createdAt: now, updatedAt: now,
      },
      {
        email: "admin@example.com", name: "Admin", role: "admin", provider: "credentials",
        subject: "admin", status: "active", createdAt: now, updatedAt: now,
      },
    ]).returning();
    const [token] = await db.insert(apiTokens).values({
      name: "Owner token",
      tokenHash: "a".repeat(64),
      createdBy: owner.id,
      createdAt: now,
    }).returning();

    await expect(deleteApiToken(token.id, otherUser.id, false))
      .rejects.toMatchObject({ name: "NotFoundError", message: "Token not found" });
    await expect(deleteApiToken(token.id + 10_000, otherUser.id, false))
      .rejects.toMatchObject({ name: "NotFoundError", message: "Token not found" });
    expect(await db.query.apiTokens.findFirst({
      where: (table, { eq }) => eq(table.id, token.id),
    })).toBeDefined();

    await deleteApiToken(token.id, admin.id, true);
    expect(await db.query.apiTokens.findFirst({
      where: (table, { eq }) => eq(table.id, token.id),
    })).toBeUndefined();
  });
});
