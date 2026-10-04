// SPDX-License-Identifier: Elastic-2.0
/**
 * The Lua scripts of the shared state. Each runs atomically on the server,
 * so a check and the write it guards (claiming a one-time code, charging a
 * balance) can never interleave with another node's.
 *
 * Cluster mode: every key a script touches shares the hash tag of KEYS[1]
 * ({fa} for forward auth, {mz:<consumer>} for one API consumer), so a script
 * never crosses slots even where it builds key names from ARGV.
 *
 * Written for Redis's Lua 5.1 and portable to 5.3: numbers are only compared
 * and added, never formatted with tostring() (Lua 5.1 prints large numbers in
 * exponent notation), amounts travel as the decimal strings the caller
 * passed, and ids built in a script go through string.format('%d').
 */
import { createHash } from "node:crypto";
import type { SharedRedis } from "./connection";

export type SharedScript = { name: string; lua: string; sha: string };

function script(name: string, lua: string): SharedScript {
  const body = lua.trim();
  return { name, lua: body, sha: createHash("sha1").update(body).digest("hex") };
}

/** Runs a script by its SHA-1, sending the body once when the server does not have it yet. */
export async function runScript(redis: SharedRedis, which: SharedScript, keys: string[], args: Array<string | number>): Promise<unknown> {
  const argv = args.map(String);
  try {
    return await redis.evalsha(which.sha, keys.length, ...keys, ...argv);
  } catch (error) {
    if (!(error instanceof Error) || !/NOSCRIPT/.test(error.message)) throw error;
    return redis.eval(which.lua, keys.length, ...keys, ...argv);
  }
}

// ── Forward auth ─────────────────────────────────────────────────────
// KEYS[1] is always <ns>{fa}:all; ARGV[1] is <ns>{fa}: (the key base).

/**
 * Creates a session. ARGV: base, userId, proxyHostId, origin, tokenHash,
 * createdMs, expiresMs, indexTtlMs. Returns the new id.
 */
export const FA_CREATE_SESSION = script(
  "fa_create_session",
  `
local base = ARGV[1]
local id = string.format('%d', redis.call('INCR', base .. 'seq'))
redis.call('PEXPIRE', base .. 'seq', ARGV[8])
local sk = base .. 's:' .. id
redis.call('DEL', sk)
redis.call('HSET', sk, 'u', ARGV[2], 'h', ARGV[3], 'o', ARGV[4], 't', ARGV[5], 'c', ARGV[6], 'e', ARGV[7])
redis.call('PEXPIREAT', sk, ARGV[7])
local tk = base .. 't:' .. ARGV[5]
redis.call('DEL', tk)
redis.call('HSET', tk, 'i', id, 'u', ARGV[2], 'h', ARGV[3], 'o', ARGV[4], 'c', ARGV[6], 'e', ARGV[7])
redis.call('PEXPIREAT', tk, ARGV[7])
local ttl = tonumber(ARGV[8])
local indexes = { base .. 'u:' .. ARGV[2], base .. 'h:' .. ARGV[3] }
for i = 1, 2 do
  redis.call('SADD', indexes[i], id)
  if redis.call('PTTL', indexes[i]) < ttl then redis.call('PEXPIRE', indexes[i], ARGV[8]) end
end
redis.call('ZADD', KEYS[1], ARGV[7], id)
if redis.call('PTTL', KEYS[1]) < ttl then redis.call('PEXPIRE', KEYS[1], ARGV[8]) end
return id
`
);

/**
 * Deletes sessions with their token keys and index entries. ARGV: base,
 * kind ("ids", "users" or "hosts"), then the ids. Returns how many sessions
 * existed.
 */
