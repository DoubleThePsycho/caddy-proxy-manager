// SPDX-License-Identifier: Elastic-2.0
/**
 * Sign-ins in progress and used assertions.
 *
 * Starting a sign-in stores the AuthnRequest ID with the SHA-256 of a random
 * binding secret, which goes to the browser as the __Host-saml_binding
 * cookie (SameSite=None, so the identity provider's cross-site POST carries
 * it). The assertion consumer service accepts a response only with that
 * cookie: it looks the sign-in up by the cookie, deletes it (one response
 * per sign-in, whatever the outcome), and the response must answer that
 * sign-in's request. A response captured from, or forced into, another
 * browser therefore finds nothing (login CSRF / session swap).
 *
 * Every assertion ID is recorded in saml_used_assertions, unique per
 * provider, until the assertion could no longer be accepted anyway, so the
 * same assertion never signs in twice. Both are ordinary tables with
 * integer keys and explicit unique indexes, independent of Better Auth's
 * verification table.
 */
import { createHash, randomBytes } from "node:crypto";
import { count, eq, lte } from "drizzle-orm";
import { samlRequests, samlUsedAssertions } from "@/src/lib/db/schema";
import { LIMITS, REQUEST_TTL_MS } from "./constants";
import { asc, first } from "@/src/lib/db/ops";
import type { DbExecutor } from "@/src/lib/db/types";

type Writer = Pick<DbExecutor, "select" | "insert" | "update" | "delete" | "transaction">;

export function hashBindingSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** An AuthnRequest ID: "_" and 40 hex digits (an xs:ID cannot start with a digit). */
export function newRequestId(): string {
  return `_${randomBytes(20).toString("hex")}`;
}

export type PendingRequest = {
  providerId: number;
  requestId: string;
  callbackUrl: string;
  createdAt: number;
};

/** Stores a started sign-in and returns the binding secret for the cookie. */
export async function createPendingRequest(
  writer: Writer,
  input: { providerId: number; requestId: string; callbackUrl: string },
  now: number = Date.now()
): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  await writer.transaction(async (tx) => {
    await tx.delete(samlRequests).where(lte(samlRequests.expiresAt, new Date(now).toISOString()));
    // A bound on what unauthenticated clients can make the table hold: the oldest go first.
    const pending = (await first(tx.select({ total: count() }).from(samlRequests).limit(1)))?.total ?? 0;
    if (pending >= LIMITS.pendingRequests) {
      const oldest = await tx
        .select({ id: samlRequests.id })
        .from(samlRequests)
        .orderBy(asc(samlRequests.id))
        .limit(pending - LIMITS.pendingRequests + 1);
      for (const row of oldest) await tx.delete(samlRequests).where(eq(samlRequests.id, row.id));
    }
    await tx.insert(samlRequests).values({
      providerId: input.providerId,
      requestId: input.requestId,
      bindingHash: hashBindingSecret(secret),
      callbackUrl: input.callbackUrl,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + REQUEST_TTL_MS).toISOString(),
    });
  });
  return secret;
}

/**
 * Takes the sign-in the binding secret belongs to out of the table. Null
 * when there is none (no cookie, another browser's response, already used)
 * or it has expired.
 */
export async function consumePendingRequest(writer: Writer, secret: string | null, now: number = Date.now()): Promise<PendingRequest | null> {
  if (!secret || secret.length > 128) return null;
  const hash = hashBindingSecret(secret);
  const row = await writer.transaction(async (tx) => {
    const found = await first(tx.select().from(samlRequests).where(eq(samlRequests.bindingHash, hash)).limit(1));
    if (!found) return null;
    const deleted = await tx.delete(samlRequests).where(eq(samlRequests.id, found.id)).returning({ id: samlRequests.id });
    return deleted.length === 1 ? found : null;
  });
  if (!row || Date.parse(row.expiresAt) <= now) return null;
  return { providerId: row.providerId, requestId: row.requestId, callbackUrl: row.callbackUrl, createdAt: Date.parse(row.createdAt) };
}

/**
 * Records the use of an assertion. False when the provider's assertion with
 * this ID was used already: a replay.
 */
export async function recordAssertionUse(
  writer: Writer,
  input: { providerId: number; assertionId: string; until: number },
  now: number = Date.now()
): Promise<boolean> {
  return await writer.transaction(async (tx) => {
    await tx.delete(samlUsedAssertions).where(lte(samlUsedAssertions.expiresAt, new Date(now).toISOString()));
    const inserted = await tx
      .insert(samlUsedAssertions)
      .values({
        providerId: input.providerId,
        assertionId: input.assertionId,
        expiresAt: new Date(Math.max(input.until, now + 1000)).toISOString(),
        createdAt: new Date(now).toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: samlUsedAssertions.id });
    return inserted.length === 1;
  });
}

/** Forgets a provider's sign-ins in progress and replay records (when it is deleted). */
export async function deleteProviderState(writer: Pick<DbExecutor, "delete">, providerId: number): Promise<void> {
  await writer.delete(samlRequests).where(eq(samlRequests.providerId, providerId));
  await writer.delete(samlUsedAssertions).where(eq(samlUsedAssertions.providerId, providerId));
}
