/**
 * What a completed sign-in records (src/lib/sign-in-activity.ts): the
 * account's last sign-in and method, and for an identity provider the
 * provider's own newest sign-in (sign_in_sources), named by the OIDC
 * callback route, the SAML ACS route or the LDAP request body; a second
 * factor completes the step that started it. And users.disabledAt, kept by
 * the triggers of drizzle/0047 whichever way the status changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import { signInSources, users } from '@/src/lib/db/schema';

let db: TestDb;

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));

import {
  completedSignIn,
  noteFirstSignInStep,
  recordSignIn,
  signInProviderFor,
  signInSourceActivity,
} from '@/src/lib/sign-in-activity';
import { first } from '@/src/lib/db/ops';

const NOW = '2026-02-01T00:00:00.000Z';

async function seedUser(email: string, status = 'active'): Promise<number> {
  return (await first(db.insert(users).values({
    email, name: email.split('@')[0], role: 'user', provider: 'credentials', subject: email, status, createdAt: NOW, updatedAt: NOW,
  }).returning()))!.id;
}

async function user(id: number) {
  return (await first(db.select().from(users).where(eq(users.id, id)).limit(1)))!;
}

beforeEach(() => {
  db = createTestDb();
});

describe('signInProviderFor', () => {
  it('names the provider of OIDC, SAML and LDAP sign-ins as accounts.providerId does', () => {
    expect(signInProviderFor('sso', { path: '/callback/:id', params: { id: 'corp-idp' } })).toBe('corp-idp');
    expect(signInProviderFor('sso', { path: '/sign-in/social', body: { provider: 'corp-idp', idToken: { token: 'x' } } })).toBe('corp-idp');
    expect(signInProviderFor('saml', { path: '/saml/acs/:providerId', params: { providerId: '3' } })).toBe('saml:3');
    expect(signInProviderFor('ldap', { path: '/sign-in/ldap', body: { directoryId: 7, username: 'u', password: 'p' } })).toBe('ldap:7');
  });

  it('names none for password and passkey sign-ins, or ids it cannot trust', () => {
    expect(signInProviderFor('password', { path: '/sign-in/username', body: { username: 'u' } })).toBeNull();
    expect(signInProviderFor('passkey', { path: '/passkey/verify-authentication' })).toBeNull();
    expect(signInProviderFor('sso', { path: '/callback/:id', params: { id: 'saml:3' } })).toBeNull();
    expect(signInProviderFor('sso', { path: '/callback/:id', params: {} })).toBeNull();
    expect(signInProviderFor('saml', { path: '/saml/acs/:providerId', params: { providerId: '0' } })).toBeNull();
    expect(signInProviderFor('saml', { path: '/saml/acs/:providerId', params: { providerId: '3; drop' } })).toBeNull();
    expect(signInProviderFor('ldap', { path: '/sign-in/ldap', body: { directoryId: '7' } })).toBeNull();
    expect(signInProviderFor('ldap', null)).toBeNull();
  });
});

describe('completedSignIn', () => {
  it('completes a directory sign-in with its directory when the second factor follows', async () => {
    await noteFirstSignInStep(41, { path: '/sign-in/ldap', body: { directoryId: 2 } });
    expect(await completedSignIn(41, { path: '/two-factor/verify-totp' })).toEqual({ method: 'ldap', providerId: 'ldap:2' });
    // Used once: a later second step without a first one counts as a password sign-in.
    expect(await completedSignIn(41, { path: '/two-factor/verify-backup-code' })).toEqual({ method: 'password', providerId: null });
  });

  it('reads a one-step sign-in from its own request', async () => {
    expect(await completedSignIn(42, { path: '/callback/:id', params: { id: 'corp-idp' } })).toEqual({ method: 'sso', providerId: 'corp-idp' });
    expect(await completedSignIn(42, { path: '/passkey/verify-authentication' })).toEqual({ method: 'passkey', providerId: null });
  });
});

describe('recordSignIn', () => {
  it("keeps the account's last sign-in and each provider's newest one", async () => {
    const alice = await seedUser('alice@example.com');
    const bob = await seedUser('bob@example.com');

    await recordSignIn(alice, { method: 'sso', providerId: 'corp-idp' }, '2026-02-01T10:00:00.000Z');
    await recordSignIn(bob, { method: 'sso', providerId: 'corp-idp' }, '2026-02-01T11:00:00.000Z');
    await recordSignIn(alice, { method: 'password', providerId: null }, '2026-02-01T12:00:00.000Z');

    expect(await user(alice)).toMatchObject({ lastSignInAt: '2026-02-01T12:00:00.000Z', lastSignInMethod: 'password' });
    expect(await signInSourceActivity()).toEqual(new Map([['corp-idp', { at: '2026-02-01T11:00:00.000Z', userId: bob }]]));
    expect(await db.select().from(signInSources)).toHaveLength(1);
  });
});

describe('users.disabledAt', () => {
  it('is set when an account is disabled, kept while it stays so and cleared when it is enabled', async () => {
    const id = await seedUser('carol@example.com');
    expect((await user(id)).disabledAt).toBeNull();

    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, id));
    const since = (await user(id)).disabledAt;
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await db.update(users).set({ name: 'Carol', status: 'disabled' }).where(eq(users.id, id));
    expect((await user(id)).disabledAt).toBe(since);

    await db.update(users).set({ status: 'active' }).where(eq(users.id, id));
    expect((await user(id)).disabledAt).toBeNull();
  });

  it('is set for an account created disabled, unless the insert gives it', async () => {
    expect((await user(await seedUser('dave@example.com', 'disabled'))).disabledAt).not.toBeNull();
    const imported = (await first(db.insert(users).values({
      email: 'erin@example.com', role: 'user', provider: 'credentials', subject: 'erin', status: 'disabled', disabledAt: '2025-12-24T08:00:00.000Z', createdAt: NOW, updatedAt: NOW,
    }).returning()))!.id;
    expect((await user(imported)).disabledAt).toBe('2025-12-24T08:00:00.000Z');
  });
});