export const FA_DELETE_SESSIONS = script(
  "fa_delete_sessions",
  `
local base = ARGV[1]
local kind = ARGV[2]
local ids = {}
for i = 3, #ARGV do
  if kind == 'ids' then
    ids[#ids + 1] = ARGV[i]
  else
    local index = base .. (kind == 'users' and 'u:' or 'h:') .. ARGV[i]
    local members = redis.call('SMEMBERS', index)
    for j = 1, #members do ids[#ids + 1] = members[j] end
    redis.call('DEL', index)
  end
end
local deleted = 0
for i = 1, #ids do
  local id = ids[i]
  local sk = base .. 's:' .. id
  local f = redis.call('HMGET', sk, 'u', 'h', 't')
  if f[1] then
    redis.call('DEL', base .. 't:' .. f[3])
    redis.call('SREM', base .. 'u:' .. f[1], id)
    redis.call('SREM', base .. 'h:' .. f[2], id)
    deleted = deleted + 1
  end
  redis.call('DEL', sk)
  redis.call('ZREM', KEYS[1], id)
end
return deleted
`
);

/**
 * Gives an unexpired session of this audience a new token (the exchange-code
 * redemption). ARGV: base, id, proxyHostId, origin, newTokenHash, nowMs.
 * Returns 1, or 0 when the session is gone, expired or of another audience.
 */
export const FA_ROTATE_TOKEN = script(
  "fa_rotate_token",
  `
local base = ARGV[1]
local sk = base .. 's:' .. ARGV[2]
local f = redis.call('HMGET', sk, 'u', 'h', 'o', 't', 'c', 'e')
if not f[1] then return 0 end
if f[2] ~= ARGV[3] or f[3] ~= ARGV[4] then return 0 end
if tonumber(f[6]) <= tonumber(ARGV[6]) then return 0 end
redis.call('DEL', base .. 't:' .. f[4])
local tk = base .. 't:' .. ARGV[5]
redis.call('DEL', tk)
redis.call('HSET', tk, 'i', ARGV[2], 'u', f[1], 'h', f[2], 'o', f[3], 'c', f[5], 'e', f[6])
redis.call('PEXPIREAT', tk, f[6])
redis.call('HSET', sk, 't', ARGV[5])
return 1
`
);

/** Replaces a hash and sets its TTL. KEYS[1]: the hash. ARGV: ttlMs, then field, value pairs. */
export const SET_HASH_WITH_TTL = script(
  "set_hash_with_ttl",
  `
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
`
);

/**
 * Claims a one-time hash (an exchange code, a redirect intent): returns its
 * fields and deletes it, or nil. With ARGV[1] set, only a hash whose h and o
 * fields equal ARGV[1] and ARGV[2] is claimed (another audience leaves it).
 */
export const CLAIM_HASH = script(
  "claim_hash",
  `
local v = redis.call('HGETALL', KEYS[1])
if #v == 0 then return nil end
if ARGV[1] ~= '' then
  local h, o
  for i = 1, #v, 2 do
    if v[i] == 'h' then h = v[i + 1] elseif v[i] == 'o' then o = v[i + 1] end
  end
  if h ~= ARGV[1] or o ~= ARGV[2] then return nil end
end
redis.call('DEL', KEYS[1])
return v
`
);

// ── API monetization ─────────────────────────────────────────────────
// KEYS[1] is the consumer's hash <ns>{mz:<id>}:c. A missing hash is seeded
// from the caller's database row: ARGV seedBalance, seedFreeMonth,
// seedFreeUsed, seedDisabled, newEpoch, always in this order first. With an
// empty seedBalance the script returns {"seed"} instead, and the caller reads
// the row and runs it again: the hot path reads no database.

const SEED = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  if ARGV[1] == '' then return {'seed'} end
  redis.call('HSET', KEYS[1], 'ep', ARGV[5], 'bal', ARGV[1], 'fm', ARGV[2], 'fu', ARGV[3], 'dis', ARGV[4], 'tc', '0', 'tr', '0', 'tf', '0')
