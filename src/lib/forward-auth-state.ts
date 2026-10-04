/**
 * Where forward-auth request-path state lives: sessions, exchange codes and
 * redirect intents. One interface, two stores:
 *
 *  - SQLite (this file), the default: the forward_auth_* tables, exactly as
 *    before high availability.
 *  - Redis or Valkey (ee/high-availability/shared-state), when high
 *    availability shared state is on: every web node sees the same sessions,
 *    so a user signed in through one node's portal passes forward auth on
 *    every node.
 *
 * src/lib/models/forward-auth.ts is the only caller that reads or writes
 * through it; everything else uses the model's functions, which do not
 * branch on the store. Tokens, codes and intent ids are only ever stored as
 * SHA-256 hashes, in both stores.
 */
import { and, eq, gt, inArray, lt, type SQL } from "drizzle-orm";
import { appDb, nowIso, toIso } from "./db";
import { forwardAuthExchanges, forwardAuthRedirectIntents, forwardAuthSessions } from "./db/schema";
import { getSharedForwardAuthStore } from "@/ee/high-availability/shared-state/forward-auth-store";

export type ForwardAuthSessionRecord = {
  id: number;
  userId: number;
  proxyHostId: number;
  audienceOrigin: string;
  expiresAt: string;
  createdAt: string;
};

export type ForwardAuthAudienceRef = { proxyHostId: number; audienceOrigin: string };

export type StoredRedirectIntent = ForwardAuthAudienceRef & { redirectUri: string };
export type ClaimedExchange = { sessionId: number; redirectUri: string };

export interface ForwardAuthStateStore {
  readonly backend: "sqlite" | "redis";
  /**
   * Whether sessions must be deleted here when a user's access shrinks
   * (group removed, grant removed, host deleted). The SQLite store does not
   * need to: the verify endpoint checks access against the same database on
   * every request. A shared store does, so that nodes whose copy of the
   * database trails the leader's refuse at once too.
   */
  readonly revokesOnAccessChange: boolean;

  createRedirectIntent(intent: StoredRedirectIntent & { ridHash: string; ttlSeconds: number }): Promise<void>;
  /** Exists, unconsumed and unexpired, without claiming it. */
  isRedirectIntentUsable(ridHash: string): Promise<boolean>;
  /** Claims the intent once (then it is gone); null when missing, consumed or expired. */
  claimRedirectIntent(ridHash: string): Promise<StoredRedirectIntent | null>;

  createSession(input: ForwardAuthAudienceRef & { userId: number; tokenHash: string; ttlSeconds: number }): Promise<ForwardAuthSessionRecord>;
  /** The session holding this token hash, expired or not (the caller checks). */
  findSessionByTokenHash(tokenHash: string): Promise<ForwardAuthSessionRecord | null>;
  getSession(id: number): Promise<ForwardAuthSessionRecord | null>;
  /** Unexpired sessions, optionally only of these users or hosts. */
  listSessions(filter?: { userIds?: number[]; proxyHostIds?: number[] }): Promise<ForwardAuthSessionRecord[]>;
  deleteSessions(ids: number[]): Promise<number>;
  deleteSessionsOfUsers(userIds: number[]): Promise<number>;
  deleteSessionsOfHosts(proxyHostIds: number[]): Promise<number>;

  createExchange(input: ForwardAuthAudienceRef & { sessionId: number; codeHash: string; redirectUri: string; ttlSeconds: number }): Promise<void>;
  /** Claims an unexpired code of this audience once; it is gone afterwards. */
  claimExchange(input: ForwardAuthAudienceRef & { codeHash: string }): Promise<ClaimedExchange | null>;
  /** Gives an unexpired session of this audience a new token hash; false when there is none. */
  rotateSessionToken(input: ForwardAuthAudienceRef & { sessionId: number; tokenHash: string }): Promise<boolean>;

  /** Removes expired state; returns the number of expired sessions removed. */
  cleanupExpired(): Promise<number>;
}

