/**
 * The enforced-SSO setting as stored, and the session decision built on it.
 * A row that cannot be read fails closed (enforced, no break-glass account).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { parseSsoEnforcement, readSsoEnforcement, writeSsoEnforcement } from '@/ee/sso/enforcement-store';
import { SSO_SESSION_PATHS, isSessionAllowedUnderSsoEnforcement, loginPageEnforcement } from '@/ee/sso/sign-in';

describe('parseSsoEnforcement', () => {
  it('treats a missing row as off', () => {
    expect(parseSsoEnforcement(null)).toEqual({ enabled: false, breakGlassUserIds: [] });
    expect(parseSsoEnforcement(undefined)).toEqual({ enabled: false, breakGlassUserIds: [] });
  });

  it('reads a stored value and drops ids that are not positive integers', () => {
    expect(parseSsoEnforcement(JSON.stringify({ enabled: true, breakGlassUserIds: [3, 3, '4', -1, 1.5, 7] })))
      .toEqual({ enabled: true, breakGlassUserIds: [3, 7] });
    expect(parseSsoEnforcement(JSON.stringify({ enabled: false, breakGlassUserIds: [3] })))
      .toEqual({ enabled: false, breakGlassUserIds: [3] });
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"off"'],
    ['null', 'null'],
    ['a value without an explicit false', JSON.stringify({ enabled: 'no' })],
  ])('fails closed on %s', (_name, raw) => {
    expect(parseSsoEnforcement(raw)).toEqual({ enabled: true, breakGlassUserIds: [] });
  });

  it('round-trips through the settings table', async () => {
    const db = createTestDb();
    expect(await readSsoEnforcement(db)).toEqual({ enabled: false, breakGlassUserIds: [] });
    await writeSsoEnforcement(db, { enabled: true, breakGlassUserIds: [2, 5, 2] });
    expect(await readSsoEnforcement(db)).toEqual({ enabled: true, breakGlassUserIds: [2, 5] });
  });
});

describe('isSessionAllowedUnderSsoEnforcement', () => {
  const db = createTestDb();

  it('allows every session while enforcement is off', async () => {
    await writeSsoEnforcement(db, { enabled: false, breakGlassUserIds: [] });
    expect(await isSessionAllowedUnderSsoEnforcement(db, 9, '/sign-in/username')).toBe(true);
  });

  it('allows SSO endpoints and break-glass accounts only, while on', async () => {
    await writeSsoEnforcement(db, { enabled: true, breakGlassUserIds: [2] });
    expect([...SSO_SESSION_PATHS]).toEqual(['/callback/:id', '/sign-in/social', '/saml/acs/:providerId']);
    for (const path of ['/callback/:id', '/sign-in/social', '/saml/acs/:providerId']) {
      expect(await isSessionAllowedUnderSsoEnforcement(db, 9, path)).toBe(true);
    }
    for (const path of ['/sign-in/username', '/sign-in/email', '/sign-up/email', '/verify-email', '/callback/x', '/sign-in/saml', '/saml/acs/1', undefined]) {
      expect(await isSessionAllowedUnderSsoEnforcement(db, 9, path)).toBe(false);
      expect(await isSessionAllowedUnderSsoEnforcement(db, 2, path)).toBe(true);
    }
  });
});

describe('loginPageEnforcement', () => {
  it('says whether a break-glass account can sign in with a password', async () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const user = async (username: string, status = 'active') => {
      const [row] = await db.insert(schema.users).values({
        email: `${username}@example.com`, username, role: 'admin', status, createdAt: now, updatedAt: now,
      }).returning();
      await db.insert(schema.accounts).values({
        accountId: String(row.id), providerId: 'credential', userId: row.id,
        password: bcrypt.hashSync('Correct-Horse-9!', 4), createdAt: now, updatedAt: now,
      });
      return row.id;
    };
    const glass = await user('glass');
    const disabled = await user('disabled', 'disabled');

    expect(await loginPageEnforcement(db)).toEqual({ enforced: false, breakGlass: false });
    await writeSsoEnforcement(db, { enabled: true, breakGlassUserIds: [] });
    expect(await loginPageEnforcement(db)).toEqual({ enforced: true, breakGlass: false });
    await writeSsoEnforcement(db, { enabled: true, breakGlassUserIds: [disabled] });
    expect(await loginPageEnforcement(db)).toEqual({ enforced: true, breakGlass: false });
    await writeSsoEnforcement(db, { enabled: true, breakGlassUserIds: [disabled, glass] });
    expect(await loginPageEnforcement(db)).toEqual({ enforced: true, breakGlass: true });
    await db.update(schema.accounts).set({ password: null }).where(eq(schema.accounts.userId, glass));
    expect(await loginPageEnforcement(db)).toEqual({ enforced: true, breakGlass: false });
  });
});

describe('enforced SSO shipping', () => {
  it('puts the password form behind "Sign in with a password" on the login page when SSO is enforced', () => {
    const root = resolve(__dirname, '../..');
    const page = readFileSync(resolve(root, 'app/(auth)/login/page.tsx'), 'utf8');
    const client = readFileSync(resolve(root, 'app/(auth)/login/LoginClient.tsx'), 'utf8');
    expect(page).toContain('ssoEnforced={enforcement.enforced}');
    expect(page).toContain('breakGlassSignIn={enforcement.breakGlass}');
    expect(client).toContain('const ssoFirst = ssoEnforced && enabledProviders.length + samlProviders.length > 0;');
    expect(client).toContain('useState(!ssoFirst && passwordSignIn)');
    expect(client).toContain('Sign in with a password');
    expect(client).toContain('Break-glass accounts only');
    expect(client).toContain('aria-expanded={showPasswordForm}');
    expect(client).toMatch(/\{showPasswordForm && \(\s*<form onSubmit=\{handleSignIn\}/);
  });
});