end
`;

/**
 * One gate request. ARGV (after the seed): 6 nowMs, 7 windowStart,
 * 8 month, 9 perMinute (0: none), 10 includedPerMonth, 11 price,
 * 12 overdraft, 13 keyId, 14 ttlMs. Returns {"ok", charged, free},
 * {"payment_required", balance}, {"rate_limited"}, {"disabled"}, {"revoked"}
 * or {"seed"}.
 */
export const MZ_CHARGE = script(
  "mz_charge",
  `
${SEED}
local c = KEYS[1]
if redis.call('HGET', c, 'dis') == '1' then return {'disabled'} end
if redis.call('HEXISTS', c, 'rk:' .. ARGV[13]) == 1 then return {'revoked'} end
local perMinute = tonumber(ARGV[9])
local sameWindow = redis.call('HGET', c, 'ws') == ARGV[7]
if perMinute > 0 and sameWindow then
  if tonumber(redis.call('HGET', c, 'wc') or '0') >= perMinute then return {'rate_limited'} end
end
local sameMonth = redis.call('HGET', c, 'fm') == ARGV[8]
local used = 0
if sameMonth then used = tonumber(redis.call('HGET', c, 'fu') or '0') end
local free = used < tonumber(ARGV[10])
if not free then
  local balance = redis.call('HGET', c, 'bal')
  if tonumber(balance) - tonumber(ARGV[11]) < -tonumber(ARGV[12]) then return {'payment_required', balance} end
end
if perMinute > 0 then
  if sameWindow then redis.call('HINCRBY', c, 'wc', 1) else redis.call('HSET', c, 'ws', ARGV[7], 'wc', '1') end
end
redis.call('HINCRBY', c, 'tr', 1)
redis.call('HSET', c, 'k:' .. ARGV[13], ARGV[6])
redis.call('PEXPIRE', c, ARGV[14])
if free then
  if sameMonth then redis.call('HINCRBY', c, 'fu', 1) else redis.call('HSET', c, 'fm', ARGV[8], 'fu', '1') end
  redis.call('HINCRBY', c, 'tf', 1)
  return {'ok', '0', '1'}
end
if ARGV[11] ~= '0' then
  redis.call('HINCRBY', c, 'bal', '-' .. ARGV[11])
  redis.call('HINCRBY', c, 'tc', ARGV[11])
end
return {'ok', ARGV[11], '0'}
`
);

/**
 * Reserves up to `want` requests at once for a sync replica's allowance
 * (ee/monetization/replica-allowance.ts), charged exactly as `want` calls of
 * MZ_CHARGE would be: the per-minute window, free requests first, then the
 * price while the balance stays within the limit. ARGV (after the seed):
 * 6 nowMs, 7 windowStart, 8 month, 9 perMinute (0: none), 10 includedPerMonth,
 * 11 price, 12 limit, 13 keyId, 14 ttlMs, 15 want. Returns
 * {"ok", granted, free, chargedMicros}, {"payment_required", balance},
 * {"rate_limited"}, {"disabled"}, {"revoked"} or {"seed"}.
 */
export const MZ_RESERVE = script(
  "mz_reserve",
  `
${SEED}
local c = KEYS[1]
if redis.call('HGET', c, 'dis') == '1' then return {'disabled'} end
if redis.call('HEXISTS', c, 'rk:' .. ARGV[13]) == 1 then return {'revoked'} end
local n = tonumber(ARGV[15])
local perMinute = tonumber(ARGV[9])
local sameWindow = redis.call('HGET', c, 'ws') == ARGV[7]
local wc = 0
if sameWindow then wc = tonumber(redis.call('HGET', c, 'wc') or '0') end
if perMinute > 0 then
  local left = perMinute - wc
  if left <= 0 then return {'rate_limited'} end
  if left < n then n = left end