type SessionRow = typeof forwardAuthSessions.$inferSelect;

function toRecord(row: Pick<SessionRow, "id" | "userId" | "proxyHostId" | "audienceOrigin" | "expiresAt" | "createdAt">): ForwardAuthSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    proxyHostId: row.proxyHostId,
    audienceOrigin: row.audienceOrigin,
    expiresAt: toIso(row.expiresAt)!,
    createdAt: toIso(row.createdAt)!,
  };
}

function expiresIn(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

/**
 * Deletes the sessions matching `where` and their exchange codes (the
 * schema's cascade, which production SQLite does not enforce), in one
 * transaction. Returns how many sessions went.
 */
async function deleteSqliteSessions(where: SQL): Promise<number> {
  return await appDb.transaction(async (tx) => {
    await tx.delete(forwardAuthExchanges)
      .where(inArray(forwardAuthExchanges.sessionId, tx.select({ id: forwardAuthSessions.id }).from(forwardAuthSessions).where(where)));
    return (await tx.delete(forwardAuthSessions).where(where).returning({ id: forwardAuthSessions.id })).length;
  });
}

/** The forward_auth_* tables (the store without high availability). */
export const sqliteForwardAuthStore: ForwardAuthStateStore = {
  backend: "sqlite",
  revokesOnAccessChange: false,

  async createRedirectIntent(intent) {
    const now = nowIso();
    await appDb.insert(forwardAuthRedirectIntents).values({
      ridHash: intent.ridHash,
      proxyHostId: intent.proxyHostId,
      audienceOrigin: intent.audienceOrigin,
      redirectUri: intent.redirectUri,
      expiresAt: expiresIn(intent.ttlSeconds),
      consumed: false,
      createdAt: now,
    });
    // Opportunistic cleanup of expired intents
    await appDb.delete(forwardAuthRedirectIntents).where(lt(forwardAuthRedirectIntents.expiresAt, now));
  },

  async isRedirectIntentUsable(ridHash) {
    const intent = await appDb.query.forwardAuthRedirectIntents.findFirst({
      where: (table, operators) =>
        operators.and(operators.eq(table.ridHash, ridHash), operators.eq(table.consumed, false), operators.gt(table.expiresAt, nowIso())),
    });
    return !!intent;
  },

  async claimRedirectIntent(ridHash) {
    // Atomic claim: only succeeds if the intent exists, is unconsumed, and not expired
    const claimed = await appDb
      .update(forwardAuthRedirectIntents)
      .set({ consumed: true })
      .where(
        and(
          eq(forwardAuthRedirectIntents.ridHash, ridHash),
          eq(forwardAuthRedirectIntents.consumed, false),
          gt(forwardAuthRedirectIntents.expiresAt, nowIso())
        )
      )
      .returning();
    if (claimed.length === 0) return null;
    const intent = claimed[0];
    // Delete immediately after consumption
    await appDb.delete(forwardAuthRedirectIntents).where(eq(forwardAuthRedirectIntents.id, intent.id));
    return { proxyHostId: intent.proxyHostId, audienceOrigin: intent.audienceOrigin, redirectUri: intent.redirectUri };
  },

  async createSession(input) {
    const [row] = await appDb
      .insert(forwardAuthSessions)
      .values({
        userId: input.userId,
        proxyHostId: input.proxyHostId,
        audienceOrigin: input.audienceOrigin,
        tokenHash: input.tokenHash,
        expiresAt: expiresIn(input.ttlSeconds),
        createdAt: nowIso(),
      })
      .returning();
    if (!row) throw new Error("Failed to create forward auth session");
    return toRecord(row);
  },

  async findSessionByTokenHash(tokenHash) {
    const row = await appDb.query.forwardAuthSessions.findFirst({ where: (table, operators) => operators.eq(table.tokenHash, tokenHash) });
    return row ? toRecord(row) : null;
  },

  async getSession(id) {
    const row = await appDb.query.forwardAuthSessions.findFirst({ where: (table, operators) => operators.eq(table.id, id) });
    return row ? toRecord(row) : null;
  },

  async listSessions(filter = {}) {
    const conditions = [gt(forwardAuthSessions.expiresAt, nowIso())];
    if (filter.userIds) conditions.push(inArray(forwardAuthSessions.userId, filter.userIds));
    if (filter.proxyHostIds) conditions.push(inArray(forwardAuthSessions.proxyHostId, filter.proxyHostIds));
    const rows = await appDb.select().from(forwardAuthSessions).where(and(...conditions)).orderBy(forwardAuthSessions.id);
    return rows.map(toRecord);
  },

  async deleteSessions(ids) {
    return ids.length === 0 ? 0 : await deleteSqliteSessions(inArray(forwardAuthSessions.id, ids));
  },

  async deleteSessionsOfUsers(userIds) {
    return userIds.length === 0 ? 0 : await deleteSqliteSessions(inArray(forwardAuthSessions.userId, userIds));
  },

  async deleteSessionsOfHosts(proxyHostIds) {
    return proxyHostIds.length === 0 ? 0 : await deleteSqliteSessions(inArray(forwardAuthSessions.proxyHostId, proxyHostIds));
  },

  async createExchange(input) {
    await appDb.insert(forwardAuthExchanges).values({
      sessionId: input.sessionId,
      proxyHostId: input.proxyHostId,
      audienceOrigin: input.audienceOrigin,
      codeHash: input.codeHash,
      sessionToken: "[pending]", // placeholder — fresh token generated at redemption
      redirectUri: input.redirectUri,
      expiresAt: expiresIn(input.ttlSeconds),
      used: false,
      createdAt: nowIso(),
    });
  },

  async claimExchange(input) {
    // Atomic claim: only succeeds if the exchange exists, is unused, and not expired
    const claimed = await appDb
      .update(forwardAuthExchanges)
      .set({ used: true })
      .where(
        and(
          eq(forwardAuthExchanges.codeHash, input.codeHash),
          eq(forwardAuthExchanges.proxyHostId, input.proxyHostId),
          eq(forwardAuthExchanges.audienceOrigin, input.audienceOrigin),
          eq(forwardAuthExchanges.used, false),
          gt(forwardAuthExchanges.expiresAt, nowIso())
        )
      )
      .returning();
    if (claimed.length === 0) return null;
    const exchange = claimed[0];
    // The claimed row is never needed again: delete it now.
    await appDb.delete(forwardAuthExchanges).where(eq(forwardAuthExchanges.id, exchange.id));
    return { sessionId: exchange.sessionId, redirectUri: exchange.redirectUri };
  },

  async rotateSessionToken(input) {
    const updated = await appDb
      .update(forwardAuthSessions)
      .set({ tokenHash: input.tokenHash })
      .where(
        and(
          eq(forwardAuthSessions.id, input.sessionId),
          eq(forwardAuthSessions.proxyHostId, input.proxyHostId),
          eq(forwardAuthSessions.audienceOrigin, input.audienceOrigin),
          gt(forwardAuthSessions.expiresAt, nowIso())
        )
      )
      .returning({ id: forwardAuthSessions.id });
    return updated.length > 0;
  },

  async cleanupExpired() {
    const now = nowIso();
    // Delete expired exchanges first (FK constraint)
    await appDb.delete(forwardAuthExchanges).where(lt(forwardAuthExchanges.expiresAt, now));
    const result = await appDb.delete(forwardAuthSessions).where(lt(forwardAuthSessions.expiresAt, now)).returning();
    return result.length;
  },
};

/**
 * The store request paths use now: the shared one when high availability
 * shared state is on, the SQLite tables otherwise. Throws (and request paths
 * fail closed) when shared state is on but cannot be used.
 */
export async function forwardAuthStateStore(): Promise<ForwardAuthStateStore> {
  return (await getSharedForwardAuthStore()) ?? sqliteForwardAuthStore;
}
