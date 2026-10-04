// SPDX-License-Identifier: Elastic-2.0
/**
 * Forward-auth sessions, exchange codes and redirect intents in Redis or
 * Valkey (high availability shared state), behind the same interface as the
 * SQLite tables (src/lib/forward-auth-state.ts).
 *
 * Keys, all under <namespace>{fa}: (one hash tag, so scripts never cross
 * cluster slots):
 *   s:<id>         session hash: u user, h proxy host, o origin, t token hash, c created, e expires (ms)
 *   t:<tokenHash>  the same fields plus i (the id), found by the cookie's hash
 *   u:<userId>     set of the user's session ids (revocation by user)
 *   h:<hostId>     set of the host's session ids (revocation by host)
 *   all            sorted set id -> expiry (listing, cleanup)
 *   seq            the id counter
 *   x:<codeHash>   exchange code: s session id, h, o, r redirect URI (60 s)
 *   i:<ridHash>    redirect intent: h, o, r (10 minutes)
 *
 * Only SHA-256 hashes of tokens, codes and intent ids are stored, as in
 * SQLite; redirect URIs and origins are in clear there too. Every key gets a
 * TTL: sessions and token keys expire with the session, indexes a day after
 * the longest session they list, codes and intents with their lifetime.
 */
import type { ForwardAuthSessionRecord, ForwardAuthStateStore } from "@/src/lib/forward-auth-state";
import { getSharedState, type SharedState } from "./connection";
import { CLAIM_HASH, FA_CREATE_SESSION, FA_DELETE_SESSIONS, FA_ROTATE_TOKEN, runScript, SET_HASH_WITH_TTL } from "./scripts";

/** Indexes, the counter and the listing outlive the longest session they hold by this much. */
const INDEX_GRACE_MS = 24 * 60 * 60 * 1000;
/** At most this many ids per delete script, so one call never blocks the server for long. */
const DELETE_BATCH = 500;

const HEX64 = /^[a-f0-9]{64}$/;

export function forwardAuthKeyBase(namespace: string): string {
  return `${namespace}{fa}:`;
}

function pairs(reply: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (Array.isArray(reply)) {
    for (let index = 0; index + 1 < reply.length; index += 2) fields[String(reply[index])] = String(reply[index + 1]);
  } else if (reply && typeof reply === "object") {
    for (const [key, value] of Object.entries(reply)) fields[key] = String(value);
  }
  return fields;
}

function positiveInt(value: string | undefined): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const number = Number(value);
  return number > 0 ? number : null;
}

function recordFrom(id: number, fields: Record<string, string>): ForwardAuthSessionRecord | null {
  const userId = positiveInt(fields.u);
  const proxyHostId = positiveInt(fields.h);
  const created = positiveInt(fields.c);
  const expires = positiveInt(fields.e);
  if (!userId || !proxyHostId || !created || !expires || !fields.o) return null;
  return {
    id,
    userId,
    proxyHostId,
    audienceOrigin: fields.o,
    expiresAt: new Date(expires).toISOString(),
    createdAt: new Date(created).toISOString(),
  };
}

/** Only hashes this module produced are used in key names. */
function assertHash(value: string): string {
  if (!HEX64.test(value)) throw new Error("Invalid forward-auth hash");
  return value;
}

