import { createHash, randomBytes } from "node:crypto";
import { appDb, nowIso, toIso } from "../db";
import { apiTokens, users } from "../db/schema";
import { and, count, eq } from "drizzle-orm";
import { NotFoundError } from "../api-auth";
import { ApiValidationError } from "../api-errors";
import { parseStoredTokenScopes, parseTokenScopesInput } from "../api-token-scopes";
import type { Permission } from "../permissions";
import { accessForUser } from "@/ee/custom-roles/access";
import { first } from "@/src/lib/db/ops";

export type ApiToken = {
  id: number;
  name: string;
  createdBy: number;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /**
   * The permissions the token is limited to (src/lib/api-token-scopes.ts), as
   * they were given; null: the same access as its owner's role.
   */
  scopes: Permission[] | null;
};

type ApiTokenRow = typeof apiTokens.$inferSelect;

function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt)!,
    lastUsedAt: row.lastUsedAt ? toIso(row.lastUsedAt) : null,
    expiresAt: row.expiresAt ? toIso(row.expiresAt) : null,
    scopes: parseStoredTokenScopes(row.scopes),
  };
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export const MAX_TOKENS_PER_USER = 10;
const MAX_TOKEN_NAME_LENGTH = 100;

/** The expiry choices of the create API and the Profile page: a number of days, or never. */
export const TOKEN_EXPIRY_PRESETS = ["30d", "90d", "365d", "never"] as const;
export type TokenExpiryPreset = (typeof TOKEN_EXPIRY_PRESETS)[number];

export function isTokenExpiryPreset(value: unknown): value is TokenExpiryPreset {
  return typeof value === "string" && (TOKEN_EXPIRY_PRESETS as readonly string[]).includes(value);
}

/** When a token created at `now` with `preset` expires (ISO 8601), or null for never. */
export function expiryFromPreset(preset: TokenExpiryPreset, now: Date = new Date()): string | null {
  if (preset === "never") return null;
  const days = Number(preset.slice(0, -1));
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export type CreateApiTokenOptions = {
  /**
   * The permissions to limit the token to, checked against what the owner
   * holds now (parseTokenScopesInput); absent or null: the owner's role.
   */
  scopes?: unknown;
};

export async function createApiToken(
  name: string,
  createdBy: number,
  expiresAt?: string,
  options: CreateApiTokenOptions = {}
): Promise<{ token: ApiToken; rawToken: string }> {
  const trimmedName = name.trim();
  if (trimmedName.length > MAX_TOKEN_NAME_LENGTH) {
    throw new ApiValidationError(`Token name must be ${MAX_TOKEN_NAME_LENGTH} characters or fewer`);
  }

  // Validate expires_at is a valid ISO 8601 date in the future
  let validatedExpiresAt: string | null = null;
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    if (isNaN(parsed.getTime())) {
      throw new ApiValidationError("expires_at must be a valid ISO 8601 date");
    }
    if (parsed <= new Date()) {
      throw new ApiValidationError("expires_at must be in the future");
    }
    validatedExpiresAt = parsed.toISOString();
  }

  // Scopes can only narrow what the owner holds now.
  let scopes: Permission[] | null = null;
  if (options.scopes !== undefined && options.scopes !== null) {
    const owner = await first(appDb
      .select({ id: users.id, role: users.role, customRoleId: users.customRoleId })
      .from(users)
      .where(eq(users.id, createdBy))
      .limit(1));
    if (!owner) throw new NotFoundError("User not found");
    scopes = parseTokenScopesInput(options.scopes, await accessForUser(owner));
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const now = nowIso();

  // The per-user limit is counted in the transaction that inserts the token.
  const row = await appDb.transaction(async (tx) => {
    const existingCount = await tx
      .select({ value: count() })
      .from(apiTokens)
      .where(eq(apiTokens.createdBy, createdBy));
    if (existingCount[0] && existingCount[0].value >= MAX_TOKENS_PER_USER) {
      throw new ApiValidationError(`Maximum of ${MAX_TOKENS_PER_USER} API tokens per user`);
    }
    return await first(tx
      .insert(apiTokens)
      .values({
        name: name.trim(),
        tokenHash,
        createdBy,
        createdAt: now,
        expiresAt: validatedExpiresAt,
        scopes: scopes === null ? null : JSON.stringify(scopes),
      })
      .returning());
  });

  if (!row) {
    throw new Error("Failed to create API token");
  }

  return { token: toApiToken(row), rawToken };
}

export async function listApiTokens(userId: number): Promise<ApiToken[]> {
  const rows = await appDb.query.apiTokens.findMany({
    where: (table, { eq }) => eq(table.createdBy, userId),
    orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
  });
  return rows.map(toApiToken);
}

export async function listAllApiTokens(): Promise<ApiToken[]> {
  const rows = await appDb.query.apiTokens.findMany({
    orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
  });
  return rows.map(toApiToken);
}

/** A token's name and owner, for the audit record of its deletion; null when it does not exist. */
export async function getApiTokenSummary(id: number): Promise<{ name: string; createdBy: number } | null> {
  if (!Number.isSafeInteger(id)) return null;
  const row = await appDb.query.apiTokens.findFirst({
    columns: { name: true, createdBy: true },
    where: (table, { eq }) => eq(table.id, id),
  });
  return row ?? null;
}

export async function deleteApiToken(
  id: number,
  userId: number,
  canDeleteAny = false
): Promise<void> {
  // Keep inaccessible and nonexistent IDs indistinguishable. Authorization is
  // part of the DELETE predicate, so a non-owner cannot use status codes to
  // enumerate another user's token IDs.
  const deleted = await appDb
    .delete(apiTokens)
    .where(
      canDeleteAny
        ? eq(apiTokens.id, id)
        : and(eq(apiTokens.id, id), eq(apiTokens.createdBy, userId))
    )
    .returning({ id: apiTokens.id });

  if (deleted.length === 0) {
    throw new NotFoundError("Token not found");
  }
}

const LAST_USED_DEBOUNCE_MS = 60_000; // 60 seconds

export async function validateToken(
  rawToken: string
): Promise<{ token: ApiToken; user: { id: number; role: string; customRoleId?: number | null } } | null> {
  const tokenHash = hashToken(rawToken);

  const row = await appDb.query.apiTokens.findFirst({
    where: (table, { eq }) => eq(table.tokenHash, tokenHash),
  });

  if (!row) {
    return null;
  }

  // Check expiry — reject tokens with invalid or past expiry dates
  if (row.expiresAt) {
    const expiresAt = new Date(row.expiresAt);
    if (isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      return null;
    }
  }

  // Load the creator user
  const user = await appDb.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, row.createdBy),
  });

  if (!user || user.status !== "active") {
    return null;
  }

  // Debounced lastUsedAt update
  const now = new Date();
  const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt) : null;
  if (!lastUsed || now.getTime() - lastUsed.getTime() > LAST_USED_DEBOUNCE_MS) {
    await appDb
      .update(apiTokens)
      .set({ lastUsedAt: nowIso() })
      .where(eq(apiTokens.id, row.id));
  }

  return {
    token: toApiToken(row),
    // The token acts with its owner's current role, custom role included.
    user: { id: user.id, role: user.role, customRoleId: user.customRoleId ?? null },
  };
}
