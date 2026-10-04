// SPDX-License-Identifier: Elastic-2.0
/**
 * Rate limiting of directory sign-in, built on the login limiter
 * (src/lib/rate-limit.ts, LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_MS /
 * LOGIN_BLOCK_MS) the same way the forward-auth portal uses it: failures per
 * client, per (account, client) pair, and per account from all clients up to
 * a ceiling, so a third party cannot lock a user out with a few guesses.
 * Better Auth's own limit on /sign-in/* (3 requests per 10 seconds per
 * client) applies on top.
 *
 * Attempts still being checked count towards every limit, so concurrent
 * requests get no more guesses than the same requests sent one by one.
 */
import { createHash } from "node:crypto";
import { ipRateLimitBucket } from "@/src/lib/client-ip";
import { createRateLimiter, LOGIN_RATE_LIMIT, type RateLimiter } from "@/src/lib/rate-limit";
import { ACCOUNT_FAILURE_CEILING, ACCOUNT_FAILURE_WINDOW_MS } from "@/src/lib/forward-auth-login-limiter";

// Separate tables, so keys that unauthenticated clients choose never evict
// entries of the other credential routes.
const perClient = createRateLimiter({ name: "directory-login-client", ...LOGIN_RATE_LIMIT });
const perAccount = createRateLimiter({
  name: "directory-login-account",
  ...LOGIN_RATE_LIMIT,
  maxAttempts: ACCOUNT_FAILURE_CEILING,
  windowMs: ACCOUNT_FAILURE_WINDOW_MS,
});

/**
 * Limiter keys. `account` names what is being guessed (a directory and the
 * typed username, or a user confirming a password) and is hashed, so every
 * key has a fixed size whatever the client sends.
 */
function keys(account: string, ip: string) {
  const hashed = createHash("sha256").update(account, "utf8").digest("base64url");
  const client = ipRateLimitBucket(ip);
  return {
    ip: `ldap-ip:${client}`,
    accountIp: `ldap-account-ip:${hashed}:${client}`,
    account: `ldap-account:${hashed}`,
  };
}

/** The account key of a sign-in: the directory and the username as typed, compared without case. */
export function signInAccountKey(directoryId: number, username: string): string {
  return `sign-in:${directoryId}:${username.trim().toLowerCase()}`;
}

/** The account key of a signed-in user confirming their directory password. */
export function confirmationAccountKey(userId: number): string {
  return `confirm:${userId}`;
}

export type DirectoryAttempt = {
  /** Counts a failure against the client, the (account, client) pair and the account. */
  fail(): Promise<void>;
  /** Clears the client's own counters; the account counter expires by itself. */
  succeed(): Promise<void>;
  /** Ends the attempt without counting it (the directory was unavailable). */
  release(): Promise<void>;
};

/** Admits an attempt, or returns null when any limit is reached. */
export async function beginDirectoryAttempt(account: string, ip: string): Promise<DirectoryAttempt | null> {
  const k = keys(account, ip);
  const slots: Array<[RateLimiter, string]> = [
    [perClient, k.ip],
    [perClient, k.accountIp],
    [perAccount, k.account],
  ];
  const releases: Array<() => Promise<void>> = [];
  for (const [limiter, key] of slots) {
    const release = await limiter.reserveAttempt(key);
    if (!release) {
      for (const held of releases) await held();
      return null;
    }
    releases.push(release);
  }
  let ended = false;
  const end = async (record: () => Promise<void>) => {
    if (ended) return;
    ended = true;
    for (const held of releases) await held();
    await record();
  };
  return {
    fail: () => end(async () => {
      for (const [limiter, key] of slots) await limiter.registerAttempt(key);
    }),
    succeed: () => end(async () => {
      await perClient.resetAttempts(k.ip);
      await perClient.resetAttempts(k.accountIp);
    }),
    release: () => end(async () => {}),
  };
}