export function createRedisForwardAuthStore(state: SharedState): ForwardAuthStateStore {
  const { redis } = state;
  const base = forwardAuthKeyBase(state.namespace);
  const all = `${base}all`;

  async function deleteBy(kind: "ids" | "users" | "hosts", ids: number[]): Promise<number> {
    const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
    let deleted = 0;
    for (let start = 0; start < unique.length; start += DELETE_BATCH) {
      const batch = unique.slice(start, start + DELETE_BATCH);
      deleted += Number(await runScript(redis, FA_DELETE_SESSIONS, [all], [base, kind, ...batch]));
    }
    return deleted;
  }

  async function sessionsByIds(ids: string[]): Promise<ForwardAuthSessionRecord[]> {
    const now = Date.now();
    const records = await Promise.all(
      ids.map(async (raw) => {
        const id = positiveInt(raw);
        if (!id) return null;
        const record = recordFrom(id, pairs(await redis.hgetall(`${base}s:${id}`)));
        return record && Date.parse(record.expiresAt) > now ? record : null;
      })
    );
    return records.filter((record): record is ForwardAuthSessionRecord => record !== null);
  }

  return {
    backend: "redis",
    revokesOnAccessChange: true,

    async createRedirectIntent(intent) {
      await runScript(redis, SET_HASH_WITH_TTL, [`${base}i:${assertHash(intent.ridHash)}`], [
        intent.ttlSeconds * 1000,
        "h",
        intent.proxyHostId,
        "o",
        intent.audienceOrigin,
        "r",
        intent.redirectUri,
      ]);
    },

    async isRedirectIntentUsable(ridHash) {
      if (!HEX64.test(ridHash)) return false;
      return (await redis.exists(`${base}i:${ridHash}`)) === 1;
    },

    async claimRedirectIntent(ridHash) {
      if (!HEX64.test(ridHash)) return null;
      const fields = pairs(await runScript(redis, CLAIM_HASH, [`${base}i:${ridHash}`], ["", ""]));
      const proxyHostId = positiveInt(fields.h);
      if (!proxyHostId || !fields.o || !fields.r) return null;
      return { proxyHostId, audienceOrigin: fields.o, redirectUri: fields.r };
    },

    async createSession(input) {
      const created = Date.now();
      const expires = created + input.ttlSeconds * 1000;
      const id = Number(
        await runScript(redis, FA_CREATE_SESSION, [all], [
          base,
          input.userId,
          input.proxyHostId,
          input.audienceOrigin,
          assertHash(input.tokenHash),
          created,
          expires,
          input.ttlSeconds * 1000 + INDEX_GRACE_MS,
        ])
      );
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Failed to create forward auth session");
      return {
        id,
        userId: input.userId,
        proxyHostId: input.proxyHostId,
        audienceOrigin: input.audienceOrigin,
        expiresAt: new Date(expires).toISOString(),
        createdAt: new Date(created).toISOString(),
      };
    },

    async findSessionByTokenHash(tokenHash) {
      if (!HEX64.test(tokenHash)) return null;
      const fields = pairs(await redis.hgetall(`${base}t:${tokenHash}`));
      const id = positiveInt(fields.i);
      return id ? recordFrom(id, fields) : null;
    },

    async getSession(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      return recordFrom(id, pairs(await redis.hgetall(`${base}s:${id}`)));
    },

    async listSessions(filter = {}) {
      let ids: string[];
      if (filter.userIds || filter.proxyHostIds) {
        const sets = [
          ...(filter.userIds ?? []).map((id) => `${base}u:${id}`),
          ...(filter.proxyHostIds ?? []).map((id) => `${base}h:${id}`),
        ];
        const members = await Promise.all(sets.map((key) => redis.smembers(key)));
        ids = [...new Set(members.flat())];
      } else {
        ids = await redis.zrangebyscore(all, Date.now() + 1, "+inf");
      }
      const records = await sessionsByIds(ids);
      return records.filter(
        (record) =>
          (!filter.userIds || filter.userIds.includes(record.userId)) &&
          (!filter.proxyHostIds || filter.proxyHostIds.includes(record.proxyHostId))
      );
    },

    deleteSessions: (ids) => deleteBy("ids", ids),
    deleteSessionsOfUsers: (userIds) => deleteBy("users", userIds),
    deleteSessionsOfHosts: (proxyHostIds) => deleteBy("hosts", proxyHostIds),

    async createExchange(input) {
      await runScript(redis, SET_HASH_WITH_TTL, [`${base}x:${assertHash(input.codeHash)}`], [
        input.ttlSeconds * 1000,
        "s",
        input.sessionId,
        "h",
        input.proxyHostId,
        "o",
        input.audienceOrigin,
        "r",
        input.redirectUri,
      ]);
    },

    async claimExchange(input) {
      if (!HEX64.test(input.codeHash)) return null;
      const fields = pairs(
        await runScript(redis, CLAIM_HASH, [`${base}x:${input.codeHash}`], [String(input.proxyHostId), input.audienceOrigin])
      );
      const sessionId = positiveInt(fields.s);
      if (!sessionId || !fields.r) return null;
      return { sessionId, redirectUri: fields.r };
    },

    async rotateSessionToken(input) {
      const rotated = await runScript(redis, FA_ROTATE_TOKEN, [all], [
        base,
        input.sessionId,
        input.proxyHostId,
        input.audienceOrigin,
        assertHash(input.tokenHash),
        Date.now(),
      ]);
      return Number(rotated) === 1;
    },

    async cleanupExpired() {
      const expired = (await redis.zrangebyscore(all, "-inf", Date.now())).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
      // The session keys are already gone (TTL); this drops their index entries.
      await deleteBy("ids", expired);
      return expired.length;
    },
  };
}

/** The shared store when high availability shared state is on, null otherwise. */
export async function getSharedForwardAuthStore(): Promise<ForwardAuthStateStore | null> {
  const state = await getSharedState();
  return state ? createRedisForwardAuthStore(state) : null;
}
