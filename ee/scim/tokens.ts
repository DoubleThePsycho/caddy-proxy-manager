// SPDX-License-Identifier: Elastic-2.0
/**
 * SCIM tokens: bearer tokens that only the /scim/v2 endpoints accept. They
 * are a credential of their own, kept apart from API tokens both ways: the
 * REST API looks tokens up in api_tokens only and SCIM in scim_tokens only,
 * so neither kind works on the other's endpoints.
 *
 * A token is shown once; only its SHA-256 is stored. Creating one needs the
 * "scim" license and scim:write (administrator-level: a token can create
 * users). Revoking one never needs a license. Authenticating a request never
 * checks the license.
 */
import { createHash, randomBytes } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import { scimTokens } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { FEATURE, type ScimTokenView } from "./types";
import { asc, first } from "@/src/lib/db/ops";

export const SCIM_TOKEN_PREFIX = "scim_";
export const MAX_SCIM_TOKENS = 20;
const MAX_NAME_LENGTH = 100;
/** Characters of the token shown to tell tokens apart (the prefix plus 6). */
const DISPLAY_PREFIX_LENGTH = SCIM_TOKEN_PREFIX.length + 6;
const LAST_USED_DEBOUNCE_MS = 60_000;

type TokenRow = typeof scimTokens.$inferSelect;

export type ScimTokenIdentity = { id: number; name: string };

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isExpired(row: Pick<TokenRow, "expiresAt">, now: Date): boolean {
  if (!row.expiresAt) return false;
  const expires = new Date(row.expiresAt);
  return Number.isNaN(expires.getTime()) || expires <= now;
}

function toView(row: TokenRow, now = new Date()): ScimTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdBy: row.createdBy ?? null,
    createdAt: toIso(row.createdAt)!,
    lastUsedAt: row.lastUsedAt ? toIso(row.lastUsedAt) : null,
    expiresAt: row.expiresAt ? toIso(row.expiresAt) : null,
    expired: isExpired(row, now),
  };
}

export async function listScimTokens(): Promise<ScimTokenView[]> {
  const rows = await appDb.select().from(scimTokens).orderBy(asc(scimTokens.id));
  const now = new Date();
  return rows.map((row) => toView(row, now));
}

function readTokenInput(input: unknown): { name: string; expiresAt: string | null } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiValidationError("Request body must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "name" && key !== "expiresAt") throw new ApiValidationError(`Unknown field "${key.slice(0, 64)}"`);
  }
  if (typeof body.name !== "string" || !body.name.trim()) throw new ApiValidationError("name is required");
  const name = body.name.trim();
  if (name.length > MAX_NAME_LENGTH) throw new ApiValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`);
  if (/\p{Cc}/u.test(name)) throw new ApiValidationError("name must not contain control characters");
  let expiresAt: string | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== "") {
    if (typeof body.expiresAt !== "string") throw new ApiValidationError("expiresAt must be an ISO 8601 date");
    const parsed = new Date(body.expiresAt);
    if (Number.isNaN(parsed.getTime())) throw new ApiValidationError("expiresAt must be an ISO 8601 date");
    if (parsed <= new Date()) throw new ApiValidationError("expiresAt must be in the future");
    expiresAt = parsed.toISOString();
  }
  return { name, expiresAt };
}

/** Creates a token and returns it once, with its view. Needs the license. */
export async function createScimToken(
  input: unknown,
  actorUserId: number
): Promise<{ token: ScimTokenView; rawToken: string }> {
  await requireFeature(FEATURE);
  const { name, expiresAt } = readTokenInput(input);
  const rawToken = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashToken(rawToken);
  // The limit and the insert in one transaction: it holds under concurrent requests.
  const row = await appDb.transaction(async (tx) => {
    const [{ value: existing }] = await tx.select({ value: count() }).from(scimTokens);
    if (existing >= MAX_SCIM_TOKENS) {
      throw new ApiValidationError(`At most ${MAX_SCIM_TOKENS} SCIM tokens can exist; revoke one first`);
    }
    return (await first(tx
      .insert(scimTokens)
      .values({
        name,
        prefix: rawToken.slice(0, DISPLAY_PREFIX_LENGTH),
        tokenHash,
        createdBy: actorUserId,
        createdAt: nowIso(),
        expiresAt,
      })
      .returning()))!;
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "scim_token",
    entityId: row.id,
    summary: `Created SCIM token "${name}"`,
    data: { prefix: row.prefix, expiresAt },
  });
  return { token: toView(row), rawToken };
}

/** Revokes (deletes) a token. Never needs a license. */
export async function deleteScimToken(id: number, actorUserId: number): Promise<void> {
  const row = await first(appDb.select().from(scimTokens).where(eq(scimTokens.id, id)).limit(1));
  if (!row) throw new ApiClientError("SCIM token not found", 404);
  await appDb.delete(scimTokens).where(eq(scimTokens.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "scim_token",
    entityId: id,
    summary: `Revoked SCIM token "${row.name}"`,
    data: { prefix: row.prefix },
  });
}

/**
 * The token a SCIM request's Authorization header carries, or null when it
 * is missing, malformed, unknown or expired. Only scim_tokens is consulted.
 */
export async function authenticateScimToken(authorization: string | null): Promise<ScimTokenIdentity | null> {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return null;
  const raw = match[1];
  if (!raw.startsWith(SCIM_TOKEN_PREFIX) || raw.length > 200) return null;
  const tokenHash = hashToken(raw);
  // The lookup and the last-use write in one transaction: a token revoked
  // meanwhile is not written to.
  return await appDb.transaction(async (tx) => {
    const row = await first(tx.select().from(scimTokens).where(eq(scimTokens.tokenHash, tokenHash)).limit(1));
    const now = new Date();
    if (!row || isExpired(row, now)) return null;
    const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (!lastUsed || now.getTime() - lastUsed > LAST_USED_DEBOUNCE_MS) {
      await tx.update(scimTokens).set({ lastUsedAt: now.toISOString() }).where(eq(scimTokens.id, row.id));
    }
    return { id: row.id, name: row.name };
  });
}
