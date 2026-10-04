/**
 * Two replicas count sign-in attempts together, and a TOTP code that signed
 * an account in on one replica is refused on the other (src/lib/db/README.md,
 * "State several replicas share"). With per-process state each replica would
 * count, and remember, only its own requests.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ensureLocalUser } from '../../helpers/e2e-sql';
import { totpCode, totpSecretFromUri } from '../../helpers/mfa-browser';
import { PUBLIC_ORIGIN, REPLICA_A, REPLICA_B, clientAddress, type Replica } from '../../helpers/replicas';

const LIMITS_USER = { username: 'replica-limits', password: 'ReplicaLimits2026!' };
const MFA_USER = { username: 'replica-mfa', password: 'ReplicaMfa2026!x' };

function signIn(request: APIRequestContext, replica: Replica, ip: string, username: string, password: string) {
  return request.post(`${replica.url}/api/auth/sign-in/username`, {
    headers: { Origin: PUBLIC_ORIGIN, 'x-forwarded-for': ip },
    data: { username, password },
  });
}

function verifyTotp(request: APIRequestContext, replica: Replica, ip: string, code: string) {
  return request.post(`${replica.url}/api/auth/two-factor/verify-totp`, {
    headers: { Origin: PUBLIC_ORIGIN, 'x-forwarded-for': ip },
    data: { code },
  });
}

test.describe('Two replicas: sign-in limits and second factors', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sign-in attempts from one client count on both replicas', async ({ request }) => {
    // Better Auth allows 3 sign-in requests per 10 seconds per client (auth_rate_limits on PostgreSQL).
    const ip = clientAddress();
    const statuses: number[] = [];
    for (const replica of [REPLICA_A, REPLICA_B, REPLICA_A]) {
      statuses.push((await signIn(request, replica, ip, 'nobody-on-replicas', 'not-the-password')).status());
    }
    expect(statuses).toEqual([401, 401, 401]);
    const fourth = await signIn(request, REPLICA_B, ip, 'nobody-on-replicas', 'not-the-password');
    expect(fourth.status()).toBe(429);
    // Another client is not affected.
    expect((await signIn(request, REPLICA_B, clientAddress(), 'nobody-on-replicas', 'not-the-password')).status()).toBe(401);
  });

  test('failed password confirmations of one account count on both replicas', async ({ playwright }) => {
    // The password change limiter (src/lib/rate-limit.ts, rate_limit_counters on
    // PostgreSQL): LOGIN_MAX_ATTEMPTS (5) failures block the account's attempts.
    ensureLocalUser({ ...LIMITS_USER, role: 'user' });
    const client = await playwright.request.newContext();
    try {
      expect((await signIn(client, REPLICA_A, clientAddress(), LIMITS_USER.username, LIMITS_USER.password)).status()).toBe(200);
      const change = (replica: Replica) =>
        client.post(`${replica.url}/api/user/change-password`, {
          // Same-origin check: the replica's own address.
          headers: { Origin: replica.url },
          data: { currentPassword: 'not-the-password', newPassword: 'ReplicaLimitsNew2026!' },
        });
      const statuses: number[] = [];
      for (const replica of [REPLICA_A, REPLICA_B, REPLICA_A, REPLICA_B, REPLICA_A]) statuses.push((await change(replica)).status());
      expect(statuses).toEqual([401, 401, 401, 401, 401]);
      expect((await change(REPLICA_B)).status()).toBe(429);
    } finally {
      await client.dispose();
    }
  });

  test('a sign-in started on one replica finishes on the other, and its TOTP code is refused on the first', async ({ playwright }) => {
    test.setTimeout(120_000);
    ensureLocalUser({ ...MFA_USER, role: 'user' });
    /** A client of its own (cookies, address), disposed after `fn`. */
    const asClient = async <T>(fn: (client: APIRequestContext, ip: string) => Promise<T>): Promise<T> => {
      const client = await playwright.request.newContext();
      try {
        return await fn(client, clientAddress());
      } finally {
        await client.dispose();
      }
    };

    // Turn MFA on for the account (on replica A).
    const secret = await asClient(async (enrol, ip) => {
      expect((await signIn(enrol, REPLICA_A, ip, MFA_USER.username, MFA_USER.password)).status()).toBe(200);
      const enable = await enrol.post(`${REPLICA_A.url}/api/auth/two-factor/enable`, {
        headers: { Origin: PUBLIC_ORIGIN, 'x-forwarded-for': ip },
        data: { password: MFA_USER.password },
      });
      expect(enable.status(), await enable.text()).toBe(200);
      const enrolled = totpSecretFromUri(((await enable.json()) as { totpURI: string }).totpURI);
      const confirm = await verifyTotp(enrol, REPLICA_A, ip, await totpCode(enrolled));
      expect(confirm.status(), await confirm.text()).toBe(200);
      return enrolled;
    });

    // First step on A, second step on B: the challenge is in the database.
    const used = await asClient(async (first, ip) => {
      const step1 = await signIn(first, REPLICA_A, ip, MFA_USER.username, MFA_USER.password);
      expect(step1.status()).toBe(200);
      expect(await step1.json()).toMatchObject({ twoFactorRedirect: true });
      let code = await totpCode(secret);
      let step2 = await verifyTotp(first, REPLICA_B, ip, code);
      if (step2.status() !== 200) {
        // The 30-second step turned between computing the code and checking it.
        code = await totpCode(secret, 1);
        step2 = await verifyTotp(first, REPLICA_B, ip, code);
      }
      expect(step2.status(), await step2.text()).toBe(200);
      const session = await first.get(`${REPLICA_A.url}/api/auth/get-session`);
      expect(((await session.json()) as { user?: { username?: string } } | null)?.user?.username).toBe(MFA_USER.username);
      return code;
    });

    // The same code again, from another sign-in, on the other replica: refused.
    await asClient(async (second, ip) => {
      const step1 = await signIn(second, REPLICA_B, ip, MFA_USER.username, MFA_USER.password);
      expect(await step1.json()).toMatchObject({ twoFactorRedirect: true });
      const replayed = await verifyTotp(second, REPLICA_A, ip, used);
      expect(replayed.status()).toBe(401);
      expect(await replayed.json()).toMatchObject({ code: 'INVALID_CODE' });
      expect(((await (await second.get(`${REPLICA_A.url}/api/auth/get-session`)).json()) as unknown)).toBeNull();
    });
  });
});
