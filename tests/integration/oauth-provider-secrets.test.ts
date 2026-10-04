import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../helpers/db";

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock("../../src/lib/db", async () => {
  const { createTestDb } = await import("../helpers/db");
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import {
  createOAuthProvider,
  getOAuthProvider,
  updateOAuthProvider,
} from "../../src/lib/models/oauth-providers";
import { oauthProviders } from "../../src/lib/db/schema";
import { isEncryptedSecret } from "../../src/lib/secret";

beforeEach(async () => {
  await ctx.db.delete(oauthProviders);
});

describe("OAuth provider secret persistence", () => {
  it("preserves an existing secret for blank updates and rotates only explicitly", async () => {
    const created = await createOAuthProvider({
      name: "OIDC",
      clientId: "client-id",
      clientSecret: "original-client-secret",
    });
    const originalRow = await ctx.db.query.oauthProviders.findFirst({
      where: (table, { eq }) => eq(table.id, created.id),
    });
    expect(isEncryptedSecret(originalRow!.clientSecret)).toBe(true);

    await updateOAuthProvider(created.id, { clientSecret: "   " });
    const preservedRow = await ctx.db.query.oauthProviders.findFirst({
      where: (table, { eq }) => eq(table.id, created.id),
    });
    expect(preservedRow!.clientSecret).toBe(originalRow!.clientSecret);
    expect((await getOAuthProvider(created.id))!.clientSecret).toBe("original-client-secret");

    await updateOAuthProvider(created.id, { clientSecret: " replacement-client-secret " });
    expect((await getOAuthProvider(created.id))!.clientSecret).toBe("replacement-client-secret");
  });
});