end
local sameMonth = redis.call('HGET', c, 'fm') == ARGV[8]
local used = 0
if sameMonth then used = tonumber(redis.call('HGET', c, 'fu') or '0') end
local free = tonumber(ARGV[10]) - used
if free < 0 then free = 0 end
if free > n then free = n end
local charged = n - free
local price = tonumber(ARGV[11])
local balance = redis.call('HGET', c, 'bal')
if charged > 0 and price > 0 then
  local afford = math.floor((tonumber(balance) + tonumber(ARGV[12])) / price)
  if afford < 0 then afford = 0 end
  if afford < charged then charged = afford end
end
local granted = free + charged
if granted == 0 then return {'payment_required', balance} end
if perMinute > 0 then
  if sameWindow then redis.call('HINCRBY', c, 'wc', granted) else redis.call('HSET', c, 'ws', ARGV[7], 'wc', string.format('%d', granted)) end
end
redis.call('HINCRBY', c, 'tr', granted)
redis.call('HSET', c, 'k:' .. ARGV[13], ARGV[6])
redis.call('PEXPIRE', c, ARGV[14])
if free > 0 then
  if sameMonth then redis.call('HINCRBY', c, 'fu', free) else redis.call('HSET', c, 'fm', ARGV[8], 'fu', string.format('%d', free)) end
  redis.call('HINCRBY', c, 'tf', free)
end
local amount = 0
if charged > 0 and price > 0 then
  amount = charged * price
  redis.call('HINCRBY', c, 'bal', string.format('%d', -amount))
  redis.call('HINCRBY', c, 'tc', string.format('%d', amount))
end
return {'ok', string.format('%d', granted), string.format('%d', free), string.format('%d', amount)}
`
);

/**
 * Gives back reserved requests a replica did not use: the cumulative
 * counters go down (the leader's write-back takes them off the ledger's
 * usage) and the money goes back on the balance. A reservation of another
 * month than the consumer's current free-request month gives back its
 * requests and money but not its free requests: they stay counted in the
 * month that is over, and the current month's are never touched. ARGV
 * (after the seed): 6 month, 7 requests, 8 free requests, 9 chargedMicros,
 * 10 ttlMs.
 */
export const MZ_RELEASE = script(
  "mz_release",
  `
${SEED}
local c = KEYS[1]
redis.call('HINCRBY', c, 'tr', string.format('%d', -tonumber(ARGV[7])))
local free = tonumber(ARGV[8])
if redis.call('HGET', c, 'fm') ~= ARGV[6] then free = 0 end
if free > 0 then
  redis.call('HINCRBY', c, 'tf', string.format('%d', -free))
  local left = tonumber(redis.call('HGET', c, 'fu') or '0') - free
  if left < 0 then left = 0 end
  redis.call('HSET', c, 'fu', string.format('%d', left))
end
local amount = tonumber(ARGV[9])
if amount > 0 then
  redis.call('HINCRBY', c, 'bal', ARGV[9])
  redis.call('HINCRBY', c, 'tc', string.format('%d', -amount))
end
redis.call('PEXPIRE', c, ARGV[10])
return 1
`
);

/**
 * Makes sure a consumer's hash exists (seeded from the leader's database),
 * so that sync replicas, which never seed, find it. ARGV (after the seed):
 * 6 ttlMs.
 */
export const MZ_SEED = script(
  "mz_seed",
  `
${SEED}
redis.call('PEXPIRE', KEYS[1], ARGV[6])
return 1
`
);

/**
 * A top-up or adjustment: credits the balance and queues the entry for the
 * ledger in one step, at most once per reference key. KEYS: hash, credit
 * queue (a list), reference key. ARGV (after the seed): 6 amount (signed),
 * 7 the entry (JSON, with its own id), 8 referenceTtlMs, 9 ttlMs.
 * Returns {"applied", balance} or {"duplicate"}.
 */
export const MZ_CREDIT = script(
  "mz_credit",
  `
