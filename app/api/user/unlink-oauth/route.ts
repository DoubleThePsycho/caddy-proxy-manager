import { NextRequest, NextResponse } from "next/server";
import { auth, checkSameOrigin } from "@/src/lib/auth";
import { getPasswordSignInUsername, getUserById } from "@/src/lib/models/user";
import { createAuditEvent } from "@/src/lib/models/audit";
import { appDb } from "@/src/lib/db";
import { accounts } from "@/src/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = Number(session.user.id);
    const user = await getUserById(userId);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // The check and the unlinking in one transaction: the password sign-in
    // the check found is still there when the OAuth links are gone.
    const { syncUserOAuthIdentity } = await import("@/src/lib/models/user");
    const outcome = await appDb.transaction(async (tx) => {
      // The login page must still work without OAuth: a username and a password
      // on the credential account, which is what that page checks.
      if (!(await getPasswordSignInUsername(userId))) return { error: "Cannot unlink OAuth: You must set a password first" } as const;

      // Check if user has any OAuth account links
      const oauthAccounts = await tx.select().from(accounts).where(
        and(
          eq(accounts.userId, userId),
          ne(accounts.providerId, "credential")
        )
      ).orderBy(accounts.id);
      if (oauthAccounts.length === 0) return { error: "No OAuth account to unlink" } as const;

      // Delete the OAuth account link(s)
      await tx.delete(accounts).where(
        and(
          eq(accounts.userId, userId),
          ne(accounts.providerId, "credential")
        )
      );

      // Re-derive users.provider/subject from the (now OAuth-free) accounts rows
      // so the Profile page stops reporting the account as linked (#261).
      await syncUserOAuthIdentity(userId);
      return { previousProvider: oauthAccounts[0].providerId } as const;
    });
    if ("error" in outcome) {
      return NextResponse.json({ error: outcome.error }, { status: 400 });
    }
    const { previousProvider } = outcome;

    // Audit log
    await createAuditEvent({
      userId,
      action: "oauth_unlinked",
      entityType: "user",
      entityId: userId,
      summary: `User unlinked OAuth account: ${previousProvider}`,
      data: JSON.stringify({ provider: previousProvider })
    });

    return NextResponse.json({
      success: true,
      message: "OAuth account unlinked successfully"
    });
  } catch (error) {
    console.error("OAuth unlink error:", error);
    return NextResponse.json(
      { error: "Failed to unlink OAuth account" },
      { status: 500 }
    );
  }
}