if redis.call('EXISTS', KEYS[3]) == 1 then return {'duplicate'} end
${SEED}
redis.call('HINCRBY', KEYS[1], 'bal', ARGV[6])
redis.call('RPUSH', KEYS[2], ARGV[7])
redis.call('SET', KEYS[3], '1', 'PX', ARGV[8])
redis.call('PEXPIRE', KEYS[1], ARGV[9])
redis.call('PEXPIRE', KEYS[2], ARGV[9])
return {'applied', redis.call('HGET', KEYS[1], 'bal')}
`
);

/**
 * Marks a consumer disabled ("disable") or active ("enable"), or one of its
 * keys revoked ("revoke"), for every node at once. ARGV (after the seed):
 * 6 operation, 7 keyId, 8 ttlMs.
 */
export const MZ_FLAG = script(
  "mz_flag",
  `
${SEED}
if ARGV[6] == 'disable' then redis.call('HSET', KEYS[1], 'dis', '1')
elseif ARGV[6] == 'enable' then redis.call('HSET', KEYS[1], 'dis', '0')
elseif ARGV[6] == 'revoke' then redis.call('HSET', KEYS[1], 'rk:' .. ARGV[7], '1') end
redis.call('PEXPIRE', KEYS[1], ARGV[8])
return 1
`
);

/**
 * Failed-answer credits (ee/monetization/answer-credits.ts): credits back the
 * requests behind charge ids not credited before, each remembered under
 * <consumer>aref:<id hash> (same hash tag as KEYS[1]), gives back free
 * requests of the current month, and queues one credit entry for the ledger.
 * KEYS: hash, credit queue. ARGV (after the seed): 6 month, 7 refTtlMs,
 * 8 ttlMs, 9 entry id, 10 ledger reference, 11 description, 12 time (ISO),
 * then per request from 13: id hash, amount, free (0|1), of this month (0|1).
 * Returns {amount, requests, free} credited now (all "0" when every id was
 * credited before), or {"seed"}.
 */
export const MZ_ANSWER_CREDIT = script(
  "mz_answer_credit",
  `
${SEED}
local base = string.sub(KEYS[1], 1, -2)
local total = 0
local n = 0
local f = 0
local fm = 0
for i = 13, #ARGV, 4 do
  local rk = base .. 'aref:' .. ARGV[i]
  if redis.call('EXISTS', rk) == 0 then
    redis.call('SET', rk, '1', 'PX', ARGV[7])
    total = total + tonumber(ARGV[i + 1])
    n = n + 1
    if ARGV[i + 2] == '1' then
      f = f + 1
      if ARGV[i + 3] == '1' then fm = fm + 1 end
    end
  end
end
if n == 0 then return {'0', '0', '0'} end
if total > 0 then redis.call('HINCRBY', KEYS[1], 'bal', string.format('%d', total)) end
if fm > 0 and redis.call('HGET', KEYS[1], 'fm') == ARGV[6] then
  local left = tonumber(redis.call('HGET', KEYS[1], 'fu') or '0') - fm
  if left < 0 then left = 0 end
  redis.call('HSET', KEYS[1], 'fu', string.format('%d', left))
end
redis.call('RPUSH', KEYS[2], '{"id":"' .. ARGV[9] .. '","ref":"' .. ARGV[10] .. '","type":"credit","amount":' .. string.format('%d', total) .. ',"requests":' .. string.format('%d', n) .. ',"free":' .. string.format('%d', f) .. ',"desc":"' .. ARGV[11] .. '","at":"' .. ARGV[12] .. '"}')
redis.call('PEXPIRE', KEYS[1], ARGV[8])
redis.call('PEXPIRE', KEYS[2], ARGV[8])
return {string.format('%d', total), string.format('%d', n), string.format('%d', f)}
`
);

/** A fixed-window counter. KEYS[1]: the window's key. ARGV: limit, windowMs. Returns 1 when allowed. */
export const RATE_WINDOW = script(
  "rate_window",
  `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if n > tonumber(ARGV[1]) then return 0 end
return 1
`
);

/** Releases a lock only when this node still holds it. KEYS[1]: the lock. ARGV: holder. */
export const RELEASE_LOCK = script(
  "release_lock",
  `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`
);
